import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { confirm, input, number, select } from '@inquirer/prompts';
import { aboutCandidates, videoOutputPath } from './config.ts';
import { displayPath, formatCommand } from './launch.ts';
import { ProgressStore, sidecarPath } from './progress.ts';
import { audioBasePath, resolveSttConfig } from './stt.ts';
import { extractedPath, formatAudioTrackList, formatTrackList, listAudioStreams, listSubtitleStreams } from './video.ts';
import type { AudioStream, SubStream } from './video.ts';

export type CliValues = Record<string, string | boolean | undefined>;

const INPUT_EXTS = new Set(['.srt', '.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v']);
const SHORT_FLAGS: Record<string, string> = { out: '-o', quiet: '-q' };
const ENDPOINTS_FILE = 'endpoints.json';
const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';

/** .srt and video files in `dir`, sorted by name */
export function findInputCandidates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** a path typed or dropped into the terminal: trims spaces and surrounding quotes */
export function cleanPathInput(raw: string): string {
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2');
}

export function toArgv(inputPath: string, values: CliValues): string[] {
  const argv = [inputPath];
  for (const [key, value] of Object.entries(values)) {
    if (key === 'interactive' || value === undefined || value === false) continue;
    const flag = SHORT_FLAGS[key] ?? `--${key}`;
    if (value === true) argv.push(flag);
    else argv.push(flag, value);
  }
  return argv;
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

async function askPath(message: string): Promise<string> {
  const raw = await input({
    message,
    validate: (v) => (isFile(path.resolve(cleanPathInput(v))) ? true : 'файл не найден'),
  });
  return path.resolve(cleanPathInput(raw));
}

async function askInput(): Promise<string> {
  const candidates = findInputCandidates(process.cwd());
  if (!candidates.length) return askPath('Файл субтитров (.srt) или видео:');
  const choice = await select({
    message: 'Что переводим?',
    pageSize: 15,
    choices: [
      ...candidates.map((name) => ({ name, value: name })),
      { name: 'Другой путь…', value: '' },
    ],
  });
  return choice ? path.resolve(choice) : askPath('Путь к файлу:');
}

type Track = { kind: 'sub'; stream: SubStream } | { kind: 'audio'; stream: AudioStream };

async function askTrack(videoPath: string): Promise<Track> {
  let subStreams: SubStream[] = [];
  try {
    subStreams = listSubtitleStreams(videoPath);
  } catch {
    // ffprobe failures are reported by the audio probe below
  }
  let audioStreams: AudioStream[];
  try {
    audioStreams = listAudioStreams(videoPath);
  } catch (err) {
    throw new Error(`${(err as Error).message} — ожидался .srt или видеофайл`);
  }
  if (!subStreams.length && !audioStreams.length) {
    throw new Error(`нет ни субтитровых, ни аудиодорожек: ${path.basename(videoPath)}`);
  }
  const subLines = formatTrackList(subStreams);
  const audioLines = formatAudioTrackList(audioStreams);
  return select<Track>({
    message: `Какую дорожку переводить из ${path.basename(videoPath)}?`,
    pageSize: 15,
    choices: [
      ...subStreams.map((stream, i) => ({
        name: `Субтитры  ${subLines[i]}`,
        value: { kind: 'sub' as const, stream },
        disabled: stream.isBitmap ? '(растровые)' : false,
      })),
      ...audioStreams.map((stream, i) => ({
        name: `Речь → субтитры (Whisper)  ${audioLines[i]}`,
        value: { kind: 'audio' as const, stream },
      })),
    ],
  });
}

/** text typed or pasted into the terminal; ends with Ctrl+D on an empty line or two empty lines in a row */
export function readMultiline(
  message: string,
  { input: stream = process.stdin, output = process.stdout }: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<string> {
  output.write(`${message}\n`);
  const rl = readline.createInterface({ input: stream, output });
  const lines: string[] = [];
  let cancelled = false;
  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length >= 2 && lines.at(-1) === '' && lines.at(-2) === '') rl.close();
    });
    rl.on('SIGINT', () => {
      cancelled = true;
      rl.close();
    });
    rl.on('close', () => {
      // same name as inquirer's Ctrl+C error, so the caller handles both the same way
      if (cancelled) reject(Object.assign(new Error('cancelled'), { name: 'ExitPromptError' }));
      else resolve(lines.join('\n').trim());
    });
  });
}

async function askAbout(inputPath: string, values: CliValues): Promise<void> {
  const candidates = aboutCandidates(inputPath);
  const existing = candidates.find(isFile);
  const found = existing !== undefined;
  const choice = await select({
    message: 'Синопсис и глоссарий (about-файл):',
    choices: [
      ...(existing ? [{ name: `Использовать ${path.basename(existing)}`, value: 'found' }] : []),
      { name: 'Ввести или вставить текст', value: 'text' },
      { name: 'Указать файл…', value: 'file' },
      { name: 'Без синопсиса', value: 'none' },
    ],
  });
  if (choice === 'file') {
    values['about-file'] = displayPath(await askPath('Путь к about-файлу:'));
  } else if (choice === 'none' && found) {
    values.about = '';
  } else if (choice === 'text') {
    const text = await readMultiline(
      'Введите или вставьте синопсис. Конец — две пустые строки подряд или Ctrl+D на пустой строке:',
    );
    if (!text) {
      if (found) values.about = '';
      return;
    }
    // --resume hints do not repeat --about, so a saved file is what keeps the synopsis for later runs
    const save =
      !found &&
      (await confirm({
        message: `Сохранить в ${path.basename(candidates[0])}? (подхватится при следующих запусках)`,
        default: true,
      }));
    if (save) writeFileSync(candidates[0], `${text}\n`, 'utf8');
    else values.about = text;
  }
}

