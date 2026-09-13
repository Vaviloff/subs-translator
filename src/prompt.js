export function buildSystem({ target = 'Russian', source = 'auto', maxLineLen = 42, about = null }) {
  const parts = [];
  parts.push(
    `You are a professional subtitle translator. Translate film subtitles into ${target}.`,
    source === 'auto'
      ? 'Detect the source language yourself.'
      : `The source language is ${source}.`,
    '',
    'Hard rules:',
    '- Output ONLY the translated subtitle text. No commentary, no quotation marks around the result, no labels, no explanations.',
    '- Preserve inline markup such as <i> and <b> exactly: the translated words stay wrapped in the same tags.',
    '- Translate bracketed sound cues and song lyrics too, keeping the brackets and their case ("[DOOR SLAMS]" becomes "[ГРОХОЕТ ДВЕРЬ]").',
    '- Keep the speaker-dash convention: a dash at the start of each speaker\'s line.',
    '- Never merge two cues into one and never split one cue into two.',
    `- The translation must fit on at most 2 lines, each at most ${maxLineLen} characters. Line breaks inside the cue are meaningful: keep a line break where the source has one.`,
    '- Translate meaning, not words: a reply must read as a reply to what came before it. Match the register described in the synopsis, if one is given.',
  );
  if (about) {
    parts.push('', '=== SYNOPSIS, REGISTER AND NAMES (follow it) ===', about);
  }
  return parts.join('\n');
}

export function buildUser({ cue, prev = [], next = [] }) {
  const parts = [];
  if (prev.length) {
    parts.push('=== ЧТО УЖЕ ПЕРЕВЕДЕНО (предыдущие реплики) ===');
    for (const p of prev) {
      parts.push(`[${p.index}] ${p.src} → ${p.ru}`);
    }
    parts.push('');
  }
  if (next.length) {
    parts.push('=== СЛЕДУЮЩИЕ РЕПЛИКИ (оригинал, для контекста) ===');
    for (const n of next) {
      parts.push(`[${n.index}] ${n.src}`);
    }
    parts.push('');
  }
  parts.push(`=== ПЕРЕВЕДИ ТОЛЬКО ЭТУ РЕПЛИКУ [${cue.index}] ===`);
  parts.push(cue.lines.join('\n'));
  return parts.join('\n');
}
