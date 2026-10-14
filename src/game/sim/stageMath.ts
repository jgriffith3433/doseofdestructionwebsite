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
  /**
   * Collision only: the stage art draws this platform, so the game paints no
   * block for it (once a layer that draws it has an image).
   */
  hidden?: boolean;
}

/**
 * A picture in the stage: the backdrop, buildings, signs, a railing in front.
 * Render only; the sim never reads it. x, y and width are as seen from the
 * default camera, in world units like platforms, so the editor can show
 * layers where the game does. z is distance from the fighters' plane in
 * render units: positive is behind them (parallax slower), negative in front.
 */
export interface StageLayer {
  id: string;
  /** Site path, e.g. stages/city-top/backdrop.webp. Empty: a placeholder still to be painted. */
  image: string;
  x: number;
  y: number;
  width: number;
  z: number;
  opacity?: number;
  /** In front only: fighters behind it show through as a colored silhouette. */
  occluder?: boolean;
  /** Adds light instead of covering (neon, glows). */
  glow?: boolean;
  hidden?: boolean;
  /** What this layer is for (shown in the editor; generated ideas fill it in). */
  note?: string;
  /**
   * The platforms (indices) this art draws. Their art follows them (a moving
   * platform carries it), and a collision-only platform keeps its default
   * block until a layer that draws it has an image.
   */
  platforms?: number[];
  /** For the painter: what this piece looks like. */
  prompt?: string;
  /** Height over width, for art not painted yet (and what a painted take was framed at). */
  aspect?: number;
  /** A silhouette sketch, rectangles relative to (x, y): what the painter paints over. */
  shape?: { x1: number; x2: number; y1: number; y2: number }[];
}

/** Something the stage does when the match does something. Render and sound only. */
export interface StageEffect {
  on: 'start' | 'ko' | 'end' | 'ambient';
  kind: 'firework' | 'burst' | 'shake' | 'embers';
  /** Colors to pick from. */
  colors?: string[];
  /** How many (fireworks, bursts); 'end' spreads them over a few seconds. */
  count?: number;
  /** Ambient only: seconds between. */
  every?: number;
  /** A sound id from content/sounds.json. */
  sound?: string;
  /** Where: in the sky behind the stage, or where the KO happened. */
  at?: 'sky' | 'ko';
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
  /** Art, back to front by z. Without any, the theme's painted backdrop shows. */
  layers?: StageLayer[];
  effects?: StageEffect[];
  /** The C:\Projects\AllTheMaps folder this stage came from. */
  source?: string;
  /** Design notes and art still to make. */
  notes?: string;
  /** Art direction for painting the stage, and the concept image it is styled on. */
  art?: { style?: string; reference?: string };
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
