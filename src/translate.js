import { createHash } from 'node:crypto';
import OpenAI from 'openai';

export const BASE_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;

const META_RE =
  /(?:\bhere(?:'s| is) the translation|\bas an AI(?: language model)?|вот перевод|как (?:ИИ|искусственный интеллект))/i;
const PREFIX_RE = /^\s*(?:\*\*)?\s*(?:translation|перевод)\s*:\s*(?:\*\*)?\s*/i;
const FENCE_OPEN_RE = /^\s*```[^\n]*\n?/;
const FENCE_CLOSE_RE = /\n?```\s*$/;
const QUOTE_PAIRS = [
  ['«', '»'],
  ['“', '”'],
  ['„', '“'],
  ['"', '"'],
];

export class TranslationError extends Error {
  constructor(message, { cueIndex = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TranslationError';
    this.cueIndex = cueIndex;
  }
}

export function sourceHash(src) {
  return createHash('sha256').update(src, 'utf8').digest('hex').slice(0, 12);
}

function stripWrappingQuotes(text) {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

export function sanitize(raw, source = '') {
  let text = String(raw ?? '');
  text = text.replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '');
  text = stripWrappingQuotes(text.trim());
  for (;;) {
    const stripped = text.replace(PREFIX_RE, '');
    if (stripped === text) break;
    text = stripped.trim();
  }
  if (!text) return { ok: false, reason: 'empty output' };
  if (META_RE.test(text)) return { ok: false, reason: 'looks like meta-commentary' };
  const visible = (s) => s.replace(/<[^<>]*>/g, '').replace(/\s+/g, '');
  const limit = Math.max(visible(source).length * 4, 40);
  if (visible(text).length > limit) {
    return { ok: false, reason: `output is ${text.length} chars, more than 4× the source` };
  }
  return { ok: true, text };
}

function isRetryable(err) {
  const status = err?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  if (status !== undefined && status !== null) return false;
  const code = err?.code;
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  ) {
    return true;
  }
  return err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError;
}

function retryAfterMs(err) {
  const value = err?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

function toFailure(err) {
  const status = err?.status;
  const detail = err?.error?.message ?? err?.message ?? String(err);
  return new TranslationError(
    `provider error${typeof status === 'number' ? ` (HTTP ${status})` : ''}: ${detail}`,
    { cause: err },
  );
}

export function createClient({ apiKey, baseUrl, timeout = 60_000 }) {
  return new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout });
}

// A bare client is treated as a one-endpoint pool, so both paths share the same code.
function asPool(poolOrClient, model) {
  if (poolOrClient && typeof poolOrClient.next === 'function') return poolOrClient;
  const endpoint = { name: 'default', client: poolOrClient, model, dead: false, failures: 0 };
  return {
    endpoints: [endpoint],
    next: () => (endpoint.dead ? null : endpoint),
    disable: (name) => {
      if (name === endpoint.name) endpoint.dead = true;
    },
    aliveCount: () => (endpoint.dead ? 0 : 1),
  };
}

const describeErr = (err) =>
  err?.status !== undefined
    ? `HTTP ${err.status}: ${err?.message ?? ''}`.trim()
    : (err?.code ?? err?.message ?? 'error');

export async function translateCue(
  poolOrClient,
  { model, system, user, source, delays = BASE_DELAYS_MS, onRetry, onCall, onWarn } = {},
) {
  const pool = asPool(poolOrClient, model);
  let nudged = false;
  let failures = 0;
  let endpoint = null;
  let lastFatal = null;
  const usage = { in: 0, out: 0 };

  const disable = (ep, reason) => {
    pool.disable(ep.name);
    onWarn?.(`endpoint ${ep.name} отключён (${reason})`);
  };

  for (;;) {
    if (!endpoint) {
      endpoint = pool.next();
      if (!endpoint) {
        throw new TranslationError(
          `все endpoints вышли из строя${
            lastFatal ? `; последняя ошибка: ${toFailure(lastFatal).message}` : ''
          }`,
        );
      }
    }

    let raw;
    try {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      if (nudged) {
        messages.push({ role: 'user', content: 'Верни только текст реплики.' });
      }
      const body = { model: endpoint.model ?? model, messages };
      if (endpoint.extraBody) Object.assign(body, endpoint.extraBody);
      const completion = await endpoint.client.chat.completions.create(body);
      onCall?.({ endpoint: endpoint.name });
      const u = completion.usage;
      usage.in += u?.prompt_tokens ?? 0;
      usage.out += u?.completion_tokens ?? 0;
      // GLM emits message.reasoning_content — ignored entirely, only content is used.
      raw = completion.choices?.[0]?.message?.content ?? '';
      endpoint.failures = 0;
    } catch (err) {
      lastFatal = err;
      const failedEndpoint = endpoint;
      endpoint.failures += 1;
      if (!isRetryable(err)) {
        // broken endpoint (bad key, unknown model, …): drop it and move on without backoff
        disable(failedEndpoint, describeErr(err));
        endpoint = null;
        continue;
      }
      if (failedEndpoint.failures >= MAX_ATTEMPTS) {
        // hopelessly throttled: retire it for the rest of the run
        disable(failedEndpoint, `${failedEndpoint.failures} неудачных вызовов подряд`);
        endpoint = null;
      }
      failures += 1;
      if (failures >= MAX_ATTEMPTS) throw toFailure(err);
      const delay = retryAfterMs(err) ?? delays[Math.min(failures - 1, delays.length - 1)];
      onRetry?.({ attempt: failures, delay, err, endpoint: failedEndpoint.name });
      await new Promise((resolve) => setTimeout(resolve, delay));
      endpoint = null; // next attempt rotates to the next alive endpoint
      continue;
    }

    const verdict = sanitize(raw, source);
    if (verdict.ok) {
      return { text: verdict.text, usage, endpoint: endpoint.name, model: endpoint.model ?? model };
    }
    if (nudged) {
      throw new TranslationError(
        `unusable output (${verdict.reason}): ${JSON.stringify(String(raw).slice(0, 200))}`,
      );
    }
    nudged = true; // stricter retry, same endpoint
  }
}
