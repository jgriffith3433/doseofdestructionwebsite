// The swinging dummy of How to play, lesson 2: it walks up to the player and throws one forward smash every few seconds,
// slow enough to see coming and dodge. It reads the sim and returns a packed input like any pad, so the sim cannot tell it
// from a person; it never edits state. Training only (online never runs it).

import { FX } from '../sim/fixed.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { ACT, type GameState } from '../sim/state.ts';

/** Frames between swings once in range (2.5 s at 60 fps). */
export const SWING_EVERY = 150;
/** It walks in until this close (sim units), and walks again if the player gets further than the far gap. */
const NEAR = 120;
const FAR = 190;

export class SwingDummy {
  private waited = 0;
  private near = false;

  think(s: GameState, id: number): number {
    const me = s.fighters[id];
    const foe = s.fighters.find((f) => f.id !== id && f.stocks > 0 && f.action !== ACT.DEAD && f.action !== ACT.RESPAWN);
    if (!me || !foe) return NO_INPUT;
    if (me.action !== ACT.IDLE && me.action !== ACT.WALK) return NO_INPUT;
    const dx = (foe.x - me.x) / FX;
    const dir = dx >= 0 ? 1 : -1;
    // Another height (a platform, or in the air): hold still and wait, don't walk off the stage.
    if (Math.abs(foe.y - me.y) / FX > 120) {
      this.waited = 0;
      return NO_INPUT;
    }
    const gap = Math.abs(dx);
    if (gap > FAR || (!this.near && gap > NEAR)) {
      this.near = false;
      this.waited = 0;
      return packInput(dir * 100, 0, 0);
    }
    this.near = true;
    if (me.facing !== dir) return packInput(dir * 100, 0, 0);
    if (++this.waited < SWING_EVERY) return NO_INPUT;
    this.waited = 0;
    return packInput(0, 0, dir > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
  }
}
