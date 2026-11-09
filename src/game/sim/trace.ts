// Animation-over-time checks (studio quality rule 5): a per-frame trace of each
// fighter's action, grounded flag and speed, failing when the state a fighter
// shows stops matching what their body is doing. Used by `npm test` on bot
// matches and by the playtest hook during every match it watches.
//
// - an air state (jumping, falling, air dodge, helpless) held while standing on a
//   platform for more than 0.3 s: the landing never fired;
// - a ground state (idle, walk, crouch, land, shield, roll...) held in the air for
//   more than 0.3 s: the fall never fired;
// - walking in place (walk with almost no speed) or standing still while sliding
//   (idle with walking speed) for more than 0.3 s: state not matching motion;
// - a timed state (land, roll, dodges, jump squat, climb, dizzy, attack, air dodge)
//   that lasts over 5 s: a state with no exit.

import { CHARACTERS } from './characters.ts';
import { ACT, ACT_NAMES, type GameState } from './state.ts';

/** 0.3 s of sim frames. */
export const TRACE_GRACE = 18;
const STUCK = 5 * 60;

const AIR_ONLY = new Set<number>([ACT.AIR, ACT.HELPLESS, ACT.AIRDODGE]);
const GROUND_ONLY = new Set<number>([
  ACT.IDLE, ACT.WALK, ACT.CROUCH, ACT.JUMPSQUAT, ACT.LAND, ACT.SHIELD, ACT.SHIELD_STUN, ACT.ROLL, ACT.SPOTDODGE,
]);
const TIMED = new Set<number>([
  ACT.LAND, ACT.ROLL, ACT.SPOTDODGE, ACT.JUMPSQUAT, ACT.LEDGE_CLIMB, ACT.DIZZY, ACT.ATTACK, ACT.AIRDODGE, ACT.SHIELD_STUN,
]);

export interface TraceProblem {
  kind: 'air-while-grounded' | 'ground-while-airborne' | 'walk-in-place' | 'idle-sliding' | 'no-exit';
  fighter: number;
  frame: number;
  text: string;
}

interface Run {
  air: number;
  ground: number;
  walkSlow: number;
  idleFast: number;
  action: number;
  since: number;
}

/** Feeds on the state after each step; reports each kind of problem once per fighter. */
export class AnimTrace {
  private runs: Run[] = [];
  private said = new Set<string>();
  readonly problems: TraceProblem[] = [];

  /** Call after every sim step. Returns the problems found on this frame (usually none). */
  check(s: GameState): TraceProblem[] {
    const out: TraceProblem[] = [];
    for (const f of s.fighters) {
      const r = (this.runs[f.id] ??= { air: 0, ground: 0, walkSlow: 0, idleFast: 0, action: -1, since: s.frame });
      if (f.action !== r.action) {
        r.action = f.action;
        r.since = s.frame;
      }
      // Frozen frames (hit-stop) don't count as time in a state.
      if (f.hitlag > 0 || f.action === ACT.DEAD || f.action === ACT.RESPAWN) {
        r.since++;
        continue;
      }
      const ch = CHARACTERS[f.char];
      const speed = Math.abs(f.vx);
      r.air = AIR_ONLY.has(f.action) && f.grounded ? r.air + 1 : 0;
      r.ground = GROUND_ONLY.has(f.action) && !f.grounded ? r.ground + 1 : 0;
      r.walkSlow = f.action === ACT.WALK && speed * 10 < ch.walkSpeed ? r.walkSlow + 1 : 0;
      r.idleFast = f.action === ACT.IDLE && f.grounded && speed * 2 > ch.walkSpeed ? r.idleFast + 1 : 0;
      const what = `${ch.name} (P${f.id + 1}) ${ACT_NAMES[f.action]}`;
      if (r.air > TRACE_GRACE) this.flag(out, 'air-while-grounded', f.id, s.frame, `${what} while standing on a platform for over 0.3 s`);
      if (r.ground > TRACE_GRACE) this.flag(out, 'ground-while-airborne', f.id, s.frame, `${what} while in the air for over 0.3 s`);
      if (r.walkSlow > TRACE_GRACE) this.flag(out, 'walk-in-place', f.id, s.frame, `${what} with no speed for over 0.3 s (walking in place)`);
      if (r.idleFast > TRACE_GRACE) this.flag(out, 'idle-sliding', f.id, s.frame, `${what} while sliding at walking speed for over 0.3 s`);
      if (TIMED.has(f.action) && s.frame - r.since > STUCK) this.flag(out, 'no-exit', f.id, s.frame, `${what} for over 5 s (no exit)`);
    }
    return out;
  }

  private flag(out: TraceProblem[], kind: TraceProblem['kind'], fighter: number, frame: number, text: string): void {
    const key = `${kind}:${fighter}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    const p = { kind, fighter, frame, text };
    out.push(p);
    this.problems.push(p);
  }
}
