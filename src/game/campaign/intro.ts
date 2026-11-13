// The match intro (docs/story.md "The broadcast opens"): after the VS card an offline match opens like a broadcast.
// The camera flies in from the stage's far layers to the fight framing, the stage's name takes the lower third, and
// each fighter makes an entrance: the 13 Season 1 fighters their own (from their story), the other 20 a spotlight drop
// with their taunt. All pure maths (no Babylon), so `test/intro.test.ts` can run it; the renderer draws it
// (render/renderer.ts `introBegin`) and ui/matchIntro.ts times it and takes the input that skips it.
//
// Distances are in "heights": multiples of the fighter's drawn height, so a giant and a small fighter share a table.

/** The whole intro. The ROUND START call (beginReady) lands right after it. */
export const INTRO_MS = 3000;
/** The camera's fly-in: from the stage's far layers to the fight framing. */
export const FLY_MS = 1700;
/** Entrances start after the camera has begun to move, and end before the hold. */
export const FIRST_ENTRANCE_MS = 500;
const LAST_END_MS = 2750;

export type EntranceKind =
  | 'board' | 'zip' | 'slam' | 'pop' | 'rig' | 'storm' | 'flash' | 'swoop' | 'stomp' | 'slash' | 'roll' | 'assemble' | 'descend'
  | 'spotlight';

/** Season 1's entrances, by fighter id (each from the fighter's story in docs/story.md and docs/world-bible.md). */
export const SEASON_ONE_ENTRANCES: Record<string, EntranceKind> = {
  'exit-punk': 'board',
  kaelen: 'zip',
  break: 'slam',
  'dj-wont-read': 'pop',
  'shutup-bot': 'rig',
  'small-weather': 'storm',
  'blog-man': 'flash',
  'evil-blue-bird': 'swoop',
  'got-ur-back': 'stomp',
  slice: 'slash',
  'ss-boulder': 'roll',
  stratabots: 'assemble',
  orchestrator: 'descend',
};

/** How long each entrance takes (ms); anything not listed takes DEFAULT_MS. */
const DURATION: Partial<Record<EntranceKind, number>> = { storm: 1250, descend: 1300, flash: 1150, board: 1100, roll: 1100, assemble: 1000, stomp: 1100 };
const DEFAULT_MS = 950;

/** A beat inside an entrance (k 0..1): what the renderer fires once when the entrance passes it. */
export type BeatFx = 'dust' | 'thud' | 'ring' | 'spark' | 'streak' | 'flash' | 'snap' | 'clank' | 'taunt';
export interface Beat {
  at: number;
  fx: BeatFx;
  /** Camera kick (0.3 is a medium hit). */
  kick?: number;
  /** How many sparks (scaled by the graphics quality). */
  n?: number;
}

export interface IntroEntry {
  /** The fighter's sim id (slot). */
  slot: number;
  who: string;
  kind: EntranceKind;
  /** The side they come from: -1 left, 1 right. */
  from: 1 | -1;
  startMs: number;
  durMs: number;
  /** The slot colour (spotlight, sparks). */
  color: string;
}

export interface IntroPlan {
  totalMs: number;
  flyMs: number;
  stage: string;
  entries: IntroEntry[];
}

export type Anim = 'idle' | 'walk' | 'fall' | 'jump' | 'land';

export interface Prop {
  kind: 'board' | 'cable' | 'spot';
  dx: number;
  dy: number;
  rot: number;
  alpha: number;
  /** Cable and spotlight: how tall (heights). */
  len?: number;
}

