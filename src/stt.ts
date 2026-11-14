import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import OpenAI from 'openai';
import type { Cue } from './types.ts';
import { formatTiming, serialize } from './srt.ts';
import { BASE_DELAYS_MS, describeErr, isRetryable, retryAfterMs } from './translate.ts';
import type { RetryInfo } from './translate.ts';
import { detectSilences, probeDuration, sliceAudioChunk } from './video.ts';
import { computeChunkBoundaries, parseSilences } from './chunk.ts';
import { workDir } from './config.ts';

export const DEFAULT_STT_BASE_URL = 'https://api.groq.com/openai/v1';
const MAX_ATTEMPTS = 5;
const STT_TIMEOUT_MS = 15 * 60_000; // local servers (LMStudio) can be slow on long chunks

export interface SttConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string | null;
  /** ISO-639-1 hint for the transcription endpoint */
  language?: string;
}

export function resolveSttConfig({
  apiKey,
  baseUrl,
  model,
  language,
}: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
} = {}): SttConfig {
  try {
    process.loadEnvFile();
  } catch {
    // missing .env is fine
  }
  return {
    // `||` over `??`: .env.example ships empty values, which must count as unset
    apiKey: (apiKey ?? process.env.STT_API_KEY ?? '').trim() || process.env.GROQ_API_TOKEN?.trim() || null,
    baseUrl: (baseUrl ?? process.env.STT_BASE_URL ?? '').trim() || DEFAULT_STT_BASE_URL,
    model: (model ?? process.env.STT_MODEL ?? '').trim() || null,
    language: language?.trim() || undefined,
  };
}

export function assertSttConfig(cfg: SttConfig): asserts cfg is SttConfig & { apiKey: string; model: string } {
  if (!cfg.model) {
    throw new Error(
      'no STT model: set STT_MODEL=whisper-large-v3-turbo in .env (see .env.example) or pass --stt-model',
    );
  }
  if (!cfg.apiKey) {
    throw new Error('no STT API key: set STT_API_KEY=... (или GROQ_API_TOKEN=...) in .env or pass --stt-api-key');
  }
}

export function createSttClient({ apiKey, baseUrl }: { apiKey: string; baseUrl: string }): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: STT_TIMEOUT_MS });
}

