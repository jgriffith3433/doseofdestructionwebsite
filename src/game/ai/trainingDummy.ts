// The Training dummy's behaviours (pause menu → Training): stand, crouch, jump, shield, walk, or a CPU at a level.
// Like every pad it reads the sim and returns a packed input; it never edits state. Training only (online never runs it).

import { FX } from '../sim/fixed.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, type GameState } from '../sim/state.ts';
import { STAGES } from '../sim/stage.ts';

export type DummyMode = 'stand' | 'crouch' | 'jump' | 'shield' | 'walk' | 'cpu';

export interface DummyOptions {
  mode: DummyMode;
  /** CPU level 1-9 when the mode is 'cpu'. */
  level: number;
}

export const DUMMY_MODES: readonly { id: DummyMode; label: string }[] = [
  { id: 'stand', label: 'Stand' },
  { id: 'crouch', label: 'Crouch' },
  { id: 'jump', label: 'Jump' },
  { id: 'shield', label: 'Shield' },
  { id: 'walk', label: 'Walk' },
  { id: 'cpu', label: 'CPU' },
];

/** Quick dummy percents (whole percent) the pause menu offers; Reset is 0. */
export const DUMMY_PERCENTS: readonly number[] = [0, 50, 100, 150];

export const DEFAULT_DUMMY: DummyOptions = { mode: 'stand', level: 5 };

/** Frames between hops for the jumping dummy, and how long a walk goes one way. */
const JUMP_EVERY = 45;
const WALK_LEG = 100;
/** The walking dummy turns round this far (sim units) from a platform's edge. */
const EDGE_MARGIN = 50;

export class TrainingDummy {
  private since = 0;
  private dir = 1;
  private legFrames = 0;

  think(s: GameState, id: number, mode: Exclude<DummyMode, 'cpu'>): number {
    const me = s.fighters[id];
    if (!me || me.stocks <= 0) return NO_INPUT;
    switch (mode) {
      case 'crouch':
        return packInput(0, -100, 0);
      case 'shield':
        return packInput(0, 0, BTN.SHIELD);
      case 'jump': {
        // Hop whenever it is back on the ground for a moment: one pressed frame is an ordinary tap.
        if (me.grounded > 0 && (me.action === ACT.IDLE || me.action === ACT.WALK || me.action === ACT.LAND)) {
          if (++this.since >= JUMP_EVERY) {
            this.since = 0;
            return packInput(0, 0, BTN.JUMP);
          }
        }
        return NO_INPUT;
      }
      case 'walk': {
        if (me.action !== ACT.IDLE && me.action !== ACT.WALK) return NO_INPUT;
        const plat = me.platform >= 0 ? STAGES[s.stage].platforms[me.platform] : null;
        if (plat) {
          const x = me.x / FX;
          if (this.dir > 0 && x > plat.x2 - EDGE_MARGIN) this.turn(-1);
          else if (this.dir < 0 && x < plat.x1 + EDGE_MARGIN) this.turn(1);
        }
        if (++this.legFrames >= WALK_LEG) this.turn(-this.dir);
        return packInput(this.dir * 60, 0, 0);
      }
      default:
        return NO_INPUT;
    }
  }

  private turn(dir: number): void {
    this.dir = dir;
    this.legFrames = 0;
  }
}
