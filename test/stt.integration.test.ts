import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_STT_BASE_URL, assertSttConfig, createSttClient, resolveSttConfig, transcribeChunk } from '../src/stt.ts';

// gated: runs only when an STT key is configured (see .env.example) and ffmpeg exists
try {
  process.loadEnvFile();
} catch {
  // missing .env is fine
}
const cfg = resolveSttConfig();
const hasKey = Boolean(cfg.apiKey && cfg.model);
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const skip = !hasKey ? 'STT_API_KEY/GROQ_API_TOKEN + STT_MODEL not configured' : !hasFfmpeg ? 'ffmpeg not installed' : false;

test(
  'integration: real STT endpoint round-trip on a generated tone',
  { skip },
  async () => {
    assertSttConfig(cfg);
    const dir = mkdtempSync(path.join(tmpdir(), 'subs-stt-'));
    try {
      // a 1.5 s tone — no speech, but the full request/response path is exercised
      const flac = path.join(dir, 'tone.flac');
      const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ar', '16000', '-ac', '1', '-c:a', 'flac', flac], {
        encoding: 'buffer',
      });
      assert.equal(enc.status, 0, `ffmpeg failed: ${enc.stderr?.toString()}`);

      const client = createSttClient({ apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl || DEFAULT_STT_BASE_URL });
      const outcome = await transcribeChunk(client, {
        model: cfg.model!,
        data: new Uint8Array(readFileSync(flac)),
        filename: 'tone.flac',
        fallbackDuration: 1.5,
      });
      // a tone may transcribe to nothing or to a hallucinated segment — shape is the contract
      assert.ok(Array.isArray(outcome.segments));
      for (const s of outcome.segments) {
        assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
        assert.ok(s.text.length > 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
