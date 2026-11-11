// The match camera's maths, kept pure (no Babylon) so `src/game/test/camera.test.ts` can run it against real bot
// matches: the framing goal, the kill cue's punch-in, critically damped follow and the keep-in-view guard.

import { FX } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { ACT, type GameState } from '../sim/state.ts';
import { RESPAWN_DELAY } from '../sim/step.ts';

/** Frames before a respawn when the camera starts making room for it, so the fighter drops into a view that already holds them. */
export const RESPAWN_LEAD = 45;

export interface CamFighter {
  /** World position of the feet, and the body's height, in world units. */
  x: number;
  y: number;
  h: number;
}

export interface CamBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface CamGoal {
  x: number;
  y: number;
  d: number;
}

export interface CamState extends CamGoal {
  vx: number;
  vy: number;
  vd: number;
}

/** Critically damped follow (Unity's SmoothDamp): reaches `target` in about `smooth` seconds with no overshoot and no snap. */
export function smoothDamp(cur: number, target: number, vel: number, smooth: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.0001, smooth);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  const nv = (vel - omega * temp) * e;
  return [target + (change + temp) * e, nv];
}

/**
 * Where the camera wants to be: the box around every living fighter (up to the blast zone, so nobody leaves the
 * frame before they are out) plus padding and a little of the stage, at a distance that fits it inside the zoom limits.
 */
export function frameGoal(fighters: readonly CamFighter[], blast: CamBounds, aspect: number, tan: number): CamGoal {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of fighters) {
    const x = Math.max(blast.left, Math.min(blast.right, f.x));
    const y = Math.max(blast.bottom, Math.min(blast.top, f.y));
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + f.h);
  }
  if (minX === Infinity) {
    minX = -3;
    maxX = 3;
    minY = 0;
    maxY = 2;
  }
  // Portrait phone: the screen is narrow, so frame tighter (less stage kept in view, smaller padding)
  // and never stop pulling out before both fighters fit; width is what limits the zoom there.
  const portrait = aspect < 0.9;
  minX = Math.min(minX, portrait ? -1.2 : -2.5);
  maxX = Math.max(maxX, portrait ? 1.2 : 2.5);
  minY = Math.min(minY, -0.4);
  const pad = portrait ? 1.0 : 1.6;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  // Zoom limits: close enough to read fighters, far enough for the widest stage's ends.
  const need = Math.max(height / (2 * tan), width / (2 * tan * aspect));
  const d = portrait ? Math.max(7, need) : Math.max(10, Math.min(40, need));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = clamp((minX + maxX) / 2, blast.left, blast.right);
  // Portrait: sit the fight lower on screen, nearer the thumbs, instead of centred under empty sky.
  const y = clamp((minY + maxY) / 2 + 0.3 + (portrait ? d * tan * 0.2 : 0), blast.bottom, blast.top);
  return { x, y, d };
}

/** The kill cue's punch-in (`p` 0 to 1): toward the impact, closer by `share` of the distance. */
export function punchGoal(goal: CamGoal, impact: { x: number; y: number }, p: number, share: number, minDist = 6): CamGoal {
  return {
    x: goal.x + (impact.x - goal.x) * 0.7 * p,
    y: goal.y + (impact.y - goal.y) * 0.7 * p,
    d: Math.max(minDist, goal.d * (1 - share * p)),
  };
}

export interface FollowOptions {
  smooth: number;
  smoothZoom: number;
  /** Seconds since the last frame (already capped). */
  dt: number;
  /** Tangent of half the vertical field of view. */
  tan: number;
  /** Sideways angle (-1..1) and extra tilt of the commercial-break cameras: they skew the view, so the guard keeps more margin. */
  side?: number;
  tilt?: number;
  /** Living fighters the view must contain; `null` for story scenes, which frame by hand. */
  keep?: { fighters: readonly CamFighter[]; tan: number; aspect: number } | null;
}

/**
 * A frame is a camera jump when the view slides by more than this share of its own height, or the distance changes by
 * more than this share of itself (per 1/60 s). Measured against the view, not in world units, so a wide portrait
 * view that sits far back is held to the same standard as a close one.
 */
export const JUMP_PAN = 0.25;
export const JUMP_ZOOM = 0.12;

/**
 * Follows `goal` with critically damped pan and zoom, then makes sure every fighter is still in view: if the damping
 * lagged behind a fast launch, the view widens or slides just enough. Both steps are rate-limited under the jump
 * threshold, so the catch-up is a smooth, fast glide, never a snap. Returns true when a frame still moved or zoomed
 * past the threshold (a bug: the limits above make it impossible, the playtest counts it anyway).
 */
