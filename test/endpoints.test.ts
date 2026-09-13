import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEndpoints, createPool } from '../src/endpoints.ts';
import { translateCue } from '../src/translate.ts';
import type { RetryInfo } from '../src/translate.ts';

function tempFile(content?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'subs-endpoints-'));
  const file = path.join(dir, 'endpoints.json');
  if (content !== undefined) writeFileSync(file, content);
  return { dir, file };
}

function stubClient(responses: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (body: unknown) => {
          calls.push(body as Record<string, unknown>);
          const next = responses.shift();
          if (next === undefined) throw new Error('stub exhausted');
          if (typeof next === 'function') return next();
          return next;
        },
      },
    },
  };
}

const fakeClient = {
  chat: {
    completions: {
      create: async () => undefined,
    },
  },
};

const ok = (text: string) => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});

const fail = (errProps: Record<string, unknown>) => () => {
  throw Object.assign(new Error(String(errProps.code ?? 'boom')), errProps);
};

test('loadEndpoints: parses entries, resolves env: keys, fills defaults', () => {
  process.env.SUBS_TEST_KEY_XYZ = 'secret';
  const { dir, file } = tempFile(
    JSON.stringify([
      { baseUrl: 'https://a.example/v1', model: 'm1', apiKey: 'env:SUBS_TEST_KEY_XYZ' },
      { name: 'b', baseUrl: 'https://b.example/v1', model: 'm2', apiKey: 'literal', extraBody: { temperature: 0.1 } },
    ]),
  );
  const list = loadEndpoints(file);
  assert.equal(list[0].name, 'm1');
  assert.equal(list[0].apiKey, 'secret');
  assert.equal(list[1].apiKey, 'literal');
  assert.deepEqual(list[1].extraBody, { temperature: 0.1 });
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SUBS_TEST_KEY_XYZ;
});

test('loadEndpoints: rejects missing env var, missing fields, bad JSON, empty array', () => {
  const { dir, file } = tempFile(JSON.stringify([{ baseUrl: 'https://a', model: 'm', apiKey: 'env:SUBS_TEST_MISSING_QQQ' }]));
  assert.throws(() => loadEndpoints(file), /SUBS_TEST_MISSING_QQQ is not set/);

  writeFileSync(file, JSON.stringify([{ model: 'm' }]));
  assert.throws(() => loadEndpoints(file), /"baseUrl" and "model" are required/);

  writeFileSync(file, '{oops');
  assert.throws(() => loadEndpoints(file), /not valid JSON/);

  writeFileSync(file, '[]');
  assert.throws(() => loadEndpoints(file), /non-empty JSON array/);
  rmSync(dir, { recursive: true, force: true });
});

test('pool: strict round-robin order, disable skips, all-dead returns null', () => {
  const pool = createPool([
    { name: 'a', model: 'm', client: fakeClient },
    { name: 'b', model: 'm', client: fakeClient },
    { name: 'c', model: 'm', client: fakeClient },
  ]);
  assert.deepEqual(
    [pool.next(), pool.next(), pool.next(), pool.next()].map((e) => e!.name),
    ['a', 'b', 'c', 'a'],
  );
  pool.disable('b');
  assert.equal(pool.aliveCount(), 2);
  assert.deepEqual(
    [pool.next(), pool.next(), pool.next()].map((e) => e!.name),
    ['c', 'a', 'c'],
  );
  pool.disable('a');
  pool.disable('c');
  assert.equal(pool.next(), null);
  assert.equal(pool.aliveCount(), 0);
});

test('translateCue over a pool: consecutive calls rotate endpoints', async () => {
  const a = stubClient([ok('x1'), ok('x2')]);
  const b = stubClient([ok('y1')]);
  const pool = createPool([
    { name: 'a', model: 'ma', client: a },
    { name: 'b', model: 'mb', client: b },
  ]);
  const one = await translateCue(pool, { system: 's', user: 'u', source: 'src' });
  const two = await translateCue(pool, { system: 's', user: 'u', source: 'src' });
  assert.equal(one.endpoint, 'a');
  assert.equal(one.model, 'ma');
  assert.equal(two.endpoint, 'b');
  assert.deepEqual(a.calls.length, 1);
  assert.deepEqual(b.calls.length, 1);
});

test('translateCue: retryable failure rotates to the next endpoint, Retry-After honored', async () => {
  const a = stubClient([fail({ status: 429, message: 'slow down', headers: new Map([['retry-after', '0']]) })]);
  const b = stubClient([ok('from-b')]);
  const pool = createPool([
    { name: 'a', model: 'ma', client: a },
    { name: 'b', model: 'mb', client: b },
  ]);
  const retries: RetryInfo[] = [];
  const res = await translateCue(pool, {
    system: 's',
    user: 'u',
    source: 'src',
    delays: [0, 0, 0, 0, 0],
    onRetry: (r) => retries.push(r),
  });
  assert.equal(res.text, 'from-b');
  assert.equal(res.endpoint, 'b');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(pool.aliveCount(), 2, 'a single 429 must not disable the endpoint');
  assert.equal(retries[0].endpoint, 'a');
});

test('translateCue: non-retryable error disables the endpoint and continues on the rest', async () => {
  const a = stubClient([fail({ status: 401, message: 'bad key' })]);
  const b = stubClient([ok('from-b')]);
  const pool = createPool([
    { name: 'a', model: 'ma', client: a },
    { name: 'b', model: 'mb', client: b },
  ]);
  const warnings: string[] = [];
  const res = await translateCue(pool, {
    system: 's',
    user: 'u',
    source: 'src',
    delays: [0, 0, 0, 0, 0],
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(res.text, 'from-b');
  assert.ok(a.calls[0].model === 'ma');
  assert.equal(pool.aliveCount(), 1);
  assert.match(warnings[0], /endpoint a отключён.*HTTP 401/);
});

test('translateCue: five consecutive failures retire an endpoint', async () => {
  const a = stubClient(Array.from({ length: 5 }, () => fail({ status: 429, message: 'limit', headers: new Map([['retry-after', '0']]) })));
  const b = stubClient(Array.from({ length: 6 }, () => ok('fine')));
  const pool = createPool([
    { name: 'a', model: 'ma', client: a },
    { name: 'b', model: 'mb', client: b },
  ]);
  const warnings: string[] = [];
  const opts = {
    system: 's',
    user: 'u',
    source: 'src',
    delays: [0, 0, 0, 0, 0],
    onWarn: (m: string) => warnings.push(m),
  };
  for (let i = 0; i < 6; i++) {
    const res = await translateCue(pool, opts);
    assert.equal(res.text, 'fine');
  }
  assert.equal(a.calls.length, 5, 'one failure per cue until retired');
  assert.equal(pool.aliveCount(), 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /endpoint a отключён/);
});

test('translateCue: when every endpoint dies, the run aborts with the cause', async () => {
  const a = stubClient([fail({ status: 401, message: 'bad key a' })]);
  const b = stubClient([fail({ status: 404, message: 'no such model' })]);
  const pool = createPool([
    { name: 'a', model: 'ma', client: a },
    { name: 'b', model: 'mb', client: b },
  ]);
  await assert.rejects(
    translateCue(pool, { system: 's', user: 'u', source: 'src', delays: [0, 0, 0, 0, 0] }),
    (err) => err instanceof Error && /все endpoints вышли из строя/.test(err.message) && /HTTP 404/.test(err.message),
  );
  assert.equal(pool.aliveCount(), 0);
});