/** What an entrance does to a fighter at one moment. */
export interface Pose {
  hidden: boolean;
  dx: number;
  dy: number;
  rot: number;
  sx: number;
  sy: number;
  alpha: number;
  anim: Anim;
  prop: Prop | null;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const sub = (k: number, a: number, b: number): number => clamp01((k - a) / (b - a));
const outC = (t: number): number => 1 - (1 - t) ** 3;
const inQ = (t: number): number => t * t;
const inOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const outBack = (t: number): number => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
/** How far a fall starts above the stage floor (heights). */
const DROP = 3.4;

export function entranceKind(who: string): EntranceKind {
  return SEASON_ONE_ENTRANCES[who] ?? 'spotlight';
}

export function entranceMs(kind: EntranceKind): number {
  return DURATION[kind] ?? DEFAULT_MS;
}

/** Beats of each entrance (the sounds, sparks and shakes that sell it). */
export function entranceBeats(kind: EntranceKind): Beat[] {
  switch (kind) {
    case 'board': return [{ at: 0.04, fx: 'streak', n: 6 }, { at: 0.35, fx: 'spark', n: 5 }, { at: 0.72, fx: 'dust', kick: 0.12, n: 8 }, { at: 0.97, fx: 'dust', kick: 0.18, n: 10 }];
    case 'zip': return [...[0.04, 0.1, 0.17, 0.24, 0.31, 0.38].map((at): Beat => ({ at, fx: 'streak', n: 4 })), { at: 0.46, fx: 'dust', n: 8 }];
    case 'slam': return [{ at: 0.5, fx: 'thud', kick: 0.7, n: 22 }, { at: 0.5, fx: 'ring' }, { at: 0.72, fx: 'dust', kick: 0.25, n: 10 }];
    case 'pop': return [{ at: 0.02, fx: 'ring' }, { at: 0.26, fx: 'ring', kick: 0.1 }, { at: 0.5, fx: 'ring', kick: 0.25, n: 14 }, { at: 0.5, fx: 'spark', n: 10 }];
    case 'rig': return [{ at: 0.02, fx: 'snap', n: 10 }, { at: 0.56, fx: 'thud', kick: 0.5, n: 14 }, { at: 0.58, fx: 'clank', n: 8 }];
    case 'storm': return [{ at: 0.0, fx: 'flash', kick: 0.25 }, { at: 0.42, fx: 'flash', kick: 0.12 }, { at: 0.86, fx: 'dust', n: 10 }, { at: 0.86, fx: 'ring' }];
    case 'flash': return [0.52, 0.66, 0.8, 0.93].map((at): Beat => ({ at, fx: 'flash', n: 5 }));
    case 'swoop': return [{ at: 0.05, fx: 'streak', n: 5 }, { at: 0.8, fx: 'dust', kick: 0.18, n: 10 }];
    case 'stomp': return [0.22, 0.43, 0.65, 0.86].map((at): Beat => ({ at, fx: 'thud', kick: 0.28, n: 9 }));
    case 'slash': return [{ at: 0.2, fx: 'streak', kick: 0.2, n: 14 }, { at: 0.32, fx: 'spark', kick: 0.2, n: 18 }];
    case 'roll': return [...[0.16, 0.32, 0.5, 0.66].map((at): Beat => ({ at, fx: 'dust', n: 6 })), { at: 0.82, fx: 'thud', kick: 0.55, n: 20 }];
    case 'assemble': return [0.2, 0.4, 0.6, 0.8].map((at): Beat => ({ at, fx: 'clank', kick: 0.12, n: 8 }));
    case 'descend': return [{ at: 0.04, fx: 'ring' }, { at: 0.92, fx: 'ring', kick: 0.12, n: 12 }, { at: 0.92, fx: 'spark', n: 10 }];
    default: return [{ at: 0.56, fx: 'thud', kick: 0.35, n: 14 }, { at: 0.56, fx: 'ring' }, { at: 0.62, fx: 'taunt' }];
  }
}

function base(): Pose {
  return { hidden: false, dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1, anim: 'idle', prop: null };
}

/** Turns about the body's middle, not its feet: moves the feet to where that turn puts them. */
function aboutCentre(p: Pose): void {
  p.dx += Math.sin(p.rot) * 0.5;
  p.dy += 0.5 * (1 - Math.cos(p.rot));
}

/**
 * The fighter's pose `k` of the way through their entrance (k < 0: not yet on; k >= 1: done, standing). `from` is the
 * side they come in from; `color` tints a spotlight.
 */
export function entrancePose(kind: EntranceKind, k: number, from: 1 | -1): Pose {
  const p = base();
  if (k < 0) return { ...p, hidden: true, alpha: 0 };
  const t = clamp01(k);
  switch (kind) {
    case 'board': {
      // Rolls in from the wings on the skateboard, pops off it into a landing and leaves it rolling on.
      const ride = sub(t, 0, 0.72);
      const j = sub(t, 0.72, 1);
      p.dx = from * (1 - outC(ride)) * 3.4;
      p.dy = Math.sin(j * Math.PI) * 0.5;
      p.rot = from * 0.06 * (1 - ride) - from * 0.1 * Math.sin(j * Math.PI);
      p.anim = j > 0 && j < 0.85 ? 'jump' : 'idle';
      p.prop = { kind: 'board', dx: p.dx + from * j * 0.9, dy: Math.sin(j * Math.PI) * 0.18, rot: -from * Math.sin(j * Math.PI) * 0.55, alpha: 1 - sub(t, 0.8, 1) };
      break;
    }
    case 'zip': {
      // Kaelen: "Hi. Bye." Gone before the trade lands: a blur across the stage, then a small wave.
      const z = sub(t, 0, 0.45);
      p.dx = from * (1 - z) ** 3 * 6.5;
      p.sx = 1 + 0.55 * (1 - z);
      p.sy = 1 - 0.1 * (1 - z);
      p.alpha = Math.min(1, t * 10);
      p.anim = z < 1 ? 'walk' : 'idle';
      p.dy = Math.sin(sub(t, 0.62, 0.9) * Math.PI) * 0.12;
      break;
    }
    case 'slam': {
      // Break's rule one is that he doesn't fall off. He comes down heavy and stays down.
      const f = sub(t, 0, 0.5);
      const l = sub(t, 0.5, 0.82);
      p.dy = (1 - inQ(f)) * DROP;
      p.anim = f < 1 ? 'fall' : l < 0.7 ? 'land' : 'idle';
      p.sx = 1 + 0.22 * Math.sin(l * Math.PI);
      p.sy = 1 - 0.26 * Math.sin(l * Math.PI);
      break;
    }
    case 'pop': {
      // DJ Won't Read: pops up out of the floor on the bass, a ring on every beat.
      const r = sub(t, 0, 0.5);
      p.sx = Math.max(0.04, outBack(r));
      p.sy = Math.max(0.04, outBack(r));
      p.sy += Math.sin(sub(t, 0.5, 1) * Math.PI * 4) * 0.035;
      p.alpha = Math.min(1, t * 12);
      break;
    }
    case 'rig': {
      // Shutup Bot drops from the lighting rig on a cable, snaps it, lands and does not flinch.
      const f = sub(t, 0, 0.55);
      p.dy = (1 - inQ(f)) * DROP;
      p.dx = Math.sin(t * 9) * 0.08 * (1 - f);
      p.anim = f < 1 ? 'fall' : 'idle';
      p.sy = 1 - 0.03 * Math.sin(sub(t, 0.55, 0.7) * Math.PI);
      p.prop = { kind: 'cable', dx: p.dx, dy: p.dy + 1, rot: 0, alpha: 1 - sub(t, 0.55, 0.68), len: DROP + 2 };
      break;
    }
    case 'storm': {
      // Small Weather brought the weather: a lightning flash, then a slow, swaying float down.
      const f = sub(t, 0.04, 0.86);
      p.alpha = Math.min(1, t * 14);
      p.dy = (1 - outC(f)) * DROP * 0.9;
      p.dx = Math.sin(f * Math.PI * 3) * 0.32 * (1 - f);
      p.rot = Math.sin(f * Math.PI * 3) * 0.12 * (1 - f);
      p.anim = f < 1 ? 'fall' : 'land';
      break;
    }
    case 'flash': {
      // Blog Man floats in to a bank of flashbulbs: the press is here.
      const f = sub(t, 0, 0.72);
      p.dy = (1 - outC(f)) * DROP * 0.85 + Math.sin(t * Math.PI * 5) * 0.05 * (1 - f);
      p.alpha = Math.min(1, t * 8);
      break;
    }
    case 'swoop': {
      // Evil Blue Bird: an air game that never lands, until it has to. Banks in from the side.
      const f = sub(t, 0, 0.8);
      p.dx = from * (1 - outC(f)) * 4.4;
      p.dy = (1 - f) ** 2 * 2.6 + Math.sin(f * Math.PI * 5) * 0.12 * (1 - f);
      p.rot = from * (1 - f) * 0.45;
      p.anim = f < 1 ? 'jump' : 'land';
      break;
    }
    case 'stomp': {
      // Got Ur Back: huge, soft, in no hurry. Four steps, each one felt.
      const f = sub(t, 0, 0.86);
      p.dx = from * (1 - f) * 3.2;
      p.dy = Math.abs(Math.sin(f * Math.PI * 4)) * 0.07 * (f < 1 ? 1 : 0);
      p.anim = f < 1 ? 'walk' : 'idle';
      break;
    }
    case 'slash': {
      // Slice cuts the air and is simply there, in a spin that settles.
      const s = sub(t, 0.3, 0.78);
      p.alpha = t < 0.3 ? 0 : 1;
      p.hidden = t < 0.3;
      p.rot = from * (1 - outC(s)) * Math.PI * 2;
      p.anim = s < 1 ? 'jump' : 'idle';
      aboutCentre(p);
      p.dy += (1 - s) * 0.5;
      break;
    }
    case 'roll': {
      // SS Boulder rolls in, slowest swings in the game and the biggest stop.
      const f = sub(t, 0, 0.8);
      const left = (1 - outC(f)) * 4.4;
      p.dx = from * left;
      p.rot = -from * (left / 0.7);
      aboutCentre(p);
      p.sy *= 1 - 0.18 * Math.sin(sub(t, 0.8, 0.95) * Math.PI);
      p.sx *= 1 + 0.14 * Math.sin(sub(t, 0.8, 0.95) * Math.PI);
      break;
    }
    case 'assemble': {
      // Stratabots: heavy plates, stacked from the floor up, one clank a plate.
      const s = sub(t, 0, 0.82) * 4;
      const i = Math.min(3, Math.floor(s));
      p.sy = Math.max(0.05, s >= 4 ? 1 : (i + outC(s - i)) / 4);
      p.dx = Math.sin(t * 70) * 0.012 * (1 - sub(t, 0.8, 1));
      break;
    }
    case 'descend': {
      // The Orchestrator does not drop. He is lowered, baton first, and the house goes quiet.
      const f = sub(t, 0, 0.92);
      p.dy = (1 - inOut(f)) * DROP * 0.8;
      p.alpha = clamp01(f * 3.5);
      p.rot = Math.sin(f * Math.PI * 2) * 0.035;
      break;
    }
    case 'spotlight': {
      // The newer fighters: a spotlight in their slot colour, a drop into it, and their taunt.
      const f = sub(t, 0, 0.55);
      const hop = sub(t, 0.58, 0.8);
      p.dy = (1 - inQ(f)) * DROP + Math.sin(hop * Math.PI) * 0.1;
      p.anim = f < 1 ? 'fall' : hop < 0.5 ? 'land' : 'idle';
      p.prop = { kind: 'spot', dx: 0, dy: 0, rot: 0, alpha: t < 0.55 ? 0.55 * Math.min(1, t * 5) : 0.55 - 0.3 * sub(t, 0.55, 1), len: DROP + 2.2 };
      break;
    }
  }
  return p;
}

/**
 * Plans the intro for a fight: who enters how, from which side, and when. `cast` is every fighter in sim order with
 * the x they start at (so the left one comes in from the left). The entrances are staggered so the last one ends
 * before the hold, whatever the number of fighters.
 */
export function planIntro(cast: { slot: number; who: string; x: number; color: string }[], stage: string): IntroPlan {
  const kinds = cast.map((c) => entranceKind(c.who));
  const longest = Math.max(...kinds.map(entranceMs), DEFAULT_MS);
  const gap = cast.length > 1 ? Math.min(500, Math.max(120, (LAST_END_MS - longest - FIRST_ENTRANCE_MS) / (cast.length - 1))) : 0;
  const entries = cast.map((c, i): IntroEntry => ({
    slot: c.slot,
    who: c.who,
    kind: kinds[i],
    from: c.x < 0 || (c.x === 0 && i % 2 === 0) ? -1 : 1,
    startMs: Math.round(FIRST_ENTRANCE_MS + i * gap),
    durMs: entranceMs(kinds[i]),
    color: c.color,
  }));
  return { totalMs: INTRO_MS, flyMs: FLY_MS, stage, entries };
}

/** The fly-in's progress at `ms` (0 to 1), eased in and out: the camera starts and stops gently, never snaps. */
export function flyProgress(ms: number, flyMs = FLY_MS): number {
  return inOut(clamp01(ms / flyMs));
}

/** The camera between the wide shot and the fight framing: `p` from flyProgress. */
export function flyCamera(wide: { x: number; y: number; d: number }, goal: { x: number; y: number; d: number }, p: number): { x: number; y: number; d: number } {
  return { x: wide.x + (goal.x - wide.x) * p, y: wide.y + (goal.y - wide.y) * p, d: wide.d + (goal.d - wide.d) * p };
}
