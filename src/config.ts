import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.paretoinference.com/v1';
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

export interface ResolvedConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
}

export function resolveConfig({
  apiKey,
  baseUrl,
  model,
}: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
} = {}): ResolvedConfig {
  try {
    process.loadEnvFile();
  } catch {
    // missing .env is fine
  }
  return {
    apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? null,
    baseUrl: baseUrl ?? process.env.SUBS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: model ?? process.env.SUBS_MODEL ?? DEFAULT_MODEL,
  };
}

export function discoverAbout(
  inputPath: string,
  { about, aboutFile }: { about?: string; aboutFile?: string } = {},
): string | null {
  if (about !== undefined) return about.trim() || null;
  if (aboutFile !== undefined) {
    if (!existsSync(aboutFile)) {
      throw new Error(`about-file not found: ${aboutFile}`);
    }
    return readFileSync(aboutFile, 'utf8').trim() || null;
  }
  const candidate = inputPath.replace(/\.[^./\\]+$/, '') + '.about.md';
  if (existsSync(candidate)) {
    return readFileSync(candidate, 'utf8').trim() || null;
  }
  return null;
}

export function defaultOutputPath(inputPath: string): string {
  const ext = path.extname(inputPath);
  const base = ext ? inputPath.slice(0, -ext.length) : inputPath;
  return `${base}.ru.srt`;
}

/** per-folder scratch dir in the OS temp: <tmp>/subs-translate/<folder>-<sha1(abs folder)[:10]> */
export function workDir(filePath: string): string {
  const dir = path.dirname(path.resolve(filePath));
  const hash = createHash('sha1').update(dir).digest('hex').slice(0, 10);
  return path.join(tmpdir(), 'subs-translate', `${path.basename(dir) || 'root'}-${hash}`);
}
