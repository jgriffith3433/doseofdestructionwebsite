// What the stage is about to do to a fighter, read from the sim's live state (event warnings and running windows,
// hazard paths, damage zones) the way a player reads the warning art. Pure: no randomness, nothing written.
// ai/bot.ts uses it to stay out of hawk dives, skaters, vacuums, falling paint and fog, and (at higher levels) to
// stand so a launch carries the player into one.

import { FX } from '../sim/fixed.ts';
import { EV_RUN, EV_WARN, eventIndex, secs, zoneOn, type StageDef, type StageHazard } from '../sim/stageMath.ts';
import { bodySize, type Fighter, type GameState } from '../sim/state.ts';

/** A hazard's hit circle at a moment: `t` frames from now, world units. */
export interface HazardCircle {
  x: number;
  y: number;
  r: number;
  t: number;
  /** The hazard's own heading, -1 left, 1 right. */
  dir: number;
  /** Extra room worth keeping from it: a fast hazard (a hawk, a skater) is dodged late, a launch carries a body further than it looks. */
  pad: number;
}

/** A damage zone that hurts now (t = 0) or when its event starts. */
export interface HazardRect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  t: number;
  /** Always there (a pit of fog under the stage), not an event. */
  always: boolean;
}

export interface Dangers {
  circles: HazardCircle[];
  rects: HazardRect[];
  /** Frames until the nearest event danger is on the stage (0 running now), Infinity with none. */
  soonest: number;
  /** An event (not an always-on zone) is warning or running. */
  event: boolean;
}

/** Hazards faster than this (units a frame) get FAST_PAD of extra room in `clearance(..., margin)`. */
const FAST = 18;
const FAST_PAD = 60;

/** Frames between the points sampled along a hazard's path (it moves about 10 units a frame at its fastest). */
const STEP = 4;

/** Where a hazard is `e` frames into its crossing (world units), mirroring sim/stageMath.ts hazardAt. */
function pathAt(h: StageHazard, e: number, len: number, loop: boolean): { x: number; y: number; dir: number } {
  const pts = h.path;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, dir: 1 };
  const segs = loop ? pts.length : pts.length - 1;
  const pos = Math.max(0, Math.min(len, e)) * segs;
  const k = Math.min(segs - 1, Math.trunc(pos / len));
  const rem = (pos - k * len) / len;
  const a = pts[k];
  const b = pts[(k + 1) % pts.length];
  return { x: a.x + (b.x - a.x) * rem, y: a.y + (b.y - a.y) * rem, dir: b.x < a.x ? -1 : 1 };
}

/**
 * Everything the stage will hurt at from now on that fighter `me` has not already been hit by this pass. `skipAlways`
 * leaves out damage zones that are always there (a bot willing to wade through the fog).
 */
export function readDangers(stage: StageDef, s: GameState, me: Fighter | null, skipAlways = false): Dangers {
  const out: Dangers = { circles: [], rects: [], soonest: Infinity, event: false };
  if (!s.rules.hazards) return out;
  (stage.hazards ?? []).forEach((h, j) => {
    if (me && s.hazHit[j] & (1 << me.id)) return;
    let e0: number;
    let len: number;
    let loop = false;
    if (h.during) {
      const i = eventIndex(stage, h.during);
      if (i < 0 || (s.evPhase[i] !== EV_WARN && s.evPhase[i] !== EV_RUN)) return;
      len = Math.max(1, secs(stage.events![i].duration));
      e0 = s.evPhase[i] === EV_WARN ? -s.evTimer[i] : len - s.evTimer[i];
    } else {
      len = Math.max(1, secs(h.period, 4));
      e0 = s.frame % len;
      loop = true;
    }
    // Sample the rest of the crossing (a loop, one lap ahead).
    const from = Math.max(0, e0);
    const to = loop ? e0 + len : len;
    const n = Math.max(1, Math.min(120, Math.ceil((to - from) / STEP)));
    // Its pace along the path, units a frame (the path's length over the crossing's).
    let pathLen = 0;
    for (let k = 1; k < h.path.length; k++) pathLen += Math.hypot(h.path[k].x - h.path[k - 1].x, h.path[k].y - h.path[k - 1].y);
    const speed = pathLen / len;
    for (let k = 0; k <= n; k++) {
      const e = from + ((to - from) * k) / n;
      const p = pathAt(h, loop ? e % len : e, len, loop);
      const t = e - e0;
      out.circles.push({ x: p.x, y: p.y, r: h.r, t, dir: p.dir, pad: speed > FAST ? FAST_PAD : 0 });
      if (t < out.soonest) out.soonest = t;
    }
    out.event = true;
  });
  for (const z of stage.zones ?? []) {
    if (z.kind !== 'damage') continue;
    if (!z.during) {
      if (skipAlways) continue;
      out.rects.push({ x1: z.x1, x2: z.x2, y1: z.y1, y2: z.y2, t: 0, always: true });
      continue;
    }
    const i = eventIndex(stage, z.during);
    if (i < 0) continue;
    if (zoneOn(stage, s, z)) out.rects.push({ x1: z.x1, x2: z.x2, y1: z.y1, y2: z.y2, t: 0, always: false });
    else if (s.evPhase[i] === EV_WARN) out.rects.push({ x1: z.x1, x2: z.x2, y1: z.y1, y2: z.y2, t: s.evTimer[i], always: false });
    else continue;
    out.event = true;
    out.soonest = Math.min(out.soonest, out.rects[out.rects.length - 1].t);
  }
  return out;
}

/**
 * Room around a standing body (feet at x, y; world units) from everything in `d` that is within `within` frames:
 * the smallest gap between the body's box and a hazard's circle or a zone's rectangle. Negative inside one.
 */
export function clearance(d: Dangers, x: number, y: number, halfW: number, h: number, within = Infinity, margin = false): number {
  let best = Infinity;
  for (const c of d.circles) {
    if (c.t > within) continue;
    const px = Math.max(x - halfW, Math.min(c.x, x + halfW));
    const py = Math.max(y, Math.min(c.y, y + h));
    best = Math.min(best, Math.hypot(c.x - px, c.y - py) - c.r - (margin ? c.pad : 0));
  }
  for (const z of d.rects) {
    if (z.t > within) continue;
    const dx = Math.max(z.x1 - (x + halfW), x - halfW - z.x2, 0);
    const dy = Math.max(z.y1 - (y + h), y - z.y2, 0);
    best = Math.min(best, dx === 0 && dy === 0 ? -1 : Math.hypot(dx, dy));
  }
  return best;
}

/** A fighter's body for `clearance`, in world units: half width, height. */
export function bodyOf(f: Fighter): [number, number] {
  const [w, h] = bodySize(f);
  return [w / FX / 2, h / FX];
}
