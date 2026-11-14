import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayPath, formatCommand, programWords } from '../src/launch.ts';
import type { Launch } from '../src/launch.ts';

test('formatCommand: quotes only what the shell would break', () => {
  const program = ['subs-translate'];
  assert.equal(formatCommand(['movie.srt', '--limit', '5'], program), 'subs-translate movie.srt --limit 5');
  assert.equal(formatCommand(['My Movie.mkv', '--about', ''], program), `subs-translate 'My Movie.mkv' --about ''`);
  assert.equal(formatCommand(["Ocean's 11.srt"], program), `subs-translate 'Ocean'\\''s 11.srt'`);
  assert.equal(formatCommand(['a.srt'], ['node', 'my dir/s.ts']), `node 'my dir/s.ts' a.srt`);
});

const launch = (over: Partial<Launch>): Launch => ({
  argv: ['/usr/bin/node', '/home/u/subs-translator/bin/subs-translate.ts'],
  execPath: '/usr/bin/node',
  execArgv: [],
  cwd: '/home/u/subs-translator',
  pathEnv: '/usr/local/bin:/usr/bin',
  ...over,
});

test('programWords: node script, relative to cwd', () => {
  assert.deepEqual(programWords(launch({})), ['node', 'bin/subs-translate.ts']);
  assert.deepEqual(programWords(launch({ cwd: '/films' })), ['node', '/home/u/subs-translator/bin/subs-translate.ts']);
  assert.deepEqual(programWords(launch({ execArgv: ['--inspect'] })), ['node', '--inspect', 'bin/subs-translate.ts']);
});

test('programWords: npm link / global install found via PATH', () => {
  const argv = ['/usr/bin/node', '/usr/local/bin/subs-translate'];
  assert.deepEqual(programWords(launch({ argv, cwd: '/films' })), ['subs-translate']);
});

test('programWords: bun binary uses execPath, not the embedded script', () => {
  const argv = ['bun', '/$bunfs/root/subs-translate-linux-x64'];
  const execPath = '/home/u/subs-translator/dist/subs-translate-linux-x64';
  assert.deepEqual(programWords(launch({ argv, execPath })), ['dist/subs-translate-linux-x64']);
  assert.deepEqual(programWords(launch({ argv, execPath, cwd: '/home/u/subs-translator/dist' })), [
    './subs-translate-linux-x64',
  ]);
  assert.deepEqual(programWords(launch({ argv, execPath: '/usr/local/bin/subs-translate' })), ['subs-translate']);
});

test('displayPath: relative inside cwd, absolute outside', () => {
  assert.equal(displayPath('/films/a/movie.mkv', '/films'), 'a/movie.mkv');
  assert.equal(displayPath('/other/movie.mkv', '/films'), '/other/movie.mkv');
  assert.equal(displayPath('/films', '/films'), '/films');
});
