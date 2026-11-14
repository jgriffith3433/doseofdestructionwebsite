/**
 * Graphics settings: Quality (High / Low), Glow and Show FPS, saved in localStorage "dod.gfx" and applied live
 * (the renderer listens, nothing reloads). Phones and touch devices default to Low with glow off; desktop keeps
 * High with glow on, the look the game always had. High renders at most 2x the device pixel ratio on desktop
 * and 1.5x on touch devices; Low renders at 1x and trims particles.
 */

export type Quality = 'high' | 'low';
export interface Graphics { quality: Quality; glow: boolean; fps: boolean }

export const GFX_KEY = 'dod.gfx';

export const isTouchDevice = (): boolean => {
  try {
    return !!window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
};

/** What a visitor with nothing saved gets. */
export const defaultGraphics = (touch = isTouchDevice()): Graphics =>
  touch ? { quality: 'low', glow: false, fps: false } : { quality: 'high', glow: true, fps: false };

const read = (): Graphics => {
  const base = defaultGraphics();
  try {
    const p = JSON.parse(localStorage.getItem(GFX_KEY) ?? 'null') as Partial<Graphics> | null;
    if (p && typeof p === 'object') {
      return {
        quality: p.quality === 'low' || p.quality === 'high' ? p.quality : base.quality,
        glow: typeof p.glow === 'boolean' ? p.glow : base.glow,
        fps: typeof p.fps === 'boolean' ? p.fps : base.fps,
      };
    }
  } catch {
    // Unreadable storage: defaults.
  }
  return base;
};

let current = read();
const listeners = new Set<(g: Graphics) => void>();

export const graphics = (): Graphics => ({ ...current });

export const HAND_KEY = 'dod.gfx.hand';
export const AUTO_KEY = 'dod.gfx.auto';
export const AUTO_TOAST_KEY = 'dod.gfx.auto-toast';

const store = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const put = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice holds for this visit only.
  }
};

/**
 * True when the player chose Quality or Glow by hand in Settings: automatic quality then never changes anything. Also true for
 * a saved choice that differs from the device's own default (it can only have come from Settings before this flag existed).
 */
export const pickedByHand = (): boolean => {
  if (store(HAND_KEY) === '1') return true;
  const raw = store(GFX_KEY);
  if (!raw) return false;
  try {
    const p = JSON.parse(raw) as Partial<Graphics> | null;
    const d = defaultGraphics();
    return !!p && ((p.quality === 'low' || p.quality === 'high') && p.quality !== d.quality || typeof p.glow === 'boolean' && p.glow !== d.glow);
  } catch {
    return false;
  }
};

/** The level automatic quality settled at on an earlier visit (0 = none). */
export const savedAutoLevel = (): number => Math.max(0, Math.min(4, Number(store(AUTO_KEY)) | 0));
export const saveAutoLevel = (level: number): void => put(AUTO_KEY, level > 0 ? String(level) : null);
/** The one-time "eased the graphics" note: shown once ever, then never again. */
export const autoToastShown = (): boolean => store(AUTO_TOAST_KEY) === '1';
export const markAutoToastShown = (): void => put(AUTO_TOAST_KEY, '1');

/** Settings calls this with byHand: a Quality or Glow press is the player's choice and switches automatic quality off for good. */
export const setGraphics = (next: Partial<Graphics>, byHand = false): void => {
  if (byHand && ('quality' in next || 'glow' in next)) put(HAND_KEY, '1');
  current = { ...current, ...next };
  try {
    localStorage.setItem(GFX_KEY, JSON.stringify(current));
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of listeners) l(graphics());
};

export const onGraphics = (l: (g: Graphics) => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The most the canvas renders per CSS pixel: Low 1x, else 2x on desktop and 1.5x on touch devices. */
export const renderScaleCap = (quality: Quality, touch = isTouchDevice()): number => (quality === 'low' ? 1 : touch ? 1.5 : 2);

/** Engine hardware scaling level for a device pixel ratio (1 = one render pixel per CSS pixel; below 1 = sharper). */
export const scalingLevel = (quality: Quality, dpr: number, touch = isTouchDevice()): number =>
  1 / Math.min(dpr || 1, renderScaleCap(quality, touch));

/** Share of the particles a hit or KO throws: Low trims them. */
export const particleShare = (quality: Quality): number => (quality === 'low' ? 0.5 : 1);
