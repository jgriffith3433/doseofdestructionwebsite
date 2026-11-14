// How to play lessons: which are done (localStorage `dod-lessons`, a list of lesson ids), the order they come in, and
// the menu line that counts the campaign from content/campaign.json (never typed).

import { CHAPTERS, SEASONS } from './story.ts';

export type LessonId = 'training' | 'defence' | 'recovery';
export const LESSON_ORDER: readonly LessonId[] = ['training', 'defence', 'recovery'];
export const LESSON_TITLE: Record<LessonId, string> = { training: 'How to play', defence: 'How to play 2', recovery: 'How to play 3' };
const KEY = 'dod-lessons';

export function doneLessons(): Set<LessonId> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set((Array.isArray(raw) ? raw : []).filter((x): x is LessonId => LESSON_ORDER.includes(x)));
  } catch {
    return new Set();
  }
}

export function markLessonDone(id: LessonId): void {
  const s = doneLessons();
  s.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // Storage full or blocked: the tick just won't stay.
  }
}

/** The lesson after this one, or null after the last. */
export function nextLesson(id: LessonId): LessonId | null {
  return LESSON_ORDER[LESSON_ORDER.indexOf(id) + 1] ?? null;
}

/** The Campaign menu line: the real season and episode count. */
export function campaignBlurb(): string {
  const s = SEASONS.length;
  const e = CHAPTERS.length;
  return `${s} season${s === 1 ? '' : 's'}, ${e} episode${e === 1 ? '' : 's'}. One way off the air.`;
}
