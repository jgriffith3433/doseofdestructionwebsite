/**
 * How heavy a hit feels. The sim freezes both fighters for `lag` frames (hit-stop, step.ts applyHit, scaled to
 * damage); this decides the rest from the same damage: the impact effect and the camera shake. The one player
 * choice, Screen shake on or off, is saved in localStorage "dod.shake" and read live by the renderer.
 */

export type HitTier = 'light' | 'medium' | 'heavy';

/** Damage is in tenths of a percent (the same cut-offs pick hit-light / hit-medium / hit-heavy in main.ts). */
export const hitTier = (dmg: number): HitTier => (dmg < 70 ? 'light' : dmg < 130 ? 'medium' : 'heavy');

export interface Impact {
  /** Sparks thrown. */
  sparks: number;
  /** Star-shaped impact sprites, 0 for a light hit. */
  stars: number;
  /** A shockwave ring (heavy only). */
  ring: boolean;
  /** Camera shake added (0-1 scale of the renderer). */
  shake: number;
  /** A white screen flash (heavy only). */
  flash: number;
}

export const impactFor = (tier: HitTier, kb: number): Impact => {
  const push = Math.min(16, kb >> 3);
  if (tier === 'light') return { sparks: 6 + (push >> 2), stars: 0, ring: false, shake: Math.min(0.12, kb * 0.001), flash: 0 };
  if (tier === 'medium') return { sparks: 10 + (push >> 1), stars: 1, ring: false, shake: Math.min(0.3, 0.1 + kb * 0.002), flash: 0 };
  return { sparks: 16 + push, stars: 2, ring: true, shake: Math.min(0.7, 0.35 + kb * 0.003), flash: 0.25 };
};

const SHAKE_KEY = 'dod.shake';
let shakeOn = (() => {
  try {
    return localStorage.getItem(SHAKE_KEY) !== 'off';
  } catch {
    return true;
  }
})();
const listeners = new Set<(on: boolean) => void>();

export const screenShake = (): boolean => shakeOn;

export const setScreenShake = (on: boolean): void => {
  shakeOn = on;
  try {
    localStorage.setItem(SHAKE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of listeners) l(on);
};

export const onScreenShake = (l: (on: boolean) => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const SHAKE_STORAGE_KEY = SHAKE_KEY;
