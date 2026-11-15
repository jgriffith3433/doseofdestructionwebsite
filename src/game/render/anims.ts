// Sprite-sheet animation clips made by _build_anims.py, and which clip a
// fighter should be showing. Fighters without clips fall back to their still
// image with procedural squash and lean, so clips can arrive one at a time.

import { CHARACTERS, MOVE_KEYS, THROW_CLIPS } from '../sim/characters.ts';
import { ACT, type Fighter } from '../sim/state.ts';
import { LEDGE_RISE } from '../sim/step.ts';

export interface Clip {
  file: string;
  /** Optional half-resolution sheet for Low quality (same UV layout; tools/smooth-clips.mjs). */
  halfFile?: string;
  frames: number;
  cols: number;
  rows: number;
  /** Frame size in pixels. */
  fw: number;
  fh: number;
  /** The feet, in pixels from the frame's top left. */
  ax: number;
  ay: number;
  fps: number;
  loop: boolean;
  /** Moves: the strike frame (full extension). Played on the move's first active frame. */
  hit?: number | null;
  /** Per frame, how far the sole sits below the anchor row, in sheet pixels (tools/fit-feet.mjs). */
  feet?: number[];
  /** Walk and run: the sheet pixels the planted foot travels over one cycle, and per frame (tools/fit-feet.mjs). */
  stride?: number;
  travel?: number[];
  slip?: number;
}

/** Sheet file to load for a clip at the current quality (half-size on Low when present). */
export function clipSheetFile(clip: Clip, quality: 'high' | 'low'): string {
  return quality === 'low' && clip.halfFile ? clip.halfFile : clip.file;
}

export interface AnimSet {
  /** The character's standing height in pixels, which maps to their in-game height. */
  refHeight: number;
  clips: Record<string, Clip>;
  base: string;
  /** Changes on every rebuild, so browsers fetch the new sheets. */
  version: number;
}

const ROOT = '/characters/anim/';
let index: Promise<Record<string, boolean>> | null = null;
const sets = new Map<string, Promise<AnimSet | null>>();

