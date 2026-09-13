import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { CompletionClient, CompletionLike, Pool, PoolEntry, TokenUsage } from './types.ts';

export const BASE_DELAYS_MS: number[] = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;

const META_RE =
  /(?:\bhere(?:'s| is) the translation|\bas an AI(?: language model)?|вот перевод|как (?:ИИ|искусственный интеллект))/i;
const PREFIX_RE = /^\s*(?:\*\*)?\s*(?:translation|перевод)\s*:\s*(?:\*\*)?\s*/i;
const FENCE_OPEN_RE = /^\s*```[^\n]*\n?/;
const FENCE_CLOSE_RE = /\n?```\s*$/;
const QUOTE_PAIRS: [string, string][] = [
  ['«', '»'],
  ['“', '”'],
  ['„', '“'],
  ['"', '"'],
];

export class TranslationError extends Error {
  cueIndex: number | null;

  constructor(message: string, { cueIndex = null, cause }: { cueIndex?: number | null; cause?: unknown } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'TranslationError';
    this.cueIndex = cueIndex;
  }
}

export function sourceHash(src: string): string {
  return createHash('sha256').update(src, 'utf8').digest('hex').slice(0, 12);
}

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

export type SanitizeVerdict = { ok: true; text: string } | { ok: false; reason: string };

export function sanitize(raw: unknown, source = ''): SanitizeVerdict {
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
  const visible = (s: string) => s.replace(/<[^<>]*>/g, '').replace(/\s+/g, '');
  const limit = Math.max(visible(source).length * 4, 40);
  if (visible(text).length > limit) {
    return { ok: false, reason: `output is ${text.length} chars, more than 4× the source` };
  }
  return { ok: true, text };
}

interface ProviderError {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  headers?: { get?(name: string): string | null | undefined };
  error?: { message?: unknown } | undefined;
}

function isRetryable(err: unknown): boolean {
  const e = err as ProviderError | null | undefined;
  const status = e?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  if (status !== undefined && status !== null) return false;
  const code = e?.code;
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  ) {
    return true;
  }
  return err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError;
}

function retryAfterMs(err: unknown): number | null {
  const value = (err as ProviderError | null | undefined)?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

function toFailure(err: unknown): TranslationError {
  const e = err as ProviderError | null | undefined;
  const status = e?.status;
  const detail = e?.error?.message ?? e?.message ?? String(err);
  return new TranslationError(
    `provider error${typeof status === 'number' ? ` (HTTP ${status})` : ''}: ${detail}`,
    { cause: err },
  );
}

export function createClient({ apiKey, baseUrl, timeout = 60_000 }: { apiKey: string | null; baseUrl: string; timeout?: number }): OpenAI {
  return new OpenAI({ apiKey: apiKey ?? undefined, baseURL: baseUrl, maxRetries: 0, timeout });
}

// A bare client is treated as a one-endpoint pool, so both paths share the same code.
function asPool(poolOrClient: Pool | CompletionClient, model: string | undefined): Pool {
  if ('next' in poolOrClient && typeof poolOrClient.next === 'function') return poolOrClient;
  const client = poolOrClient as CompletionClient;
  const endpoint: PoolEntry = { name: 'default', client, model: model ?? '', dead: false, failures: 0 };
  return {
    endpoints: [endpoint],
    next: () => (endpoint.dead ? null : endpoint),
    disable: (name) => {
      if (name === endpoint.name) endpoint.dead = true;
    },
    aliveCount: () => (endpoint.dead ? 0 : 1),
  };
}

const describeErr = (err: unknown): string => {
  const e = err as ProviderError | null | undefined;
  return e?.status !== undefined
    ? `HTTP ${String(e.status)}: ${String(e.message ?? '')}`.trim()
    : String(e?.code ?? e?.message ?? 'error');
};

export interface RetryInfo {
  attempt: number;
  delay: number;
  err: unknown;
  endpoint: string;
}

export interface TranslateCueOptions {
  model?: string;
  system: string;
  user: string;
  source: string;
  delays?: number[];
  onRetry?: (info: RetryInfo) => void;
  onCall?: (info: { endpoint: string }) => void;
  onWarn?: (message: string) => void;
}

export interface TranslateCueResult {
  text: string;
  usage: TokenUsage;
  endpoint: string;
  model: string;
}

export async function translateCue(
  poolOrClient: Pool | CompletionClient,
  { model, system, user, source, delays = BASE_DELAYS_MS, onRetry, onCall, onWarn }: TranslateCueOptions,
): Promise<TranslateCueResult> {
  const pool = asPool(poolOrClient, model);
  let nudged = false;
  let failures = 0;
  let endpoint: PoolEntry | null = null;
  let lastFatal: unknown = null;
  const usage: TokenUsage = { in: 0, out: 0 };

  const disable = (ep: PoolEntry, reason: string) => {
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

    let raw: string;
    try {
      const messages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      if (nudged) {
        messages.push({ role: 'user', content: 'Верни только текст реплики.' });
      }
      const body: Record<string, unknown> = { model: endpoint.model ?? model, messages };
      if (endpoint.extraBody) Object.assign(body, endpoint.extraBody);
      const completion = (await endpoint.client.chat.completions.create(body)) as CompletionLike;
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
