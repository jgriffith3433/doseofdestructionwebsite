/**
 * Text size (Settings → Text size 100% / 125% / 150%): one CSS variable, --ts, on <html>. game.css multiplies every
 * font size (menus, HUD, captions, story cards) by var(--ts, 1), so the whole game scales from here and nowhere else.
 * Saved in localStorage "dod.textsize" and applied before the first screen draws.
 */

export const TEXT_SIZES = [100, 125, 150] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const TEXT_SIZE_KEY = 'dod.textsize';

const read = (): TextSize => {
  try {
    const n = Number(localStorage.getItem(TEXT_SIZE_KEY));
    return (TEXT_SIZES as readonly number[]).includes(n) ? (n as TextSize) : 100;
  } catch {
    return 100;
  }
};

let current: TextSize = read();
const listeners = new Set<(s: TextSize) => void>();

const apply = (): void => {
  const root = document.documentElement;
  root.style.setProperty('--ts', String(current / 100));
  root.dataset.textSize = String(current);
};
apply();

export const textSize = (): TextSize => current;

export const setTextSize = (s: TextSize): void => {
  current = (TEXT_SIZES as readonly number[]).includes(s) ? s : 100;
  apply();
  try {
    localStorage.setItem(TEXT_SIZE_KEY, String(current));
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of listeners) l(current);
};

export const onTextSize = (l: (s: TextSize) => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
