// Reads the local keyboard and gamepads and packs them into the sim's input format.

import { BTN, packInput, stickX, stickY } from '../sim/input.ts';
import { consumeTouchEventAt, readTouch } from './touch.ts';
import { applyShieldMode } from './shieldMode.ts';
import { bindings, keyNames, padNames, KEY_ACTIONS, RESERVED_KEYS } from './bindings.ts';

const held = new Set<string>();
let listening = false;
let lastKeyEventAt = 0;
/** Last time a key (or a pad button) was used, to tell which device the player is on (inputDevice). */
let lastKeyUseAt = 0;
let lastPadUseAt = 0;

export interface InputEdge {
  at: number;
  polledAt: number;
  buttons: number;
  stick: boolean;
}

let lastReadButtons = 0;
let lastReadSignX = 0;
let lastReadSignY = 0;
let lastInputEdge: InputEdge | null = null;

/** Returns and clears the most recent input edge read by readLocal(). */
export function consumeInputEdge(): InputEdge | null {
  const e = lastInputEdge;
  lastInputEdge = null;
  return e;
}

/** Keys the game takes from the page (no scrolling, no focus moves): every bound key, plus Space and the arrows. */
function isGameKey(code: string): boolean {
  if (RESERVED_KEYS.has(code)) return false;
  if (code === 'Space' || code.startsWith('Arrow')) return true;
  const b = bindings().keys;
  return KEY_ACTIONS.some(({ id }) => b[id][0] === code || b[id][1] === code);
}

export function listenKeyboard(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    if (isGameKey(e.code) && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (!held.has(e.code)) lastKeyEventAt = performance.now();
    }
    held.add(e.code);
    if (isGameKey(e.code)) lastKeyUseAt = performance.now();
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
}

/** The keyboard list with the player's actual bindings (Controls page, Pause's All controls). */
export function keyboardHelp(): [string, string][] {
  const k = bindings().keys;
  const n = (a: keyof typeof k) => keyNames(k[a]);
  const move = `${keyNames([k.left[0], k.right[0]])}`;
  return [
    ['Move left / right', `${n('left')}  ·  ${n('right')}`],
    ['Up / down', `${n('up')}  ·  ${n('down')}`],
    ['Jump', n('jump')],
    ['Attack', n('attack')],
    ['Special', `${n('special')}  (neutral)`],
    ['Side special', `${n('special')} + ${move}`],
    ['Up special', `${n('special')} + ${keyNames([k.up[0], ''])}  (recovery)`],
    ['Down special', `${n('special')} + ${keyNames([k.down[0], ''])}`],
    ['Shield / dodge', n('shield')],
    ['On the ledge', `${keyNames([k.up[0], ''])} or ${keyNames([k.right[0], ''])}: get up · ${n('attack')}: attack · ${n('shield')}: roll · ${n('jump')}: jump · ${keyNames([k.down[0], ''])}: drop`],
    ['Grab', `${n('shield')} + ${n('attack')}  (beats shield)`],
    ['Throw', 'Grab, then a direction'],
    ['Smash', `${n('smash')} + direction`],
    ['Taunt', n('taunt')],
    ['Pause', 'Esc'],
  ];
}

/**
 * The pad family by its Gamepad.id: Sony (vendor 054c), Nintendo (057e), else Xbox. The browser's standard mapping puts
 * the bottom face button at index 0 on every pad, so the game's buttons are the same; only the names change.
 */
export type PadFamily = 'xbox' | 'playstation' | 'switch';

export function padFamilyOf(id: string | undefined | null): PadFamily {
  const s = (id ?? '').toLowerCase();
  if (/054c|sony|playstation|dualshock|dualsense|ps[345]/.test(s)) return 'playstation';
  if (/057e|nintendo|switch|joy-?con|pro controller/.test(s)) return 'switch';
  return 'xbox';
}

/** What each of the game's pad buttons is called on a family's pad. Attack = bottom, Special = right, Jump = left / top. */
export interface PadNames {
  attack: string;
  special: string;
  jump: string;
  shield: string;
  triggers: string;
  pause: string;
  /** Short caption for each (a symbol on PlayStation); `name` is the spoken / logged word. */
  symbol: Record<'attack' | 'special' | 'jump' | 'shield', string>;
}

