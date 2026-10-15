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
  /** A stage event id: the platform is gone while that event runs (a panel tilting away, a floor breaking). */
  offDuring?: string;
  /** A stage event id: the platform only exists while that event runs (a bridge extending, a raft surfacing). */
  onlyDuring?: string;
}

/**
 * Something the stage does on its own: a storm, a hawk swooping in, panels
 * turning. It warns, runs for a while and ends; zones, hazards and platforms
 * that name it switch on and off with it, and art and effects react to it.
 * Part of the sim (deterministic: the timer draws from the sim's rng).
 */
export interface StageEvent {
  id: string;
  name?: string;
  /** What starts it: a timer (default), or someone being KO'd or hit. */
  trigger?: 'timer' | 'ko' | 'hit';
  /** Timer: seconds from the end of one to the warning of the next, random in [min, max]. Without it the timer fires once. */
  every?: [number, number];
  /** Timer: seconds into the match before the first one warns (default: a draw from every). */
  first?: number;
  /** KO and hit triggers: percent chance each time (default 100). */
  chance?: number;
  /** Seconds of warning before it starts (art and effects can show it coming). */
  warn?: number;
  /** Seconds it runs. 0 is an instant (art and effects still react). */
  duration: number;
}

/**
 * A region of the stage that changes how fighters move or hurts them. World
 * units, like platforms. Always on, or only while an event runs.
 */
export interface StageZone {
  id?: string;
  /** damage: hurts on a tick (fog, lava, spikes). wind: pushes. water: swim (floaty, jump again and again). gravity: lighter or heavier. */
  kind: 'damage' | 'wind' | 'water' | 'gravity';
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  /** An event id: the zone only exists while it runs. */
  during?: string;
  /** damage: percent dealt each tick. */
  damage?: number;
  /** damage: seconds between ticks (default 0.5). */
  tick?: number;
  /** damage: launch strength (base knockback, 0 for none; 40 is a firm shove, 80 strong) and its angle in degrees (90 is up). */
  knock?: number;
  angle?: number;
  /** wind: push in world units per second, [x, y] (fighters are about 110 tall; 120 is a strong gust). */
  force?: [number, number];
  /** water and gravity: percent of normal gravity inside (water defaults to 35). */
  gravity?: number;
}

/**
 * Something that moves along a path and hits fighters: a hawk, a train, a
 * swinging wrecking ball. With an event it crosses its path once while the
 * event runs; without one it loops the path forever every `period` seconds.
 */
export interface StageHazard {
  id: string;
  during?: string;
  /** Loop length in seconds, without an event. */
  period?: number;
  /** Points it passes through, evenly spaced in time, world units. */
  path: { x: number; y: number }[];
  /** Hit radius, world units. */
  r: number;
  /** Percent dealt. */
  dmg: number;
  /** Launch angle in degrees for a hazard moving right (90 is up); mirrored when it moves left. */
  angle: number;
  /** Base and growing knockback, like a move's (a strong smash is about 40 and 100). */
  bkb: number;
  kbg: number;
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
  /** A loop it plays on its own: a crowd bobbing, a sign swaying, clouds scrolling. */
  anim?: LayerAnim;
  /** An event id: only shown while it runs (or, with 'warn:<id>', while it warns). */
  showDuring?: string;
  /** An event id: hidden while it runs. */
  hideDuring?: string;
  /** A hazard id: the art rides that hazard (the hawk's picture on the hawk). */
  follows?: string;
  /** How it reacts to match moments and stage events. */
  reacts?: LayerReact[];
}

export interface LayerAnim {
  kind: 'bob' | 'sway' | 'spin' | 'pulse' | 'scroll' | 'wave';
  /** bob/scroll/wave: world units. sway/spin: degrees. pulse: scale percent. */
  amount?: number;
  /** Seconds per cycle. */
  speed?: number;
}

/**
 * A layer reacting to a moment. on: 'ko', 'hit', 'start', 'end', or a stage
 * event: 'event:<id>' when it starts, 'warn:<id>' when it warns, 'eventEnd:<id>'.
 * hop/flash/shake/spin play once; tilt (and tip, a big tilt) hold for `seconds`,
 * or until the event ends when `on` is an event.
 */
export interface LayerReact {
  on: string;
  kind: 'hop' | 'flash' | 'shake' | 'spin' | 'tilt' | 'tip';
  /** hop: world units. tilt/tip/spin: degrees. */
  amount?: number;
  seconds?: number;
}

