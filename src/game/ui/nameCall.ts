// The announcer shouts a fighter's name when the cursor (a mouse, a finger, the pad or the keyboard) lands on them in
// the select. Landing is debounced: the name plays once the cursor has stayed 250 ms; a new landing cuts the name that is
// playing and drops the one waiting, so a fast sweep across the grid plays only where it stops. Landing on the same
// fighter again (focus + hover + tap all fire on one tap) does nothing.

import { audio } from '../audio.ts';
import { currentScreen } from './screens.ts';

export const NAME_DEBOUNCE_MS = 250;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending = '';
let last = '';

const emit = (phase: string, id: string): void => {
  try {
    window.dispatchEvent(new CustomEvent('dod:name-call', { detail: { phase, id, at: performance.now() } }));
  } catch {
    // Node tests have no window.
  }
};

/** The cursor landed on this announcer line (`announcer.name.<fighter>`). */
export function landOn(id: string): void {
  if (id === pending || id === last) return;
  if (timer) clearTimeout(timer);
  audio.stopCall();
  last = '';
  pending = id;
  emit('land', id);
  timer = setTimeout(() => {
    timer = null;
    pending = '';
    // The select closed while the name waited: it is not called on another screen.
    if (currentScreen() !== 'select') return;
    last = id;
    emit('play', id);
    void audio.call(id);
  }, NAME_DEBOUNCE_MS);
}

/** The select closed or opened: forget where the cursor was, and stop what is waiting or playing. */
export function resetLanding(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = '';
  last = '';
  audio.stopCall();
}
