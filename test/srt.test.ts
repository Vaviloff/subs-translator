import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, wrap } from '../src/srt.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(here, 'fixtures', 'sample.srt'));

test('parse: cues, verbatim timing, position token, lines', () => {
  const { cues, eol } = parse(fixture);
  assert.equal(eol, '\n');
  assert.equal(cues.length, 5);
  assert.deepEqual(
    cues.map((c) => c.index),
    [1, 2, 3, 7, 8],
  );
  assert.equal(cues[0].timing, '00:00:01,000 --> 00:00:03,500 X1:40 X2:600 Y1:20 Y2:60');
  assert.deepEqual(cues[0].lines, ['<i>Previously</i> on "The Division":']);
  assert.equal(cues[0].position, null);
  assert.equal(cues[1].position, '{\\an8}');
  assert.deepEqual(cues[1].lines, ["Where's Hollis?", 'Gone since Tuesday.']);
  assert.deepEqual(cues[4].lines, ['No index on this one.']);
});

test('parse: skips junk blocks without a timing line', () => {
  const { cues } = parse(fixture);
  assert.ok(cues.every((c) => c.timing.includes('-->')));
});

test('parse: decodes cp1251 with leading BOM tolerated', () => {
  const buf = readFileSync(path.join(here, 'fixtures', 'sample.cp1251.srt'));
  const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
  const { cues } = parse(bommed);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].lines[0], 'Привет, мир!');
  assert.equal(cues[1].lines[0], 'Как дела?');
});

test('parse: detects CRLF eol', () => {
  const { eol } = parse(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n\r\n'));
  assert.equal(eol, '\r\n');
});

test('serialize: CRLF, no BOM, trailing blank line, position re-attached', () => {
  const { cues } = parse(fixture);
  const text = serialize(cues);
  assert.ok(!text.startsWith('\uFEFF'));
  assert.ok(text.endsWith('\r\n\r\n'));
  assert.ok(!/(?<!\r)\n/.test(text));
  assert.ok(text.includes('{\\an8}Where\'s Hollis?\r\nGone since Tuesday.'));
  assert.ok(text.includes('00:00:01,000 --> 00:00:03,500 X1:40 X2:600 Y1:20 Y2:60'));
});

test('round-trip: serialize∘parse is stable', () => {
  const once = serialize(parse(fixture).cues);
  const twice = serialize(parse(Buffer.from(once)).cues);
  assert.equal(twice, once);
});

test('wrap: short text stays on one line', () => {
  assert.deepEqual(wrap('Short line', 42, 2), ['Short line']);
});

test('wrap: existing line breaks preserved when they fit', () => {
  assert.deepEqual(wrap('He was taken.\nAnd quickly.', 42, 2), ['He was taken.', 'And quickly.']);
});

test('wrap: re-wraps when the model overshoots the line count', () => {
  const lines = wrap('one two three four five six seven eight', 20, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), 'one two three four five six seven eight');
  assert.ok(lines.every((l) => l.length <= 20));
});

test('wrap: balanced rather than greedy', () => {
  const lines = wrap('aaaa bbbb cccc dddd', 9, 2);
  assert.deepEqual(lines, ['aaaa bbbb', 'cccc dddd']);
});

test('wrap: never splits inside a tag', () => {
  const text = "He didn't <i>leave</i>. He was <b>taken</b> away.";
  const lines = wrap(text, 24, 2);
  assert.equal(lines.join(' '), text);
  for (const line of lines) {
    assert.equal((line.match(/<i>/g) ?? []).length, (line.match(/<\/i>/g) ?? []).length);
    assert.equal((line.match(/<b>/g) ?? []).length, (line.match(/<\/b>/g) ?? []).length);
  }
});

test('wrap: unbreakable word overflows instead of being dropped', () => {
  const word = 'x'.repeat(50);
  assert.deepEqual(wrap(word, 42, 2), [word]);
});
