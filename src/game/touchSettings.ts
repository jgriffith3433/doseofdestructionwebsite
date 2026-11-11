/**
 * Touch size (75% to 150%), Touch opacity (30% to 100%) and hit vibrate for the on-screen controls, saved in
 * localStorage "dod.touch" and applied live: input/touch.ts sets size/opacity as CSS variables on its overlay
 * (game.css reads them); vibrate is read on a landed hit in main.ts.
 * Settings shows the sliders and vibrate switch on touch devices only.
 */

export interface TouchSettings { size: number; opacity: number; vibrate: boolean }

export const TOUCH_KEY = 'dod.touch';
export const TOUCH_SIZE = { min: 75, max: 150, def: 100 };
export const TOUCH_OPACITY = { min: 30, max: 100, def: 100 };

const clamp = (v: unknown, r: { min: number; max: number; def: number }): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : r.def;
};

const read = (): TouchSettings => {
  try {
    const p = JSON.parse(localStorage.getItem(TOUCH_KEY) ?? 'null') as Partial<TouchSettings> | null;
    if (p && typeof p === 'object') {
      return {
        size: clamp(p.size ?? TOUCH_SIZE.def, TOUCH_SIZE),
        opacity: clamp(p.opacity ?? TOUCH_OPACITY.def, TOUCH_OPACITY),
        vibrate: typeof p.vibrate === 'boolean' ? p.vibrate : true,
      };
    }
  } catch {
    // Unreadable storage: defaults.
  }
  return { size: TOUCH_SIZE.def, opacity: TOUCH_OPACITY.def, vibrate: true };
};

let current = read();
const listeners = new Set<(s: TouchSettings) => void>();

export const touchSettings = (): TouchSettings => ({ ...current });

export const setTouchSettings = (next: Partial<TouchSettings>): void => {
  current = {
    size: clamp(next.size ?? current.size, TOUCH_SIZE),
    opacity: clamp(next.opacity ?? current.opacity, TOUCH_OPACITY),
    vibrate: typeof next.vibrate === 'boolean' ? next.vibrate : current.vibrate,
  };
  try {
    localStorage.setItem(TOUCH_KEY, JSON.stringify(current));
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of listeners) l(touchSettings());
};

export const onTouchSettings = (l: (s: TouchSettings) => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Light haptic on a landed hit when Settings → Vibrate is on and the browser supports it. */
export const hitVibrate = (ms = 12): void => {
  if (!current.vibrate) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Unsupported or blocked: ignore.
  }
};

/** The playtest bot runs on a desktop browser: it asks Settings to show the touch sliders as on a phone. */
let forced = false;
export const forceTouchUi = (on: boolean): void => {
  forced = on;
};
export const touchUiForced = (): boolean => forced;
