import { readFileSync } from 'node:fs';
import process from 'node:process';
import OpenAI from 'openai';
import type { EndpointConfig, Pool, PoolEntry, PoolInput } from './types.ts';

type RawEntry = Record<string, unknown>;

export function loadEndpoints(path: string): EndpointConfig[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read endpoints file ${path}: ${(err as Error).message}`);
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(`endpoints file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`endpoints file ${path} must contain a non-empty JSON array`);
  }
  try {
    process.loadEnvFile();
  } catch {
    // missing .env is fine
  }
  return list.map((value, i): EndpointConfig => {
    const entry = value as RawEntry | null;
    if (!entry || typeof entry !== 'object') {
      throw new Error(`endpoints[${i}]: must be an object`);
    }
    const name = (entry.name ?? entry.model) as string | undefined;
    if (!entry.baseUrl || !entry.model) {
      throw new Error(`endpoints[${i}] (${name ?? 'unnamed'}): "baseUrl" and "model" are required`);
    }
    let apiKey: string | null = null;
    if (typeof entry.apiKey === 'string' && entry.apiKey) {
      if (entry.apiKey.startsWith('env:')) {
        const varName = entry.apiKey.slice(4);
        apiKey = process.env[varName] ?? null;
        if (!apiKey) {
          throw new Error(`endpoints[${i}] (${name}): env var ${varName} is not set`);
        }
      } else {
        apiKey = entry.apiKey;
      }
    }
    return {
      name: name ?? '',
      baseUrl: entry.baseUrl as string,
      apiKey,
      model: entry.model as string,
      extraBody: (entry.extraBody as RawEntry) ?? null,
    };
  });
}

export function createPool(entries: PoolInput[]): Pool {
  const endpoints: PoolEntry[] = entries.map((entry) => ({
    ...entry,
    name: entry.name ?? '',
    client:
      entry.client ??
      new OpenAI({
        apiKey: entry.apiKey ?? 'missing',
        baseURL: entry.baseUrl,
        maxRetries: 0,
        timeout: 60_000,
      }),
    dead: false,
    failures: 0,
  }));

  let cursor = 0;
  return {
    endpoints,
    next() {
      const n = endpoints.length;
      for (let i = 0; i < n; i++) {
        const e = endpoints[cursor % n];
        cursor += 1;
        if (!e.dead) return e;
      }
      return null;
    },
    disable(name) {
      const e = endpoints.find((x) => x.name === name);
      if (e) e.dead = true;
    },
    aliveCount() {
      return endpoints.filter((e) => !e.dead).length;
    },
  };
}
