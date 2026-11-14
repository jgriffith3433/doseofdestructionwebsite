// The match camera's maths, kept pure (no Babylon) so `src/game/test/camera.test.ts` can run it against real bot
// matches: the framing goal, the kill cue's punch-in, critically damped follow and the keep-in-view guard.

import { FX } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { ACT, type GameState } from '../sim/state.ts';
import { RESPAWN_DELAY } from '../sim/step.ts';

/** Frames before a respawn when the camera starts making room for it, so the fighter drops into a view that already holds them. */
export const RESPAWN_LEAD = 45;

/** Zoom springs: closing in is quick (about 0.15 s), pulling out is lazy (about 0.5 s), like a camera operator's. */
export const ZOOM_IN_S = 0.15;
export const ZOOM_OUT_S = 0.5;
/** The share of the view's half-width and half-height fighters may use: the rest is the 5% screen margin. */
export const SAFE_SHARE = 0.9;

export interface CamFighter {
  /** World position of the feet, and the body's height, in world units. */
  x: number;
  y: number;
  h: number;
  /** Knockback velocity in world units a second. */
  vx?: number;
  vy?: number;
  /**
   * Flung by a hard hit (knockback speed over `LAUNCH_SPEED`) within the last `LAUNCH_EXEMPT_S`: the camera lets it fly
   * (the other fighter stays framed, the offscreen bubble follows the launched one) and the framing checks give the
   * camera that long to bring it back.
   */
  launched?: boolean;
  /** Seconds since the launch while it still counts (`LEASH_S`); undefined for a fighter that was not launched. */
  age?: number;
}

/**
 * A launched fighter is framed on a leash: it counts only as far as `LEASH_BASE` + `LEASH_RATE` * age beyond the box of the
 * others, so the view widens at the pace the zoom may (never in one lurch) instead of dropping the flier and then grabbing it back.
 */
export const LEASH_S = 6;
export const LEASH_BASE = 1.2;
export const LEASH_RATE = 1.5;

/** The fighters as the framing sees them: launched ones pulled in on their leash toward the rest. */
export function leashed(fighters: readonly CamFighter[]): readonly CamFighter[] {
  const free = fighters.filter((f) => f.age === undefined);
  if (free.length === 0 || free.length === fighters.length) return fighters;
  let lx = Infinity;
  let hx = -Infinity;
  let ly = Infinity;
  let hy = -Infinity;
  for (const f of free) {
    lx = Math.min(lx, f.x);
    hx = Math.max(hx, f.x);
    ly = Math.min(ly, f.y);
    hy = Math.max(hy, f.y);
  }
  return fighters.map((f) => {
    if (f.age === undefined) return f;
    const s = LEASH_BASE + LEASH_RATE * f.age;
    return { ...f, x: Math.max(lx - s, Math.min(hx + s, f.x)), y: Math.max(ly - s, Math.min(hy + s, f.y)) };
  });
}

