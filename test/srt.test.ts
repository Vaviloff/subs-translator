import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, wrap, parseTiming, formatTiming } from '../src/srt.ts';

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

test('wrap: existing line breaks preserved when a single line would overflow', () => {
  const a = 'He was taken, and the case went cold.';
  const b = 'And quickly, within a week.';
  assert.deepEqual(wrap(`${a}\n${b}`, 42, 2), [a, b]);
});

test('wrap: balanced two-line cue collapses to one line when it all fits', () => {
  const model =
    '<font color="#ffff00">Вы летите в Нуллу</font>\n<font color="#ffff00">по делу об убийстве.</font>';
  const lines = wrap(model, 42, 2);
  assert.equal(lines.length, 1);
  assert.equal(visText(lines[0]), 'Вы летите в Нуллу по делу об убийстве.');
  assert.deepEqual(wrap('He was taken.\nAnd quickly.', 42, 2), ['He was taken. And quickly.']);
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

const visLen = (s: string): number => s.replace(/<[^>]*>/g, '').length;
const visText = (s: string): string => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const plane =
  '<font color="#ffff00">Самолёт\nПолЭйр</font> <font color="#ffff00">ожидает вас на взлётной полосе.</font>';
const nulla =
  '<font color="#ffff00">Ты летишь в\nНуллу</font> <font color="#ffff00">по делу об убийстве.</font>';

test('wrap: balances by visible length, not raw, when tags inflate the text', () => {
  const lines = wrap(plane, 42, 2);
  assert.equal(lines.length, 2);
  const lens = lines.map(visLen);
  assert.ok(Math.max(...lens) <= 2 * Math.min(...lens), `unbalanced: ${lens.join(' vs ')}`);
  assert.ok(lens.every((n) => n <= 42));
  assert.equal(lines.map(visText).join(' '), visText(plane));
});

test('wrap: tagged line that fits on one visible line collapses to one', () => {
  const lines = wrap(nulla, 42, 2);
  assert.equal(lines.length, 1);
  assert.equal(visText(lines[0]), visText(nulla));
});

test('wrap: reopens tags split by a line break so each line stays balanced', () => {
  const lines = wrap('<i>one two three four five six</i>', 12, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal((line.match(/<i>/g) ?? []).length, (line.match(/<\/i>/g) ?? []).length);
  }
  assert.equal(lines.map((l) => l.replace(/<[^>]*>/g, '')).join(' '), 'one two three four five six');
});

test('wrap: font tag split across lines is closed and re-opened', () => {
  const lines = wrap(plane, 42, 2);
  const [top, bottom] = lines;
  assert.ok(top.includes('</font>'), 'first line must close the tag');
  assert.ok(bottom.startsWith('<font color="#ffff00">'), 'second line must re-open the tag');
  for (const line of lines) {
    assert.equal(
      (line.match(/<font\b/g) ?? []).length,
      (line.match(/<\/font>/g) ?? []).length,
      `unbalanced font tags: ${line}`,
    );
  }
});

test('wrap: speaker-dash lines are never merged or rebalanced', () => {
  const text = '— Привет.\n— Как дела, давно не виделись, дружище?';
  assert.deepEqual(wrap(text, 42, 2), text.split('\n'));
});

test('wrap: fits but badly unbalanced model breaks get re-wrapped', () => {
  const lines = wrap('Hi.\nThis sentence here is quite a lot longer.', 42, 2);
  assert.equal(lines.join(' '), 'Hi. This sentence here is quite a lot longer.');
  const lens = lines.map(visLen);
  assert.ok(Math.max(...lens) <= 2 * Math.min(...lens), `unbalanced: ${lens.join(' vs ')}`);
});

test('wrap: wrapping already wrapped output is stable', () => {
  const once = wrap(plane, 42, 2);
  const twice = wrap(once.join('\n'), 42, 2);
  assert.deepEqual(twice, once);
});

test('parseTiming: ms, suffix, coordinate metadata', () => {
  const t = parseTiming('00:02:25,400 --> 00:02:28,360 X1:40 X2:600 Y1:20 Y2:60');
  assert.deepEqual(t, { startMs: 145_400, endMs: 148_360, suffix: 'X1:40 X2:600 Y1:20 Y2:60' });
  assert.deepEqual(parseTiming('00:00:01,000 --> 00:00:03,500'), { startMs: 1000, endMs: 3500, suffix: '' });
  assert.equal(parseTiming('not a timing'), null);
});

test('parseTiming: tolerates dot milliseconds and extra spaces', () => {
  const t = parseTiming('1:02:03.500   -->   1:02:04.000');
  assert.deepEqual(t, { startMs: 3_723_500, endMs: 3_724_000, suffix: '' });
});

test('formatTiming ∘ parseTiming round-trips, suffix and comma format preserved', () => {
  for (const timing of [
    '00:02:25,400 --> 00:02:28,360',
    '00:02:25,400 --> 00:02:28,360 X1:40 X2:600 Y1:20 Y2:60',
    '99:59:59,999 --> 100:00:00,000',
  ]) {
    const t = parseTiming(timing);
    assert.ok(t);
    assert.equal(formatTiming(t.startMs, t.endMs, t.suffix), timing);
  }
});
