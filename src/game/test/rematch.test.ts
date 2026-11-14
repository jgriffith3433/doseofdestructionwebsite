// Headless checks for the online rematch (net/rematch.ts, docs/online.md "Rematch"): two sessions over a pair of linked
// stand-in rooms. Run with `npm test`.

import { Rematch, rematchSetup, stagePicker, REMATCH_MS, type RematchRoom } from '../net/rematch.ts';
import type { OnlineSetup } from '../net/matchmaker.ts';
import { STAGES } from '../sim/stage.ts';
import { stagesFor } from '../modes.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

class FakeRoom implements RematchRoom {
  closed = false;
  other!: FakeRoom;
  private h: Record<string, ((v: any) => void)[]> = {};
  sent: string[] = [];
  send(kind: string, data: string): boolean {
    if (this.closed) return false;
    this.sent.push(kind);
    const o = this.other;
    queueMicrotask(() => o.emit('message', { kind, data }));
    return true;
  }
  on(t: string, fn: (v: any) => void): () => void {
    (this.h[t] ??= []).push(fn);
    return () => (this.h[t] = (this.h[t] ?? []).filter((x) => x !== fn));
  }
  emit(t: string, v: unknown): void {
    for (const f of this.h[t] ?? []) f(v);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.other.emit('closed', { reason: 'left' }));
  }
}

const prev: OnlineSetup = {
  matchId: 'a-b-old', seed: 1, stage: 0, stocks: 3, rules: {}, timeLimit: 100,
  ids: ['a', 'b'], names: ['A', 'B'], avatars: ['x', 'y'], chars: [0, 1], looks: [0, 0], pids: ['pa', 'pb'], at: 1,
};
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function pair(winner: number) {
  const ra = new FakeRoom();
  const rb = new FakeRoom();
  ra.other = rb;
  rb.other = ra;
  const mk = (room: FakeRoom, slot: number) => new Rematch({ room, slot, prev, winner, char: prev.chars[slot], look: 0, opponent: slot ? 'A' : 'B' });
  return { ra, rb, a: mk(ra, 0), b: mk(rb, 1) };
}

// Stage rule: the loser picks; a draw is random.
check(stagePicker(0) === 1 && stagePicker(1) === 0 && stagePicker(-1) === -1, 'the loser of the last game picks the stage');
{
  const legal = stagesFor('versus');
  const want = legal[legal.length - 1].index;
  const s = rematchSetup(prev, [{ char: 0, look: 0 }, { char: 1, look: 0, stage: want }], 0);
  check(s.stage === want, 'the loser\'s stage is used');
  const w = rematchSetup(prev, [{ char: 0, look: 0, stage: want }, { char: 1, look: 0 }], 0);
  check(legal.some((x) => x.index === w.stage), 'the winner\'s own stage request is ignored: a legal one is picked');
  check(s.matchId !== prev.matchId && s.matchId.startsWith('a-b-'), 'each game has its own match id (ratings stay per game)');
  const same = rematchSetup(prev, [{ char: 3, look: 0 }, { char: 3, look: 0 }], -1);
  check(same.looks![0] !== same.looks![1], 'the same fighter twice never shares a colour');
  check(!!STAGES[same.stage], 'a draw picks a stage that exists');
}

// Both press, both pick (one changes fighter), the new match is the same on both sides.
{
  const { a, b } = pair(0);
  let sa: OnlineSetup | null = null;
  let sb: OnlineSetup | null = null;
  a.on('start', (s) => (sa = s));
  b.on('start', (s) => (sb = s));
  a.press();
  await tick();
  check(a.phase === 'waiting' && b.theyWant, 'one presses Rematch: they wait, the other is told');
  b.press();
  await tick();
  check(a.phase === 'picking' && b.phase === 'picking', 'both pressed: both are picking');
  b.choose(5, 0);
  b.chooseStage(stagesFor('versus')[0].index);
  b.lock();
  a.lock();
  await tick();
  await tick();
  check(!!sa && !!sb && JSON.stringify(sa) === JSON.stringify(sb), 'both start the same new match');
  check(sa!.chars[0] === prev.chars[0] && sa!.chars[1] === 5, 'the fighter change is in the new match (default kept for the other)');
  check(sa!.stage === stagesFor('versus')[0].index, 'the loser\'s stage was played');
}

// One declines: the other is told at once and can queue again.
{
  const { ra, a, b } = pair(1);
  let ended: any = null;
  a.on('end', (e) => (ended = e));
  b.press();
  await tick();
  b.decline();
  await tick();
  check(ended?.reason === 'declined' && a.phase === 'declined' && ra.closed, 'a decline ends it for the other, who sees who left');
}

// The room closing (they left the page) and the clock.
{
  const { rb, a } = pair(0);
  let ended: any = null;
  a.on('end', (e) => (ended = e));
  rb.close();
  await tick();
  check(ended?.reason === 'closed', 'a closed room ends it');
}
{
  let t = 0;
  const ra = new FakeRoom();
  const rb = new FakeRoom();
  ra.other = rb;
  rb.other = ra;
  const a = new Rematch({ room: ra, slot: 0, prev, winner: 0, char: 0, look: 0, opponent: 'B', clock: () => t });
  let ended: any = null;
  a.on('end', (e) => (ended = e));
  a.press();
  t = REMATCH_MS + 300;
  await new Promise((r) => setTimeout(r, 400));
  check(ended?.reason === 'timeout' && ended.weWant && !ended.theyWant && ra.closed, 'no answer within 15 s: off, and the room is let go');
}

if (failed) {
  console.log(`${failed} rematch check(s) failed`);
  process.exit(1);
}
console.log('rematch ok');
