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

const TIMING_RE =
  /^(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})(.*)$/;

export interface ParsedTiming {
  startMs: number;
  endMs: number;
  suffix: string;
}

export function parseTiming(timing: string): ParsedTiming | null {
  const m = TIMING_RE.exec(timing.trim());
  if (!m) return null;
  const toMs = (h: string, mi: string, s: string, ms: string): number =>
    ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms);
  return {
    startMs: toMs(m[1], m[2], m[3], m[4]),
    endMs: toMs(m[5], m[6], m[7], m[8]),
    suffix: m[9].trim(),
  };
}

export function formatTiming(startMs: number, endMs: number, suffix = ''): string {
  const fmt = (ms: number): string => {
    const total = Math.max(0, Math.round(ms));
    const millis = String(total % 1000).padStart(3, '0');
    const secs = String(Math.floor(total / 1000) % 60).padStart(2, '0');
    const mins = String(Math.floor(total / 60000) % 60).padStart(2, '0');
    const hours = String(Math.floor(total / 3600000)).padStart(2, '0');
    return `${hours}:${mins}:${secs},${millis}`;
  };
  return `${fmt(startMs)} --> ${fmt(endMs)}${suffix ? ` ${suffix}` : ''}`;
}

const TAG_RE = /<[^>]*>/g;
const TAG_SCAN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^<>]*>/g;
const DASH_RE = /^[-–—]/;

function visibleLen(text: string): number {
  return text.replace(TAG_RE, '').length;
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

function fill(words: string[], limit: number): string[][] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const w of words) {
    const wl = visibleLen(w);
    if (!cur.length) {
      cur = [w];
      len = wl;
    } else if (len + 1 + wl <= limit) {
      cur.push(w);
      len += 1 + wl;
    } else {
      lines.push(cur);
      cur = [w];
      len = wl;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// A line break inside an open tag region would leave the tag unclosed, so the
// tag is closed at the end of the line and re-opened at the start of the next
// one — the rendered text stays identical.
function applyTagBalance(lines: string[][]): string[] {
  const stack: { open: string; name: string }[] = [];
  return lines.map((tokens) => {
    const head = stack.map((t) => t.open).join('');
    for (const token of tokens) {
      for (const m of token.matchAll(TAG_SCAN_RE)) {
        const [full, slash, name] = m;
        if (slash) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].name === name) {
              stack.splice(i, 1);
              break;
            }
          }
        } else if (!full.endsWith('/>')) {
          stack.push({ open: full, name });
        }
      }
    }
    const tail = stack
      .slice()
      .reverse()
      .map((t) => `</${t.name}>`)
      .join('');
    return head + tokens.join(' ') + tail;
  });
}

export function wrap(text: string, maxLen = 42, maxLines = 2): string[] {
  const paragraphs = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!paragraphs.length) return [''];
  const visibles = paragraphs.map(visibleLen);
  // Speaker-dash lines carry dialogue structure: never merge or rebalance them.
  if (paragraphs.some((p) => DASH_RE.test(p))) return paragraphs;
  // Fewest lines possible: if the whole cue fits on one line, it is one line.
  const singleLen = visibles.reduce((a, b) => a + b, 0) + paragraphs.length - 1;
  if (singleLen <= maxLen) {
    return [paragraphs.join(' ')];
  }
  if (
    paragraphs.length <= maxLines &&
    visibles.every((n) => n <= maxLen) &&
    Math.max(...visibles) <= 2 * Math.min(...visibles)
  ) {
    return paragraphs;
  }
  const merged = paragraphs.join(' ');
  const words = tokenize(merged);
  const lineLen = (tokens: string[]): number =>
    tokens.reduce((n, w) => n + visibleLen(w), 0) + Math.max(0, tokens.length - 1);
  const total = lineLen(words);
  for (let k = 1; k <= maxLines; k++) {
    const lines = fill(words, Math.min(Math.ceil(total / k), maxLen));
    if (lines.length <= k && lines.every((toks) => lineLen(toks) <= maxLen)) {
      return applyTagBalance(lines);
    }
  }
  const greedy = fill(words, maxLen);
  if (greedy.length > maxLines) {
    greedy.splice(maxLines - 1, greedy.length, greedy.slice(maxLines - 1).flat());
  }
  return applyTagBalance(greedy);
}
