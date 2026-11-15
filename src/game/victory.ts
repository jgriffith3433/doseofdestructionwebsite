// The victory stage on the results screen (ui/views.ts `showResults`): the winner on a lit podium, their group's 5 s fanfare,
// the loser in a dim inset. Pure data and maths here, so the test can check them: the 8 fanfare groups (assigned per fighter in
// content/fighters.json `fanfare`), the clips each role plays, the frame stepping and the confetti. Presentation only, never in the sim.

import { FIGHTERS } from './sim/characters.ts';

export interface FanfareGroup {
  id: string;
  /** The show's name for the group (docs/story.md "Victory fanfares"). */
  name: string;
  /** The sound id in content/sounds.json (a 5 s file). */
  sound: string;
}

export const FANFARE_SECONDS = 5;
/** The panel slides in this long after the podium opens (any input skips it). */
export const PANEL_AT_MS = 2200;
/** The slow camera push-in runs this long, from 1 to PUSH_SCALE. */
export const PUSH_MS = 5000;
export const PUSH_SCALE = 1.12;

export const FANFARES: FanfareGroup[] = [
  { id: 'open-mic', name: 'Open Mic', sound: 'fanfare-open-mic' },
  { id: 'the-booth', name: 'The Booth', sound: 'fanfare-the-booth' },
  { id: 'the-host', name: 'The Host', sound: 'fanfare-the-host' },
  { id: 'champions-card', name: "The Champion's Card", sound: 'fanfare-champions-card' },
  { id: 'rival-broadcast', name: 'The Rival Broadcast', sound: 'fanfare-rival-broadcast' },
  { id: 'sweeps-week', name: 'Sweeps Week', sound: 'fanfare-sweeps-week' },
  { id: 'syndication', name: 'Syndication', sound: 'fanfare-syndication' },
  { id: 'the-reboot', name: 'The Reboot', sound: 'fanfare-the-reboot' },
];

export const fanfareGroup = (id: string): FanfareGroup | undefined => FANFARES.find((g) => g.id === id);

/** The fanfare group a fighter (by id) wins with. */
export function fanfareFor(fighterId: string): FanfareGroup {
  const f = FIGHTERS.find((x) => x.id === fighterId);
  return fanfareGroup(f?.fanfare ?? '') ?? FANFARES[0];
}

/** Clips to try, best first: a `win` or `taunt` clip if the fighter has one, else the jump (the hop) and idle. */
export const WINNER_CLIPS = ['win', 'victory', 'taunt', 'jump', 'idle'];
/** The loser's inset: the idle clip (slumped by the stage's own styling), else the hurt clip. */
export const LOSER_CLIPS = ['idle', 'hurt'];

export interface ClipInfo { frames: number; fps: number }

/** The first of `wanted` the fighter has. */
export function pickPoseClip<T>(clips: Record<string, T>, wanted: string[]): { key: string; clip: T } | null {
  for (const key of wanted) if (clips[key]) return { key, clip: clips[key] };
  return null;
}

/** The frame a looping clip shows `ms` after it started. */
export const clipIndex = (c: ClipInfo, ms: number): number => Math.floor((Math.max(0, ms) / 1000) * c.fps) % Math.max(1, c.frames);

/** The winner's victory bounce, in pixels of lift (0 to `h`): a bounce, three hops, then a calmer sway. Zero at t = 0. */
export function victoryHop(ms: number, h: number): number {
  const t = Math.max(0, ms) / 1000;
  if (t < 1.8) return Math.abs(Math.sin(t * Math.PI * 1.7)) * h * (1 - t / 3);
  return 0;
}

/** The camera push-in scale at `ms`: eased from 1 to PUSH_SCALE over PUSH_MS, then held. */
export function pushScale(ms: number): number {
  const k = Math.min(1, Math.max(0, ms) / PUSH_MS);
  const e = 1 - (1 - k) * (1 - k);
  return 1 + (PUSH_SCALE - 1) * e;
}

export interface Confetto { x: number; y: number; vx: number; vy: number; rot: number; vr: number; size: number; color: string; spark: boolean }

/** Deterministic xorshift, so the test and the replay agree. */
export function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** `n` pieces of confetti and sparks above a stage `w` wide, in the winner's colour (plus white and gold). */
export function makeConfetti(n: number, w: number, color: string, rand: () => number): Confetto[] {
  const palette = [color, color, '#ffffff', '#ffc43d'];
  return Array.from({ length: n }, () => {
    const spark = rand() < 0.3;
    return {
      x: rand() * w,
      y: -10 - rand() * 120,
      vx: (rand() - 0.5) * 60,
      vy: (spark ? 50 : 90) + rand() * 110,
      rot: rand() * Math.PI * 2,
      vr: (rand() - 0.5) * 9,
      size: spark ? 2 + rand() * 2 : 5 + rand() * 5,
      color: palette[Math.floor(rand() * palette.length)],
      spark,
    };
  });
}

/** One step of `dt` seconds. Returns whether the piece is still on stage (height `h`). */
export function stepConfetto(c: Confetto, dt: number, h: number): boolean {
  c.vy += 40 * dt;
  c.x += c.vx * dt + Math.sin(c.y * 0.05) * 14 * dt;
  c.y += c.vy * dt;
  c.rot += c.vr * dt;
  return c.y < h + 20;
}
