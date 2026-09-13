import { readFileSync } from 'node:fs';
import process from 'node:process';
import OpenAI from 'openai';

export function loadEndpoints(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read endpoints file ${path}: ${err.message}`);
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(`endpoints file ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`endpoints file ${path} must contain a non-empty JSON array`);
  }
  try {
    process.loadEnvFile();
  } catch {
    // missing .env is fine
  }
  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`endpoints[${i}]: must be an object`);
    }
    const name = entry.name ?? entry.model;
    if (!entry.baseUrl || !entry.model) {
      throw new Error(`endpoints[${i}] (${name ?? 'unnamed'}): "baseUrl" and "model" are required`);
    }
    let apiKey = null;
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
      name,
      baseUrl: entry.baseUrl,
      apiKey,
      model: entry.model,
      extraBody: entry.extraBody ?? null,
    };
  });
}

export function createPool(entries) {
  const endpoints = entries.map((entry) => ({
    ...entry,
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
