import { buildUser } from './prompt.ts';
import { sourceHash } from './translate.ts';
import type { ProgressStore } from './progress.ts';
import type { Cue, NextEntry, PrevEntry, ProgressEntry, TokenUsage, TranslateFn } from './types.ts';

export interface ContextWindow {
  prev(index: number, entries: Map<number, ProgressEntry>): PrevEntry[];
  next(index: number): NextEntry[];
}

export function createContext(
  cues: Cue[],
  { contextBefore = 3, contextAfter = 3 }: { contextBefore?: number; contextAfter?: number } = {},
): ContextWindow {
  const indexOf = new Map(cues.map((c, i) => [c.index, i]));
  return {
    prev(index: number, entries: Map<number, ProgressEntry>): PrevEntry[] {
      const prev: PrevEntry[] = [];
      for (let i = (indexOf.get(index) ?? 0) - 1; i >= 0 && prev.length < contextBefore; i--) {
        const c = cues[i];
        const entry = entries.get(c.index);
        if (entry && entry.h === sourceHash(c.lines.join('\n'))) {
          prev.unshift({ index: c.index, src: c.lines.join('\n'), ru: entry.ru });
        }
      }
      return prev;
    },
    next(index: number): NextEntry[] {
      const next: NextEntry[] = [];
      for (let i = (indexOf.get(index) ?? 0) + 1; i < cues.length && next.length < contextAfter; i++) {
        next.push({ index: cues[i].index, src: cues[i].lines.join('\n') });
      }
      return next;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function pendingCues(selected: Cue[], entries: Map<number, ProgressEntry>): Cue[] {
  return selected.filter((c) => {
    const entry = entries.get(c.index);
    return !(entry && entry.h === sourceHash(c.lines.join('\n')));
  });
}

export interface ProgressInfo {
  processed: number;
  total: number;
  tokens: TokenUsage;
  cue: Cue;
}

export interface EndpointStat {
  model: string;
  cues: number;
  in: number;
  out: number;
}

export interface RunResult {
  processed: number;
  total: number;
  tokens: TokenUsage;
  perEndpoint: Map<string, EndpointStat>;
}

export interface RunOptions {
  cues: Cue[];
  store: ProgressStore;
  model: string;
  translate: TranslateFn;
  resume?: boolean;
  concurrency?: number;
  contextBefore?: number;
  contextAfter?: number;
  delayMs?: number;
  onProgress?: (info: ProgressInfo) => void;
}

export async function runTranslation(
  selected: Cue[],
  {
    cues,
    store,
    model,
    translate,
    resume = false,
    concurrency = 1,
    contextBefore = 3,
    contextAfter = 3,
    delayMs = 0,
    onProgress = () => {},
  }: RunOptions,
): Promise<RunResult> {
  const total = selected.length;
  const tokens: TokenUsage = { in: 0, out: 0 };
  const perEndpoint = new Map<string, EndpointStat>();
  let processed = 0;
  const ctx = createContext(cues, { contextBefore, contextAfter });

  const handleCue = async (cue: Cue): Promise<void> => {
    const src = cue.lines.join('\n');
    const h = sourceHash(src);
    const existing = store.map.get(cue.index);
    if (resume && existing && existing.h === h) {
      processed += 1;
      onProgress({ processed, total, tokens, cue });
      return;
    }
    const user = buildUser({
      cue,
      prev: ctx.prev(cue.index, store.map),
      next: ctx.next(cue.index),
    });
    const { text, usage, endpoint, model: servedModel } = await translate({ cue, user, source: src });
    tokens.in += usage?.in ?? 0;
    tokens.out += usage?.out ?? 0;
    const usedModel = servedModel ?? model;
    const key = endpoint ?? usedModel;
    const agg = perEndpoint.get(key) ?? { model: usedModel, cues: 0, in: 0, out: 0 };
    agg.cues += 1;
    agg.in += usage?.in ?? 0;
    agg.out += usage?.out ?? 0;
    perEndpoint.set(key, agg);
    store.record({
      i: cue.index,
      h,
      src,
      ru: text,
      tokens: { in: usage?.in ?? 0, out: usage?.out ?? 0 },
      model: usedModel,
      at: new Date().toISOString(),
    });
    processed += 1;
    onProgress({ processed, total, tokens, cue });
  };

  let firstError: (Error & { cueIndex?: number }) | null = null;
  let cursor = 0;
  const nextCue = (): Cue | undefined => (firstError || cursor >= selected.length ? undefined : selected[cursor++]);

  const worker = async (): Promise<void> => {
    for (;;) {
      const cue = nextCue();
      if (!cue) return;
      try {
        await handleCue(cue);
      } catch (caught) {
        if (!firstError) {
          const err = (caught instanceof Error ? caught : new Error(String(caught))) as Error & { cueIndex?: number };
          err.cueIndex = cue.index;
          firstError = err;
        }
        return;
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, total)) },
    () => worker(),
  );
  await Promise.all(workers);

  if (firstError) throw firstError;
  return { processed, total, tokens, perEndpoint };
}
