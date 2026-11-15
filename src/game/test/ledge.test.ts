// The ledge options in the deterministic sim (sim/step.ts "The ledge is a choice"): the getup (stick up or toward the stage),
// the roll (Shield, a body-length further in), the ledge attack (Attack, the fighter's down tilt from the top, short
// invincibility), the ledge jump (Jump, a higher hop), the drop (stick down, or the hang running out), each with its own
// invincibility window; Special does nothing; every fighter's ledge attack has a hitbox; and a replay from a cloned state lands
// on the same hash.

import { CHARACTERS, MOVE } from '../sim/characters.ts';
import { STAGES, ledges } from '../sim/stage.ts';
import { ACT, ACT_NAMES, bodySize, cloneState, hashState, newGame, type GameState } from '../sim/state.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import {
  LEDGE_ATTACK_FRAMES, LEDGE_ATTACK_INVULN, LEDGE_CHOOSE, LEDGE_GETUP_FRAMES, LEDGE_HANG_MAX, LEDGE_JUMP_FRAMES, LEDGE_JUMP_INVULN,
  LEDGE_ROLL_FRAMES, LEDGE_ROLL_INVULN, ledgeRollEndX, step, type SimEvent,
} from '../sim/step.ts';
import { FX } from '../sim/fixed.ts';

declare const process: { exit(code: number): never };

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const ep = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
const kaelen = CHARACTERS.findIndex((c) => c.id === 'kaelen');
const stageIx = STAGES.findIndex((s) => s.id === 'city-top');
const stage = STAGES[stageIx];
const all = ledges(stage);

/** Two fighters; fighter 0 falls onto a ledge of the main platform (side -1 left, 1 right) and holds it. Returns the game and the ledge. */
function hang(char = ep, side = 1) {
  const g = newGame([{ char }, { char: kaelen }], { stocks: 3, seed: 5, stage: stageIx });
  const li = all.findIndex((l) => l.side === side && stage.platforms[l.platform].solid);
  const l = all[li];
  const [me, foe] = g.fighters;
  const [w, h] = bodySize(me);
  me.x = l.x * FX + l.side * ((w >> 1) + 6 * FX);
  me.y = l.y * FX - h + 26 * FX;
  me.grounded = 0;
  me.platform = -1;
  me.vy = -FX;
  me.facing = -l.side;
  me.action = ACT.AIR;
  // The other fighter stands well inside, out of the way.
  foe.x = (stage.platforms[l.platform].x1 + stage.platforms[l.platform].x2) * (FX >> 1);
  foe.y = l.y * FX;
  foe.grounded = 1;
  foe.platform = l.platform;
  for (let i = 0; i < 12 && me.action !== ACT.LEDGE; i++) step(g, [NO_INPUT, NO_INPUT]);
  return { g, l, me, foe, w, h };
}

/** Steps `n` frames with fighter 0 holding `inp` (a press needs NO_INPUT first, so the edge is seen); returns the events. */
function frames(g: GameState, n: number, inp = NO_INPUT, foeInp = NO_INPUT): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...step(g, [inp, foeInp]));
  return out;
}
/** Waits out the choice window, then presses. */
function choose(g: GameState, inp: number): SimEvent[] {
  frames(g, LEDGE_CHOOSE + 2);
  return [...frames(g, 1, inp), ...frames(g, 1)];
}
const option = (ev: SimEvent[], o: string) => ev.some((e) => e.type === 'ledge-option' && e.option === o);
const STICK_UP = packInput(0, 100, 0);

// ---- grabbing the ledge no longer climbs by itself, and no button climbs it by default
{
  const { g, me } = hang();
  check('grabbing the ledge hangs the fighter', me.action === ACT.LEDGE, ACT_NAMES[me.action]);
  frames(g, 60);
  check('with no input the fighter keeps hanging (no automatic climb)', me.action === ACT.LEDGE && me.ledge > 0, ACT_NAMES[me.action]);
  const { g: g2, me: me2 } = hang();
  choose(g2, packInput(0, 0, BTN.SPECIAL));
  check('Special on the ledge does nothing', me2.action === ACT.LEDGE);
}

