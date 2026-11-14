import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { workDir } from './config.ts';

export interface SubStream {
  /** index among subtitle streams, as consumed by `ffmpeg -map 0:s:<n>` */
  track: number;
  codecName: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  /** bitmap formats (PGS, VobSub, DVB) cannot be converted to text */
  isBitmap: boolean;
}

const BITMAP_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'vobsub',
  'dvb_subtitle',
  'dvb_teletext',
]);

// metadata-only language tags are useless in a file name
const JUNK_LANGS = new Set(['und', 'mis', 'mul', 'zxx']);

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

export function parseFfprobeStreams(json: string): SubStream[] {
  let data: { streams?: RawStream[] };
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  if (!Array.isArray(data.streams)) throw new Error('ffprobe returned no streams array');
  const streams: SubStream[] = [];
  for (const s of data.streams) {
    if (s.codec_type !== 'subtitle') continue;
    const codecName = s.codec_name ?? 'unknown';
    streams.push({
      track: streams.length,
      codecName,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      isDefault: s.disposition?.default === 1,
      isForced: s.disposition?.forced === 1,
      isBitmap: BITMAP_CODECS.has(codecName),
    });
  }
  return streams;
}

function runTool(
  tool: 'ffmpeg' | 'ffprobe',
  args: string[],
): { code: number | null; stdout: Uint8Array; stderr: string } {
  const res = spawnSync(tool, args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${tool} not found: install ffmpeg and make sure it is in PATH`);
    }
    throw res.error;
  }
  return {
    code: res.status,
    stdout: res.stdout ?? new Uint8Array(),
    stderr: (res.stderr ?? new Uint8Array()).toString('utf8').trim(),
  };
}

export { runTool };

export function listSubtitleStreams(videoPath: string): SubStream[] {
  const { code, stdout, stderr } = runTool('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    's',
    videoPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe could not read the file (exit ${code}${stderr ? `, ${stderr}` : ''}): ${videoPath}`);
  }
  return parseFfprobeStreams(new TextDecoder().decode(stdout));
}

export function extractSubtitle(videoPath: string, track: number): Uint8Array {
  const { code, stdout, stderr } = runTool('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    videoPath,
    '-map',
    `0:s:${track}`,
    '-f',
    'srt',
    'pipe:1',
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with ${code} while extracting subtitle track ${track}${stderr ? `: ${stderr}` : ''}`);
  }
  if (!stdout.length) {
    throw new Error(`ffmpeg produced no subtitles for track ${track}${stderr ? `: ${stderr}` : ''}`);
  }
  return stdout;
}

export function listAudioStreams(videoPath: string): AudioStream[] {
  const { code, stdout, stderr } = runTool('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    'a',
    videoPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe could not read the file (exit ${code}${stderr ? `, ${stderr}` : ''}): ${videoPath}`);
  }
  return parseFfprobeAudioStreams(new TextDecoder().decode(stdout));
}

/** container/stream duration in seconds; throws when unknowable */
export function probeDuration(mediaPath: string): number {
  const { code, stdout, stderr } = runTool('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_entries',
    'format=duration:stream=duration',
    mediaPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffprobe could not read the file (exit ${code}${stderr ? `, ${stderr}` : ''}): ${mediaPath}`);
  }
  let data: { format?: { duration?: string }; streams?: { duration?: string }[] };
  try {
    data = JSON.parse(new TextDecoder().decode(stdout));
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${mediaPath}`);
  }
  const candidates = [data.format?.duration, ...(data.streams ?? []).map((s) => s.duration)]
    .map((v) => (v ? Number(v) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!candidates.length) throw new Error(`cannot determine media duration: ${mediaPath}`);
  return Math.max(...candidates);
}

