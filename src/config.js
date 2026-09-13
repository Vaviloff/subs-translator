import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.paretoinference.com/v1';
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

export function resolveConfig({ apiKey, baseUrl, model } = {}) {
  try {
    process.loadEnvFile();
  } catch {
    // missing .env is fine
  }
  return {
    apiKey: apiKey ?? process.env.PARETO_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    baseUrl: baseUrl ?? process.env.SUBS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: model ?? process.env.SUBS_MODEL ?? DEFAULT_MODEL,
  };
}

export function discoverAbout(inputPath, { about, aboutFile } = {}) {
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

export function defaultOutputPath(inputPath) {
  const ext = path.extname(inputPath);
  const base = ext ? inputPath.slice(0, -ext.length) : inputPath;
  return `${base}.ru.srt`;
}
