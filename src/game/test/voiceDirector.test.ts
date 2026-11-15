declare const process: { exit(code: number): never };
// The voice director (src/game/voiceDirector.ts): one speaker at a time, priority, the 0.6 s wait, the 60 ms cut, repeats.
// Run: node --experimental-strip-types src/game/test/voiceDirector.test.ts

import { FADE_MS, PRIORITY, REPEAT_MS, VoiceDirector, WAIT_MS, type Outcome, type VoiceKind } from '../voiceDirector.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok - ${name}`);
  else {
    failed++;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

let now = 0;
const d = new VoiceDirector(() => now);
const types = (o: Outcome[]): string => o.map((x) => `${x.type}:${x.take.id}`).join(',');
const ask = (kind: VoiceKind, id: string, ms: number, extra: { speaker?: string; once?: boolean; pool?: number } = {}): Outcome[] =>
  d.request({ kind, speaker: extra.speaker ?? kind, id, ms, once: extra.once, pool: extra.pool });
const reset = (): void => {
  d.reset();
  now = 0;
};

// Priority order, as J wrote it.
const order: VoiceKind[] = ['scene', 'announcer', 'win-quote', 'banter', 'commentary', 'ko', 'taunt', 'hurt', 'effort'];
check('priority is scene > announcer > win quote > banter > commentary > KO > taunt > hurt > effort', order.every((k, i) => i === 0 || PRIORITY[order[i - 1]] > PRIORITY[k]));

// Free air: starts at once.
reset();
check('a take on free air starts', types(ask('commentary', 'c1', 2000)) === 'start:c1');

// A lower line waits for the speaker ahead and starts when it ends (inside 0.6 s).
check('a lower line waits', types(ask('ko', 'k1', 300, { speaker: 'a' })) === '');
now = 400;
check('nothing wakes before the wait ends', d.nextWake() === 600);
now = 2000;
let o = d.pump();
check('the waiter is dropped when the speaker ahead outlasts 0.6 s', types(o) === 'drop:k1,end:c1', types(o));

reset();
ask('commentary', 'c1', 500);
ask('ko', 'k1', 300, { speaker: 'a' });
now = 500;
o = d.pump();
check('the waiter starts when the speaker ahead ends inside the wait', types(o) === 'end:c1,start:k1', types(o));
check('it waited no more than 0.6 s', d.stats().maxWaitMs <= WAIT_MS);

// Efforts and hurts are dropped, never played late.
reset();
ask('commentary', 'c1', 3000);
check('an effort on a taken air is dropped at once', types(ask('effort', 'e1', 300, { speaker: 'a' })) === 'drop:e1');
check('a hurt on a taken air is dropped at once', types(ask('hurt', 'h1', 300, { speaker: 'a' })) === 'drop:h1');
check('nothing waits for them', d.nextWake() === 3000);

// A higher line cuts a bark with a 60 ms fade.
reset();
ask('effort', 'e1', 800, { speaker: 'a' });
now = 100;
o = ask('announcer', 'go', 700);
check('the announcer cuts an effort', types(o) === 'cut:e1,start:go', types(o));
const played = d.played[0];
check('the cut take ends where it was cut', played.cut && played.end === 100);
check('the overlap is the fade only', d.stats().maxOverlapMs <= FADE_MS && d.stats().overBudgetMs === 0, JSON.stringify(d.stats()));

reset();
ask('hurt', 'h1', 500, { speaker: 'a' });
now = 50;
check('a KO cry cuts a hurt', types(ask('ko', 'k1', 900, { speaker: 'b' })) === 'cut:h1,start:k1');

// Same priority: a barker does not cut a barker; a scene take replaces a scene take; an announcer call replaces a call.
reset();
ask('taunt', 't1', 900, { speaker: 'a' });
check('a taunt does not cut a taunt, it waits', types(ask('taunt', 't2', 500, { speaker: 'b' })) === '');
now = 700;
check('and is dropped when the wait runs out', types(d.pump()) === 'drop:t2', types(d.pump()));

reset();
ask('scene', 's1', 4000);
check('a scene take replaces the scene take before it', types(ask('scene', 's2', 3000)) === 'cut:s1,start:s2');
check('a lower line never cuts a scene take', types(ask('announcer', 'a1', 800)) === '');
now = WAIT_MS;
o = d.pump();
check('the announcer waited 0.6 s then was dropped under the scene', types(o) === 'drop:a1', types(o));

// A higher line waits 0.6 s for a lower spoken line and then cuts it.
reset();
ask('commentary', 'c1', 3000);
check('the announcer waits behind a commentary line', types(ask('announcer', 'a1', 800)) === '');
now = WAIT_MS;
o = d.pump();
check('then cuts it', types(o) === 'cut:c1,start:a1', types(o));

// Highest waiting line goes first when the air frees.
reset();
ask('win-quote', 'w1', 1000);
ask('commentary', 'c1', 400);
ask('banter', 'b1', 400);
now = 500;
check('the waiters are only dropped past the wait, the better first', d.nextWake() === 600);
now = 1000;
o = d.pump();
check('the air frees: waiters past their wait are dropped, none overlaps', !types(o).includes('start:c1') || !types(o).includes('start:b1'), types(o));

// Same fighter never overlaps itself, different fighters never overlap.
reset();
ask('effort', 'e1', 600, { speaker: 'a' });
check('a second fighter\'s effort is dropped while the first speaks', types(ask('effort', 'e2', 600, { speaker: 'b' })) === 'drop:e2');
check('stats: no overlaps', d.stats().overlaps === 0);

// Repeats: commentary / pooled announcer never inside 5 minutes.
reset();
ask('commentary', 'announcer.ko.1', 500, { once: true });
now = 600;
d.pump();
check('commentary line is fresh? no', !d.fresh('announcer.ko.1'));
check('the same commentary line inside 5 minutes is dropped', types(ask('commentary', 'announcer.ko.1', 500, { once: true })) === 'drop:announcer.ko.1');
now = REPEAT_MS - 1;
check('still dropped at 5 minutes less 1 ms', types(ask('commentary', 'announcer.ko.1', 500, { once: true })) === 'drop:announcer.ko.1');
now = REPEAT_MS + 1;
check('allowed after 5 minutes', types(ask('commentary', 'announcer.ko.1', 500, { once: true })) === 'start:announcer.ko.1');
check('stats: no repeats were played', d.stats().repeats === 0);
reset();
ask('announcer', 'announcer.go', 300);
now = 400;
check('a cue call (no once) can repeat every match', types(ask('announcer', 'announcer.go', 300)).includes('start:announcer.go'));

// Bark takes never twice in a row from one fighter and kind.
reset();
ask('effort', 'fighter.a.effort.0', 200, { speaker: 'a', pool: 3 });
now = 300;
check('the same effort take twice in a row is dropped', types(ask('effort', 'fighter.a.effort.0', 200, { speaker: 'a', pool: 3 })).includes('drop:fighter.a.effort.0'));
check('another take is fine', types(ask('effort', 'fighter.a.effort.1', 200, { speaker: 'a', pool: 3 })).includes('start:fighter.a.effort.1'));
now = 600;
check('a one-take kind (KO) is exempt', types(ask('ko', 'fighter.a.ko', 200, { speaker: 'a', pool: 1 })).includes('start'));
now = 900;
check('and may play again', types(ask('ko', 'fighter.a.ko', 200, { speaker: 'a', pool: 1 })).includes('start'));

// stopKind cuts a call and drops waiting calls.
reset();
ask('announcer', 'a1', 2000);
now = 100;
o = d.stopKind('announcer');
check('stopKind cuts the call on the air', types(o) === 'cut:a1');
check('and the air is free', d.busyMs() === 0);

// A busy random match: whatever the mix, nothing overlaps beyond the crossfade and nothing waits over 0.6 s.
reset();
let seed = 7;
const rnd = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
for (let i = 0; i < 4000; i++) {
  const target = now + Math.floor(rnd() * 400);
  for (let w = d.nextWake(); w !== null && w <= target; w = d.nextWake()) {
    now = Math.max(now, w);
    d.pump();
  }
  now = target;
  const k = order[Math.floor(rnd() * order.length)];
  const who = `f${Math.floor(rnd() * 4)}`;
  d.request({ kind: k, speaker: k === 'effort' || k === 'hurt' || k === 'ko' || k === 'taunt' ? who : k, id: `${k}.${i % 3}`, ms: 200 + rnd() * 1800, pool: 3 });
  d.pump();
}
for (let w = d.nextWake(); w !== null; w = d.nextWake()) {
  now = Math.max(now, w);
  d.pump();
}
const st = d.stats();
check('4000 random takes: 0 ms overlap beyond the crossfade', st.overBudgetMs === 0 && st.overlaps === 0, JSON.stringify(st));
check('4000 random takes: nobody waited over 0.6 s', st.maxWaitMs <= WAIT_MS + 1, String(st.maxWaitMs));
check('4000 random takes: no bark twice in a row', st.barkRepeats === 0, String(st.barkRepeats));
check('4000 random takes: some played, some dropped, some cut', st.played > 100 && st.dropped > 100 && st.cut > 10, JSON.stringify(st));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('voice director ok');
