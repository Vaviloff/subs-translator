import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { sourceHash } from './translate.js';
import { wrap } from './srt.js';

export function sidecarPath(outputPath) {
  return `${outputPath}.progress.jsonl`;
}

export class ProgressStore {
  #fd = null;

  constructor(path) {
    this.path = path;
    this.map = new Map();
  }

  load() {
    if (!existsSync(this.path)) return this.map;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && Number.isInteger(entry.i)) {
          this.map.set(entry.i, entry); // last write wins
        }
      } catch {
        // skip a corrupt trailing line rather than losing the rest
      }
    }
    return this.map;
  }

  record(entry) {
    if (this.#fd === null) this.#fd = openSync(this.path, 'a');
    writeSync(this.#fd, JSON.stringify(entry) + '\n');
    this.map.set(entry.i, entry);
  }

  close() {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

export function assemble(cues, entries, { maxLen = 42, maxLines = 2 } = {}) {
  return cues.map((cue) => {
    const src = cue.lines.join('\n');
    const entry = entries.get(cue.index);
    if (!entry || entry.h !== sourceHash(src) || typeof entry.ru !== 'string') {
      return { ...cue };
    }
    return { ...cue, lines: wrap(entry.ru, maxLen, maxLines) };
  });
}
