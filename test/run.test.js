import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext, pendingCues, runTranslation } from '../src/run.js';
import { ProgressStore, sidecarPath } from '../src/progress.js';
import { sourceHash } from '../src/translate.js';

function makeCues(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    timing: `00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},000`,
    lines: [`line-${i + 1}`],
    position: null,
  }));
}

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subs-run-'));
  return new ProgressStore(sidecarPath(path.join(dir, 'out.ru.srt')));
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function makeTranslator({ gates = new Map(), failAt = null } = {}) {
  const captured = new Map();
  const openers = new Map();
  for (const index of [...gates.keys()]) {
    openers.set(index, new Promise((resolve) => gates.set(index, resolve)));
  }
  const translate = async ({ cue, user }) => {
    captured.set(cue.index, user);
    if (failAt === cue.index) throw new Error('boom');
    await (openers.get(cue.index) ?? Promise.resolve());
    return { text: `ru-${cue.index}`, usage: { in: 10, out: 2 } };
  };
  return {
    captured,
    translate,
    open: (index) => {
      const resolve = gates.get(index);
      gates.delete(index);
      resolve?.();
    },
  };
}

test('concurrency: context holds finished predecessors only, never in-flight ones', async () => {
  const cues = makeCues(9);
  const gates = new Map(cues.map((c) => [c.index, null]));
  const { captured, translate, open } = makeTranslator({ gates });
  const store = tempStore();

  const run = runTranslation(cues, {
    cues,
    store,
    model: 'm',
    translate,
    concurrency: 3,
  });
  await flush();

  // three calls in flight, none of them may carry Russian context
  assert.deepEqual([...captured.keys()].sort(), [1, 2, 3]);
  assert.ok(!captured.get(2).includes('ЧТО УЖЕ ПЕРЕВЕДЕНО'));

  open(1);
  await flush();
  assert.ok(captured.has(4), 'cue 4 should start after cue 1 lands');
  assert.ok(captured.get(4).includes('[1] line-1 → ru-1'), 'finished cue 1 is context');
  assert.ok(!captured.get(4).includes('[2]'), 'in-flight cue 2 must not appear');

  open(2);
  await flush();
  assert.ok(captured.has(5));
  assert.ok(captured.get(5).includes('[1] line-1 → ru-1'));
  assert.ok(captured.get(5).includes('[2] line-2 → ru-2'));
  assert.ok(!captured.get(5).includes('[3]'), 'cue 3 still in flight');
  assert.ok(!captured.get(5).includes('[4]'), 'cue 4 still in flight');

  for (let i = 3; i <= 9; i++) open(i);
  const result = await run;

  assert.equal(result.processed, 9);
  assert.equal(result.tokens.in, 90);
  assert.equal(result.tokens.out, 18);
  assert.equal(store.map.size, 9);
  store.close();
});

test('failure: no new cues start, in-flight results still land, error carries cue index', async () => {
  const cues = makeCues(6);
  const gates = new Map([[2, null]]);
  const { translate, open } = makeTranslator({ gates, failAt: 1 });
  const store = tempStore();

  const run = runTranslation(cues, { cues, store, model: 'm', translate, concurrency: 2 });
  const rejection = assert.rejects(run, (err) => err.message === 'boom' && err.cueIndex === 1);
  await flush();

  open(2);
  await flush();
  await rejection;

  assert.equal(store.map.get(2)?.ru, 'ru-2', 'in-flight cue landed in the sidecar');
  assert.ok(!store.map.has(3), 'no new cues scheduled after the failure');
  store.close();
});

test('pendingCues: drops hash-matched entries, keeps stale and untranslated ones', () => {
  const cues = makeCues(4);
  const entries = new Map([
    [1, { i: 1, h: sourceHash('line-1'), ru: 'ru-1' }],
    [2, { i: 2, h: 'stalehash0000', ru: 'устаревший' }],
  ]);
  const pending = pendingCues(cues, entries);
  assert.deepEqual(
    pending.map((c) => c.index),
    [2, 3, 4],
  );
});

test('sequential run with resume skips matching entries but keeps them as context', async () => {
  const cues = makeCues(3);
  const store = tempStore();
  store.record({ i: 1, h: sourceHash('line-1'), src: 'line-1', ru: 'ru-1' });

  const calls = [];
  const translate = async ({ cue, user }) => {
    calls.push(cue.index);
    return { text: `ru-${cue.index}`, usage: { in: 10, out: 2 } };
  };

  const result = await runTranslation(cues, {
    cues,
    store,
    model: 'm',
    translate,
    resume: true,
    concurrency: 1,
  });

  assert.deepEqual(calls, [2, 3]);
  assert.equal(result.processed, 3, 'skipped cues count toward progress');
  assert.deepEqual([...store.map.keys()], [1, 2, 3], 'completion order is sequential');
  store.close();
});
