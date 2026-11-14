import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { workDir } from '../src/config.ts';
import {
  audioBasePath,
  mergeSegmentChunks,
  parseVerboseJson,
  resolveSttConfig,
  segmentsToCues,
  splitSegmentsForSubtitles,
} from '../src/stt.ts';
import { parseTiming } from '../src/srt.ts';
import type { SegChunk, TranscribeOutcome, WhisperWord } from '../src/stt.ts';

const outcome = (segments: [number, number, string][], words: WhisperWord[] = [], language = 'english'): TranscribeOutcome => ({
  segments: segments.map(([start, end, text]) => ({ start, end, text })),
  words,
  language,
  duration: segments.length ? segments[segments.length - 1][1] : 0,
});

test('parseVerboseJson: segments parsed, whitespace collapsed, invalid dropped', () => {
  const raw = {
    text: ' Hello world. ',
    language: 'english',
    duration: 10.5,
    segments: [
      { start: 0, end: 2.5, text: '  Hello   world. ' },
      { start: 2.5, end: 2.5, text: 'zero length' },
      { start: 3, end: 2, text: 'reversed' },
      { start: 4, end: 6, text: '' },
      { start: 7, end: 9, text: 'Fine.' },
      { start: 'x', end: 3, text: 'NaN start' },
    ],
  };
  const res = parseVerboseJson(raw);
  assert.deepEqual(res.segments, [
    { start: 0, end: 2.5, text: 'Hello world.' },
    { start: 7, end: 9, text: 'Fine.' },
  ]);
  assert.equal(res.language, 'english');
  assert.equal(res.duration, 10.5);
});

test('parseVerboseJson: words sanitized, missing words → []', () => {
  const res = parseVerboseJson({
    segments: [{ start: 0, end: 2, text: 'Hi there.' }],
    words: [
      { word: ' Hi', start: 0, end: 0.5 },
      { word: 'there.', start: 0.6, end: 2 },
      { word: '', start: 2, end: 2.1 },
      { word: 'bad', start: 'x', end: 3 },
    ],
  });
  assert.deepEqual(res.words, [
    { word: 'Hi', start: 0, end: 0.5 },
    { word: 'there.', start: 0.6, end: 2 },
  ]);
  assert.deepEqual(parseVerboseJson({ segments: [{ start: 0, end: 1, text: 'Hi.' }] }).words, []);
});

test('parseVerboseJson: no segments but text → single fallback segment', () => {
  const res = parseVerboseJson({ text: 'All of it.', language: 'english', duration: null, segments: null }, 5);
  assert.deepEqual(res.segments, [{ start: 0, end: 5, text: 'All of it.' }]);
  assert.equal(res.duration, null);
});

test('parseVerboseJson: garbage and silence yield no segments', () => {
  assert.deepEqual(parseVerboseJson(null).segments, []);
  assert.deepEqual(parseVerboseJson({}).segments, []);
  assert.deepEqual(parseVerboseJson({ text: '  ', segments: [] }).segments, []);
});

const chunk = (startSec: number, segments: [number, number, string][], words: WhisperWord[] = []): SegChunk => ({
  startSec,
  outcome: outcome(segments, words),
});

test('mergeSegmentChunks: offsets chunks to absolute time', () => {
  const merged = mergeSegmentChunks(
    [chunk(600, [[0, 2, 'six hundred'], [2, 4, 'and on']]), chunk(0, [[0, 1.5, 'opening'], [1.5, 3, 'line']])],
    1000,
  );
  assert.deepEqual(
    merged.segments.map((s) => [s.start, s.end, s.text]),
    [
      [0, 1.5, 'opening'],
      [1.5, 3, 'line'],
      [600, 602, 'six hundred'],
      [602, 604, 'and on'],
    ],
  );
});

test('mergeSegmentChunks: seam overlap clamped to previous end, tail clamped to duration', () => {
  const merged = mergeSegmentChunks(
    [chunk(0, [[0, 3, 'a']]), chunk(2.5, [[0, 2, 'b spillover'], [2.2, 4, 'c spillover'], [5, 7, 'd']])],
    6,
  );
  assert.deepEqual(
    merged.segments.map((s) => [s.start, s.end, s.text]),
    [
      [0, 3, 'a'],
      [3, 4.5, 'b spillover'],
      [4.7, 6, 'c spillover'],
    ],
  );
});

