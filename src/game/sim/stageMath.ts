// Stage geometry types and the pure functions over them: ledges, and where a
// moving platform is on a given frame. World units, y up; a stage's main floor
// sits at y = 0. No content is loaded here, so devtools can use it directly.

import { FX, TRIG_ONE, idiv, isin } from './fixed.ts';

export interface PlatformMotion {
  /** Peak offset from the rest position, world units. */
  ax: number;
  ay: number;
  /** Frames for one full cycle. */
  period: number;
  /** Degrees into the cycle at frame 0. */
  phase?: number;
}

export interface Platform {
  x1: number;
  x2: number;
  y: number;
  /** Solid platforms have sides, a bottom, and grabbable ledges; thin ones only a top. */
  solid: boolean;
  /** How far a solid platform extends below its top. */
  depth?: number;
  /** Only thin platforms move. */
  motion?: PlatformMotion;
}

export interface StageTheme {
  /** Backdrop gradient, center to edge. */
  sky: [string, string, string];
  /** The glow behind the stage. */
  glow: string;
  body: string;
  under: string;
  edge: string;
  thinEdge: string;
  /** What gets painted into the backdrop. */
  props: 'frame' | 'skyline' | 'clouds' | 'embers' | 'pipes';
}

export interface StageDef {
  id: string;
  name: string;
  blurb: string;
  platforms: Platform[];
  blast: { left: number; right: number; top: number; bottom: number };
  spawns: { x: number; y: number }[];
  respawn: { x: number; y: number };
  theme: StageTheme;
}

export interface Ledge {
  x: number;
  y: number;
  /** -1 for a left edge, 1 for a right edge. Fighters hang on the outside. */
  side: number;
  platform: number;
}

const ledgeCache = new Map<StageDef, Ledge[]>();

/** Every grabbable ledge: both top corners of each solid platform. */
export function ledges(stage: StageDef): Ledge[] {
  let out = ledgeCache.get(stage);
  if (!out) {
    out = [];
    stage.platforms.forEach((p, i) => {
      if (!p.solid) return;
      out!.push({ x: p.x1, y: p.y, side: -1, platform: i }, { x: p.x2, y: p.y, side: 1, platform: i });
    });
    ledgeCache.set(stage, out);
  }
  return out;
}

/** A platform's offset from rest at a frame, in FX units. */
export function platformOffset(p: Platform, frame: number): [number, number] {
  const m = p.motion;
  if (!m) return [0, 0];
  // Degrees through the cycle, kept integral so the result is engine independent.
  const deg = idiv(frame % m.period * 360, m.period) + (m.phase ?? 0);
  const s = isin(deg);
  return [idiv(m.ax * FX * s, TRIG_ONE), idiv(m.ay * FX * s, TRIG_ONE)];
}

/** Where a platform is at a frame, in FX units. */
export function platformAt(p: Platform, frame: number): { x1: number; x2: number; y: number } {
  const [dx, dy] = platformOffset(p, frame);
  return { x1: p.x1 * FX + dx, x2: p.x2 * FX + dx, y: p.y * FX + dy };
}