/** Something the stage does when the match does something. Render and sound only. */
export interface StageEffect {
  /** 'start', 'ko', 'hit', 'end', 'ambient', or a stage event: 'event:<id>', 'warn:<id>', 'eventEnd:<id>'. */
  on: string;
  /**
   * firework, burst (at the KO or in the sky), shake (camera), embers (rising
   * sparks), splat (paint blobs where a hit lands), dust (a sweeping cloud),
   * flash (the screen lights up), confetti (falls from above), rain (streaks
   * while the event runs).
   */
  kind: 'firework' | 'burst' | 'shake' | 'embers' | 'splat' | 'dust' | 'flash' | 'confetti' | 'rain';
  /** Colors to pick from. */
  colors?: string[];
  /** How many (fireworks, bursts); 'end' spreads them over a few seconds. */
  count?: number;
  /** Ambient only: seconds between. */
  every?: number;
  /** A sound id from content/sounds.json. */
  sound?: string;
  /** Where: in the sky behind the stage, or where the KO (or hit) happened. */
  at?: 'sky' | 'ko';
  /** dust and rain: which way it blows, -1 left or 1 right. */
  dir?: number;
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
  /** Things the stage does on its own (sim). */
  events?: StageEvent[];
  /** Regions that hurt, push, float or drown fighters (sim). */
  zones?: StageZone[];
  /** Moving things that hit fighters (sim). */
  hazards?: StageHazard[];
  /** A special version of another stage (its id), e.g. for one game mode. Its art can be shared. */
  variantOf?: string;
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

// ----------------------------------------------------------- stage events

/** Event state the sim keeps: per event, a phase and the frames left in it. */
export interface StageClock {
  frame: number;
  /** 0 waiting, 1 warning, 2 running. */
  evPhase: number[];
  evTimer: number[];
}

export const EV_IDLE = 0;
export const EV_WARN = 1;
export const EV_RUN = 2;

/** Seconds in frames (stage data is authored in seconds). */
export function secs(v: number | undefined, fallback = 0): number {
  return Math.round((v ?? fallback) * 60);
}

const eventIndexCache = new Map<StageDef, Map<string, number>>();

/** The index of a stage event by id, or -1. */
export function eventIndex(stage: StageDef, id: string | undefined): number {
  if (!id) return -1;
  let m = eventIndexCache.get(stage);
  if (!m) {
    m = new Map((stage.events ?? []).map((e, i) => [e.id, i]));
    eventIndexCache.set(stage, m);
  }
  return m.get(id) ?? -1;
}

/** Whether an event runs now. 'warn:<id>' asks whether it warns. Unknown ids never run. */
export function eventOn(stage: StageDef, c: StageClock, id: string | undefined): boolean {
  if (!id) return false;
  const warn = id.startsWith('warn:');
  const i = eventIndex(stage, warn ? id.slice(5) : id);
  return i >= 0 && c.evPhase[i] === (warn ? EV_WARN : EV_RUN);
}

/** Frames an event has been running (0 when it isn't). */
export function eventElapsed(stage: StageDef, c: StageClock, i: number): number {
  if (c.evPhase[i] !== EV_RUN) return 0;
  return secs(stage.events![i].duration) - c.evTimer[i];
}

/** Whether a platform is there now (event toggles). */
export function platformOn(stage: StageDef, c: StageClock, i: number): boolean {
  const p = stage.platforms[i];
  if (p.offDuring && eventOn(stage, c, p.offDuring)) return false;
  if (p.onlyDuring && !eventOn(stage, c, p.onlyDuring)) return false;
  return true;
}

/** Whether a zone is there now. */
export function zoneOn(stage: StageDef, c: StageClock, z: StageZone): boolean {
  return !z.during || eventOn(stage, c, z.during);
}

/**
 * Where a hazard is now, in FX units, and which way it is going; null when
 * it is not out. Event hazards cross their path once over the event; others
 * loop it.
 */
export function hazardAt(stage: StageDef, c: StageClock, h: StageHazard): { x: number; y: number; dir: number } | null {
  const pts = h.path;
  if (!pts.length) return null;
  let t: number;
  let len: number;
  let loop = false;
  if (h.during) {
    const i = eventIndex(stage, h.during);
    if (i < 0 || c.evPhase[i] !== EV_RUN) return null;
    len = Math.max(1, secs(stage.events![i].duration));
    t = Math.min(len, eventElapsed(stage, c, i));
  } else {
    len = Math.max(1, secs(h.period, 4));
    t = c.frame % len;
    loop = true;
  }
  if (pts.length === 1) return { x: pts[0].x * FX, y: pts[0].y * FX, dir: 1 };
  // A loop runs back to its first point; a crossing ends at the last.
  const segs = loop ? pts.length : pts.length - 1;
  const pos = t * segs;
  const k = Math.min(segs - 1, Math.trunc(pos / len));
  const rem = pos - k * len;
  const a = pts[k];
  const b = pts[(k + 1) % pts.length];
  const x = a.x * FX + idiv((b.x - a.x) * FX * rem, len);
  const y = a.y * FX + idiv((b.y - a.y) * FX * rem, len);
  return { x, y, dir: b.x < a.x ? -1 : 1 };
}