test('mergeSegmentChunks: words offset and ordered across chunks', () => {
  const merged = mergeSegmentChunks(
    [
      chunk(10, [[0, 2, 'b words']], [
        { word: 'b', start: 0, end: 0.5 },
        { word: 'words', start: 0.6, end: 1.8 },
      ]),
      chunk(0, [[0, 2, 'a word']], [
        { word: 'a', start: 0, end: 0.4 },
        { word: 'word', start: 0.5, end: 1.9 },
      ]),
    ],
    100,
  );
  assert.deepEqual(merged.words.map((w) => [w.word, w.start]), [
    ['a', 0],
    ['word', 0.5],
    ['b', 10],
    ['words', 10.6],
  ]);
});

const word = (text: string, start: number, end: number): WhisperWord => ({ word: text, start, end });

test('splitSegmentsForSubtitles: short segments pass through untouched', () => {
  const segs = outcome([[0, 3, 'Short and sweet.'], [4, 6, 'Also fine.']]).segments;
  assert.deepEqual(splitSegmentsForSubtitles(segs, []), segs);
});

test('splitSegmentsForSubtitles: prefers sentence punctuation nearest the middle', () => {
  const seg: [number, number, string] = [0, 10, 'One two three four. Five six seven eight. Nine ten.'];
  const [a, b] = splitSegmentsForSubtitles(outcome([seg]).segments, []);
  // both sentence ends are legal; the one with balanced halves wins (k=4)
  assert.equal(a.text, 'One two three four.');
  assert.equal(b.text, 'Five six seven eight. Nine ten.');
  assert.equal(a.end, 4); // proportional fallback tiles uniformly: [0..4] + [4..10]
  assert.equal(b.start, 4);
});

test('splitSegmentsForSubtitles: word gaps decide when there is no punctuation', () => {
  const tokens = (
    'No sir And my hearing is above average No backup unit breaking down the door ' +
    'No military vehicles rushing to the rescue'
  ).split(' ');
  const words: WhisperWord[] = [];
  let t = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (i === 15) t += 0.9; // speech pause before "No military…"
    words.push(word(tokens[i], t, t + 0.4));
    t += 0.5;
  }
  const seg: [number, number, string] = [0, words[words.length - 1].end, tokens.join(' ')];
  assert.ok(seg[1] - seg[0] > 7.5 && seg[2].length > 84, 'fixture must be over-long');

  const pieces = splitSegmentsForSubtitles(outcome([seg]).segments, words);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0].text.endsWith('the door'));
  assert.equal(pieces[1].text, 'No military vehicles rushing to the rescue');
  assert.equal(pieces[0].end, words[14].end); // seam sits in the real pause
  assert.equal(pieces[1].start, words[15].start);
});

test('splitSegmentsForSubtitles: recurses until every cue is within limits', () => {
  const sentence = (n: number): string => `Sentence number ${n} ends here.`;
  const text = Array.from({ length: 10 }, (_, i) => sentence(i + 1)).join(' ');
  const seg: [number, number, string] = [100, 160, text];
  const pieces = splitSegmentsForSubtitles(outcome([seg]).segments, []);
  assert.ok(pieces.length >= 4);
  for (const p of pieces) {
    assert.ok(p.end - p.start <= 7.5 + 0.01, `duration ${p.end - p.start}`);
    assert.ok(p.text.length <= 84, `chars ${p.text.length}`);
    assert.match(p.text, /\.$/);
  }
  // tiles the original segment exactly
  assert.equal(pieces[0].start, 100);
  assert.equal(pieces[pieces.length - 1].end, 160);
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].start, pieces[i - 1].end);
  assert.equal(pieces.map((p) => p.text).join(' '), text);
});

test('splitSegmentsForSubtitles: char-overlong but short segment still splits at any boundary', () => {
  const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '); // ~276 chars
  const pieces = splitSegmentsForSubtitles(outcome([[0, 2, text]]).segments, []);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) assert.ok(p.text.length <= 84, `chars ${p.text.length}`);
});