/** Knockback speed (world units a second) that counts as a launch, and how long after it the camera has to catch up. */
export const LAUNCH_SPEED = 12;
export const LAUNCH_EXEMPT_S = 1.2;

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
export function frameGoal(fighters: readonly CamFighter[], blast: CamBounds, aspect: number, tan: number, bottomInset = 0): CamGoal {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of leashed(fighters)) {
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
  // Touch controls cover the bottom `bottomInset` of the screen (a share of its height): the fight uses the rest.
  const usable = 1 - Math.max(0, Math.min(0.6, bottomInset));
  const width = maxX - minX + pad * 2;
  const height = (maxY - minY + pad * 2) / usable;
  // Zoom limits: close enough to read fighters, far enough for the widest stage's ends.
  const need = Math.max(height / (2 * tan), width / (2 * tan * aspect));
  const d = portrait ? Math.max(7, need) : Math.max(10, Math.min(40, need));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = clamp((minX + maxX) / 2, blast.left, blast.right);
  // Portrait: sit the fight lower on screen, nearer the thumbs, instead of centred under empty sky.
  // The view's middle drops by half the inset, which lifts the fight clear of the controls.
  const y = clamp((minY + maxY) / 2 + 0.3 + (portrait ? d * tan * 0.2 : 0) - bottomInset * d * tan, blast.bottom, blast.top);
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
  keep?: { fighters: readonly CamFighter[]; tan: number; aspect: number; bottomInset?: number } | null;
  /** Closing in uses `ZOOM_IN_S`, pulling out `ZOOM_OUT_S` (default on; story scenes keep their own slow springs). */
  zoomAsym?: boolean;
  /** The camera holds still while the framing box stays near the middle of the view (default on; off for the kill cue and story scenes). */
  deadZone?: boolean;
  /** Screen width over height, for the dead zone (default 16:9). */
  aspect?: number;
  /** Fastest zoom-out as a share of the distance a second (the playtest's 40% limit); `undefined` = no cap (the KO zoom). */
  maxZoomOut?: number;
}

/** The dead zone: how far the framing box's centre may stray from the view's middle before the camera follows, as shares of the view's height (and width). */
export const DEAD_ZONE = { x: 0.07, y: 0.12 };

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
  if (o.deadZone !== false) {
    const dzx = DEAD_ZONE.x * viewH * (o.aspect ?? 16 / 9);
    const dzy = DEAD_ZONE.y * viewH;
    goal = { x: goal.x - Math.max(-dzx, Math.min(dzx, goal.x - cam.x)), y: goal.y - Math.max(-dzy, Math.min(dzy, goal.y - cam.y)), d: goal.d };
  }
  [cam.x, cam.vx] = smoothDamp(cam.x, goal.x, cam.vx, o.smooth, o.dt);
  [cam.y, cam.vy] = smoothDamp(cam.y, goal.y, cam.vy, o.smooth, o.dt);
  const asym = o.zoomAsym !== false;
  const zs = asym ? (goal.d < cam.d ? Math.min(o.smoothZoom, ZOOM_IN_S) : Math.max(o.smoothZoom, ZOOM_OUT_S)) : o.smoothZoom;
  [cam.d, cam.vd] = smoothDamp(cam.d, goal.d, cam.vd, zs, o.dt);
  // The damped glide never asks for more than half the threshold in one frame (and its speed follows what was allowed).
  const dx = limit(cam.x, px, panThr * 0.5) - cam.x;
  const dy = limit(cam.y, py, panThr * 0.5) - cam.y;
  const dd = limit(cam.d, pd, zoomThr * 0.5) - cam.d;
  const outCap = o.maxZoomOut === undefined ? Infinity : o.maxZoomOut * o.dt * pd;
  cam.x += dx;
  cam.y += dy;
  cam.d += dd;
  if (dx !== 0) cam.vx = (cam.x - px) / o.dt;
  if (dy !== 0) cam.vy = (cam.y - py) / o.dt;
  if (dd !== 0) cam.vd = (cam.d - pd) / o.dt;
  if (o.keep && o.keep.fighters.length > 0) keepInView(cam, o.keep.fighters, o.keep.tan, o.keep.aspect, o.side ?? 0, o.tilt ?? 0, px, py, pd, panThr * 0.7, zoomThr * 0.95, o.keep.bottomInset ?? 0);
  if (cam.d > pd + outCap) {
    cam.d = pd + outCap;
    cam.vd = Math.min(cam.vd, outCap / o.dt);
  }
  return Math.hypot(cam.x - px, cam.y - py) > panThr || Math.abs(cam.d - pd) > zoomThr;
}

