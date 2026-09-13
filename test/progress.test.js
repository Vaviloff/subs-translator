import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, serialize } from '../src/srt.js';
import { sourceHash } from '../src/translate.js';
import { ProgressStore, assemble, sidecarPath } from '../src/progress.js';

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subs-progress-'));
  const store = new ProgressStore(sidecarPath(path.join(dir, 'out.ru.srt')));
  return { dir, store };
}

test('record then load returns the same entries', () => {
  const { dir, store } = tempStore();
  const entry = {
    i: 5,
    h: sourceHash('Hello'),
    src: 'Hello',
    ru: 'Привет',
    tokens: { in: 100, out: 10 },
    model: 'm',
    at: '2026-09-12T17:04:11.902Z',
  };
  store.record(entry);
  store.close();

  const reopened = new ProgressStore(store.path);
  const map = reopened.load();
  assert.deepEqual(map.get(5), entry);
  rmSync(dir, { recursive: true, force: true });
});

test('load: last write wins per cue index', () => {
  const { dir, store } = tempStore();
  store.record({ i: 1, h: 'a', src: 'x', ru: 'первый' });
  store.record({ i: 2, h: 'b', src: 'y', ru: 'второй' });
  store.record({ i: 1, h: 'a', src: 'x', ru: 'повторный' });
  store.close();

  const map = new ProgressStore(store.path).load();
  assert.equal(map.size, 2);
  assert.equal(map.get(1).ru, 'повторный');
  assert.equal(map.get(2).ru, 'второй');
  rmSync(dir, { recursive: true, force: true });
});

test('load: skips corrupt lines instead of failing', () => {
  const { dir, store } = tempStore();
  store.record({ i: 1, h: 'a', src: 'x', ru: 'ок' });
  store.close();
  const corrupted = readFileSync(store.path, 'utf8') + '{not json\n';
  writeFileSync(store.path, corrupted);

  const map = new ProgressStore(store.path).load();
  assert.equal(map.size, 1);
  assert.equal(map.get(1).ru, 'ок');
  rmSync(dir, { recursive: true, force: true });
});

test('load on a missing sidecar yields an empty map', () => {
  const { dir, store } = tempStore();
  assert.equal(store.load().size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('assemble: mocked translations replace lines and keep position tokens', () => {
  const { cues } = parse(
    Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nHello world, this is a fairly long line of dialogue.\n\n2\n00:00:03,000 --> 00:00:04,000\n{\\an8}Bye.\n',
    ),
  );
  const entries = new Map([
    [1, { i: 1, h: sourceHash(cues[0].lines.join('\n')), ru: 'Привет, мир, это довольно длинная строка диалога из фильма.' }],
    [2, { i: 2, h: sourceHash(cues[1].lines.join('\n')), ru: 'Пока.' }],
  ]);
  const assembled = assemble(cues, entries, { maxLen: 42, maxLines: 2 });
  assert.equal(assembled[0].lines.length, 2);
  assert.ok(assembled[0].lines.every((l) => l.length <= 42));
  assert.deepEqual(assembled[1].lines, ['Пока.']);
  assert.equal(assembled[1].position, '{\\an8}');

  const text = serialize(assembled);
  assert.ok(text.includes('{\\an8}Пока.'));
  assert.ok(!text.includes('Hello world'));
});

test('assemble: hash mismatch or missing entry falls back to the original', () => {
  const { cues } = parse(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello.\n'));
  const stale = new Map([[1, { i: 1, h: 'deadbeefdead', ru: 'Устаревший перевод.' }]]);
  assert.deepEqual(assemble(cues, stale)[0].lines, ['Hello.']);
  assert.deepEqual(assemble(cues, new Map())[0].lines, ['Hello.']);
});
