#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { parse, serialize } from '../src/srt.js';
import { defaultOutputPath, discoverAbout, resolveConfig } from '../src/config.js';
import { buildSystem, buildUser } from '../src/prompt.js';
import { createClient, translateCue } from '../src/translate.js';
import { createPool, loadEndpoints } from '../src/endpoints.js';
import { ProgressStore, assemble, sidecarPath } from '../src/progress.js';
import { createContext, pendingCues, runTranslation } from '../src/run.js';

const USAGE = `subs-translate — переводит .srt реплика за репликой, с контекстом и синопсисом

Использование:
  subs-translate <input.srt> [options]

Опции:
  -o, --out <path>            выходной файл (по умолчанию <input>.ru.srt)
      --about <text>          синопсис текстом
      --about-file <path>     синопсис из файла (по умолчанию <input>.about.md, если есть)
      --from <lang>           исходный язык (по умолчанию: авто)
      --to <lang>             язык перевода (по умолчанию: Russian)
      --context-before <n>    сколько предыдущих реплик давать как перевод (3)
      --context-after <n>     сколько следующих реплик давать как оригинал (3)
      --concurrency <n>       параллельных вызова (1; >1 слегка ослабляет контекст)
      --max-line-len <n>      максимальная длина строки (42)
      --model <id>            модель (z-ai/glm-5.3-flash)
      --base-url <url>        endpoint (https://api.paretoinference.com/v1)
      --api-key <key>         ключ (env PARETO_API_KEY || OPENAI_API_KEY)
      --endpoints <file>      JSON-список endpoint'ов, round-robin (см. endpoints.example.json)
      --range <A-B>           диапазон номеров реплик, включительно
      --limit <n>             только первые n реплик диапазона (с --resume — первые n непереведённых)
      --delay <ms>            пауза между вызовами (0)
      --price-in <usd>        цена 1M input-токенов, для оценки стоимости
      --price-out <usd>       цена 1M output-токенов
      --resume                переиспользовать готовые записи из sidecar-файла
      --dry-run               показать промпт первой реплики и выйти, без вызовов
  -q, --quiet                 без прогресса на stderr`;

function die(message, code = 2) {
  console.error(`subs-translate: ${message}`);
  process.exit(code);
}

function intOption(values, name, { min = 0 } = {}) {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    die(`--${name} expects an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function floatOption(values, name) {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    die(`--${name} expects a number >= 0, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function fmtDuration(ms) {
  const total = Math.floor(ms / 1000);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function parseRange(raw) {
  const m = /^(\d+)-(\d+)$/.exec(raw ?? '');
  if (!m) die(`--range expects A-B, got ${JSON.stringify(raw)}`);
  return [Number(m[1]), Number(m[2])];
}

function costLine(tokens, priceIn, priceOut) {
  if (priceIn === undefined && priceOut === undefined) return '';
  const usd = (tokens.in / 1e6) * (priceIn ?? 0) + (tokens.out / 1e6) * (priceOut ?? 0);
  return ` · $${usd.toFixed(2)}`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        about: { type: 'string' },
        'about-file': { type: 'string' },
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
    die(`${err.message}\n\n${USAGE}`);
  }
  const values = parsed.values;
  if (parsed.positionals.length !== 1) {
    die(`expected exactly one input .srt file\n\n${USAGE}`);
  }

  const inputPath = path.resolve(parsed.positionals[0]);
  if (!existsSync(inputPath)) die(`input file not found: ${inputPath}`);
  const outPath = path.resolve(values.out ?? defaultOutputPath(inputPath));
  if (outPath === inputPath) die('refusing to overwrite the input file: use -o <path>');

  const contextBefore = intOption(values, 'context-before') ?? 3;
  const contextAfter = intOption(values, 'context-after') ?? 3;
  const concurrency = intOption(values, 'concurrency', { min: 1 }) ?? 1;
  const maxLineLen = intOption(values, 'max-line-len', { min: 10 }) ?? 42;
  const limit = intOption(values, 'limit', { min: 1 });
  const delayMs = intOption(values, 'delay') ?? 0;
  const priceIn = floatOption(values, 'price-in');
  const priceOut = floatOption(values, 'price-out');
  const quiet = values.quiet;

  const config = resolveConfig({
    apiKey: values['api-key'],
    baseUrl: values['base-url'],
    model: values.model,
  });

  let pool = null;
  if (values.endpoints !== undefined) {
    try {
      pool = createPool(loadEndpoints(values.endpoints));
    } catch (err) {
      die(err.message);
    }
    if (values['api-key'] !== undefined || values['base-url'] !== undefined || values.model !== undefined) {
      console.error('subs-translate: --endpoints задан — --model/--base-url/--api-key игнорируются');
    }
  }

  const { cues } = parse(readFileSync(inputPath));
  if (!cues.length) die('no subtitle cues found in the input');

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

  let about = null;
  try {
    about = discoverAbout(inputPath, { about: values.about, aboutFile: values['about-file'] });
  } catch (err) {
    die(err.message);
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
    die('no API key: put PARETO_API_KEY=... into .env (see .env.example) or pass --api-key', 1);
  }
  const client = pool ?? createClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  const total = selected.length;
  const startedAt = Date.now();
  const live = { processed: 0, tokens: { in: 0, out: 0 } };
  let lastPaint = 0;
  let progressLen = 0;

  const paint = (force = false) => {
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

  const clearProgress = () => {
    if (progressLen > 0) {
      process.stderr.write('\r' + ' '.repeat(progressLen) + '\r');
      progressLen = 0;
    }
  };

  const noteRetry = ({ attempt, delay, err, endpoint }) => {
    if (quiet) return;
    const why = err?.status !== undefined ? `HTTP ${err.status}` : (err?.code ?? 'network error');
    clearProgress();
    console.error(`повтор ${attempt}/5 через ${Math.round(delay / 1000)} с (${why}${endpoint ? `, ${endpoint}` : ''})`);
    paint(true);
  };

  const warnEndpoint = (message) => {
    if (quiet) return;
    clearProgress();
    console.error(`⚠ ${message}`);
    paint(true);
  };

  const translate = async ({ user, source }) =>
    translateCue(client, {
      model: config.model,
      system,
      user,
      source,
      onRetry: noteRetry,
      onWarn: warnEndpoint,
    });

  const resumeHint = () => {
    console.error(`Прогресс сохранён в ${sidecar}`);
    const rangePart = values.range !== undefined ? ` --range ${values.range}` : '';
    console.error(
      `Продолжить: subs-translate ${path.relative(process.cwd(), inputPath) || inputPath} --resume${rangePart}`,
    );
  };
  const onInterrupt = (signal) => {
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
    console.error(`\nОшибка на реплике [${err.cueIndex ?? '?'}]: ${err.message}`);
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
    console.error(`subs-translate: ${err?.stack ?? err}`);
    process.exit(1);
  });