/** runs silencedetect over one audio track; stderr lines are parsed by chunk.ts */
export function detectSilences(mediaPath: string, track: number, { noiseDb = -35, minDur = 0.6 } = {}): string {
  const { code, stderr } = runTool('ffmpeg', [
    '-nostdin',
    '-v',
    'info',
    '-i',
    mediaPath,
    '-map',
    `0:a:${track}`,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    '-f',
    'null',
    '-',
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with ${code} while detecting silence in track ${track}${stderr ? `: ${stderr}` : ''}`);
  }
  return stderr;
}

/** cuts one mono 16 kHz FLAC chunk; timestamps inside restart at zero */
export function sliceAudioChunk(
  mediaPath: string,
  track: number,
  startSec: number,
  durationSec: number,
  outPath: string,
): void {
  const { code, stderr } = runTool('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    mediaPath,
    '-map',
    `0:a:${track}`,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'flac',
    outPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with ${code} while slicing track ${track} @${startSec.toFixed(1)}s${stderr ? `: ${stderr}` : ''}`);
  }
}

export function extractedPath(videoPath: string, track: number, language?: string | null): string {
  const base = path.join(workDir(videoPath), path.basename(videoPath, path.extname(videoPath)));
  const lang = language?.trim().toLowerCase() ?? '';
  const tag = lang && !JUNK_LANGS.has(lang) && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(lang) ? `.${lang}` : '';
  return `${base}.track${track}${tag}.srt`;
}

export function formatTrackList(streams: SubStream[]): string[] {
  return streams.map((s) => {
    const parts = [
      String(s.track).padStart(2),
      s.codecName,
      s.language ? `[${s.language}]` : null,
      s.title ?? null,
      s.isDefault ? '(default)' : null,
      s.isForced ? '(forced)' : null,
    ].filter((p): p is string => p !== null);
    return s.isBitmap ? `${parts.join('  ')}  — растровые, в текст не извлекаются` : parts.join('  ');
  });
}

export interface AudioStream {
  /** index among audio streams, as consumed by `ffmpeg -map 0:a:<n>` */
  track: number;
  codecName: string;
  channels: number | null;
  sampleRate: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  /** seconds, from stream or container metadata; null when unknown */
  durationSec: number | null;
}

/** "00:03:04.828000000" → 184.828 */
export function parseClockDuration(raw: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const [, h, min, s] = m;
  return (Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s)) || null;
}

export function parseFfprobeAudioStreams(json: string): AudioStream[] {
  let data: { streams?: RawStream[] };
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  if (!Array.isArray(data.streams)) throw new Error('ffprobe returned no streams array');
  const streams: AudioStream[] = [];
  for (const s of data.streams) {
    if (s.codec_type !== 'audio') continue;
    const sampleRate = s.sample_rate ? Number(s.sample_rate) : null;
    streams.push({
      track: streams.length,
      codecName: s.codec_name ?? 'unknown',
      channels: typeof s.channels === 'number' ? s.channels : null,
      sampleRate: sampleRate && Number.isFinite(sampleRate) ? sampleRate : null,
      language: s.tags?.language ?? s.tags?.LANGUAGE ?? null,
      title: s.tags?.title ?? s.tags?.TITLE ?? null,
      isDefault: s.disposition?.default === 1,
      durationSec:
        (s.duration ? Number(s.duration) : NaN) > 0
          ? Number(s.duration)
          : (s.tags?.DURATION ? parseClockDuration(s.tags.DURATION) : null),
    });
  }
  return streams;
}

function fmtClock(sec: number): string {
  const total = Math.round(sec);
  const s = String(total % 60).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function formatAudioTrackList(streams: AudioStream[]): string[] {
  return streams.map((s) => {
    const parts = [
      String(s.track).padStart(2),
      s.codecName,
      s.channels !== null ? `${s.channels}ch` : null,
      s.sampleRate ? `${Math.round(s.sampleRate / 100) / 10}kHz` : null,
      s.language && !JUNK_LANGS.has(s.language.toLowerCase()) ? `[${s.language}]` : null,
      s.title ?? null,
      s.isDefault ? '(default)' : null,
      s.durationSec ? fmtClock(s.durationSec) : null,
    ].filter((p): p is string => p !== null);
    return parts.join('  ');
  });
}
