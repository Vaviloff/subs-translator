import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCues } from '../src/clean.ts';
import type { Cue } from '../src/types.ts';

function cue(index: number, start: string, end: string, ...lines: string[]): Cue {
  return { index, timing: `${start} --> ${end}`, lines, position: null };
}

const FONT = (text: string): string => `<font color="#00ff00">${text}</font>`;

test('clean: drops fully parenthetical cues, both bracket styles, tag shells included', () => {
  const { cues, stats } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', FONT('(CAT MIAOWS)')),
    cue(2, '00:00:02,040', '00:00:03,000', FONT('[GOBLIN GRUNTING]')),
    cue(3, '00:00:03,040', '00:00:04,000', '<i>[MUSIC PLAYING]</i>'),
    cue(4, '00:00:04,040', '00:00:05,000', 'Hello.'),
  ]);
  assert.deepEqual(cues.map((c) => c.index), [4]);
  assert.equal(stats.sdhCues, 3);
  assert.equal(stats.sdhLines, 0);
  assert.equal(stats.merged, 0);
});

test('clean: strips inline SDH but keeps the rest of the line', () => {
  const { cues, stats } = cleanCues([
    cue(31, '00:02:21,320', '00:02:22,360', '<font color="#ffff00">WOMAN: (ON PHONE) It\'s Packenham.</font>'),
    cue(5, '00:00:01,000', '00:00:02,000', '[GOBLIN GRUNTING] Where is it?'),
  ]);
  assert.deepEqual(cues[0].lines, ['<font color="#ffff00">WOMAN: It\'s Packenham.</font>']);
  assert.deepEqual(cues[1].lines, ['Where is it?']);
  assert.equal(stats.sdhCues, 0);
  assert.equal(stats.sdhLines, 2);
});

test('clean: mixed cue keeps surviving lines, drops emptied ones', () => {
  const { cues, stats } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', '(GASPS) Look at that.', 'It\'s huge.'),
  ]);
  assert.deepEqual(cues[0].lines, ["Look at that.", "It's huge."]);
  assert.equal(stats.sdhCues, 0);
  assert.equal(stats.sdhLines, 1);
});

test('clean: nested and repeated SDH spans converge', () => {
  const { cues } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', '(WHISPERS [IN FRENCH]) Bonjour.'),
    cue(2, '00:00:02,040', '00:00:03,000', 'Hello (hello) (hello) again.'),
  ]);
  assert.deepEqual(cues[0].lines, ['Bonjour.']);
  assert.deepEqual(cues[1].lines, ['Hello again.']);
});

test('clean: chain-merges byte-identical adjacent cues into one long cue', () => {
  const text = [
    '<font color="#ffff00">There\'s a PolAir plane</font>',
    '<font color="#ffff00">on the tarmac waiting for you.</font>',
  ];
  const { cues, stats } = cleanCues([
    cue(33, '00:02:25,400', '00:02:25,560', ...text),
    cue(34, '00:02:25,600', '00:02:27,600', ...text),
    cue(35, '00:02:27,640', '00:02:28,120', ...text),
    cue(36, '00:02:28,160', '00:02:28,360', ...text),
    cue(37, '00:02:28,400', '00:02:30,120', 'You\'re flying out to Nulla'),
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].index, 33);
  assert.equal(cues[0].timing, '00:02:25,400 --> 00:02:28,360');
  assert.deepEqual(cues[0].lines, text);
  assert.equal(stats.merged, 3);
});

test('clean: identical cues beyond the gap threshold stay separate', () => {
  const { cues, stats } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', 'No.'),
    cue(2, '00:00:05,000', '00:00:06,000', 'No.'),
  ]);
  assert.equal(cues.length, 2);
  assert.equal(stats.merged, 0);
});

test('clean: non-adjacent identical cues stay separate', () => {
  const { cues, stats } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', 'No.'),
    cue(2, '00:00:02,040', '00:00:03,000', 'Why?'),
    cue(3, '00:00:03,040', '00:00:04,000', 'No.'),
  ]);
  assert.deepEqual(cues.map((c) => c.index), [1, 2, 3]);
  assert.equal(stats.merged, 0);
});

test('clean: overlapping duplicates merge too', () => {
  const { cues } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', 'Stop!'),
    cue(2, '00:00:01,960', '00:00:03,000', 'Stop!'),
  ]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].timing, '00:00:01,000 --> 00:00:03,000');
});

test('clean: position and timing suffix of the first cue are preserved', () => {
  const first: Cue = {
    index: 7,
    timing: '00:00:01,000 --> 00:00:01,200 X1:40 X2:600 Y1:20 Y2:60',
    lines: ['Hold it.'],
    position: '{\\an8}',
  };
  const second: Cue = { ...first, index: 8, timing: '00:00:01,240 --> 00:00:02,000' };
  const { cues } = cleanCues([first, second]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].index, 7);
  assert.equal(cues[0].position, '{\\an8}');
  assert.equal(cues[0].timing, '00:00:01,000 --> 00:00:02,000 X1:40 X2:600 Y1:20 Y2:60');
});

test('clean: maxGapMs option is honored', () => {
  const pair = [
    cue(1, '00:00:01,000', '00:00:02,000', 'No.'),
    cue(2, '00:00:04,300', '00:00:05,000', 'No.'),
  ];
  assert.equal(cleanCues(pair).cues.length, 2);
  assert.equal(cleanCues(pair, { maxGapMs: 2500 }).cues.length, 1);
});

test('clean: malformed timings never merge', () => {
  const bad: Cue = { index: 1, timing: 'garbage', lines: ['Hi'], position: null };
  const { cues, stats } = cleanCues([bad, { ...bad, index: 2 }]);
  assert.equal(cues.length, 2);
  assert.equal(stats.merged, 0);
});

test('clean: is idempotent on a mixed fixture', () => {
  const input: Cue[] = [
    cue(29, '00:02:19,960', '00:02:21,080', 'Hello.'),
    cue(30, '00:02:21,120', '00:02:21,280', 'Hello.'),
    cue(31, '00:02:21,320', '00:02:22,360', '<font color="#ffff00">WOMAN: (ON PHONE) It\'s Packenham.</font>'),
    cue(32, '00:02:23,600', '00:02:25,360', 'Your name comes up.'),
    cue(33, '00:02:25,400', '00:02:25,560', '<font color="#ffff00">There\'s a PolAir plane</font>'),
    cue(34, '00:02:25,600', '00:02:27,600', '<font color="#ffff00">There\'s a PolAir plane</font>'),
    cue(39, '00:02:30,360', '00:02:31,080', FONT('(CAT MIAOWS)')),
    cue(40, '00:02:31,120', '00:02:31,280', FONT('(CAT MIAOWS)')),
    cue(41, '00:02:31,320', '00:02:33,240', 'Why me?'),
  ];
  const once = cleanCues(input);
  const twice = cleanCues(once.cues);
  assert.deepEqual(twice.cues, once.cues);
  assert.deepEqual(twice.stats, { sdhCues: 0, sdhLines: 0, merged: 0 });
});

test('clean: textually identical lines differing only in tags are not merged', () => {
  const { cues, stats } = cleanCues([
    cue(1, '00:00:01,000', '00:00:02,000', '<i>Really.</i>'),
    cue(2, '00:00:02,040', '00:00:03,000', 'Really.'),
  ]);
  assert.equal(cues.length, 2);
  assert.equal(stats.merged, 0);
});
