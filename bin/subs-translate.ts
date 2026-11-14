#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { parse, serialize } from '../src/srt.ts';
import { cleanCues } from '../src/clean.ts';
import { defaultOutputPath, discoverAbout, resolveConfig, workDir } from '../src/config.ts';
import { buildSystem, buildUser } from '../src/prompt.ts';
import { createClient, translateCue } from '../src/translate.ts';
import type { RetryInfo } from '../src/translate.ts';
import { createPool, loadEndpoints } from '../src/endpoints.ts';
import { ProgressStore, assemble, sidecarPath } from '../src/progress.ts';
import { createContext, pendingCues, runTranslation } from '../src/run.ts';
import { extractSubtitle, extractedPath, formatAudioTrackList, formatTrackList, listAudioStreams, listSubtitleStreams } from '../src/video.ts';
import type { AudioStream, SubStream } from '../src/video.ts';
import { assertSttConfig, resolveSttConfig, transcribeAudioTrack } from '../src/stt.ts';
import type { Pool } from '../src/types.ts';
import { displayPath, formatCommand, programWords, quoteArg } from '../src/launch.ts';

const USAGE = `subs-translate — переводит .srt реплика за репликой, с контекстом и синопсисом

Использование:
  subs-translate <input.srt | video> [options]

Опции:
  -o, --out <path>            выходной файл (по умолчанию <input>.ru.srt)
      --about <text>          синопсис текстом
      --about-file <path>     синопсис из файла (по умолчанию <input>.about.md, если есть)
      --sub-track <n>         извлечь встроенную дорожку субтитров <n> из видео и переводить её
      --audio-track <n>       транскрибировать аудиодорожку <n> через Whisper и переводить её
                              (STT_MODEL + STT_API_KEY/GROQ_API_TOKEN в .env)
      --stt-model <id>        модель STT (env STT_MODEL; обязателен для --audio-track)
      --stt-base-url <url>    OpenAI-совместимый STT endpoint (env STT_BASE_URL; по умолчанию Groq)
      --stt-api-key <key>     ключ STT (env STT_API_KEY || GROQ_API_TOKEN)
      --stt-lang <iso>        язык речи, ISO-639-1 (необязательно, улучшает точность)
      --stt-limit <n>         транскрибировать только первые n чанков (пробный прогон)
      --from <lang>           исходный язык (по умолчанию: авто)
      --to <lang>             язык перевода (по умолчанию: Russian)
      --context-before <n>    сколько предыдущих реплик давать как перевод (3)
      --context-after <n>     сколько следующих реплик давать как оригинал (3)
      --concurrency <n>       параллельных вызова (1; >1 слегка ослабляет контекст)
      --max-line-len <n>      максимальная длина строки (42)
      --model <id>            модель (z-ai/glm-5.3-flash)
      --base-url <url>        endpoint (https://api.paretoinference.com/v1)
      --api-key <key>         ключ (env OPENAI_API_KEY)
      --endpoints <file>      JSON-список endpoint'ов, round-robin (см. endpoints.example.json)
      --range <A-B>           диапазон номеров реплик, включительно
      --limit <n>             только первые n реплик диапазона (с --resume — первые n непереведённых)
      --delay <ms>            пауза между вызовами (0)
      --price-in <usd>        цена 1M input-токенов, для оценки стоимости
      --price-out <usd>       цена 1M output-токенов
      --resume                переиспользовать готовые записи из sidecar-файла
      --dry-run               показать промпт первой реплики и выйти, без вызовов
  -q, --quiet                 без прогресса на stderr

Перед переводом вход чистится: удаляются SDH-реплики «(...)»/«[...]»
и сливаются идущие подряд одинаковые реплики. Номера реплик сохраняются,
поэтому --range работает по нумерации исходного файла.`;

function die(message: string, code = 2): never {
  console.error(`subs-translate: ${message}`);
  process.exit(code);
}

