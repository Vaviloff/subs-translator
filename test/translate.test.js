import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitize, sourceHash, translateCue, TranslationError } from '../src/translate.js';

function stubClient(responses) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.push(body);
          const next = responses.shift();
          if (typeof next === 'function') return next();
          return next;
        },
      },
    },
  };
}

function completion(text) {
  return {
    choices: [{ message: { content: text, reasoning_content: 'internal chatter' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

test('sourceHash: 12 hex chars, stable', () => {
  const h = sourceHash('He didn\'t <i>leave</i>.\nHe was taken.');
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(h, sourceHash('He didn\'t <i>leave</i>.\nHe was taken.'));
  assert.notEqual(h, sourceHash('other'));
});

test('sanitize: plain text passes through', () => {
  assert.deepEqual(sanitize('Он не <i>уходил</i>.\nЕго забрали.', 'He left.'), {
    ok: true,
    text: 'Он не <i>уходил</i>.\nЕго забрали.',
  });
});

test('sanitize: strips code fences, wrapping quotes and labels', () => {
  assert.equal(sanitize('```\nПривет\n```', 'Hi').text, 'Привет');
  assert.equal(sanitize('«Привет»', 'Hi').text, 'Привет');
  assert.equal(sanitize('**Translation:** Привет', 'Hi').text, 'Привет');
  assert.equal(sanitize('Перевод: Привет', 'Hi').text, 'Привет');
});

test('sanitize: rejects empty, meta and overlong output', () => {
  assert.equal(sanitize('   ', 'Hi').ok, false);
  assert.equal(sanitize("Here is the translation: Привет", 'Hi').ok, false);
  assert.equal(sanitize('Как ИИ, я не могу...', 'Hi').ok, false);
  const long = 'д'.repeat(41);
  assert.equal(sanitize(long, 'x').ok, false);
  assert.equal(sanitize('д'.repeat(30), 'x').ok, true);
  assert.equal(sanitize('д'.repeat(200), 'Hello there, this is a normal cue').ok, false);
});

test('translateCue: happy path ignores reasoning_content, sums usage', async () => {
  const client = stubClient([completion('Привет')]);
  const { text, usage } = await translateCue(client, {
    model: 'm',
    system: 's',
    user: 'u',
    source: 'Hi',
  });
  assert.equal(text, 'Привет');
  assert.deepEqual(usage, { in: 10, out: 5 });
  assert.equal(client.calls.length, 1);
});

test('translateCue: rejected output triggers exactly one stricter retry', async () => {
  const client = stubClient([
    completion('Here is the translation: Привет'),
    completion('Привет'),
  ]);
  const { text } = await translateCue(client, {
    model: 'm',
    system: 's',
    user: 'u',
    source: 'Hi',
  });
  assert.equal(text, 'Привет');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.at(-1).content, 'Верни только текст реплики.');
});

test('translateCue: rejected output after the nudge fails hard', async () => {
  const client = stubClient([
    completion('Here is the translation: Привет'),
    completion('Here is the translation: Привет'),
  ]);
  await assert.rejects(
    translateCue(client, { model: 'm', system: 's', user: 'u', source: 'Hi' }),
    TranslationError,
  );
  assert.equal(client.calls.length, 2);
});

test('translateCue: 4xx aborts immediately with the provider message', async () => {
  const client = stubClient([
    () => {
      throw Object.assign(new Error('Incorrect API key'), { status: 401 });
    },
  ]);
  await assert.rejects(
    translateCue(client, { model: 'm', system: 's', user: 'u', source: 'Hi' }),
    (err) => err instanceof TranslationError && /HTTP 401/.test(err.message) && /Incorrect API key/.test(err.message),
  );
  assert.equal(client.calls.length, 1);
});

test('translateCue: retries 5xx and honors Retry-After', async () => {
  const client = stubClient([
    () => {
      throw Object.assign(new Error('slow down'), {
        status: 429,
        headers: new Map([['retry-after', '0']]),
      });
    },
    completion('Привет'),
  ]);
  const { text } = await translateCue(client, {
    model: 'm',
    system: 's',
    user: 'u',
    source: 'Hi',
    delays: [0, 0, 0, 0, 0],
  });
  assert.equal(text, 'Привет');
  assert.equal(client.calls.length, 2);
});

test('translateCue: connection errors are retried, exhaustion throws', async () => {
  const client = stubClient(
    Array.from({ length: 5 }, () => () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }),
  );
  await assert.rejects(
    translateCue(client, {
      model: 'm',
      system: 's',
      user: 'u',
      source: 'Hi',
      delays: [0, 0, 0, 0, 0],
    }),
    TranslationError,
  );
  assert.equal(client.calls.length, 5);
});
