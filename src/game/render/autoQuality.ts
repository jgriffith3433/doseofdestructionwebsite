/**
 * Auto quality: the renderer measures its own frame time over the first seconds of a match and, if the median stays over
 * budget, steps the picture down a level at a time until it fits. Pure maths and state (no Babylon, no DOM), so
 * `test/autoQuality.test.ts` can drive it with a made-up frame clock.
 *
 * Levels (cumulative; a level that changes nothing on this device is skipped):
 *   1  render scale capped at 0.75 per CSS pixel
 *   2  glow layer off
 *   3  post chain on its Low path (no grain, no hit punch) and the parallax layers and haze sheets between backdrop and stage hidden
 *   4  render scale capped at 0.5
 * Steps down happen only on a calm frame (no hit-stop, no punch), only in the first seconds of play, at most one step per
 * measuring window. Steps back up happen only at the start of the next match, one level at a time, and a step up that
 * did not hold is never tried again this visit. A quality the player picked by hand is never touched.
 */

export const AUTO_LEVELS = 4;
/** 45 fps is the bar; a median frame over this many ms is over budget (a little slack for the display's own jitter). */
export const BUDGET_MS = 23.5;
/** A window is this much measured play time and at least this many calm frames. */
export const WINDOW_MS = 800;
export const WINDOW_FRAMES = 6;
/** Steps down are only taken in this much play time of a match; after it the match plays as it settled. */
export const DECIDE_MS = 12000;
/** Consecutive windows inside the budget that count as settled. */
export const SETTLE_WINDOWS = 2;
/** A settled median at or above this fps is headroom: the next match tries one level higher. */
export const HEADROOM_FPS = 56;

export interface AutoEffects {
  /** The most render pixels per CSS pixel (Infinity: the quality's own cap). */
  scaleMax: number;
  glowOff: boolean;
  postLow: boolean;
  hideParallax: boolean;
}

export const effectsFor = (level: number): AutoEffects => ({
  scaleMax: level >= 4 ? 0.5 : level >= 1 ? 0.75 : Infinity,
  glowOff: level >= 2,
  postLow: level >= 3,
  hideParallax: level >= 3,
});

/** What a level actually does on a device whose own settings are `base` (render scale at `scale`, glow on or off, quality). */
export const signature = (level: number, base: { scale: number; glow: boolean; quality: string }): string => {
  const e = effectsFor(level);
  return [
    Number(Math.min(base.scale, e.scaleMax).toFixed(3)),
    base.glow && !e.glowOff ? 1 : 0,
    base.quality === 'high' && !e.postLow ? 1 : 0,
    e.hideParallax ? 1 : 0,
  ].join('/');
};

/** The next level above `from` (or below, dir -1) that changes something on this device; `from` when none does. */
export const nextLevel = (from: number, dir: 1 | -1, base: { scale: number; glow: boolean; quality: string }): number => {
  const here = signature(from, base);
  for (let l = from + dir; l >= 0 && l <= AUTO_LEVELS; l += dir) if (signature(l, base) !== here) return l;
  return from;
};

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface AutoChange {
  from: number;
  to: number;
  /** Median frame time (ms) of the window that decided it. */
  medianMs: number;
  /** Play time into the match, ms. */
  atMs: number;
  /** `down` while measuring, `up` at a match start. */
  dir: 'down' | 'up';
}

export class AutoQuality {
  level = 0;
  /** Off for a player's hand-picked quality, and for tests and scenarios that need a fixed picture. */
  enabled = true;
  /** Every change this visit, in order. */
  readonly changes: AutoChange[] = [];
  /** Windows' median fps of the current match, last first. */
  lastFps = 0;
  settled = false;
  /** Play time at which the current match settled, ms (-1: not yet). */
  settledAtMs = -1;
  /** Median fps of the settled windows of the last match that settled (0: none yet). */
  headroomFps = 0;
  /** A step up that had to be undone: no more step ups this visit. */
  upBlocked = false;
  /** The match began on a stepped-up level that has not been proved yet. */
  private trialUp = false;
  private playMs = 0;
  private win: number[] = [];
  private winMs = 0;
  private okWindows = 0;
  private okFps: number[] = [];

  constructor(level = 0) {
    this.level = Math.max(0, Math.min(AUTO_LEVELS, level | 0));
  }

  /** A new match begins: measuring starts over, and a level with headroom last time is tried one step higher. */
  beginMatch(base: { scale: number; glow: boolean; quality: string }): AutoChange | null {
    this.playMs = 0;
    this.win = [];
    this.winMs = 0;
    this.okWindows = 0;
    this.okFps = [];
    this.settled = false;
    this.settledAtMs = -1;
    this.trialUp = false;
    if (!this.enabled || this.level === 0 || this.upBlocked || this.headroomFps < HEADROOM_FPS) return null;
    const to = nextLevel(this.level, -1, base);
    if (to === this.level) return null;
    const c: AutoChange = { from: this.level, to, medianMs: 1000 / this.headroomFps, atMs: 0, dir: 'up' };
    this.level = to;
    this.headroomFps = 0;
    this.trialUp = true;
    this.changes.push(c);
    return c;
  }

  /**
   * One rendered frame of play. `dt` is the frame time in ms; `calm` is false in hit-stop and punch frames (those are
   * not measured and never trigger a step). Returns the change when this frame closed a window over budget.
   */
  frame(dt: number, calm: boolean, base: { scale: number; glow: boolean; quality: string }): AutoChange | null {
    if (!this.enabled) return null;
    // A load stall, a tab in the background: not the picture's cost.
    if (!(dt > 0) || dt > 1500) return null;
    this.playMs += dt;
    if (this.settled && this.playMs >= DECIDE_MS) return null;
    if (!calm) return null;
    this.win.push(dt);
    this.winMs += dt;
    if (this.winMs < WINDOW_MS || this.win.length < WINDOW_FRAMES) return null;
    const med = median(this.win);
    this.win = [];
    this.winMs = 0;
    if (med <= BUDGET_MS) {
      this.okWindows++;
      this.okFps.push(1000 / med);
      this.lastFps = 1000 / med;
      if (this.okWindows >= SETTLE_WINDOWS && !this.settled) {
        this.settled = true;
        this.settledAtMs = this.playMs;
        this.headroomFps = median(this.okFps);
        this.trialUp = false;
      }
      return null;
    }
    this.lastFps = 1000 / med;
    this.okWindows = 0;
    this.okFps = [];
    this.settled = false;
    if (this.playMs > DECIDE_MS) return null;
    let to = nextLevel(this.level, 1, base);
    // Far over budget (under ~22 fps): one more step at once, so a very slow device settles inside a few seconds.
    if (med > 45 && to !== this.level) to = nextLevel(to, 1, base);
    if (to === this.level) return null;
    if (this.trialUp) {
      this.upBlocked = true;
      this.trialUp = false;
    }
    const c: AutoChange = { from: this.level, to, medianMs: med, atMs: this.playMs, dir: 'down' };
    this.level = to;
    this.changes.push(c);
    return c;
  }
}