async function askOut(defaultOut: string, forbidden: string[]): Promise<string> {
  const raw = await input({
    message: 'Куда сохранить перевод?',
    default: displayPath(defaultOut),
    validate: (v) =>
      forbidden.includes(path.resolve(cleanPathInput(v))) ? 'нельзя перезаписать входной файл' : true,
  });
  return path.resolve(cleanPathInput(raw));
}

async function askMode(values: CliValues): Promise<void> {
  const mode = await select({
    message: 'Что сделать?',
    choices: [
      { name: 'Перевести весь файл', value: 'all' },
      { name: 'Пробный прогон: первые N реплик', value: 'limit' },
      { name: 'Диапазон реплик A-B', value: 'range' },
      { name: 'Только показать промпт первой реплики (без вызовов API)', value: 'dry-run' },
    ],
  });
  if (mode === 'limit') {
    const n = await number({ message: 'Сколько реплик?', default: 5, min: 1, required: true });
    values.limit = String(n);
  } else if (mode === 'range') {
    const range = await input({
      message: 'Диапазон номеров реплик (например 100-130):',
      validate: (v) => (/^\d+-\d+$/.test(v.trim()) ? true : 'формат A-B, например 100-130'),
    });
    values.range = range.trim();
  } else if (mode === 'dry-run') {
    values['dry-run'] = true;
  }
}

/**
 * Asks for everything not given as a flag and returns the filled flags.
 * Returns null when the user decides not to start.
 */
export async function runWizard<V extends CliValues>({
  input: givenInput,
  values: givenValues,
}: {
  input?: string;
  values: V;
}): Promise<{ input: string; values: V } | null> {
  const values: CliValues = { ...givenValues };
  delete values.interactive;

  const inputPath = givenInput !== undefined ? path.resolve(givenInput) : await askInput();
  if (!isFile(inputPath)) throw new Error(`input file not found: ${inputPath}`);
  const inputIsSrt = /\.srt$/i.test(inputPath);

  let effectiveInput = inputPath;
  if (!inputIsSrt) {
    if (values['sub-track'] === undefined && values['audio-track'] === undefined) {
      const track = await askTrack(inputPath);
      if (track.kind === 'sub') values['sub-track'] = String(track.stream.track);
      else values['audio-track'] = String(track.stream.track);
    }
    if (values['audio-track'] !== undefined) {
      const track = Number(values['audio-track']);
      effectiveInput = `${audioBasePath(inputPath, track)}.srt`;
      const stt = resolveSttConfig({
        model: values['stt-model'] as string | undefined,
        language: values['stt-lang'] as string | undefined,
      });
      if (!stt.model) {
        values['stt-model'] = await input({ message: 'Модель STT (STT_MODEL не задан):', default: DEFAULT_STT_MODEL });
      }
      if (values['stt-lang'] === undefined) {
        const lang = await input({
          message: 'Язык речи, ISO-639-1 (пусто — автоопределение):',
          validate: (v) => (/^([a-z]{2})?$/.test(v.trim()) ? true : 'две буквы, например en'),
        });
        if (lang.trim()) values['stt-lang'] = lang.trim();
      }
    } else if (values['sub-track'] !== undefined) {
      const track = Number(values['sub-track']);
      let language: string | null = null;
      try {
        language = listSubtitleStreams(inputPath).find((s) => s.track === track)?.language ?? null;
      } catch {
        // main() reports probe errors
      }
      effectiveInput = extractedPath(inputPath, track, language);
    }
  }

  if (values.about === undefined && values['about-file'] === undefined) {
    await askAbout(inputPath, values);
  }

  let outPath: string;
  if (values.out === undefined) {
    const defaultOut = path.resolve(videoOutputPath(inputPath, effectiveInput));
    outPath = await askOut(defaultOut, [inputPath, effectiveInput]);
    if (outPath !== defaultOut) values.out = displayPath(outPath);
  } else {
    outPath = path.resolve(values.out as string);
  }

  if (!values.resume) {
    const sidecar = sidecarPath(outPath);
    const done = existsSync(sidecar) ? new ProgressStore(sidecar).load().size : 0;
    if (done > 0) {
      const resume = await select({
        message: `Найден прогресс: переведено реплик — ${done}.`,
        choices: [
          { name: 'Продолжить с того же места', value: true },
          { name: 'Начать заново', value: false },
        ],
      });
      if (resume) values.resume = true;
    }
  }

  if (values.range === undefined && values.limit === undefined && !values['dry-run']) {
    await askMode(values);
  }

  if (values.endpoints === undefined && isFile(path.resolve(ENDPOINTS_FILE))) {
    const many = await select({
      message: 'Куда отправлять запросы?',
      choices: [
        { name: 'Один endpoint (модель из .env или флагов)', value: false },
        { name: `Несколько endpoint'ов из ${ENDPOINTS_FILE} (по кругу)`, value: true },
      ],
    });
    if (many) {
      values.endpoints = ENDPOINTS_FILE;
      if (values.concurrency === undefined) {
        const n = await number({ message: 'Сколько параллельных вызовов?', default: 3, min: 1, required: true });
        values.concurrency = String(n);
      }
    }
  }

  const inputArg = displayPath(inputPath);
  console.log(`\nКоманда: ${formatCommand(toArgv(inputArg, values))}\n`);
  if (!(await confirm({ message: 'Запустить?', default: true }))) return null;
  return { input: inputPath, values: values as V };
}