export const PAD_NAMES: Record<PadFamily, PadNames> = {
  xbox: { attack: 'A', special: 'B', jump: 'X / Y', shield: 'LB', triggers: 'Triggers / bumpers', pause: 'Start', symbol: { attack: 'A', special: 'B', jump: 'X', shield: 'LB' } },
  playstation: { attack: 'Cross', special: 'Circle', jump: 'Square / Triangle', shield: 'L1', triggers: 'L1 / R1 / L2 / R2', pause: 'Options', symbol: { attack: '✕', special: '○', jump: '□', shield: 'L1' } },
  switch: { attack: 'B', special: 'A', jump: 'Y / X', shield: 'L', triggers: 'L / R / ZL / ZR', pause: '+', symbol: { attack: 'B', special: 'A', jump: 'Y', shield: 'L' } },
};

/** The controls list for the pad family in hand, with the player's actual button bindings. */
export function gamepadHelp(f: PadFamily = padFamily()): [string, string][] {
  const n = PAD_NAMES[f];
  const p = bindings().pad;
  const a = padNames(p.attack, f);
  const sp = padNames(p.special, f);
  const jp = padNames(p.jump, f);
  const sh = padNames(p.shield, f);
  return [
    ['Move', 'Left stick / D-pad'],
    ['Jump', jp],
    ['Attack', a],
    ['Special', `${sp}  (neutral)`],
    ['Side special', `${sp} + left / right`],
    ['Up special', `${sp} + up  (recovery)`],
    ['Down special', `${sp} + down`],
    ['Shield / dodge', sh],
    ['On the ledge', `Stick up: get up · ${a}: attack · ${sh}: roll · ${jp}: jump · stick down: drop`],
    ['Grab', `${sh} + ${a}  (beats shield)`],
    ['Throw', 'Grab, then left stick'],
    ['Smash', 'Right stick'],
    ['Taunt', padNames(p.taunt, f)],
    ['Pause', n.pause],
  ];
}

let lastPadId = '';
const padStamp = new Map<number, number>();
/** Notes which connected pad gave input last (a button, or a stick past its dead zone). Called by the game and menu loops. */
export function scanPads(): void {
  for (const p of pads()) {
    const active = p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5);
    const prev = padStamp.get(p.index);
    padStamp.set(p.index, p.timestamp);
    if (active && (prev === undefined || p.timestamp !== prev || emulatedPads.get(p.index) === p)) lastPadId = p.id;
  }
}

/** The family of whichever pad last gave input (else the first connected pad, else Xbox). */
export function padFamily(): PadFamily {
  return padFamilyOf(lastPadId || pads()[0]?.id);
}

/** The on-screen controls: no extra buttons, the stick picks which special the Special button does. */
export const TOUCH_HELP: [string, string][] = [
  ['Move', 'Left stick'],
  ['Special', 'Special button'],
  ['Side / down special', 'Hold the stick left, right or down, then Special'],
  ['Up special', 'Hold the stick up, then Special'],
  ['On the ledge', 'Stick up: get up · Attack · Shield: roll · Jump · stick down: drop'],
  ['Grab', 'Shield + Attack together'],
  ['Throw', 'Grab, then the stick: forward, back, up or down'],
];

function keyboardInput(): [number, number, number] {
  const keys = bindings().keys;
  const k = (a: keyof typeof keys) => keys[a].some((c) => !!c && held.has(c));
  let sx = 0;
  let sy = 0;
  if (k('left')) sx -= 100;
  if (k('right')) sx += 100;
  if (k('up')) sy += 100;
  if (k('down')) sy -= 100;
  let b = 0;
  if (k('jump')) b |= BTN.JUMP;
  if (k('attack')) b |= BTN.ATTACK;
  if (k('special')) b |= BTN.SPECIAL;
  if (k('shield')) b |= BTN.SHIELD;
  if (k('smash')) b |= BTN.C_NEUTRAL;
  return [sx, sy, b];
}

function deadzone(v: number): number {
  return Math.abs(v) < 0.22 ? 0 : v;
}