// ---- getup: stick up or toward the stage
for (const [label, inp] of [['stick up', STICK_UP], ['stick toward the stage', packInput(100, 0, 0)]] as const) {
  const { g, l, me, w } = hang(ep, -1);
  frames(g, LEDGE_CHOOSE + 2);
  const ev = frames(g, 1, label === 'stick up' ? inp : packInput(100 * -l.side, 0, 0));
  check(`getup (${label}): climbs and says so`, me.action === ACT.LEDGE_CLIMB && option(ev, 'getup'), ACT_NAMES[me.action]);
  let invulnAll = true;
  for (let i = 0; i < LEDGE_GETUP_FRAMES - 1; i++) {
    frames(g, 1);
    if (me.action === ACT.LEDGE_CLIMB && me.intangible === 0) invulnAll = false;
  }
  frames(g, 3);
  check(`getup (${label}): invincible the whole climb`, invulnAll);
  const inside = (me.x - l.x * FX) * -l.side;
  check(`getup (${label}): stands on the stage just inside the edge`, me.grounded === 1 && me.platform === l.platform && inside > 0 && inside < w, `${Math.round(inside / FX)} units in, ${ACT_NAMES[me.action]}`);
}

// ---- roll: Shield
{
  const { g, l, me, w } = hang(ep, 1);
  const ev = choose(g, packInput(0, 0, BTN.SHIELD));
  check('roll: Shield rolls and says so', me.action === ACT.LEDGE_ROLL && option(ev, 'roll'), ACT_NAMES[me.action]);
  let invuln = 0;
  let after = -1;
  for (let i = 0; i < LEDGE_ROLL_FRAMES + 4 && after < 0; i++) {
    frames(g, 1);
    if (me.action === ACT.LEDGE_ROLL && me.intangible > 0) invuln++;
    if (me.action !== ACT.LEDGE_ROLL) after = i;
  }
  check('roll: ends on the ground, idle', me.grounded === 1 && me.platform === l.platform && me.action === ACT.IDLE, ACT_NAMES[me.action]);
  const inside = (me.x - l.x * FX) * -l.side;
  check('roll: lands a body-length further in than the getup (and stays on the platform)', inside >= w && inside <= (stage.platforms[l.platform].x2 - stage.platforms[l.platform].x1) * (FX >> 1), `${Math.round(inside / FX)} units in, body ${Math.round(w / FX)}`);
  check('roll: ends exactly where the sim says', me.x === ledgeRollEndX(me, l));
  check('roll: invincible for most of it, not all', invuln >= LEDGE_ROLL_INVULN - 4 && invuln < LEDGE_ROLL_FRAMES - 1, `${invuln} frames`);
  check('roll: the roll takes the fighter inward on a left ledge too', (() => {
    const h2 = hang(ep, -1);
    choose(h2.g, packInput(0, 0, BTN.SHIELD));
    frames(h2.g, LEDGE_ROLL_FRAMES);
    return h2.me.x > h2.l.x * FX + h2.w && h2.me.grounded === 1;
  })());
}

// ---- ledge attack: Attack
{
  const { g, l, me, foe, w } = hang(ep, 1);
  // The foe stands at the edge (a body-length in, where the attacker lands).
  foe.x = l.x * FX - l.side * w;
  foe.y = l.y * FX;
  const ev = choose(g, packInput(0, 0, BTN.ATTACK));
  check('ledge attack: Attack climbs and says so', me.action === ACT.LEDGE_ATTACK && option(ev, 'attack'), ACT_NAMES[me.action]);
  check('ledge attack: invincible as it starts', me.intangible > 0 && me.intangible <= LEDGE_ATTACK_INVULN);
  let swept = false;
  let hit: SimEvent | undefined;
  let safe = true;
  for (let i = 0; i < LEDGE_ATTACK_FRAMES + 40; i++) {
    const e = frames(g, 1);
    if (me.action === ACT.ATTACK && me.move === MOVE.DTILT) swept = true;
    if (me.action === ACT.LEDGE_ATTACK && me.intangible === 0) safe = false;
    hit ??= e.find((x) => x.type === 'hit' && x.attacker === 0);
  }
  check('ledge attack: the climb turns into the fighter\'s own down tilt, from the top of the stage', swept && me.grounded === 1);
  check('ledge attack: invincible the whole climb', safe);
  check('ledge attack: the sweep hits a fighter standing at the edge', !!hit && foe.percent > 0, `foe at ${foe.percent / 10}%`);
}
const noSweep: string[] = [];
for (const [i, ch] of CHARACTERS.entries()) {
  const { g, me } = hang(i, 1);
  choose(g, packInput(0, 0, BTN.ATTACK));
  let sweep = false;
  for (let k = 0; k < LEDGE_ATTACK_FRAMES + 4; k++) {
    frames(g, 1);
    if (me.action === ACT.ATTACK && me.move === MOVE.DTILT) sweep = true;
  }
  if (!(sweep && ch.moves[MOVE.DTILT].hits.length > 0)) noSweep.push(ch.name);
}
check(`ledge attack: every one of the ${CHARACTERS.length} fighters sweeps with a hitbox`, noSweep.length === 0, noSweep.join(', '));