function loadIndex(): Promise<Record<string, boolean>> {
  index ??= fetch(`${ROOT}index.json`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return index;
}

/** The clips for a character, or null when none have been made yet. */
export function loadAnimSet(id: string): Promise<AnimSet | null> {
  let p = sets.get(id);
  if (!p) {
    p = loadIndex().then(async (have) => {
      if (!have[id]) return null;
      try {
        const r = await fetch(`${ROOT}${id}/anims.json`, { cache: 'no-store' });
        if (!r.ok) return null;
        const data = await r.json();
        return { refHeight: data.refHeight, clips: data.clips, base: `${ROOT}${id}/`, version: data.version ?? 0 } as AnimSet;
      } catch {
        return null;
      }
    });
    sets.set(id, p);
  }
  return p;
}

/** Clips to try for an action, best first. The first one is an exact match. */
function wanted(f: Fighter): string[] {
  switch (f.action) {
    case ACT.IDLE:
    case ACT.RESPAWN:
      return ['idle'];
    case ACT.WALK:
      return ['walk', 'idle'];
    case ACT.CROUCH:
      return ['crouch', 'idle'];
    case ACT.JUMPSQUAT:
      return ['jumpsquat', 'crouch', 'idle'];
    case ACT.AIR:
      return f.vy > 0 ? ['jump', 'fall', 'idle'] : ['fall', 'jump', 'idle'];
    case ACT.LAND:
      return ['land', 'crouch', 'idle'];
    case ACT.ATTACK:
      return [MOVE_KEYS[f.move], ...(CHARACTERS[f.char].moves[f.move].clips ?? []), 'idle'];
    case ACT.HITSTUN:
      return ['hurt', 'fall', 'idle'];
    case ACT.SHIELD:
    case ACT.SHIELD_STUN:
      return ['shield', 'idle'];
    case ACT.ROLL:
      return ['roll', 'idle'];
    case ACT.SPOTDODGE:
      return ['dodge', 'shield', 'idle'];
    case ACT.AIRDODGE:
      return ['airdodge', 'fall', 'idle'];
    case ACT.LEDGE:
      return ['ledge', 'fall', 'idle'];
    case ACT.LEDGE_CLIMB:
      return ['climb', 'jump', 'idle'];
    // The roll climbs over the edge, then rolls across; the attack climbs, then swings the down tilt (the sim hands over to it).
    case ACT.LEDGE_ROLL:
      return f.frame <= LEDGE_RISE ? ['climb', 'jump', 'idle'] : ['roll', 'idle'];
    case ACT.LEDGE_ATTACK:
      return ['climb', 'jump', 'idle'];
    case ACT.LEDGE_JUMP:
      return f.vy > 0 ? ['jump', 'fall', 'idle'] : ['fall', 'jump', 'idle'];
    case ACT.HELPLESS:
      return ['helpless', 'fall', 'idle'];
    case ACT.DIZZY:
      return ['dizzy', 'idle'];
    // The grab reuses the jab for its reach, the throws reuse the tilts and the back air, the held fighter plays hurt.
    case ACT.GRAB:
    case ACT.GRAB_HOLD:
      return ['jab', 'idle'];
    case ACT.THROW:
      return [THROW_CLIPS[Math.max(0, f.throwKind - 1)], 'idle'];
    case ACT.GRABBED:
      return ['hurt', 'fall', 'idle'];
    default:
      return ['idle'];
  }
}

export interface Pick {
  key: string;
  clip: Clip;
  /** False when a stand-in clip is used; the renderer then adds procedural motion. */
  exact: boolean;
  /** The set's standing height in sheet pixels. */
  refHeight: number;
}

export function pickClip(f: Fighter, set: AnimSet | null): Pick | null {
  if (!set) return null;
  const keys = wanted(f);
  for (let i = 0; i < keys.length; i++) {
    const clip = set.clips[keys[i]];
    if (clip) return { key: keys[i], clip, exact: i === 0, refHeight: set.refHeight };
  }
  return null;
}

/** Which frame of the clip to show. Moves are stretched to fit their frame data. */
export function clipFrame(f: Fighter, pick: Pick): number {
  const { clip } = pick;
  const n = clip.frames;
  let span = 0;
  // Holding someone: the jab's reach stays at full extension, and the held fighter's hurt pose stays put.
  if (f.action === ACT.GRAB_HOLD) return Math.max(0, Math.min(n - 1, clip.hit && clip.hit > 0 ? clip.hit : n >> 1));
  if (f.action === ACT.GRABBED) return Math.min(n - 1, n >> 1);
  if (f.action === ACT.GRAB && pick.exact) return Math.min(n - 1, Math.floor((f.frame / Math.max(1, f.length)) * n));
  if (f.action === ACT.ATTACK && pick.exact) {
    const move = CHARACTERS[f.char].moves[f.move];
    span = move.total;
    // Line the strike up with the hitbox: frames before the first active frame play the
    // wind-up (up to the strike), the rest play the recovery. Fighting games barely
    // anticipate, so a jab reaches full extension right as it can hit.
    const strike = clip.hit;
    const active = move.hits.length ? Math.min(...move.hits.map((w) => w.start)) : 0;
    if (strike != null && strike > 0 && active > 0 && active < span) {
      const t = f.frame;
      const i = t < active ? (t / active) * strike : strike + ((t - active) / (span - active)) * (n - 1 - strike);
      return Math.max(0, Math.min(n - 1, Math.round(i)));
    }
  }
  else if (f.action === ACT.LEDGE_ROLL && pick.key === 'roll') span = f.length - LEDGE_RISE;
  else if (f.action === ACT.LEDGE_JUMP) span = 0;
  else if (pick.exact && f.length > 0 && !clip.loop) span = f.length;
  if (f.action === ACT.LEDGE_ROLL && pick.key === 'roll') return Math.min(n - 1, Math.floor(((f.frame - LEDGE_RISE) / span) * n));
  if (span > 0) return Math.min(n - 1, Math.floor((f.frame / span) * n));
  if (f.action === ACT.WALK && pick.key === 'walk' && clip.loop) return walkFrame(f, clip, pick.refHeight);
  const i = Math.floor((f.frame * clip.fps) / 60);
  return clip.loop ? i % n : Math.min(n - 1, i);
}

/** The art stands this much taller than the hurtbox (render/renderer.ts ART_SCALE). */
const ART_SCALE = 1.18;
const FX = 1000;

/**
 * The ground one walk cycle covers (sim units). A measured stride (the planted foot's travel over the cycle, from
 * tools/fit-feet.mjs) is turned into sim units with the fighter's art scale, so playback follows the fighter's own
 * ground speed; without one the clip's natural travel speed is the fighter's full walking speed at the clip's
 * own frame rate.
 */
export function walkStride(char: number, clip: Clip, refHeight = 0): number {
  if (clip.stride && refHeight > 0) return Math.max(1, clip.stride * ((CHARACTERS[char].height * ART_SCALE) / refHeight) * FX);
  return Math.max(1, (CHARACTERS[char].walkSpeed * clip.frames * 60) / clip.fps);
}

/**
 * Walk frames follow the ground covered, not the clock (studio rule 5, no foot sliding):
 * playback is actual speed / clip speed, so a light tilt of the stick walks slowly
 * instead of skating, and stopping freezes the stride where the feet are. With the measured per-frame
 * travel the frame is the one whose stretch of ground the fighter is on, so a foot that moves fast early in
 * its stance is shown moving fast and stays on the floor.
 */
export function walkFrame(f: Fighter, clip: Clip, refHeight = 0): number {
  const stride = walkStride(f.char, clip, refHeight);
  const d = (((f.x * f.facing) % stride) + stride) % stride;
  const t = clip.travel;
  if (t && clip.stride && t.length === clip.frames && refHeight > 0) {
    let at = 0;
    for (let i = 0; i < t.length; i++) {
      at += (t[i] / clip.stride) * stride;
      if (d < at) return i;
    }
    return clip.frames - 1;
  }
  return Math.min(clip.frames - 1, Math.floor((d / stride) * clip.frames));
}

/** Clips whose feet are on the floor while the fighter stands, walks, crouches, lands or shields. */
const FEET_CLIPS = new Set(['idle', 'walk', 'run', 'crouch', 'jumpsquat', 'land', 'shield', 'dodge', 'roll', 'dizzy']);

/**
 * How far to lift the sprite (sheet pixels) so the frame's lowest solid row meets the platform: the clip's
 * per-frame `feet`. Only for a grounded fighter on a floor clip (a stand-in clip or a launched fighter keeps its
 * anchor). Cap at 20% of height so a bad measurement can't throw a fighter, but idle soles that sit ~12% off
 * the anchor (spider-bot, evil-blue-bird) still correct fully.
 */
export function feetLift(f: Fighter, pick: Pick, frame: number): number {
  const feet = pick.clip.feet;
  if (!feet || !f.grounded || !pick.exact || !FEET_CLIPS.has(pick.key)) return 0;
  const v = feet[frame];
  if (v == null) return 0;
  const max = pick.refHeight * 0.2;
  return Math.max(-max, Math.min(max, v));
}