test('splitSegmentsForSubtitles: single-word and unsplittable segments stay intact', () => {
  const segs = [{ start: 0, end: 9, text: 'Supercalifragilisticexpialidocious' }];
  assert.deepEqual(splitSegmentsForSubtitles(segs, []), segs);
});

test('splitSegmentsForSubtitles: sparse cue over music is trimmed to its word span', () => {
  // two spoken words, whole 30 s decode window as the segment — trim, not split
  const words = [word('Package', 535.2, 535.7), word('delivered.', 535.8, 536.4)];
  const pieces = splitSegmentsForSubtitles(outcome([[535, 562.3, 'Package delivered.']]).segments, words);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].text, 'Package delivered.');
  assert.equal(pieces[0].start, 535); // clamped to the original bound
  assert.equal(pieces[0].end, 536.9); // last word + 0.5 s padding
});

test('splitSegmentsForSubtitles: dense speech is not trimmed', () => {
  const words = [word('Hello', 10, 10.4), word('world.', 10.5, 11.9)];
  const segs = [{ start: 9.9, end: 12.1, text: 'Hello world.' }];
  assert.deepEqual(splitSegmentsForSubtitles(segs, words), segs); // span diff < 2 s
});

test('splitSegmentsForSubtitles: degenerate word timings (hallucination over music) are clamped', () => {
  // Whisper gave "Oh," a 29.8 s duration — no real word lasts that long
  const words = [word('Oh,', 415, 444.82), word('God.', 444.82, 444.92)];
  const pieces = splitSegmentsForSubtitles(outcome([[415, 444.98, 'Oh, God.']]).segments, words);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].text, 'Oh, God.');
  assert.equal(pieces[0].end, 418); // start + max(3, chars/3)
});

test('segmentsToCues: numbered cues with SRT timing', () => {
  const cues = segmentsToCues(outcome([[0.5, 2.25, 'Hi'], [3, 4, 'Yo']]).segments);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((c) => c.index), [1, 2]);
  assert.equal(cues[0].timing, '00:00:00,500 --> 00:00:02,250');
  assert.deepEqual(cues[0].lines, ['Hi']);
  assert.equal(cues[0].position, null);
  const t = parseTiming(cues[1].timing);
  assert.equal(t?.startMs, 3000);
  assert.equal(t?.endMs, 4000);
});

test('audioBasePath: in the temp work dir, video extension stripped, track number embedded', () => {
  const dir = workDir('/a/movie.mkv');
  assert.equal(audioBasePath('/a/movie.mkv', 0), path.join(dir, 'movie.audio0'));
  assert.equal(audioBasePath('/a/Movie [id].mp4', 1), path.join(dir, 'Movie [id].audio1'));
  assert.equal(audioBasePath('/a/movie', 2), path.join(dir, 'movie.audio2'));
});

test('resolveSttConfig: flags beat env, empty env values count as unset, GROQ_API_TOKEN is the key fallback', () => {
  const saved = { ...process.env };
  try {
    process.env.STT_API_KEY = 'env-key';
    process.env.STT_BASE_URL = 'http://env-url/v1';
    process.env.STT_MODEL = 'env-model';
    process.env.GROQ_API_TOKEN = 'groq-token';

    assert.deepEqual(resolveSttConfig(), {
      apiKey: 'env-key',
      baseUrl: 'http://env-url/v1',
      model: 'env-model',
      language: undefined,
    });
    assert.deepEqual(resolveSttConfig({ apiKey: 'flag', baseUrl: 'http://flag/v1', model: 'flag-model' }), {
      apiKey: 'flag',
      baseUrl: 'http://flag/v1',
      model: 'flag-model',
      language: undefined,
    });

    // .env.example state: STT_* empty → GROQ token engages, Groq defaults apply
    process.env.STT_API_KEY = '';
    process.env.STT_BASE_URL = '';
    process.env.STT_MODEL = '';
    const cfg = resolveSttConfig();
    assert.equal(cfg.apiKey, 'groq-token');
    assert.equal(cfg.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(cfg.model, null);
    assert.equal(resolveSttConfig({ language: '  en ' }).language, 'en');
  } finally {
    process.env = saved;
  }
});
