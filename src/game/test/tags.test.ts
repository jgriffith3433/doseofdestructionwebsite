import { placeTag, tagText } from '../ui/tags.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

const slots = [{ cpu: null }, { cpu: 5 }, { cpu: null }, { cpu: 0 }];
ok(tagText(slots, 0) === 'P1', 'P1');
ok(tagText(slots, 1) === 'CPU', 'CPU');
ok(tagText(slots, 2) === 'P3', 'P3');
ok(tagText(slots, 3) === 'DUMMY', 'dummy');
ok(tagText(slots, 0, 'Ada') === 'Ada', 'online name');
ok(tagText(slots, 0, 'A very long name').length <= 10, 'name cut');
ok(tagText(slots, 1, 'Ada') === 'CPU', 'bot keeps CPU');

const safe = { l: 8, t: 8, r: 382, b: 836 };
const p = placeTag(2, 300, 40, 18, safe, []);
ok(p.x === 28, 'clamped left');
const top = placeTag(200, 5, 40, 18, safe, []);
ok(top.y - 18 >= 8, 'clamped top');
const stick = { l: 0, t: 600, r: 200, b: 836 };
const q = placeTag(100, 700, 40, 18, safe, [stick]);
ok(q.clear && q.y <= 596, 'nudged above the stick');
if (fails) process.exit(1);
console.log('tags ok');
