import { buildUser } from './prompt.js';
import { sourceHash } from './translate.js';

export function createContext(cues, { contextBefore = 3, contextAfter = 3 } = {}) {
  const indexOf = new Map(cues.map((c, i) => [c.index, i]));
  return {
    prev(index, entries) {
      const prev = [];
      for (let i = (indexOf.get(index) ?? 0) - 1; i >= 0 && prev.length < contextBefore; i--) {
        const c = cues[i];
        const entry = entries.get(c.index);
        if (entry && entry.h === sourceHash(c.lines.join('\n'))) {
          prev.unshift({ index: c.index, src: c.lines.join('\n'), ru: entry.ru });
        }
      }
      return prev;
    },
    next(index) {
      const next = [];
      for (let i = (indexOf.get(index) ?? 0) + 1; i < cues.length && next.length < contextAfter; i++) {
        next.push({ index: cues[i].index, src: cues[i].lines.join('\n') });
      }
      return next;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pendingCues(selected, entries) {
  return selected.filter((c) => {
    const entry = entries.get(c.index);
    return !(entry && entry.h === sourceHash(c.lines.join('\n')));
  });
}

export async function runTranslation(
  selected,
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
  } = {},
) {
  const total = selected.length;
  const tokens = { in: 0, out: 0 };
  const perEndpoint = new Map();
  let processed = 0;
  const ctx = createContext(cues, { contextBefore, contextAfter });

  const handleCue = async (cue) => {
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

  let firstError = null;
  let cursor = 0;
  const nextCue = () => (firstError || cursor >= selected.length ? undefined : selected[cursor++]);

  const worker = async () => {
    for (;;) {
      const cue = nextCue();
      if (!cue) return;
      try {
        await handleCue(cue);
      } catch (err) {
        if (!firstError) {
          firstError = err;
          err.cueIndex = cue.index;
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
