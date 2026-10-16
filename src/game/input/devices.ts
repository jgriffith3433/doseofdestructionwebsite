// Reads the local keyboard and gamepads and packs them into the sim's input format.

import { BTN, packInput, stickX, stickY } from '../sim/input.ts';

const held = new Set<string>();
let listening = false;

const GAME_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyI', 'KeyU',
]);

export function listenKeyboard(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    held.add(e.code);
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
}

export const KEYBOARD_HELP: [string, string][] = [
  ['Move', 'A D (or arrows)'],
  ['Up / down', 'W S'],
  ['Jump', 'Space'],
  ['Attack', 'J'],
  ['Special', 'K  (W+K recovers)'],
  ['Shield / dodge', 'L'],
  ['Smash', 'I + direction'],
  ['Pause', 'Esc'],
];

export const GAMEPAD_HELP: [string, string][] = [
  ['Move', 'Left stick / D-pad'],
  ['Jump', 'X / Y'],
  ['Attack', 'A'],
  ['Special', 'B'],
  ['Shield / dodge', 'Triggers / bumpers'],
  ['Smash', 'Right stick'],
  ['Pause', 'Start'],
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
  if (btn(12)) sy = 100;
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

export function pads(): Gamepad[] {
  return (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
}

/**
 * A virtual controller: the playtest bot plugs in here and is read once per
 * frame like a gamepad. Null (always, outside a playtest) means none.
 */
let virtualPad: (() => number) | null = null;
export function setVirtualPad(read: (() => number) | null): void {
  virtualPad = read;
}

/** The local player's input this frame: the keyboard, the first gamepad and any virtual pad, merged. */
export function readLocal(): number {
  let [sx, sy, b] = keyboardInput();
  const merge = ([px, py, pb]: [number, number, number]) => {
    if (Math.abs(px) > Math.abs(sx)) sx = px;
    if (Math.abs(py) > Math.abs(sy)) sy = py;
    b |= pb;
  };
  const pad = pads()[0];
  if (pad) merge(gamepadInput(pad));
  if (virtualPad) {
    const v = virtualPad();
    merge([stickX(v), stickY(v), v & ~0xffff]);
  }
  return packInput(sx, sy, b);
}

/** True on the frame Start or Esc goes down. */
let pauseWasDown = false;
export function pausePressed(): boolean {
  const down = held.has('Escape') || pads().some((p) => !!p.buttons[9]?.pressed);
  const edge = down && !pauseWasDown;
  pauseWasDown = down;
  return edge;
}

/** Runs cb once per key press (auto-repeat ignored). */
export function onKey(code: string, cb: () => void): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === code && !e.repeat) cb();
  });
}
