// The show's opening titles (docs/story.md "The opening"): a 30 s film (audio/opening.webm, 720p WebM, the theme song in
// its audio) of six cast shots cut to the beat, a name lower third per fighter drawn here in code, and the logo slamming in
// on the last hit. It plays once, right after the pilot episode (the cold open) ends; Extras > Opening replays it.
// A tap, Enter, Space or Esc skips it, but not in its first second (so the pilot's last tap does not skip it by accident).

import { audio } from '../audio.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { $, h } from './dom.ts';

export const OPENING_KEY = 'dod-opening';
export const OPENING_URL = '/audio/opening.webm';
/** Skip is accepted after this many ms. */
export const OPENING_SKIP_AFTER = 1000;
export const OPENING_SECONDS = 30;
/** Lower thirds: when each shot cuts in (s, on the beat at 128 BPM) and whose it is. */
export const OPENING_CAST: readonly { at: number; id: string }[] = [
  { at: 2.34, id: 'exit-punk' },
  { at: 4.69, id: 'kaelen' },
  { at: 7.03, id: 'break' },
  { at: 9.38, id: 'dj-wont-read' },
  { at: 11.72, id: 'orchestrator' },
];
/** The logo slams in on the song's last hit. */
export const OPENING_LOGO_AT = 26.6;

export function openingSeen(): boolean {
  try {
    return localStorage.getItem(OPENING_KEY) !== null;
  } catch {
    return true;
  }
}
export function markOpeningSeen(): void {
  try {
    localStorage.setItem(OPENING_KEY, '1');
  } catch {
    // Blocked storage: it just plays again next visit.
  }
}

let active = false;
export const openingShowing = (): boolean => active;

const fire = (phase: string, detail: Record<string, unknown> = {}): void => {
  window.dispatchEvent(new CustomEvent('dod:opening', { detail: { phase, ...detail } }));
};

/** Plays the opening over everything; resolves when it ends or is skipped. */
export function playOpening(opts: { replay?: boolean } = {}): Promise<{ skipped: boolean; ms: number }> {
  const root = $('opening');
  const video = h('video', { class: 'opening-video', id: 'opening-video', playsinline: '', preload: 'auto', src: OPENING_URL }) as HTMLVideoElement;
  video.setAttribute('playsinline', '');
  const third = h('div', { class: 'opening-third', id: 'opening-third', 'aria-live': 'polite' });
  const logo = h('h1', { class: 'opening-logo', id: 'opening-logo' }, 'Dose of ', h('span', {}, 'Destruction'));
  const skip = h('button', { type: 'button', class: 'opening-skip', id: 'opening-skip', 'aria-label': 'Skip the opening' }, 'Skip');
  root.replaceChildren(video, third, logo, skip);
  root.classList.remove('slam');
  root.hidden = false;
  active = true;
  audio.playMusic(null);
  const started = performance.now();
  fire('start', { replay: !!opts.replay, url: OPENING_URL });

  return new Promise((resolve) => {
    let done = false;
    let shown = -1;
    let raf = 0;
    const finish = (skipped: boolean): void => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('pointerdown', onTap);
      video.pause();
      video.removeAttribute('src');
      video.load();
      active = false;
      root.hidden = true;
      root.classList.remove('slam');
      root.replaceChildren();
      markOpeningSeen();
      const ms = Math.round(performance.now() - started);
      fire('end', { replay: !!opts.replay, skipped, ms });
      resolve({ skipped, ms });
    };
    const tryEnd = (): void => {
      if (performance.now() - started < OPENING_SKIP_AFTER) return;
      finish(true);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (['Enter', ' ', 'Escape', 'Backspace'].includes(ev.key)) {
        ev.preventDefault();
        ev.stopPropagation();
        tryEnd();
      }
    };
    const onTap = (): void => tryEnd();
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', onTap);
    video.addEventListener('ended', () => finish(false));
    video.addEventListener('error', () => {
      console.error('[dod-opening] the opening video did not load');
      fire('error', {});
      finish(false);
    });
    // Lower thirds and the logo follow the video's own clock, so they stay on the beat.
    const tick = (): void => {
      if (done) return;
      const t = video.currentTime;
      let n = -1;
      OPENING_CAST.forEach((c, i) => { if (t >= c.at && t < c.at + 2.2) n = i; });
      if (n !== shown) {
        shown = n;
        if (n < 0) third.classList.remove('in');
        else {
          const c = OPENING_CAST[n]!;
          const ch = CHARACTERS.find((x) => x.id === c.id);
          third.replaceChildren(h('em', {}, `Season 1 · ${n + 1} of ${OPENING_CAST.length}`), h('strong', {}, ch?.name ?? c.id));
          third.classList.remove('in');
          void third.offsetWidth;
          third.classList.add('in');
          fire('name', { id: c.id, name: ch?.name ?? c.id, at: Math.round(t * 100) / 100 });
        }
      }
      if (t >= OPENING_LOGO_AT && !root.classList.contains('slam')) {
        root.classList.add('slam');
        fire('logo', { at: Math.round(t * 100) / 100 });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    skip.focus({ preventScroll: true });
    video.play().then(
      () => fire('playing', { ms: Math.round(performance.now() - started) }),
      (err) => {
        // Sound blocked or no decoder: do not strand the player on a black screen.
        console.error('[dod-opening] play failed', err);
        fire('error', { message: String(err) });
        finish(false);
      },
    );
  });
}
