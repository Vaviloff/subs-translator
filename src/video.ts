import { spawnSync } from 'node:child_process';
import path from 'node:path';

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

export function extractedPath(videoPath: string, track: number, language?: string | null): string {
  const ext = path.extname(videoPath);
  const base = ext ? videoPath.slice(0, -ext.length) : videoPath;
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
