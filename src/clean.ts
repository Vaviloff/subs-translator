import { formatTiming, parseTiming } from './srt.ts';
import type { Cue } from './types.ts';

export interface CleanOptions {
  maxGapMs?: number;
}

export interface CleanStats {
  sdhCues: number;
  sdhLines: number;
  merged: number;
}

export interface CleanResult {
  cues: Cue[];
  stats: CleanStats;
}

const TAG_RE = /<[^>]*>/g;
const SDH_SPANS = [/\([^<>()]*\)/g, /\[[^\[\]<>]*\]/g];

function stripSdh(line: string): string {
  let cur = line;
  let removed = false;
  for (;;) {
    const next = cur.replace(SDH_SPANS[0], '').replace(SDH_SPANS[1], '');
    if (next === cur) break;
    cur = next;
    removed = true;
  }
  if (!removed) return line;
  return cur.replace(/\s+/g, ' ').trim();
}

function visible(line: string): string {
  return line.replace(TAG_RE, '').trim();
}

export function cleanCues(cues: Cue[], { maxGapMs = 1000 }: CleanOptions = {}): CleanResult {
  const stats: CleanStats = { sdhCues: 0, sdhLines: 0, merged: 0 };

  const noSdh: Cue[] = [];
  for (const cue of cues) {
    const lines: string[] = [];
    let changed = 0;
    for (const line of cue.lines) {
      const stripped = stripSdh(line);
      if (stripped === line) {
        lines.push(line);
        continue;
      }
      changed += 1;
      if (visible(stripped) !== '') lines.push(stripped);
    }
    if (!lines.length) {
      if (changed) stats.sdhCues += 1;
      continue;
    }
    stats.sdhLines += changed;
    noSdh.push({ ...cue, lines });
  }

  const merged: Cue[] = [];
  for (const cue of noSdh) {
    const last = merged[merged.length - 1];
    if (last && last.lines.join('\n') === cue.lines.join('\n')) {
      const cur = parseTiming(last.timing);
      const nxt = parseTiming(cue.timing);
      if (cur && nxt && nxt.startMs - cur.endMs <= maxGapMs) {
        merged[merged.length - 1] = {
          ...last,
          timing: formatTiming(cur.startMs, Math.max(cur.endMs, nxt.endMs), cur.suffix),
        };
        stats.merged += 1;
        continue;
      }
    }
    merged.push(cue);
  }

  return { cues: merged, stats };
}
