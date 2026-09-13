import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSilences, computeChunkBoundaries } from '../src/chunk.ts';
import type { Silence } from '../src/chunk.ts';

const sil = (start: number, end: number): Silence => ({ start, end, duration: end - start });

test('parseSilences: pairs of start/end lines, ignores noise', () => {
  const log = [
    '[silencedetect @ 0x55] silence_start: 1.25',
    '[silencedetect @ 0x55] silence_end: 2.5 | silence_duration: 1.25',
    '[someotherfilter @ 0x55] noise: -30 dB',
    '[silencedetect @ 0x55] silence_start: 10',
    '[silencedetect @ 0x55] silence_end: 10.4 | silence_duration: 0.4',
  ].join('\n');
  assert.deepEqual(parseSilences(log), [sil(1.25, 2.5), sil(10, 10.4)]);
});

test('parseSilences: negative start clamped, dangling start dropped, empty log', () => {
  assert.deepEqual(parseSilences('[silencedetect @ 0x1] silence_start: -0.05\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.55'), [
    sil(0, 0.5),
  ]);
  assert.deepEqual(parseSilences('[silencedetect @ 0x1] silence_start: 5'), []);
  assert.deepEqual(parseSilences(''), []);
});

test('computeChunkBoundaries: empty and short inputs', () => {
  assert.deepEqual(computeChunkBoundaries([], 0), []);
  assert.deepEqual(computeChunkBoundaries([], -5), []);
  assert.deepEqual(computeChunkBoundaries([], 120), [[0, 120]]);
});

test('computeChunkBoundaries: cuts at the latest silence midpoint inside the window', () => {
  const silences = [sil(10, 12), sil(100, 104), sil(500, 502)];
  // window [0,600]: usable midpoints 102 and 501 → latest wins
  assert.deepEqual(computeChunkBoundaries(silences, 2000, { maxLen: 600, minLen: 90 }), [
    [0, 501],
    [501, 1101],
    [1101, 1701],
    [1701, 2000],
  ]);
});

test('computeChunkBoundaries: hard cut when the window has no usable silence', () => {
  const silences = [sil(5, 7), sil(700, 704)];
  assert.deepEqual(computeChunkBoundaries(silences, 2000, { maxLen: 600, minLen: 90 }), [
    [0, 600],
    [600, 702],
    [702, 1302],
    [1302, 1902],
    [1902, 2000],
  ]);
});

test('computeChunkBoundaries: midpoints before minLen are ignored', () => {
  const silences = [sil(50, 52)];
  assert.deepEqual(computeChunkBoundaries(silences, 1800, { maxLen: 600, minLen: 90 }), [
    [0, 600],
    [600, 1200],
    [1200, 1800],
  ]);
});

test('computeChunkBoundaries: chunks tile [0, duration] exactly', () => {
  const silences = [sil(100, 103), sil(250, 256), sil(590, 594), sil(1200, 1203)];
  const chunks = computeChunkBoundaries(silences, 1800, { maxLen: 600, minLen: 90 });
  assert.equal(chunks[0][0], 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i][0], chunks[i - 1][1]);
  assert.equal(chunks[chunks.length - 1][1], 1800);
  for (const [a, b] of chunks) assert.ok(b > a);
});
