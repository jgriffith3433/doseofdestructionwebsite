// The select screen's special preview: the real deterministic sim (newGame + step) run live in a small inset, one
// fighter against a training dummy, looping every 3 s. No video: the fighters are drawn with the same clip picks and
// frames the match uses (render/anims.ts pickClip + clipFrame), a shot is a glowing ball at its sim position.
// The script (who presses what, when) is pure and has a node test (test/specialSim.test.ts).

import { CHARACTERS, MOVE } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, newGame, type Fighter, type GameState } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { FX } from '../sim/fixed.ts';

/** One loop is 3 s of sim time. */
export const LOOP_FRAMES = 180;
/** Where the two stand (sim units from the stage centre). */
const YOU_X = -70;
const DUMMY_X = 70;
/** The first press, in frames after the loop starts (a beat to see the fighter stand). */
const FIRST = 18;

export type Slot = 'neutral' | 'side' | 'up' | 'down';
export const SLOT_MOVE: Record<Slot, number> = { neutral: MOVE.NSPECIAL, side: MOVE.SSPECIAL, up: MOVE.UPB, down: MOVE.DSPECIAL };

/** The dummy is never the fighter being shown. */
export function dummyFor(char: number): number {
  const want = CHARACTERS.findIndex((c) => c.id === 'wallit');
  const alt = CHARACTERS.findIndex((c) => c.id === 'ball-person');
  return want >= 0 && want !== char ? want : alt !== char ? Math.max(0, alt) : 0;
}

/** Frames (from the loop's start) at which the special button goes down: once, and again if it ends early enough. */
export function pressFrames(char: number, slot: Slot): number[] {
  const m = CHARACTERS[char].moves[SLOT_MOVE[slot]];
  const total = Math.max(10, m?.total ?? 40);
  const again = FIRST + total + 26;
  return again + total < LOOP_FRAMES - 10 ? [FIRST, again] : [FIRST];
}

/** Your stick and button on one frame of the loop. */
export function inputAt(char: number, slot: Slot, frame: number): number {
  const presses = pressFrames(char, slot);
  if (!presses.some((p) => frame >= p && frame < p + 3)) return NO_INPUT;
  const sx = slot === 'side' ? 100 : 0;
  const sy = slot === 'up' ? 100 : slot === 'down' ? -100 : 0;
  return packInput(sx, sy, BTN.SPECIAL);
}

/** A fresh loop: the fighter and the dummy on the floor of stage 0, facing each other. */
export function startLoop(char: number, seed = 7): GameState {
  const s = newGame([{ char, stocks: 9 }, { char: dummyFor(char), stocks: 9 }], { stocks: 9, seed, stage: 0, rules: { hazards: 0 } });
  const [a, b] = s.fighters;
  a.x = YOU_X * FX;
  b.x = DUMMY_X * FX;
  a.facing = 1;
  b.facing = -1;
  return s;
}

/** Steps a loop to the end and says whether the special came out and whether it touched the dummy. */
export function runLoop(char: number, slot: Slot): { cameOut: boolean; hit: boolean; frames: number } {
  const s = startLoop(char);
  const move = SLOT_MOVE[slot];
  let cameOut = false;
  let hit = false;
  for (let f = 0; f < LOOP_FRAMES; f++) {
    step(s, [inputAt(char, slot, f), NO_INPUT]);
    const [a, b] = s.fighters;
    if (a.action === ACT.ATTACK && a.move === move) cameOut = true;
    if (b.percent > b.startPercent) hit = true;
  }
  return { cameOut, hit, frames: LOOP_FRAMES };
}

export interface SimView {
  /** CSS pixels per sim unit. */
  k: number;
  /** Canvas x of the stage centre and y of the floor. */
  cx: number;
  floor: number;
}

export const fighterPos = (f: Fighter, v: SimView): { x: number; y: number } => ({ x: v.cx + (f.x / FX) * v.k, y: v.floor - (f.y / FX) * v.k });
export const shotPos = (x: number, y: number, v: SimView): { x: number; y: number } => ({ x: v.cx + (x / FX) * v.k, y: v.floor - (y / FX) * v.k });
