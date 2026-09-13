import type { Cue, ParsedSubs } from './types.ts';

const BOM = '\uFEFF';
const BLOCK_SPLIT = /\r?\n\s*\r?\n/;
const OVERRIDES_RE = /^((?:\{\\(?:an\d+|pos|move|fade)\b[^}]*\})+)([\s\S]*)$/;

function decode(buffer: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

export function parse(buffer: Uint8Array): ParsedSubs {
  let text = decode(buffer);
  if (text.startsWith(BOM)) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const eol = crlf >= lf ? '\r\n' : '\n';

  const cues: Cue[] = [];
  let fallbackIndex = 1;
  for (const raw of text.split(BLOCK_SPLIT)) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim());
    while (lines.length && lines[0] === '') lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) continue;

    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    let index = fallbackIndex;
    for (const l of lines.slice(0, timingIdx)) {
      if (/^\d+$/.test(l)) index = Number(l);
    }
    fallbackIndex = index + 1;

    const timing = lines[timingIdx];
    let body = lines.slice(timingIdx + 1);
    let position: string | null = null;
    if (body.length) {
      const m = body[0].match(OVERRIDES_RE);
      if (m) {
        position = m[1];
        const rest = m[2].trim();
        body.shift();
        if (rest) body.unshift(rest);
      }
    }
    cues.push({ index, timing, lines: body, position });
  }
  return { cues, eol };
}

export function serialize(cues: Cue[]): string {
  const blocks = cues.map((cue) =>
    [
      String(cue.index),
      cue.timing,
      (cue.position ?? '') + cue.lines.join('\r\n'),
    ].join('\r\n'),
  );
  return blocks.join('\r\n\r\n') + '\r\n\r\n';
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end !== -1) {
        cur += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function fill(words: string[], limit: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= limit) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function wrap(text: string, maxLen = 42, maxLines = 2): string[] {
  const paragraphs = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!paragraphs.length) return [''];
  if (paragraphs.length <= maxLines && paragraphs.every((p) => p.length <= maxLen)) {
    return paragraphs;
  }
  const merged = paragraphs.join(' ');
  const words = tokenize(merged);
  for (let k = 1; k <= maxLines; k++) {
    const lines = fill(words, Math.min(Math.ceil(merged.length / k), maxLen));
    if (lines.length <= k && lines.every((l) => l.length <= maxLen)) return lines;
  }
  const greedy = fill(words, maxLen);
  if (greedy.length > maxLines) {
    greedy.splice(maxLines - 1, greedy.length, greedy.slice(maxLines - 1).join(' '));
  }
  return greedy;
}
