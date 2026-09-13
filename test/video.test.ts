import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractSubtitle,
  extractedPath,
  formatTrackList,
  listSubtitleStreams,
  parseFfprobeStreams,
} from '../src/video.ts';
import { parse } from '../src/srt.ts';

const fixture = JSON.stringify({
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    {
      index: 2,
      codec_type: 'subtitle',
      codec_name: 'subrip',
      tags: { language: 'eng', title: 'Full' },
      disposition: { default: 1, forced: 0, comment: 0 },
    },
    { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'jpn' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'ass', disposition: { forced: 1 } },
  ],
});

test('parseFfprobeStreams: keeps subtitles only, numbers them relative, detects bitmap', () => {
  const streams = parseFfprobeStreams(fixture);
  assert.deepEqual(
    streams.map((s) => [s.track, s.codecName, s.isBitmap]),
    [
      [0, 'subrip', false],
      [1, 'hdmv_pgs_subtitle', true],
      [2, 'ass', false],
    ],
  );
  assert.equal(streams[0].language, 'eng');
  assert.equal(streams[0].title, 'Full');
  assert.equal(streams[0].isDefault, true);
  assert.equal(streams[0].isForced, false);
  assert.equal(streams[1].language, 'jpn');
  assert.equal(streams[1].title, null);
  assert.equal(streams[2].language, null);
  assert.equal(streams[2].title, null);
  assert.equal(streams[2].isForced, true);
});

test('parseFfprobeStreams: empty selection and garbage input', () => {
  assert.deepEqual(parseFfprobeStreams(JSON.stringify({ streams: [{ codec_type: 'video' }] })), []);
  assert.throws(() => parseFfprobeStreams('{oops'), /invalid JSON/);
  assert.throws(() => parseFfprobeStreams('{}'), /no streams array/);
});

test('formatTrackList: track, codec, lang, title, markers, bitmap note', () => {
  const lines = formatTrackList(parseFfprobeStreams(fixture));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ 0  subrip  \[eng\]  Full  \(default\)$/);
  assert.match(lines[1], /^ 1  hdmv_pgs_subtitle  \[jpn\]/);
  assert.match(lines[1], /растровые/);
  assert.match(lines[2], /ass  \(forced\)$/);
  assert.doesNotMatch(lines[2], /растровые/);
});

test('extractedPath: embeds track and language, skips junk metadata', () => {
  assert.equal(extractedPath('/a/movie.mkv', 0, 'eng'), '/a/movie.track0.eng.srt');
  assert.equal(extractedPath('/a/movie.mkv', 2, null), '/a/movie.track2.srt');
  assert.equal(extractedPath('/a/movie.mkv', 1, 'und'), '/a/movie.track1.srt');
  assert.equal(extractedPath('/a/movie.mkv', 1, 'not a lang!'), '/a/movie.track1.srt');
  assert.equal(extractedPath('/a/movie.mkv', 3, 'en-US'), '/a/movie.track3.en-us.srt');
  assert.equal(extractedPath('/a/movie', 0, 'RU'), '/a/movie.track0.ru.srt');
});

const toolOk = (tool: string) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfmpeg = toolOk('ffmpeg') && toolOk('ffprobe');

test(
  'integration: list + extract embedded srt from a generated mkv',
  { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe not installed' },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'subs-video-'));
    try {
      const srtFile = path.join(dir, 'subs.srt');
      writeFileSync(srtFile, '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n');
      const video = path.join(dir, 'video.mkv');
      const enc = spawnSync(
        'ffmpeg',
        [
          '-v', 'error', '-y',
          '-f', 'lavfi', '-i', 'color=black:size=160x120:rate=5:duration=2',
          '-i', srtFile,
          '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'srt',
          video,
        ],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );
      assert.equal(enc.status, 0, `ffmpeg mux failed: ${enc.stderr?.toString()}`);

      const streams = listSubtitleStreams(video);
      assert.equal(streams.length, 1);
      assert.equal(streams[0].track, 0);
      assert.equal(streams[0].codecName, 'subrip');
      assert.equal(streams[0].isBitmap, false);

      const data = extractSubtitle(video, 0);
      assert.deepEqual(
        parse(data).cues.map((c) => c.lines.join(' ')),
        ['Hello', 'World'],
      );

      assert.throws(() => extractSubtitle(video, 5), /track 5/);
      assert.throws(() => listSubtitleStreams(path.join(dir, 'nope.mkv')), /could not read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