/** deterministic working names in the temp work dir: <video>.audio<n>{.stt/,.srt} */
export function audioBasePath(videoPath: string, track: number): string {
  const stem = path.basename(videoPath, path.extname(videoPath));
  return path.join(workDir(videoPath), `${stem}.audio${track}`);
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeOutcome {
  segments: WhisperSegment[];
  /** word-level timestamps when the provider returns them, else [] */
  words: WhisperWord[];
  /** full language name as reported by the model ("english") or null */
  language: string | null;
  /** audio duration as reported by the model, seconds */
  duration: number | null;
}

function sanitizeSegments(raw: unknown): WhisperSegment[] {
  const list = Array.isArray(raw) ? raw : [];
  const segments: WhisperSegment[] = [];
  for (const s of list) {
    const start = Number((s as WhisperSegment | undefined)?.start);
    const end = Number((s as WhisperSegment | undefined)?.end);
    const text = String((s as WhisperSegment | undefined)?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    segments.push({ start: Math.max(0, start), end, text });
  }
  return segments;
}

function sanitizeWords(raw: unknown): WhisperWord[] {
  const list = Array.isArray(raw) ? raw : [];
  const words: WhisperWord[] = [];
  for (const w of list) {
    const start = Number((w as WhisperWord | undefined)?.start);
    const end = Number((w as WhisperWord | undefined)?.end);
    const word = String((w as WhisperWord | undefined)?.word ?? '').trim();
    if (!word || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    words.push({ word, start: Math.max(0, start), end });
  }
  return words;
}

/** verbose_json payload → segments; providers without segment support degrade to one big segment */
export function parseVerboseJson(raw: unknown, fallbackDuration?: number): TranscribeOutcome {
  const r = (raw ?? {}) as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
    segments?: unknown;
    words?: unknown;
  };
  const duration = Number(r.duration);
  const segments = sanitizeSegments(r.segments);
  if (!segments.length) {
    const text = String(r.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const fb = Number.isFinite(duration) && duration > 0 ? duration : fallbackDuration ?? 0;
    if (text && fb > 0) segments.push({ start: 0, end: fb, text });
  }
  return {
    segments,
    words: sanitizeWords(r.words),
    language: typeof r.language === 'string' && r.language ? r.language : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

function sttError(err: unknown): Error {
  const e = err as { status?: unknown };
  return new Error(`STT provider error${typeof e?.status === 'number' ? ` (HTTP ${e.status})` : ''}: ${describeErr(err)}`, {
    cause: err,
  });
}

export async function transcribeChunk(
  client: OpenAI,
  {
    model,
    data,
    filename,
    language,
    fallbackDuration,
    delays = BASE_DELAYS_MS,
    onRetry,
  }: {
    model: string;
    data: Uint8Array;
    filename: string;
    language?: string;
    fallbackDuration?: number;
    delays?: number[];
    onRetry?: (info: RetryInfo) => void;
  },
): Promise<TranscribeOutcome> {
  const file = new File([data], filename, { type: 'audio/flac' });
  let failures = 0;
  for (;;) {
    let raw: unknown;
    try {
      raw = await client.audio.transcriptions.create({
        file,
        model,
        ...(language ? { language } : {}),
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment'],
      });
    } catch (err) {
      if (!isRetryable(err) || failures >= MAX_ATTEMPTS - 1) throw sttError(err);
      failures += 1;
      const delay = retryAfterMs(err) ?? delays[Math.min(failures - 1, delays.length - 1)];
      onRetry?.({ attempt: failures, delay, err, endpoint: 'stt' });
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    return parseVerboseJson(raw, fallbackDuration);
  }
}

export interface SegChunk {
  startSec: number;
  outcome: TranscribeOutcome;
}

export interface MergedTranscript {
  segments: WhisperSegment[];
  words: WhisperWord[];
}

/** offsets chunk-local segments and words to absolute time, clamps seam overlaps */
export function mergeSegmentChunks(chunks: SegChunk[], totalDuration: number): MergedTranscript {
  const segments: WhisperSegment[] = [];
  const words: WhisperWord[] = [];
  let prevEnd = 0;
  for (const chunk of [...chunks].sort((a, b) => a.startSec - b.startSec)) {
    for (const seg of chunk.outcome.segments) {
      let start = chunk.startSec + seg.start;
      let end = chunk.startSec + seg.end;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (Number.isFinite(totalDuration) && totalDuration > 0) {
        start = Math.min(start, totalDuration);
        end = Math.min(end, totalDuration);
      }
      if (start < prevEnd) start = prevEnd;
      if (end <= start + 0.05) continue;
      segments.push({ start, end, text: seg.text });
      prevEnd = end;
    }
    for (const w of chunk.outcome.words) {
      const start = chunk.startSec + w.start;
      const end = chunk.startSec + w.end;
      if (Number.isFinite(totalDuration) && totalDuration > 0 && (start >= totalDuration || end <= 0)) continue;
      words.push({ word: w.word, start, end: Math.max(end, start) });
    }
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return { segments, words };
}

export function segmentsToCues(segments: WhisperSegment[]): Cue[] {
  return segments.map((s, i) => ({
    index: i + 1,
    timing: formatTiming(Math.round(s.start * 1000), Math.round(s.end * 1000)),
    lines: [s.text],
    position: null,
  }));
}

// ---------------------------------------------------------------------------
// subtitle-grade cue splitting: Whisper segments follow its 30 s decoding
// windows, not subtitle norms (≤ ~7 s, ≤ 2×42 chars), so over-long segments
// are split at sentence punctuation, else at speech pauses, else at midpoint.
// ---------------------------------------------------------------------------

export interface SplitOptions {
  /** maximum cue duration in seconds */
  maxDur?: number;
  /** maximum cue text length in chars (≈ 2 subtitle lines) */
  maxChars?: number;
  /** minimum piece duration in seconds (slivers guard) */
  minDur?: number;
  /** inter-word silence that counts as a pause, seconds */
  gapThreshold?: number;
}

const SENTENCE_END_RE = /[.!?…]["'»)\]]*$/;

function pieceTooLong(piece: WhisperSegment, { maxDur, maxChars }: Required<SplitOptions>): boolean {
  return piece.end - piece.start > maxDur || piece.text.length > maxChars;
}

/**
 * Word entries for a segment's tokens: exact containment first; when that
 * misses (Whisper word ends often overshoot the segment end), overlap-based
 * membership. Empty array = untrusted, callers fall back to proportional time.
 */
function wordsFor(seg: WhisperSegment, words: WhisperWord[]): WhisperWord[] {
  const tokens = seg.text.split(/\s+/).length;
  const strict = words.filter((w) => w.start >= seg.start - 0.01 && w.end <= seg.end + 0.01);
  if (strict.length === tokens) return strict;
  const overlapping = words.filter((w) => w.end > seg.start && w.start < seg.end).sort((a, b) => a.start - b.start);
  return overlapping.length === tokens ? overlapping : [];
}

/**
 * Splits one segment in two at the best boundary: after sentence punctuation
 * beats a speech pause beats the plain midpoint; both pieces must be at least
 * `minDur` long (relaxed to "any boundary" when the segment is short but long
 * in chars). Returns null when the segment cannot be split further.
 */
function splitInTwo(
  seg: WhisperSegment,
  times: { start: number; end: number }[], // per token
  opts: Required<SplitOptions>,
): [WhisperSegment, WhisperSegment] | null {
  const tokens = seg.text.split(/\s+/);
  if (tokens.length < 2) return null;
  const dur = seg.end - seg.start;

  const floor = Math.min(opts.minDur, dur / 4); // short-but-verbose segments still split
  let best: { k: number; rank: number; imbalance: number } | null = null;
  for (let k = 1; k < tokens.length; k++) {
    const leftEnd = times[k - 1].end;
    const rightStart = times[k].start;
    const leftDur = leftEnd - seg.start;
    const rightDur = seg.end - rightStart;
    if (leftDur < floor || rightDur < floor) continue;
    const rank = SENTENCE_END_RE.test(tokens[k - 1]) ? 0 : rightStart - leftEnd >= opts.gapThreshold ? 1 : 2;
    const imbalance = Math.abs(leftDur - rightDur);
    if (!best || rank < best.rank || (rank === best.rank && imbalance < best.imbalance)) {
      best = { k, rank, imbalance };
    }
  }
  if (!best) return null;

  const mk = (from: number, to: number, start: number, end: number): WhisperSegment => ({
    start,
    end,
    text: tokens.slice(from, to).join(' '),
  });
  return [mk(0, best.k, seg.start, times[best.k - 1].end), mk(best.k, tokens.length, times[best.k].start, seg.end)];
}

export function splitSegmentsForSubtitles(
  segments: WhisperSegment[],
  words: WhisperWord[],
  { maxDur = 7.5, maxChars = 84, minDur = 1, gapThreshold = 0.4 }: SplitOptions = {},
): WhisperSegment[] {
  const opts: Required<SplitOptions> = { maxDur, maxChars, minDur, gapThreshold };
  const result: WhisperSegment[] = [];
  for (const seg of segments) {
    // token times: 1:1 from word timestamps when counts line up, else uniform
    let queue: WhisperSegment[] = [seg];
    while (queue.length) {
      const cur = queue.shift()!;
      if (!pieceTooLong(cur, opts)) {
        result.push(clampDegenerate(trimToWords(cur, words), words));
        continue;
      }
      const tokens = cur.text.split(/\s+/);
      const aligned = wordsFor(cur, words);
      let times: { start: number; end: number }[];
      if (aligned.length) {
        times = aligned;
      } else {
        const dur = cur.end - cur.start;
        times = tokens.map((_, i) => ({
          start: cur.start + (dur * i) / tokens.length,
          end: cur.start + (dur * (i + 1)) / tokens.length,
        }));
      }
      const parts = splitInTwo(cur, times, opts);
      if (!parts) {
        result.push(clampDegenerate(trimToWords(cur, words), words)); // single word or no legal boundary
        continue;
      }
      queue = [...parts, ...queue];
    }
  }
  return result;
}

/**
 * Hallucinated segments over music get degenerate word timings too — a single
 * "word" spanning tens of seconds. No real word lasts that long, so such cues
 * are squeezed down to a sane display window (text kept: it might be real
 * voice-over, just badly timed).
 */
function clampDegenerate(seg: WhisperSegment, words: WhisperWord[]): WhisperSegment {
  const inRange = wordsFor(seg, words);
  if (!inRange.length) return seg;
  if (!inRange.some((w) => w.end - w.start > 4)) return seg;
  const floor = Math.max(3, seg.text.length / 3);
  if (seg.end - seg.start <= floor) return seg;
  return { ...seg, end: seg.start + floor };
}

/**
 * Sparse segments (a couple of words over music/silence — Whisper likes to
 * span whole 30 s decode windows) get their bounds tightened to the actual
 * word span plus a little reading padding. Word-aligned only: without trusted
 * times there is nothing to trim to.
 */
function trimToWords(seg: WhisperSegment, words: WhisperWord[]): WhisperSegment {
  const inRange = wordsFor(seg, words);
  if (!inRange.length) return seg;
  const first = inRange[0].start;
  const last = inRange[inRange.length - 1].end;
  if (seg.end - seg.start - (last - first) <= 2) return seg; // dense speech, nothing to trim
  return {
    ...seg,
    start: Math.max(seg.start, first - 0.3),
    end: Math.min(seg.end, last + 0.5),
  };
}

// ---------------------------------------------------------------------------
// orchestration: plan → slice → transcribe (cached per chunk) → merge → srt
// ---------------------------------------------------------------------------

interface SttPlan {
  duration: number;
  boundaries: [number, number][];
}

interface ChunkCache {
  outcome: TranscribeOutcome;
}

function fmtClock(sec: number): string {
  const total = Math.round(sec);
  const s = String(total % 60).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function loadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadPlan(file: string, duration: number): SttPlan | null {
  const raw = loadJson(file) as SttPlan | null;
  if (
    !raw ||
    !Number.isFinite(raw.duration) ||
    Math.abs(raw.duration - duration) >= 1 ||
    !Array.isArray(raw.boundaries) ||
    !raw.boundaries.length ||
    !raw.boundaries.every(
      (b) =>
        Array.isArray(b) &&
        b.length === 2 &&
        Number.isFinite(b[0]) &&
        Number.isFinite(b[1]) &&
        b[1] > b[0],
    )
  ) {
    return null;
  }
  return raw;
}

function loadChunkCache(file: string, start: number, end: number, model: string): ChunkCache | null {
  const raw = loadJson(file) as {
    start?: unknown;
    end?: unknown;
    model?: unknown;
    language?: unknown;
    duration?: unknown;
    segments?: unknown;
    words?: unknown;
  } | null;
  if (!raw) return null;
  if (Math.abs(Number(raw.start) - start) > 0.01 || Math.abs(Number(raw.end) - end) > 0.01) return null;
  if (raw.model !== model) return null;
  const segments = sanitizeSegments(raw.segments);
  return {
    outcome: {
      segments,
      words: sanitizeWords(raw.words),
      language: typeof raw.language === 'string' && raw.language ? raw.language : null,
      duration: Number.isFinite(Number(raw.duration)) && Number(raw.duration) > 0 ? Number(raw.duration) : null,
    },
  };
}

export interface SttStageOptions {
  videoPath: string;
  track: number;
  config: SttConfig & { apiKey: string; model: string };
  /** transcribe only the first N chunks (trials/smoke tests) */
  limit?: number;
  quiet?: boolean;
  onRetry?: (info: RetryInfo) => void;
}

export interface SttStageResult {
  srtPath: string;
  segments: number;
  audioSec: number;
  language: string | null;
  chunksTotal: number;
  chunksDone: number;
}

const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_DUR = 0.6;
const CHUNK_MAX_SEC = 600;
const CHUNK_MIN_SEC = 90;

export async function transcribeAudioTrack({
  videoPath,
  track,
  config,
  limit,
  quiet,
  onRetry,
}: SttStageOptions): Promise<SttStageResult> {
  const base = audioBasePath(videoPath, track);
  const srtPath = `${base}.srt`;
  const dir = `${base}.stt`;
  mkdirSync(dir, { recursive: true });
  const log = (msg: string): void => {
    if (!quiet) console.error(msg);
  };

  const duration = probeDuration(videoPath);
  const planFile = path.join(dir, 'plan.json');
  let plan = loadPlan(planFile, duration);
  if (plan) {
    log(`STT: план из кэша — ${plan.boundaries.length} чанков (${fmtClock(duration)} аудио)`);
  } else {
    log(`STT: анализ тишины ${path.basename(videoPath)}…`);
    plan = {
      duration,
      boundaries: computeChunkBoundaries(
        parseSilences(detectSilences(videoPath, track, { noiseDb: SILENCE_NOISE_DB, minDur: SILENCE_MIN_DUR })),
        duration,
        { maxLen: CHUNK_MAX_SEC, minLen: CHUNK_MIN_SEC },
      ),
    };
    writeFileSync(planFile, JSON.stringify(plan));
  }
  const boundaries = plan.boundaries;
  const total = boundaries.length;
  const selected = limit !== undefined ? boundaries.slice(0, limit) : boundaries;

  const client = createSttClient(config);
  const results: SegChunk[] = [];
  let language: string | null = null;
  const startedAt = Date.now();
  let done = 0;
  let audioSec = 0;
  let progressLen = 0;

  const clearProgress = (): void => {
    if (progressLen > 0) {
      process.stderr.write('\r' + ' '.repeat(progressLen) + '\r');
      progressLen = 0;
    }
  };
  const paint = (): void => {
    if (quiet || !process.stderr.isTTY) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = done > 0 ? (elapsed / done) * (selected.length - done) : NaN;
    const line =
      `STT ${done}/${selected.length} · ${fmtClock(audioSec)} аудио · прошло ${fmtClock(elapsed)}` +
      (Number.isFinite(eta) ? ` · ~${fmtClock(eta)} осталось` : '');
    progressLen = line.length + 4;
    process.stderr.write(`\r${line}    `);
  };

  try {
    for (let i = 0; i < selected.length; i++) {
      const [start, end] = selected[i];
      const nnn = String(i).padStart(3, '0');
      const cached = loadChunkCache(path.join(dir, `${nnn}.json`), start, end, config.model);
      if (cached) {
        results.push({ startSec: start, outcome: cached.outcome });
        language ||= cached.outcome.language;
        done += 1;
        audioSec += end - start;
        paint();
        continue;
      }
      clearProgress();
      log(`STT: чанк ${i + 1}/${selected.length} (${fmtClock(start)}–${fmtClock(end)}) — транскрибация…`);
      const flac = path.join(dir, `${nnn}.flac`);
      sliceAudioChunk(videoPath, track, start, end - start, flac);
      const outcome = await transcribeChunk(client, {
        model: config.model,
        data: readFileSync(flac),
        filename: `${nnn}.flac`,
        language: config.language,
        fallbackDuration: end - start,
        onRetry,
      });
      writeFileSync(
        path.join(dir, `${nnn}.json`),
        JSON.stringify({
          start,
          end,
          model: config.model,
          language: outcome.language,
          duration: outcome.duration,
          segments: outcome.segments,
          words: outcome.words,
          at: new Date().toISOString(),
        }),
      );
      results.push({ startSec: start, outcome });
      language ||= outcome.language;
      done += 1;
      audioSec += end - start;
      paint();
    }
  } finally {
    clearProgress();
  }

  const merged = mergeSegmentChunks(results, duration);
  const rawCount = merged.segments.length;
  const segments = splitSegmentsForSubtitles(merged.segments, merged.words);
  if (segments.length > rawCount) {
    log(`STT: длинные сегменты разбиты: ${rawCount} → ${segments.length} реплик`);
  }
  writeFileSync(srtPath, serialize(segmentsToCues(segments)), 'utf8');

  if (selected.length < total) {
    log(`⚠ транскрибированы первые ${selected.length} из ${total} чанков (--stt-limit) — SRT неполный`);
  }
  log(
    `STT готов: ${srtPath} · ${segments.length} реплик из ${fmtClock(audioSec)} аудио` +
      (language ? ` · язык: ${language}` : ''),
  );
  return { srtPath, segments: segments.length, audioSec, language, chunksTotal: total, chunksDone: done };
}
