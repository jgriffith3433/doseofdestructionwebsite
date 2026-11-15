import {
  DEFAULT_BINDINGS, KEY_ACTIONS, PAD_ACTIONS, applyBindings, bindButton, bindKey, bindings, clearKey, cloneBindings, isDefault, keyName, keyNames,
  padNames, resetBindings,
} from '../input/bindings.ts';

declare const process: { exit(code: number): never };
let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

ok(isDefault(), 'starts at defaults');

// Rebind Jump's first slot to KeyH: the new key is there, Space is gone from Jump, defaults untouched.
let b = cloneBindings(bindings());
ok(bindKey(b, 'jump', 0, 'KeyH') === null, 'free key: no clash');
ok(b.keys.jump[0] === 'KeyH' && b.keys.jump[1] === 'KeyU', 'jump slot set');
ok(DEFAULT_BINDINGS.keys.jump[0] === 'Space', 'defaults not mutated');

// A clash takes the key from the other action and reports it.
b = cloneBindings(bindings());
const clash = bindKey(b, 'jump', 0, 'KeyJ');
ok(clash?.action === 'Attack', 'clash names Attack');
ok(b.keys.attack[0] !== 'KeyJ' && b.keys.attack.some(Boolean), 'attack lost J but still has a key');
const all = KEY_ACTIONS.flatMap(({ id }) => b.keys[id]).filter(Boolean);
ok(new Set(all).size === all.length, 'no key on two actions');

// Reserved keys never bind.
b = cloneBindings(bindings());
bindKey(b, 'jump', 0, 'Escape');
ok(b.keys.jump[0] === 'Space', 'Escape is not bindable');

// The last key of an action can't be cleared.
b = cloneBindings(bindings());
ok(!clearKey(b, 'attack', 0), 'attack keeps its only key');
ok(clearKey(b, 'jump', 1) && b.keys.jump[1] === '', 'a second key clears');

// Pad: a button replaces the list; the loser keeps something playable.
b = cloneBindings(bindings());
const pc = bindButton(b, 'jump', 0);
ok(pc?.action === 'Attack' && b.pad.jump.join() === '0', 'jump takes button 0 from attack');
ok(b.pad.attack.length > 0 && !b.pad.attack.includes(0), 'attack still has a button');
ok(bindButton(b, 'jump', 9) === null && b.pad.jump.join() === '0', 'Start is not bindable');

// Save and reload: a fresh read of storage gives the bindings back; Reset restores defaults.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
b = cloneBindings(bindings());
bindKey(b, 'jump', 0, 'KeyH');
applyBindings(b);
ok(store.get('dod.bindings')?.includes('KeyH') === true, 'saved');
ok(bindings().keys.jump[0] === 'KeyH' && !isDefault(), 'applied');
store.set('dod.bindings', '{"keys":{"jump":["KeyZ","KeyU"],"left":["Escape","KeyA"]},"pad":{"jump":[99]}}');
applyBindings(JSON.parse(store.get('dod.bindings')!));
ok(bindings().keys.jump[0] === 'KeyZ', 'sane keeps good entries');
ok(bindings().keys.left[0] === 'KeyA', 'sane drops reserved keys to default');
ok(bindings().pad.jump.join() === '2,3', 'sane drops bad buttons to default');
resetBindings();
ok(isDefault() && JSON.parse(store.get('dod.bindings')!).keys.jump[0] === 'Space', 'reset restores and saves defaults');

// Names.
ok(keyName('KeyJ') === 'J' && keyName('ArrowLeft') === '←' && keyName('Digit4') === '4' && keyName('') === 'None', 'key names');
ok(keyNames(['KeyA', 'ArrowLeft']) === 'A / ←', 'key names list');
ok(padNames([2, 3], 'xbox') === 'X / Y' && padNames([0], 'playstation') === 'Cross' && padNames([0], 'switch') === 'B', 'pad names by family');
ok(PAD_ACTIONS.length === 5, 'pad actions');

if (fails) process.exit(1);
console.log('bindings ok');
