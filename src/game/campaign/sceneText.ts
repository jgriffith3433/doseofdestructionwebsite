// How story text is shown during play (studio quality rule 6e): never a paragraph, one short line at a time.
// A line from content/campaign.json or content/voice.json is cut into pieces of at most MAX_WORDS words,
// at sentence ends first, then at commas, then evenly; each piece stays up for its share of the voice take
// (or a reading time when there is no take yet). Pure, so `npm test` checks it.

/** The most words a piece of on-screen story text may have. */
export const MAX_WORDS = 10;
/** Reading time per word, plus a moment to look, when a line has no voice take yet. */
const MS_PER_WORD = 300;
const MS_BASE = 700;
const MS_MIN = 1300;
const MS_MAX = 4200;

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/** Cuts `text` into pieces of at most `max` words, preferring sentence ends, then commas. */
export function chunkLine(text: string, max = MAX_WORDS): string[] {
  const out: string[] = [];
  // Sentences, keeping any leading ellipsis ("...I fell off.") with the words after it.
  const sentences = text.trim().match(/[.!?…]*[^.!?…]+(?:[.!?…]+["'”’)]*|$)|[.!?…]+$/g) ?? [text];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (words(s).length <= max) {
      out.push(s);
      continue;
    }
    // Long sentence: split at commas, semicolons and dashes, then pack the parts back up to `max` words.
    const parts = s.split(/(?<=[,;:])\s+|\s+(?=[-–—]\s)/).map((p) => p.trim()).filter(Boolean);
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
    };
    for (const p of parts) {
      const w = words(p);
      if (w.length > max) {
        flush();
        // No comma to cut at: even pieces, none longer than `max`.
        const n = Math.ceil(w.length / max);
        const size = Math.ceil(w.length / n);
        for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size).join(' '));
        continue;
      }
      if (cur.length + w.length > max) flush();
      cur.push(...w);
    }
    flush();
  }
  return out.length ? out : [text.trim()];
}

/**
 * How long each piece stays up, in ms. With a voice take (`voiceMs`), the take is shared by word count, so the
 * text follows the voice; without one, a reading time per piece.
 */
export function chunkTimes(chunks: string[], voiceMs: number | null): number[] {
  const counts = chunks.map((c) => Math.max(1, words(c).length));
  if (voiceMs && voiceMs > 0) {
    const total = counts.reduce((a, b) => a + b, 0);
    // A little air after the take before the next line.
    return counts.map((n, i) => Math.max(700, (voiceMs * n) / total + (i === counts.length - 1 ? 350 : 0)));
  }
  return counts.map((n) => Math.min(MS_MAX, Math.max(MS_MIN, MS_BASE + n * MS_PER_WORD)));
}