function gamepadInput(pad: Gamepad): [number, number, number] {
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  const any = (list: number[]) => list.some(btn);
  const pb = bindings().pad;
  let sx = deadzone(pad.axes[0] ?? 0) * 100;
  let sy = -deadzone(pad.axes[1] ?? 0) * 100;
  if (btn(14)) sx = -100;
  if (btn(15)) sx = 100;
  // D-pad up is the taunt (Smash-style); stick still aims up for jumps and recoveries.
  if (btn(13)) sy = -100;
  let b = 0;
  if (any(pb.attack)) b |= BTN.ATTACK;
  if (any(pb.special)) b |= BTN.SPECIAL;
  if (any(pb.jump)) b |= BTN.JUMP;
  if (any(pb.shield)) b |= BTN.SHIELD;
  const cx = pad.axes[2] ?? 0;
  const cy = pad.axes[3] ?? 0;
  if (Math.abs(cx) > 0.6 || Math.abs(cy) > 0.6) {
    if (Math.abs(cx) > Math.abs(cy)) b |= cx > 0 ? BTN.C_RIGHT : BTN.C_LEFT;
    else b |= cy > 0 ? BTN.C_DOWN : BTN.C_UP;
  }
  return [sx, sy, b];
}

/** Controllers the playtest presses (menu-walk, rebinding): standard mapping, button i pressed or not, left stick axes. `index` picks which pad. Null outside a playtest. */
const emulatedPads = new Map<number, Gamepad>();
export function emulatePad(state: { buttons: boolean[]; axes: [number, number]; id?: string } | null, index = 0): void {
  if (!state) {
    if (index === 0) emulatedPads.clear();
    else emulatedPads.delete(index);
  } else {
    emulatedPads.set(index, {
      id: state.id ?? 'playtest-pad', index, connected: true, mapping: 'standard', timestamp: performance.now(),
      axes: state.axes,
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!state.buttons[i], touched: !!state.buttons[i], value: state.buttons[i] ? 1 : 0 })),
      vibrationActuator: null, hapticActuators: [],
    } as unknown as Gamepad);
  }
}

/** Every connected controller: the playtest's emulated ones first, then the real ones, each with its own index. */
export function pads(): Gamepad[] {
  const real = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
  return emulatedPads.size ? [...emulatedPads.values(), ...real] : real;
}

/** Local versus: which controller (by position in pads()) drives which player slot. A pad given to a slot no longer drives player 1. */
const padOwner = new Map<number, number>();
export function assignPad(padIndex: number, slot: number | null): void {
  if (slot === null || slot === 0) padOwner.delete(padIndex);
  else padOwner.set(padIndex, slot);
}
/** The input of a controller assigned to `slot` (0 = player 1: every pad nobody else owns, plus keys). Null when none is assigned. */
export function readPadSlot(slot: number): number | null {
  let sx = 0;
  let sy = 0;
  let b = 0;
  let found = false;
  for (const p of pads()) {
    if ((padOwner.get(p.index) ?? 0) !== slot) continue;
    found = true;
    const [px, py, pb] = gamepadInput(p);
    if (Math.abs(px) > Math.abs(sx)) sx = px;
    if (Math.abs(py) > Math.abs(sy)) sy = py;
    b |= pb;
  }
  return found ? packInput(sx, sy, b) : null;
}

/**
 * A virtual controller: the playtest bot plugs in here and is read once per
 * frame like a gamepad. Null (always, outside a playtest) means none.
 */
let virtualPad: (() => number) | null = null;
export function setVirtualPad(read: (() => number) | null): void {
  virtualPad = read;
}

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

/** The device the player is on right now (for on-screen button glyphs): touch controls up, else whichever of pad and keys was used last. */
export function inputDevice(): InputDevice {
  if (typeof document !== 'undefined' && document.body.classList.contains('touch-ui')) return 'touch';
  if (lastPadUseAt > lastKeyUseAt) return 'gamepad';
  if (lastKeyUseAt === 0 && pads().length > 0) return 'gamepad';
  return 'keyboard';
}

/**
 * Local versus with two or more people: each device is its own player. Controllers fill the player slots in order
 * (pad 1 = player 1 and so on, the keyboard staying with player 1); with fewer pads than people the keyboard is player 1
 * and the pads take the next slots. Extra pads beyond the people go to player 1, as in single play. Clears when `humans` < 2.
 */
