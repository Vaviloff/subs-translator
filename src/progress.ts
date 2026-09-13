import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { sourceHash } from './translate.ts';
import { wrap } from './srt.ts';
import type { Cue, ProgressEntry } from './types.ts';

export function sidecarPath(outputPath: string): string {
  return `${outputPath}.progress.jsonl`;
}

export class ProgressStore {
  #fd: number | null = null;
  readonly path: string;
  readonly map = new Map<number, ProgressEntry>();

  constructor(path: string) {
    this.path = path;
  }

  load(): Map<number, ProgressEntry> {
    if (!existsSync(this.path)) return this.map;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as ProgressEntry;
        if (entry && Number.isInteger(entry.i)) {
          this.map.set(entry.i, entry); // last write wins
        }
      } catch {
        // skip a corrupt trailing line rather than losing the rest
      }
    }
    return this.map;
  }

  record(entry: ProgressEntry): void {
    if (this.#fd === null) this.#fd = openSync(this.path, 'a');
    writeSync(this.#fd, JSON.stringify(entry) + '\n');
    this.map.set(entry.i, entry);
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

export function assemble(
  cues: Cue[],
  entries: Map<number, ProgressEntry>,
  { maxLen = 42, maxLines = 2 }: { maxLen?: number; maxLines?: number } = {},
): Cue[] {
  return cues.map((cue) => {
    const src = cue.lines.join('\n');
    const entry = entries.get(cue.index);
    if (!entry || entry.h !== sourceHash(src) || typeof entry.ru !== 'string') {
      return { ...cue };
    }
    return { ...cue, lines: wrap(entry.ru, maxLen, maxLines) };
  });
}