/** Widens and slides the camera so every fighter (feet to head) is inside the view with a margin, within the per-frame limits. */
function keepInView(cam: CamState, fighters: readonly CamFighter[], tan: number, aspect: number, side: number, tilt: number, px: number, py: number, pd: number, panMax: number, zoomMax: number, inset: number): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of leashed(fighters)) {
    minX = Math.min(minX, f.x);
    maxX = Math.max(maxX, f.x);
    minY = Math.min(minY, f.y);
    maxY = Math.max(maxY, f.y + f.h);
  }
  // The camera sits a little off the line of sight (a slight downward look, and the side angles), so the plane
  // is skewed and one edge shows less than the middle does: keep more margin in those views.
  const safeX = Math.max(0.6, SAFE_SHARE - 0.14 * Math.abs(side));
  const safeY = Math.max(0.6, 0.93 - (0.06 + Math.abs(tilt)) * 1.1);
  const usable = 1 - Math.max(0, Math.min(0.6, inset));
  const need = Math.max((maxX - minX) / (2 * tan * aspect * safeX), (maxY - minY) / (2 * tan * safeY * usable));
  if (need > cam.d) cam.d = Math.min(need, Math.max(cam.d, pd + zoomMax));
  const hw = cam.d * tan * aspect * safeX;
  const hh = cam.d * tan * safeY;
  // Slide only as far as needed to bring the box inside the view, and never faster than the limit.
  const slide = (cur: number, prev: number, lo: number, hi: number): number => {
    const want = lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, cur));
    return prev + Math.max(-panMax, Math.min(panMax, want - prev));
  };
  cam.x = slide(cam.x, px, maxX - hw, minX + hw);
  cam.y = slide(cam.y, py, maxY - hh, minY + hh * (1 - 2 * inset));
}

/** The fighters the camera frames, in world units: everyone alive, and the spot of anyone about to respawn. */
export function cameraFighters(state: GameState, respawn: { x: number; y: number }, launch?: Map<number, number>, leash = false): { live: CamFighter[]; soon: CamFighter[] } {
  const live: CamFighter[] = [];
  const soon: CamFighter[] = [];
  const unit = 1 / (100 * FX);
  for (const f of state.fighters) {
    const h = (CHARACTERS[f.char].height * (f.scale / 100)) / 100;
    if (f.action !== ACT.DEAD) {
      // Only a launch (knockback) is looked ahead along: jumps and runs are followed, not predicted.
      const c: CamFighter = { x: f.x * unit, y: f.y * unit, h, vx: f.kbx * unit * 60, vy: f.kby * unit * 60 };
      if (launch) {
        if (Math.hypot(c.vx!, c.vy!) >= LAUNCH_SPEED) launch.set(f.id, state.frame);
        const age = (state.frame - (launch.get(f.id) ?? -9999)) / 60;
        c.launched = age <= LAUNCH_EXEMPT_S;
        if (leash && age <= LEASH_S) c.age = age;
      }
      live.push(c);
    }
    else if (f.stocks > 0 && f.frame >= RESPAWN_DELAY - RESPAWN_LEAD) soon.push({ x: (respawn.x + (f.id - 1) * 90) / 100, y: respawn.y / 100, h });
  }
  return { live, soon };
}

// ---------------------------------------------------------------- the camera trace (playtest and test/camera.test.ts)

/** One rendered frame of the match camera: where it is, and where each fighter landed on screen (0..1, y down). */
export interface CamSample {
  /** Seconds on a steady clock. */
  t: number;
  x: number;
  y: number;
  d: number;
  /** Screen shake was running, or a kill cue's punch: the frame is exempt from the jitter and zoom checks. */
  shake: boolean;
  ko: boolean;
  /** An intended cut (new stage, rematch, a scene): the trace starts over after it. */
  cut: boolean;
  /** Living fighters: feet and head on screen; `exempt` when past the blast zone (the offscreen bubble shows them). */
  f: { x: number; y: number; top: number; exempt: boolean }[];
  dbg?: string;
}

/** A touch control's rectangle as shares of the screen (left, top, right, bottom). */
export interface ScreenRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Seconds after a kill cue that its zoom may still be easing back out. */
export const KO_TAIL_S = 0.8;

