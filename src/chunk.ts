/** silence interval in seconds, as reported by ffmpeg silencedetect */
export interface Silence {
  start: number;
  end: number;
  duration: number;
}

const START_RE = /silence_start:\s*(-?[\d.]+)/;
const END_RE = /silence_end:\s*(-?[\d.]+)/;

/**
 * Parses ffmpeg silencedetect stderr output. A trailing silence that never
 * gets an `silence_end` line (stream ends in silence) is dropped — a cut
 * there is pointless anyway since the last chunk always ends at `duration`.
 */
export function parseSilences(log: string): Silence[] {
  const silences: Silence[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    if (open === null) {
      const m = START_RE.exec(line);
      if (m) open = Math.max(0, Number(m[1]));
    } else {
      const m = END_RE.exec(line);
      if (m) {
        const end = Number(m[1]);
        if (end > open) silences.push({ start: open, end, duration: end - open });
        open = null;
      }
    }
  }
  return silences;
}

export interface ChunkPlanOptions {
  /** maximum chunk length in seconds (upload-size safety) */
  maxLen?: number;
  /** chunks shorter than this are avoided when a later cut exists */
  minLen?: number;
}

/**
 * Plans chunk boundaries: cuts at silence midpoints when possible (no word
 * ever spans a chunk seam), falls back to a hard cut every `maxLen` seconds
 * when a window has no usable silence. The result tiles [0, duration] exactly.
 */
export function computeChunkBoundaries(
  silences: Silence[],
  duration: number,
  { maxLen = 600, minLen = 90 }: ChunkPlanOptions = {},
): [number, number][] {
  if (!(duration > 0)) return [];
  const midpoints = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((m) => m > 0 && m < duration)
    .sort((a, b) => a - b);

  const chunks: [number, number][] = [];
  let start = 0;
  while (start < duration - 0.01) {
    const limit = start + maxLen;
    if (limit >= duration) {
      chunks.push([start, duration]);
      break;
    }
    // cut as late as possible inside the window so chunks stay big
    let cut = -1;
    for (const m of midpoints) {
      if (m > limit) break;
      if (m > start + minLen) cut = m;
    }
    if (cut < 0) cut = limit;
    chunks.push([start, cut]);
    start = cut;
  }
  return chunks;
}