function intOption(
  values: Record<string, string | boolean | undefined>,
  name: string,
  { min = 0 }: { min?: number } = {},
): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    die(`--${name} expects an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function floatOption(values: Record<string, string | boolean | undefined>, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    die(`--${name} expects a number >= 0, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function parseRange(raw: string | undefined): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(raw ?? '');
  if (!m) die(`--range expects A-B, got ${JSON.stringify(raw)}`);
  return [Number(m[1]), Number(m[2])];
}

function costLine(tokens: { in: number; out: number }, priceIn: number | undefined, priceOut: number | undefined): string {
  if (priceIn === undefined && priceOut === undefined) return '';
  const usd = (tokens.in / 1e6) * (priceIn ?? 0) + (tokens.out / 1e6) * (priceOut ?? 0);
  return ` · $${usd.toFixed(2)}`;
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        about: { type: 'string' },
        'about-file': { type: 'string' },
        'sub-track': { type: 'string' },
        'audio-track': { type: 'string' },
        'stt-model': { type: 'string' },
        'stt-base-url': { type: 'string' },
        'stt-api-key': { type: 'string' },
        'stt-lang': { type: 'string' },
        'stt-limit': { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        'context-before': { type: 'string' },
        'context-after': { type: 'string' },
        concurrency: { type: 'string' },
        'max-line-len': { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'api-key': { type: 'string' },
        endpoints: { type: 'string' },
        range: { type: 'string' },
        limit: { type: 'string' },
        delay: { type: 'string' },
        'price-in': { type: 'string' },
        'price-out': { type: 'string' },
        resume: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
      },
    });
  } catch (err) {
    die(`${(err as Error).message}\n\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const parsed = parseCliArgs();
  const values = parsed.values;
  if (parsed.positionals.length !== 1) {
    die(`expected exactly one input file: an .srt or a video\n\n${USAGE}`);
  }

  const inputPath = path.resolve(parsed.positionals[0]);
  if (!existsSync(inputPath)) die(`input file not found: ${inputPath}`);
  const subTrack = intOption(values, 'sub-track');
  const audioTrack = intOption(values, 'audio-track');
  const sttLimit = intOption(values, 'stt-limit', { min: 1 });
  const quiet = values.quiet;

  const inputIsSrt = /\.srt$/i.test(inputPath);
  if (inputIsSrt) {
    if (subTrack !== undefined) die('--sub-track применяется к видеофайлам; вход .srt уже является субтитрами');
    if (audioTrack !== undefined) die('--audio-track применяется к видеофайлам; вход .srt уже является субтитрами');
  }
  if (subTrack !== undefined && audioTrack !== undefined) {
    die('--sub-track и --audio-track взаимоисключающие — выберите одну дорожку');
  }

  let effectiveInput = inputPath;
  if (!inputIsSrt && subTrack !== undefined) {
    let streams: SubStream[];
    try {
      streams = listSubtitleStreams(inputPath);
    } catch (err) {
      die(`${(err as Error).message} — ожидался .srt или видеофайл со встроенными субтитрами`);
    }
    if (!streams.length) die(`нет встроенных субтитровых дорожек: ${path.basename(inputPath)}`);

    const stream = streams.find((s) => s.track === subTrack);
    if (!stream) die(`--sub-track ${subTrack} вне диапазона: доступные дорожки — 0..${streams.length - 1}`);
    if (stream.isBitmap) {
      die(`--sub-track ${subTrack}: растровая дорожка (${stream.codecName}) не извлекается в текст`);
    }
    let data: Uint8Array;
    try {
      data = extractSubtitle(inputPath, stream.track);
    } catch (err) {
      die((err as Error).message);
    }
    const extracted = extractedPath(inputPath, stream.track, stream.language);
    try {
      mkdirSync(path.dirname(extracted), { recursive: true });
      writeFileSync(extracted, data);
    } catch (err) {
      die(`cannot write ${extracted}: ${(err as Error).message}`);
    }
    console.error(`Субтитры извлечены: ${extracted} (${parse(data).cues.length} реплик)`);
    effectiveInput = extracted;
  } else if (!inputIsSrt && audioTrack !== undefined) {
    let streams: AudioStream[];
    try {
      streams = listAudioStreams(inputPath);
    } catch (err) {
      die(`${(err as Error).message} — ожидался .srt или видеофайл со звуковой дорожкой`);
    }
    if (!streams.length) die(`нет аудиодорожек: ${path.basename(inputPath)}`);
    if (!streams.some((s) => s.track === audioTrack)) {
      die(`--audio-track ${audioTrack} вне диапазона: доступные дорожки — 0..${streams.length - 1}`);
    }

    const onSttRetry = ({ attempt, delay, err }: RetryInfo): void => {
      if (quiet) return;
      console.error(`повтор STT ${attempt}/5 через ${Math.round(delay / 1000)} с (${String((err as Error)?.message ?? err)})`);
    };
    try {
      const sttConfig = resolveSttConfig({
        apiKey: values['stt-api-key'],
        baseUrl: values['stt-base-url'],
        model: values['stt-model'],
        language: values['stt-lang'],
      });
      assertSttConfig(sttConfig);
      const stt = await transcribeAudioTrack({
        videoPath: inputPath,
        track: audioTrack,
        config: sttConfig,
        limit: sttLimit,
        quiet,
        onRetry: onSttRetry,
      });
      effectiveInput = stt.srtPath;
    } catch (err) {
      die((err as Error).message);
    }
  } else if (!inputIsSrt) {
    let subStreams: SubStream[] = [];
    try {
      subStreams = listSubtitleStreams(inputPath);
    } catch {
      // ffprobe failures are reported by the audio probe below
    }
    let audioStreams: AudioStream[];
    try {
      audioStreams = listAudioStreams(inputPath);
    } catch (err) {
      die(`${(err as Error).message} — ожидался .srt или видеофайл`);
    }
    if (!subStreams.length && !audioStreams.length) {
      die(`нет ни субтитровых, ни аудиодорожек: ${path.basename(inputPath)}`);
    }
    if (subStreams.length) {
      console.log(`Встроенные субтитры в ${path.basename(inputPath)}:`);
      for (const line of formatTrackList(subStreams)) console.log(`  ${line}`);
    } else {
      console.log(`Встроенных субтитров нет: ${path.basename(inputPath)}`);
    }
    console.log(`\nАудиодорожки в ${path.basename(inputPath)}:`);
    for (const line of formatAudioTrackList(audioStreams)) console.log(`  ${line}`);
    const cmd = [...programWords(), displayPath(inputPath)].map(quoteArg).join(' ');
    console.log(`\nПеревести дорожку субтитров: ${cmd} --sub-track <номер>`);
    console.log(
      `Транскрибировать речь:      ${cmd} --audio-track <номер>` +
        `  (нужны STT_MODEL и STT_API_KEY/GROQ_API_TOKEN в .env)`,
    );
    return 0;
  }

  if (effectiveInput !== inputPath && !quiet) {
    console.error(`Рабочие файлы: ${workDir(inputPath)}`);
  }
  // извлечённый/распознанный вход лежит во временной папке — перевод кладём рядом с видео
  const outPath = path.resolve(
    values.out ?? path.join(path.dirname(inputPath), path.basename(defaultOutputPath(effectiveInput))),
  );
  if (outPath === inputPath || outPath === effectiveInput) {
    die('refusing to overwrite the input file: use -o <path>');
  }

  const contextBefore = intOption(values, 'context-before') ?? 3;
  const contextAfter = intOption(values, 'context-after') ?? 3;
  const concurrency = intOption(values, 'concurrency', { min: 1 }) ?? 1;
  const maxLineLen = intOption(values, 'max-line-len', { min: 10 }) ?? 42;
  const limit = intOption(values, 'limit', { min: 1 });
  const delayMs = intOption(values, 'delay') ?? 0;
  const priceIn = floatOption(values, 'price-in');
  const priceOut = floatOption(values, 'price-out');

  const config = resolveConfig({
    apiKey: values['api-key'],
    baseUrl: values['base-url'],
    model: values.model,
  });

  let pool: Pool | null = null;
  if (values.endpoints !== undefined) {
    try {
      pool = createPool(loadEndpoints(values.endpoints));
    } catch (err) {
      die((err as Error).message);
    }
    if (values['api-key'] !== undefined || values['base-url'] !== undefined || values.model !== undefined) {
      console.error('subs-translate: --endpoints задан — --model/--base-url/--api-key игнорируются');
    }
  }

  const rawCues = parse(readFileSync(effectiveInput)).cues;
  const { cues, stats: cleaned } = cleanCues(rawCues);
  if (!cues.length) die('no subtitle cues found in the input');
  if (!quiet && (cleaned.sdhCues || cleaned.sdhLines || cleaned.merged)) {
    const parts: string[] = [];
    if (cleaned.sdhCues) parts.push(`−${cleaned.sdhCues} SDH-реплик`);
    if (cleaned.sdhLines) parts.push(`−${cleaned.sdhLines} SDH-строк`);
    if (cleaned.merged) parts.push(`слито ${cleaned.merged} дубликатов`);
    console.error(`Чистка: ${parts.join(', ')} (${rawCues.length} → ${cues.length} реплик)`);
  }

  const sidecar = sidecarPath(outPath);
  const store = new ProgressStore(sidecar);
  if (values.resume) store.load();

  let selected = cues;
  if (values.range !== undefined) {
    const [a, b] = parseRange(values.range);
    selected = selected.filter((c) => c.index >= Math.min(a, b) && c.index <= Math.max(a, b));
  }
  if (limit !== undefined) {
    // with --resume, --limit counts untranslated cues: "next N new ones", not "first N overall"
    const pool = values.resume ? pendingCues(selected, store.map) : selected;
    if (values.resume && !pool.length && selected.length) {
      die('все реплики диапазона уже переведены — нужен другой --range, или уберите --limit');
    }
    selected = pool.slice(0, limit);
  }
  if (!selected.length) die('no cues fall into the requested range');

  let about: string | null = null;
  try {
    about = discoverAbout(effectiveInput, { about: values.about, aboutFile: values['about-file'] });
    if (about === null && effectiveInput !== inputPath) {
      // для извлечённого входа подхватываем about-файл, лежащий рядом с видео
      about = discoverAbout(inputPath, { about: values.about, aboutFile: values['about-file'] });
    }
  } catch (err) {
    die((err as Error).message);
  }

  const system = buildSystem({
    target: values.to ?? 'Russian',
    source: values.from ?? 'auto',
    maxLineLen,
    about,
  });

  if (values['dry-run']) {
    const ctx = createContext(cues, { contextBefore, contextAfter });
    const cue = selected[0];
    if (pool) {
      console.log(`=== ENDPOINTS (${pool.aliveCount()} alive) ===`);
      for (const e of pool.endpoints) {
        console.log(`- ${e.name} · ${e.model} · ${e.baseUrl}${e.dead ? ' · DEAD' : ''}`);
      }
      console.log('');
    }
    console.log('=== SYSTEM ===');
    console.log(system);
    console.log('\n=== USER ===');
    console.log(
      buildUser({
        cue,
        prev: ctx.prev(cue.index, store.map),
        next: ctx.next(cue.index),
      }),
    );
    return 0;
  }

  if (!pool && !config.apiKey) {
    die('no API key: put OPENAI_API_KEY=... into .env (see .env.example) or pass --api-key', 1);
  }
  const client = pool ?? createClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  const total = selected.length;
  const startedAt = Date.now();
  const live = { processed: 0, tokens: { in: 0, out: 0 } };
  let lastPaint = 0;
  let progressLen = 0;

  const paint = (force = false): void => {
    if (quiet || !process.stderr.isTTY) return;
    const now = Date.now();
    if (!force && now - lastPaint < 250) return;
    lastPaint = now;
    const elapsed = now - startedAt;
    const eta = live.processed > 0 ? (elapsed / live.processed) * (total - live.processed) : NaN;
    const line =
      `${live.processed}/${total} · ${Math.floor((live.processed / total) * 100)}% · ${fmtDuration(elapsed)} elapsed` +
      (Number.isFinite(eta) ? ` · ~${fmtDuration(eta)} left` : '') +
      ` · ${fmtTokens(live.tokens.in)} in / ${fmtTokens(live.tokens.out)} out` +
      costLine(live.tokens, priceIn, priceOut);
    progressLen = line.length + 4;
    process.stderr.write(`\r${line}    `);
  };

  const clearProgress = (): void => {
    if (progressLen > 0) {
      process.stderr.write('\r' + ' '.repeat(progressLen) + '\r');
      progressLen = 0;
    }
  };

  const noteRetry = ({ attempt, delay, err, endpoint }: RetryInfo): void => {
    if (quiet) return;
    const e = err as { status?: unknown; code?: unknown };
    const why = e?.status !== undefined ? `HTTP ${String(e.status)}` : String(e?.code ?? 'network error');
    clearProgress();
    console.error(`повтор ${attempt}/5 через ${Math.round(delay / 1000)} с (${why}${endpoint ? `, ${endpoint}` : ''})`);
    paint(true);
  };

  const warnEndpoint = (message: string): void => {
    if (quiet) return;
    clearProgress();
    console.error(`⚠ ${message}`);
    paint(true);
  };

  const translate = async ({ user, source }: { user: string; source: string }) =>
    translateCue(client, {
      model: config.model,
      system,
      user,
      source,
      onRetry: noteRetry,
      onWarn: warnEndpoint,
    });

  const resumeHint = (): void => {
    console.error(`Прогресс сохранён в ${sidecar}`);
    const argv = [displayPath(inputPath)];
    if (subTrack !== undefined) argv.push('--sub-track', String(subTrack));
    else if (audioTrack !== undefined) argv.push('--audio-track', String(audioTrack));
    argv.push('--resume');
    if (values.range !== undefined) argv.push('--range', values.range);
    if (values.out !== undefined) argv.push('-o', values.out);
    console.error(`Продолжить: ${formatCommand(argv)}`);
  };
  const onInterrupt = (signal: string): void => {
    store.close();
    console.error(`\nПрервано (${signal}) после ${live.processed}/${total} реплик`);
    resumeHint();
    process.exit(130);
  };
  process.on('SIGINT', () => onInterrupt('SIGINT'));
  process.on('SIGTERM', () => onInterrupt('SIGTERM'));

  let result;
  try {
    result = await runTranslation(selected, {
      cues,
      store,
      model: config.model,
      translate,
      resume: values.resume,
      concurrency,
      contextBefore,
      contextAfter,
      delayMs,
      onProgress: ({ processed, tokens }) => {
        live.processed = processed;
        live.tokens = tokens;
        paint();
      },
    });
  } catch (err) {
    store.close();
    paint(true);
    clearProgress();
    const e = err as Error & { cueIndex?: number };
    console.error(`\nОшибка на реплике [${e.cueIndex ?? '?'}]: ${e.message}`);
    resumeHint();
    return 1;
  }

  store.close();
  paint(true);
  clearProgress();

  writeFileSync(outPath, serialize(assemble(cues, store.map, { maxLen: maxLineLen })), 'utf8');

  console.error(
    `Готово: ${result.processed}/${result.total} реплик` +
      ` · ${fmtTokens(result.tokens.in)} in / ${fmtTokens(result.tokens.out)} out` +
      `${costLine(result.tokens, priceIn, priceOut)}` +
      ` · ${fmtDuration(Date.now() - startedAt)} · ${path.relative(process.cwd(), outPath) || outPath}`,
  );
  if (result.perEndpoint.size > 1) {
    for (const [name, s] of result.perEndpoint) {
      console.error(
        `  ${name} · ${s.model}: ${s.cues} реплик · ${fmtTokens(s.in)} in / ${fmtTokens(s.out)} out`,
      );
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`subs-translate: ${(err as Error)?.stack ?? err}`);
    process.exit(1);
  });