export function followCamera(cam: CamState, goal: CamGoal, o: FollowOptions): boolean {
  const px = cam.x;
  const py = cam.y;
  const pd = cam.d;
  const frames = Math.max(1, o.dt * 60);
  const viewH = 2 * o.tan * pd;
  const panThr = JUMP_PAN * viewH * frames;
  const zoomThr = JUMP_ZOOM * pd * frames;
  const limit = (cur: number, prev: number, max: number): number => prev + Math.max(-max, Math.min(max, cur - prev));
  [cam.x, cam.vx] = smoothDamp(cam.x, goal.x, cam.vx, o.smooth, o.dt);
  [cam.y, cam.vy] = smoothDamp(cam.y, goal.y, cam.vy, o.smooth, o.dt);
  [cam.d, cam.vd] = smoothDamp(cam.d, goal.d, cam.vd, o.smoothZoom, o.dt);
  // The damped glide never asks for more than half the threshold in one frame (and its speed follows what was allowed).
  const dx = limit(cam.x, px, panThr * 0.5) - cam.x;
  const dy = limit(cam.y, py, panThr * 0.5) - cam.y;
  const dd = limit(cam.d, pd, zoomThr * 0.5) - cam.d;
  cam.x += dx;
  cam.y += dy;
  cam.d += dd;
  if (dx !== 0) cam.vx = (cam.x - px) / o.dt;
  if (dy !== 0) cam.vy = (cam.y - py) / o.dt;
  if (dd !== 0) cam.vd = (cam.d - pd) / o.dt;
  if (o.keep && o.keep.fighters.length > 0) keepInView(cam, o.keep.fighters, o.keep.tan, o.keep.aspect, o.side ?? 0, o.tilt ?? 0, px, py, pd, panThr * 0.7, zoomThr * 0.95);
  return Math.hypot(cam.x - px, cam.y - py) > panThr || Math.abs(cam.d - pd) > zoomThr;
}

/** Widens and slides the camera so every fighter (feet to head) is inside the view with a margin, within the per-frame limits. */
function keepInView(cam: CamState, fighters: readonly CamFighter[], tan: number, aspect: number, side: number, tilt: number, px: number, py: number, pd: number, panMax: number, zoomMax: number): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of fighters) {
    minX = Math.min(minX, f.x);
    maxX = Math.max(maxX, f.x);
    minY = Math.min(minY, f.y);
    maxY = Math.max(maxY, f.y + f.h);
  }
  // The camera sits a little off the line of sight (a slight downward look, and the side angles), so the plane
  // is skewed and one edge shows less than the middle does: keep more margin in those views.
  const safeX = Math.max(0.6, 0.93 - 0.14 * Math.abs(side));
  const safeY = Math.max(0.6, 0.93 - (0.06 + Math.abs(tilt)) * 1.1);
  const need = Math.max((maxX - minX) / (2 * tan * aspect * safeX), (maxY - minY) / (2 * tan * safeY));
  if (need > cam.d) cam.d = Math.min(need, Math.max(cam.d, pd + zoomMax));
  const hw = cam.d * tan * aspect * safeX;
  const hh = cam.d * tan * safeY;
  // Slide only as far as needed to bring the box inside the view, and never faster than the limit.
  const slide = (cur: number, prev: number, lo: number, hi: number): number => {
    const want = lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, cur));
    return prev + Math.max(-panMax, Math.min(panMax, want - prev));
  };
  cam.x = slide(cam.x, px, maxX - hw, minX + hw);
  cam.y = slide(cam.y, py, maxY - hh, minY + hh);
}

/** The fighters the camera frames, in world units: everyone alive, and the spot of anyone about to respawn. */
export function cameraFighters(state: GameState, respawn: { x: number; y: number }): { live: CamFighter[]; soon: CamFighter[] } {
  const live: CamFighter[] = [];
  const soon: CamFighter[] = [];
  const unit = 1 / (100 * FX);
  for (const f of state.fighters) {
    const h = (CHARACTERS[f.char].height * (f.scale / 100)) / 100;
    if (f.action !== ACT.DEAD) live.push({ x: f.x * unit, y: f.y * unit, h });
    else if (f.stocks > 0 && f.frame >= RESPAWN_DELAY - RESPAWN_LEAD) soon.push({ x: (respawn.x + (f.id - 1) * 90) / 100, y: respawn.y / 100, h });
  }
  return { live, soon };
}
