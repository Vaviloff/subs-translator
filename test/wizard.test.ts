import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { cleanPathInput, findInputCandidates, readMultiline, toArgv } from '../src/wizard.ts';

test('toArgv: strings, booleans, -o; drops interactive and unset flags', () => {
  assert.deepEqual(
    toArgv('movie.mkv', {
      interactive: true,
      'sub-track': '0',
      out: 'out/ru.srt',
      resume: true,
      'dry-run': false,
      limit: undefined,
      about: '',
    }),
    ['movie.mkv', '--sub-track', '0', '-o', 'out/ru.srt', '--resume', '--about', ''],
  );
});

test('readMultiline: keeps single blank lines, stops at two in a row', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const text = readMultiline('?', { input, output });
  input.write('Synopsis line.\n\nNames:\n- Lucic — Лучич\n\n\nignored after the end\n');
  assert.equal(await text, 'Synopsis line.\n\nNames:\n- Lucic — Лучич');
});

test('readMultiline: end of input (Ctrl+D) finishes the text', async () => {
  const input = new PassThrough();
  const text = readMultiline('?', { input, output: new PassThrough() });
  input.end('one\ntwo\n');
  assert.equal(await text, 'one\ntwo');
});

test('cleanPathInput: trims spaces and quotes from a dropped path', () => {
  assert.equal(cleanPathInput("  '/a/My Movie.mkv' "), '/a/My Movie.mkv');
  assert.equal(cleanPathInput('"/a/b.srt"'), '/a/b.srt');
  assert.equal(cleanPathInput('b.srt'), 'b.srt');
});

test('findInputCandidates: only .srt and video files, sorted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wizard-'));
  try {
    for (const name of ['c.txt', 'b.MKV', 'a.srt', 'd.md']) writeFileSync(path.join(dir, name), '');
    assert.deepEqual(findInputCandidates(dir), ['a.srt', 'b.MKV']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
