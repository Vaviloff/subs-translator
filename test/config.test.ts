import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aboutCandidates, discoverAbout } from '../src/config.ts';

test('aboutCandidates: same name as the input, .txt then .md', () => {
  assert.deepEqual(aboutCandidates('/films/movie.mkv'), ['/films/movie.txt', '/films/movie.md']);
  assert.deepEqual(aboutCandidates('/films/movie.en.srt'), ['/films/movie.en.txt', '/films/movie.en.md']);
});

test('discoverAbout: picks movie.txt over movie.md, ignores movie.about.md', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'about-'));
  try {
    const video = path.join(dir, 'movie.mkv');
    writeFileSync(path.join(dir, 'movie.about.md'), 'old');
    assert.equal(discoverAbout(video), null);
    writeFileSync(path.join(dir, 'movie.md'), 'from md\n');
    assert.equal(discoverAbout(video), 'from md');
    writeFileSync(path.join(dir, 'movie.txt'), 'from txt\n');
    assert.equal(discoverAbout(video), 'from txt');
    assert.equal(discoverAbout(video, { about: '' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