export function assignDevices(humans: number): void {
  padOwner.clear();
  if (humans < 2) return;
  const list = pads();
  const padsLead = list.length >= humans;
  list.forEach((p, j) => {
    const slot = padsLead ? j : j + 1;
    if (slot > 0 && slot < humans) padOwner.set(p.index, slot);
  });
}

/** Every person's input this frame in slot order: [0] is `readLocal()` (keyboard, its pad, touch), the rest are their own pads. */
export function readHumans(humans: number): number[] {
  assignDevices(humans);
  const first = readLocal();
  const out = [first];
  for (let k = 1; k < humans; k++) out.push(readPadSlot(k) ?? packInput(0, 0, 0));
  return out;
}

/** The local player's input this frame: the keyboard, every gamepad and any virtual pad, merged. */
export function readLocal(): number {
  let [sx, sy, b] = keyboardInput();
  const merge = ([px, py, pb]: [number, number, number]) => {
    if (Math.abs(px) > Math.abs(sx)) sx = px;
    if (Math.abs(py) > Math.abs(sy)) sy = py;
    b |= pb;
  };
  scanPads();
  // Any connected controller can drive player 1 (the ones given to another local player excepted).
  for (const pad of pads()) {
    if ((padOwner.get(pad.index) ?? 0) !== 0) continue;
    const g = gamepadInput(pad);
    if (g[0] !== 0 || g[1] !== 0 || (g[2] & 0xffff0000) !== 0) lastPadUseAt = performance.now();
    merge(g);
  }
  merge(readTouch());
  if (virtualPad) {
    const v = virtualPad();
    merge([stickX(v), stickY(v), v & ~0xffff]);
  }
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const domAt = consumeTouchEventAt() || lastKeyEventAt;
  lastKeyEventAt = 0;
  const newButtons = b & ~lastReadButtons;
  const signX = Math.abs(sx) > 20 ? Math.sign(sx) : 0;
  const signY = Math.abs(sy) > 60 ? Math.sign(sy) : 0;
  const newStick = (signX !== 0 && signX !== lastReadSignX) || (signY !== 0 && signY !== lastReadSignY);
  lastReadButtons = b;
  lastReadSignX = signX;
  lastReadSignY = signY;
  if (newButtons !== 0 || newStick) {
    lastInputEdge = { at: domAt || now, polledAt: now, buttons: newButtons, stick: newStick };
  }
  // Shield: Hold passes straight through; Toggle latches it (input/shieldMode.ts), so the sim and online see a plain held bit.
  return packInput(sx, sy, applyShieldMode(b, sx, sy));
}

/** True on the frame Start or Esc goes down. */
let pauseWasDown = false;
export function pausePressed(): boolean {
  const down = held.has('Escape') || pads().some((p) => !!p.buttons[9]?.pressed);
  const edge = down && !pauseWasDown;
  pauseWasDown = down;
  return edge;
}

/**
 * Which person pressed Start or Esc this frame: their slot (0 = keyboard and every pad nobody else owns, 1+ = a pad given
 * to that player), or null when nobody did. Solo play always reads slot 0.
 */
const pauseDown = new Map<string, boolean>();
export function pausePressedBy(): number | null {
  let by: number | null = null;
  const sources: [string, boolean, number][] = [['key', held.has('Escape'), 0]];
  for (const p of pads()) sources.push([`pad${p.index}`, !!p.buttons[9]?.pressed, padOwner.get(p.index) ?? 0]);
  for (const [id, down, slot] of sources) {
    if (down && !pauseDown.get(id) && by === null) by = slot;
    pauseDown.set(id, down);
  }
  return by;
}

/** The player slot a controller drives (0 when it is not given to anyone else). */
export function padSlot(p: Gamepad): number {
  return padOwner.get(p.index) ?? 0;
}

/** True on the frame T or gamepad D-pad up goes down (no touch button: space is tight on phones). */
let tauntWasDown = false;
export function tauntPressed(): boolean {
  const down = bindings().keys.taunt.some((c) => !!c && held.has(c)) || pads().some((p) => bindings().pad.taunt.some((i) => !!p.buttons[i]?.pressed));
  const edge = down && !tauntWasDown;
  tauntWasDown = down;
  return edge;
}

/** Runs cb once per key press (auto-repeat ignored). */
export function onKey(code: string, cb: () => void): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'text') return;
    if (e.code === code && !e.repeat) cb();
  });
}