export const TRACE_LIMITS = {
  /** Direction flips a second, either axis: 2 or more fails. */
  flipsPerSecond: 2,
  /** Zoom-out, share of the distance a second (outside the KO zoom). */
  zoomOutPerSecond: 0.4,
  /** The screen margin, and how long one fighter may sit outside it. */
  margin: 0.05,
  marginSeconds: 0.2,
  /** Share of frames that may have a fighter outside the margin. */
  marginFrames: 0.01,
  /** A fighter under the stick or buttons. */
  touchSeconds: 0.5,
};

export interface TraceReport {
  frames: number;
  seconds: number;
  /** The most direction flips in any one second, per axis. */
  flipsX: number;
  flipsY: number;
  /** The fastest zoom-out over a 0.25 s window, share of distance a second. */
  zoomOutMax: number;
  /** When (trace seconds) the fastest zoom-out and the last flips happened, to find them in a recording. */
  zoomOutAt: number;
  flipAt: number[];
  /** The largest frame-to-frame change of camera speed, world units a second squared. */
  accelMax: number;
  marginFrames: number;
  marginShare: number;
  marginLongest: number;
  touchLongest: number;
  fails: string[];
}

/** Reads a camera trace against `TRACE_LIMITS`. Pure: the renderer records, the playtest and the test judge. */
export function analyzeCameraTrace(samples: readonly CamSample[], touch: readonly ScreenRect[] = [], tan = Math.tan(0.275)): TraceReport {
  const L = TRACE_LIMITS;
  const r: TraceReport = { frames: samples.length, seconds: 0, flipsX: 0, flipsY: 0, zoomOutMax: 0, zoomOutAt: 0, flipAt: [], accelMax: 0, marginFrames: 0, marginShare: 0, marginLongest: 0, touchLongest: 0, fails: [] };
  if (samples.length < 2) return r;
  r.seconds = samples[samples.length - 1].t - samples[0].t;
  // The KO zoom runs on after the cue itself: the zoom spring is still easing back out for a moment.
  let koUntil = -1;
  const koAt = samples.map((q) => {
    if (q.ko) koUntil = q.t + KO_TAIL_S;
    return q.t <= koUntil;
  });
  const flips: [number[], number[]] = [[], []];
  const lastSign = [0, 0];
  const ext: (number | null)[] = [null, null];
  let prevV: [number, number] | null = null;
  let judged = 0;
  let marginRun = 0;
  let marginRunStart = 0;
  const touchRun: number[] = touch.map(() => 0);
  const touchStart: number[] = touch.map(() => 0);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const p = samples[i - 1];
    // Fighters against the margin and the controls (a cut frame is not judged, the camera has just been set).
    if (!s.cut && s.f.some((f) => !f.exempt)) {
      judged++;
      const out = s.f.some((f) => !f.exempt && (f.x < L.margin || f.x > 1 - L.margin || f.top < L.margin || f.y > 1 - L.margin));
      if (out) {
        r.marginFrames++;
        if (marginRun === 0) marginRunStart = s.t;
        marginRun++;
        r.marginLongest = Math.max(r.marginLongest, s.t - marginRunStart);
      } else marginRun = 0;
      touch.forEach((q, k) => {
        const under = s.f.some((f) => !f.exempt && [f.y, f.top, (f.y + f.top) / 2].some((y) => f.x >= q.l && f.x <= q.r && y >= q.t && y <= q.b));
        if (under) {
          if (touchRun[k] === 0) touchStart[k] = s.t;
          touchRun[k]++;
          r.touchLongest = Math.max(r.touchLongest, s.t - touchStart[k]);
        } else touchRun[k] = 0;
      });
    } else {
      marginRun = 0;
      touchRun.fill(0);
    }
    if (!p || s.cut || p.cut || s.t - p.t <= 0) {
      prevV = null;
      lastSign[0] = lastSign[1] = 0;
      ext[0] = ext[1] = null;
      continue;
    }
    const dt = s.t - p.t;
    const v: [number, number] = [(s.x - p.x) / dt, (s.y - p.y) / dt];
    if (prevV) r.accelMax = Math.max(r.accelMax, Math.hypot(v[0] - prevV[0], v[1] - prevV[1]) / dt);
    prevV = v;
    if (s.shake || p.shake) {
      lastSign[0] = lastSign[1] = 0;
      ext[0] = ext[1] = null;
      continue;
    }
    // Direction flips: the camera turns back after moving the other way by more than 1.5% of the view (a zigzag filter,
    // so drift and rounding are not jitter but a real back-and-forth is).
    const thr = 0.015 * 2 * tan * s.d;
    const pos = [s.x, s.y];
    for (let a = 0; a < 2; a++) {
      if (ext[a] === null) {
        ext[a] = pos[a];
        continue;
      }
      if (lastSign[a] === 0) {
        if (Math.abs(pos[a] - ext[a]!) >= thr) {
          lastSign[a] = Math.sign(pos[a] - ext[a]!);
          ext[a] = pos[a];
        }
      } else if (lastSign[a] > 0) {
        if (pos[a] > ext[a]!) ext[a] = pos[a];
        else if (ext[a]! - pos[a] >= thr) {
          flips[a].push(s.t);
          lastSign[a] = -1;
          ext[a] = pos[a];
        }
      } else if (pos[a] < ext[a]!) ext[a] = pos[a];
      else if (pos[a] - ext[a]! >= thr) {
        flips[a].push(s.t);
        lastSign[a] = 1;
        ext[a] = pos[a];
      }
    }
    // Zoom-out over 0.25 s, skipping windows that touch a kill cue.
    let j = i;
    while (j > 0 && s.t - samples[j - 1].t < 0.25) j--;
    if (j > 0 && j < i) {
      const w = samples[j - 1];
      const span = s.t - w.t;
      if (span >= 0.2 && !samples.slice(j - 1, i + 1).some((q, k) => koAt[j - 1 + k] || q.cut)) {
        const rate = (s.d - w.d) / w.d / span;
        if (rate > r.zoomOutMax) {
          r.zoomOutMax = rate;
          r.zoomOutAt = s.t;
        }
      }
    }
  }
  r.marginShare = judged ? r.marginFrames / judged : 0;
  for (let a = 0; a < 2; a++) {
    const ts = flips[a];
    let best = 0;
    for (let i = 0, j = 0; i < ts.length; i++) {
      while (ts[i] - ts[j] > 1) j++;
      best = Math.max(best, i - j + 1);
    }
    if (best >= L.flipsPerSecond) r.flipAt.push(...ts);
    if (a === 0) r.flipsX = best;
    else r.flipsY = best;
  }
  if (r.flipsX >= L.flipsPerSecond || r.flipsY >= L.flipsPerSecond) r.fails.push(`camera jitter: ${r.flipsX} horizontal / ${r.flipsY} vertical direction flips in one second (limit under ${L.flipsPerSecond})`);
  if (r.zoomOutMax > L.zoomOutPerSecond) r.fails.push(`zoom-out ${(r.zoomOutMax * 100).toFixed(0)}% a second (limit ${L.zoomOutPerSecond * 100}%)`);
  if (r.marginShare > L.marginFrames || r.marginLongest > L.marginSeconds) r.fails.push(`a fighter outside the ${L.margin * 100}% margin in ${(r.marginShare * 100).toFixed(1)}% of frames, longest ${r.marginLongest.toFixed(2)} s`);
  if (r.touchLongest > L.touchSeconds) r.fails.push(`a fighter under the touch controls for ${r.touchLongest.toFixed(2)} s (limit ${L.touchSeconds} s)`);
  return r;
}
