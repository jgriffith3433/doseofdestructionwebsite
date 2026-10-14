// Sprite-sheet animation clips made by _build_anims.py, and which clip a
// fighter should be showing. Fighters without clips fall back to their still
// image with procedural squash and lean, so clips can arrive one at a time.

import { CHARACTERS, MOVE_KEYS } from '../sim/characters.ts';
import { ACT, type Fighter } from '../sim/state.ts';

export interface Clip {
  file: string;
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
      return [MOVE_KEYS[f.move], 'idle'];
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
    case ACT.HELPLESS:
      return ['helpless', 'fall', 'idle'];
    case ACT.DIZZY:
      return ['dizzy', 'idle'];
    default:
      return ['idle'];
  }
}

export interface Pick {
  key: string;
  clip: Clip;
  /** False when a stand-in clip is used; the renderer then adds procedural motion. */
  exact: boolean;
}

export function pickClip(f: Fighter, set: AnimSet | null): Pick | null {
  if (!set) return null;
  const keys = wanted(f);
  for (let i = 0; i < keys.length; i++) {
    const clip = set.clips[keys[i]];
    if (clip) return { key: keys[i], clip, exact: i === 0 };
  }
  return null;
}

/** Which frame of the clip to show. Moves are stretched to fit their frame data. */
export function clipFrame(f: Fighter, pick: Pick): number {
  const { clip } = pick;
  const n = clip.frames;
  let span = 0;
  if (f.action === ACT.ATTACK && pick.exact) span = CHARACTERS[f.char].moves[f.move].total;
  else if (pick.exact && f.length > 0 && !clip.loop) span = f.length;
  if (span > 0) return Math.min(n - 1, Math.floor((f.frame / span) * n));
  const i = Math.floor((f.frame * clip.fps) / 60);
  return clip.loop ? i % n : Math.min(n - 1, i);
}
