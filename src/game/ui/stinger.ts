// The show's stinger: every screen change plays it (screens.ts go()). A diagonal wipe in the slot colours, a light streak,
// the logo, a whoosh going in and an impact as the panels close. The next screen loads behind it; if loading runs longer the
// cover holds on a branded loop (logo pulse + streak), never black. Reduced motion gets a quick crossfade.

import { audio } from '../audio.ts';

const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Timings in ms: the cover closing, the cover opening. In + out is 0.58 s (0.5-0.7 s), longer only while loading. */
export const STINGER_IN_MS = 290;
export const STINGER_OUT_MS = 300;
export const STINGER_REDUCED_MS = 120;

export interface StingerRun {
  /** Resolves once the cover is closed; the next screen may be built behind it. */
  covered: Promise<void>;
  /** Call once the next screen is showing: the cover opens, and the returned promise resolves when it is gone. */
  open(): Promise<void>;
}

let log: { at: number; from: string; to: string; ms: number; loadMs: number; reduced: boolean }[] = [];
export const stingerLog = () => log;

/** Starts the stinger for a switch from -> to. */
export function startStinger(from: string, to: string): StingerRun {
  const wipe = document.getElementById('wipe')!;
  const reduced = reduceMotion();
  const t0 = performance.now();
  let coveredAt = t0;
  audio.sfx('wipe'); // whoosh going in
  wipe.className = 'wipe in';
  const inMs = reduced ? STINGER_REDUCED_MS : STINGER_IN_MS;
  const covered = wait(inMs).then(() => {
    coveredAt = performance.now();
    if (wipe.className === 'wipe in') wipe.className = 'wipe hold';
    if (!reduced) audio.sfx('vs-slam'); // impact as the panels meet
  });
  return {
    covered,
    async open() {
      const loadMs = Math.round(performance.now() - coveredAt);
      wipe.className = 'wipe out';
      await wait(reduced ? STINGER_REDUCED_MS : STINGER_OUT_MS);
      wipe.className = 'wipe';
      const ms = Math.round(performance.now() - t0);
      log.push({ at: Math.round(t0), from, to, ms, loadMs, reduced });
      if (log.length > 200) log = log.slice(-100);
      try {
        window.dispatchEvent(new CustomEvent('dod:stinger', { detail: { from, to, ms, loadMs, reduced } }));
      } catch {
        // No window in node tests.
      }
    },
  };
}