// ---- ledge jump: Jump
{
  const { g, l, me } = hang(ep, 1);
  const startY = me.y;
  const ev = choose(g, packInput(0, 0, BTN.JUMP));
  check('ledge jump: Jump leaps and says so', (me.action === ACT.LEDGE_JUMP || me.action === ACT.AIR) && option(ev, 'jump') && ev.some((e) => e.type === 'jump'), ACT_NAMES[me.action]);
  check('ledge jump: invincible for a short time', me.intangible > 0 && me.intangible <= LEDGE_JUMP_INVULN, `${me.intangible}`);
  let top = me.y;
  let invuln = 0;
  for (let i = 0; i < 70; i++) {
    frames(g, 1);
    top = Math.max(top, me.y);
    if (me.intangible > 0 && i < LEDGE_JUMP_FRAMES) invuln++;
  }
  check('ledge jump: rises well above the ledge', top - startY > 60 * FX && top > l.y * FX, `${Math.round((top - startY) / FX)} units`);
  check('ledge jump: keeps the air jump', me.jumpsLeft > 0 || me.grounded === 1);
  const t = hang(ep, 1);
  choose(t.g, packInput(0, 0, BTN.JUMP));
  let state = '';
  for (let i = 0; i < LEDGE_JUMP_FRAMES + 2; i++) {
    frames(t.g, 1);
    if (i === LEDGE_JUMP_FRAMES + 1) state = ACT_NAMES[t.me.action];
  }
  check('ledge jump: after its frames the fighter is in the ordinary air state (or has landed)', state === 'AIR' || state === 'LAND' || state === 'ATTACK', state);
  const d = hang(ep, 1);
  choose(d.g, packInput(0, 0, BTN.JUMP));
  frames(d.g, 8);
  const before = d.me.jumpsLeft;
  frames(d.g, 1, packInput(0, 0, BTN.JUMP));
  frames(d.g, 1);
  check('ledge jump: an air jump opens up a few frames in', d.me.jumpsLeft < before || before === 0, `${before} -> ${d.me.jumpsLeft}`);
  check('ledge jump: invincible at least a few frames', invuln >= 6, `${invuln}`);
}

// ---- hang limit and drop
{
  const { g, me } = hang(ep, 1);
  let dropAt = -1;
  let dropped = false;
  for (let i = 0; i < LEDGE_HANG_MAX + 30; i++) {
    const ev = frames(g, 1);
    if (me.action !== ACT.LEDGE && dropAt < 0) dropAt = i;
    if (option(ev, 'drop')) dropped = true;
  }
  check('hang limit: holding the ledge too long drops the fighter', dropAt > 0 && dropped && me.ledge === 0, `let go after ${dropAt + 12} frames in the hang, ${ACT_NAMES[me.action]}`);
  check('hang limit: not before the limit', dropAt >= LEDGE_HANG_MAX - 12, `${dropAt}`);
  check('hang limit: falls afterwards (and cannot grab the same ledge at once)', me.action !== ACT.LEDGE && me.ledgeCooldown >= 0);
}
{
  const { g, me } = hang(ep, 1);
  frames(g, LEDGE_CHOOSE + 2);
  const ev = frames(g, 2, packInput(0, -100, 0));
  check('drop: the stick down lets go', me.action !== ACT.LEDGE && option(ev, 'drop'), ACT_NAMES[me.action]);
}

// ---- determinism: a clone replays to the same hash
{
  const run = (inp: number) => {
    const { g } = hang(ep, 1);
    frames(g, LEDGE_CHOOSE + 2);
    const snap = cloneState(g);
    frames(g, 1, inp);
    frames(g, 70);
    const a = hashState(g);
    frames(snap, 1, inp);
    frames(snap, 70);
    return a === hashState(snap);
  };
  check('rollback: a cloned ledge state replays each option to the same hash', [STICK_UP, packInput(0, 0, BTN.SHIELD), packInput(0, 0, BTN.ATTACK), packInput(0, 0, BTN.JUMP)].every(run));
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('ledge ok');
