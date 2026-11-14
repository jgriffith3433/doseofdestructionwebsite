// Reads the local keyboard and gamepads and packs them into the sim's input format.

import { BTN, packInput, stickX, stickY } from '../sim/input.ts';
import { consumeTouchEventAt, readTouch } from './touch.ts';
import { applyShieldMode } from './shieldMode.ts';

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

const GAME_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyI', 'KeyU', 'KeyT',
]);

export function listenKeyboard(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code) && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (!held.has(e.code)) lastKeyEventAt = performance.now();
    }
    held.add(e.code);
    if (GAME_KEYS.has(e.code)) lastKeyUseAt = performance.now();
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
}

export const KEYBOARD_HELP: [string, string][] = [
  ['Move', 'A D (or arrows)'],
  ['Up / down', 'W S'],
  ['Jump', 'Space'],
  ['Attack', 'J'],
  ['Special', 'K  (neutral)'],
  ['Side special', 'K + A / D'],
  ['Up special', 'K + W  (recovery)'],
  ['Down special', 'K + S'],
  ['Shield / dodge', 'L'],
  ['Grab', 'L + J  (beats shield)'],
  ['Throw', 'Grab, then A D W S'],
  ['Smash', 'I + direction'],
  ['Taunt', 'T'],
  ['Pause', 'Esc'],
];

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

/** The controls list for the pad family in hand. */
export function gamepadHelp(f: PadFamily = padFamily()): [string, string][] {
  const n = PAD_NAMES[f];
  return [
    ['Move', 'Left stick / D-pad'],
    ['Jump', n.jump],
    ['Attack', n.attack],
    ['Special', `${n.special}  (neutral)`],
    ['Side special', `${n.special} + left / right`],
    ['Up special', `${n.special} + up  (recovery)`],
    ['Down special', `${n.special} + down`],
    ['Shield / dodge', n.triggers],
    ['Grab', `${f === 'xbox' ? 'Trigger' : n.shield} + ${n.attack}  (beats shield)`],
    ['Throw', 'Grab, then left stick'],
    ['Smash', 'Right stick'],
    ['Taunt', 'D-pad up'],
    ['Pause', n.pause],
  ];
}

export const GAMEPAD_HELP: [string, string][] = gamepadHelp('xbox');

let lastPadId = '';
const padStamp = new Map<number, number>();
/** Notes which connected pad gave input last (a button, or a stick past its dead zone). Called by the game and menu loops. */
export function scanPads(): void {
  for (const p of pads()) {
    const active = p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5);
    const prev = padStamp.get(p.index);
    padStamp.set(p.index, p.timestamp);
    if (active && (prev === undefined || p.timestamp !== prev || p === emulated)) lastPadId = p.id;
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
  ['Grab', 'Shield + Attack together'],
  ['Throw', 'Grab, then the stick: forward, back, up or down'],
];

function keyboardInput(): [number, number, number] {
  const k = (c: string) => held.has(c);
  let sx = 0;
  let sy = 0;
  if (k('KeyA') || k('ArrowLeft')) sx -= 100;
  if (k('KeyD') || k('ArrowRight')) sx += 100;
  if (k('KeyW') || k('ArrowUp')) sy += 100;
  if (k('KeyS') || k('ArrowDown')) sy -= 100;
  let b = 0;
  if (k('Space') || k('KeyU')) b |= BTN.JUMP;
  if (k('KeyJ')) b |= BTN.ATTACK;
  if (k('KeyK')) b |= BTN.SPECIAL;
  if (k('KeyL')) b |= BTN.SHIELD;
  if (k('KeyI')) b |= BTN.C_NEUTRAL;
  return [sx, sy, b];
}

function deadzone(v: number): number {
  return Math.abs(v) < 0.22 ? 0 : v;
}

function gamepadInput(pad: Gamepad): [number, number, number] {
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  let sx = deadzone(pad.axes[0] ?? 0) * 100;
  let sy = -deadzone(pad.axes[1] ?? 0) * 100;
  if (btn(14)) sx = -100;
  if (btn(15)) sx = 100;
  // D-pad up is the taunt (Smash-style); stick still aims up for jumps and recoveries.
  if (btn(13)) sy = -100;
  let b = 0;
  if (btn(0)) b |= BTN.ATTACK;
  if (btn(1)) b |= BTN.SPECIAL;
  if (btn(2) || btn(3)) b |= BTN.JUMP;
  if (btn(4) || btn(5) || btn(6) || btn(7)) b |= BTN.SHIELD;
  const cx = pad.axes[2] ?? 0;
  const cy = pad.axes[3] ?? 0;
  if (Math.abs(cx) > 0.6 || Math.abs(cy) > 0.6) {
    if (Math.abs(cx) > Math.abs(cy)) b |= cx > 0 ? BTN.C_RIGHT : BTN.C_LEFT;
    else b |= cy > 0 ? BTN.C_DOWN : BTN.C_UP;
  }
  return [sx, sy, b];
}

/** A controller the playtest presses (menu-walk): standard mapping, button i pressed or not, left stick axes. Null outside a playtest. */
let emulated: Gamepad | null = null;
export function emulatePad(state: { buttons: boolean[]; axes: [number, number]; id?: string } | null): void {
  emulated = state
    ? ({
        id: state.id ?? 'playtest-pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
        axes: state.axes,
        buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!state.buttons[i], touched: !!state.buttons[i], value: state.buttons[i] ? 1 : 0 })),
        vibrationActuator: null, hapticActuators: [],
      } as unknown as Gamepad)
    : null;
}

export function pads(): Gamepad[] {
  const real = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
  return emulated ? [emulated, ...real] : real;
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

/** The local player's input this frame: the keyboard, the first gamepad and any virtual pad, merged. */
export function readLocal(): number {
  let [sx, sy, b] = keyboardInput();
  const merge = ([px, py, pb]: [number, number, number]) => {
    if (Math.abs(px) > Math.abs(sx)) sx = px;
    if (Math.abs(py) > Math.abs(sy)) sy = py;
    b |= pb;
  };
  scanPads();
  const pad = pads()[0];
  if (pad) {
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

/** True on the frame T or gamepad D-pad up goes down (no touch button: space is tight on phones). */
let tauntWasDown = false;
export function tauntPressed(): boolean {
  const down = held.has('KeyT') || pads().some((p) => !!p.buttons[12]?.pressed);
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
