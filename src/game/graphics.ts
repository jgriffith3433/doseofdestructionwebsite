/**
 * Graphics settings: Quality (High / Low), Glow and Show FPS, saved in localStorage "dod.gfx" and applied live
 * (the renderer listens, nothing reloads). Phones and touch devices default to Low with glow off; desktop keeps
 * High with glow on, the look the game always had. High renders at most 2x the device pixel ratio on desktop
 * and 1.5x on touch devices; Low renders at 1x and trims particles.
 */

import { softwareRenderer } from './boot.ts';

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
export const defaultGraphics = (touch = isTouchDevice() || softwareRenderer()): Graphics =>
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

export const setGraphics = (next: Partial<Graphics>): void => {
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
