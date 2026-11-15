// Fighter lighting (render only, never the sim): each stage's `light` in content/stages.json says what colour the
// set puts on a fighter. The shader (lightPlugin.ts) uses it; this file is the data and the pure maths: the defaults,
// the platform below a fighter, and how a contact shadow shrinks and fades with height (gone above SHADOW_RANGE).

import { platformAt, type StageDef, type StageLight } from '../sim/stageMath.ts';
import { FX } from '../sim/fixed.ts';

export type { StageLight } from '../sim/stageMath.ts';

/** Above this many stage units over the platform below, the contact shadow is gone. */
export const SHADOW_RANGE = 300;
/** The shadow's opacity under the feet, and the share of it that stays at the highest point. */
export const SHADOW_ALPHA = 0.55;
export const SHADOW_MIN_SCALE = 0.35;
/** The mirror image's opacity on glossy floors. */
export const REFLECTION_ALPHA = 0.15;

/** Neutral daylight, for a stage with no light of its own. */
export const NEUTRAL_LIGHT: StageLight = { key: { dir: [0.4, 0.8], color: '#fff4e0', strength: 0.3 }, rim: { color: '#bcd4ff', strength: 0.3 }, ambient: '#ffffff' };

export const lightOf = (stage: StageDef): StageLight => stage.light ?? NEUTRAL_LIGHT;

/** The top of the platform below a point (fighter feet, x and y in FX units), in stage units, or null when there is none. `frame` moves moving platforms. */
export function floorBelow(stage: StageDef, frame: number, x: number, y: number): number | null {
  let best: number | null = null;
  for (const p of stage.platforms) {
    const a = platformAt(p, frame);
    if (x < a.x1 || x > a.x2) continue;
    // A little give, so a fighter standing on a platform (or a hair under its top) counts as on it.
    if (a.y > y + FX * 2) continue;
    if (best === null || a.y > best) best = a.y;
  }
  return best === null ? null : best / FX;
}

export interface ShadowShape {
  /** Show it at all. */
  on: boolean;
  /** 1 on the floor, SHADOW_MIN_SCALE at the top of the range. */
  scale: number;
  alpha: number;
  /** Height over the floor, stage units. */
  height: number;
}

/** The shadow at `height` stage units over the platform below (null: no platform below). */
export function shadowAt(height: number | null): ShadowShape {
  if (height === null || height >= SHADOW_RANGE) return { on: false, scale: 0, alpha: 0, height: height ?? -1 };
  const t = Math.max(0, height) / SHADOW_RANGE;
  return { on: true, scale: 1 - (1 - SHADOW_MIN_SCALE) * t, alpha: SHADOW_ALPHA * (1 - t), height };
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
