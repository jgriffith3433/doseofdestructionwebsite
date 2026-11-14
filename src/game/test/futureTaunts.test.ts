import { FutureTaunts, FUTURE_TAUNTS, TAUNT_GAP_FRAMES } from '../campaign/futureTaunts.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

ok(FUTURE_TAUNTS.every((t) => t.text.split(/\s+/).length <= 10), 'every taunt is 10 words or fewer');
ok(new Set(FUTURE_TAUNTS.map((t) => t.id)).size === FUTURE_TAUNTS.length, 'ids are unique');

const me = 1;
const t = new FutureTaunts();
ok(t.react({ type: 'hit', attacker: me, victim: 0, dmg: 100 }, me, 0)?.kind === 'hit', 'he lands a hit: hit taunt');
ok(t.react({ type: 'hit', attacker: 0, victim: me, dmg: 100 }, me, 60) === null, 'inside the gap: silent');
ok(t.react({ type: 'hit', attacker: 0, victim: me, dmg: 100 }, me, TAUNT_GAP_FRAMES)?.kind === 'hurt', 'he is hit: hurt taunt');
ok(t.react({ type: 'ledge', id: 0 }, me, TAUNT_GAP_FRAMES * 2)?.kind === 'ledge', 'the other fighter hangs: ledge taunt');
ok(t.react({ type: 'ledge', id: me }, me, TAUNT_GAP_FRAMES * 4) === null, 'his own ledge grab: silent');
ok(t.react({ type: 'hit', attacker: me, victim: 0, dmg: 10 }, me, TAUNT_GAP_FRAMES * 5) === null, 'a light poke: silent');
ok(t.react({ type: 'hit', attacker: me, victim: 0, dmg: 100, shield: true }, me, TAUNT_GAP_FRAMES * 6) === null, 'a shielded hit: silent');
const u = new FutureTaunts();
let last = '';
let repeat = false;
for (let i = 0; i < 12; i++) {
  const x = u.react({ type: 'hit', attacker: me, victim: 0, dmg: 100 }, me, i * TAUNT_GAP_FRAMES);
  if (x?.id === last) repeat = true;
  last = x?.id ?? '';
}
ok(!repeat, 'no line twice in a row');
if (fails) process.exit(1);
console.log('futureTaunts ok');
