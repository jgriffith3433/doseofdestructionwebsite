// Screens, the wipe between them, and menu navigation with keyboard or gamepad.
//
// Each screen is a <section class="screen" id="..."> in the page. Only one is
// shown at a time; go() covers the switch with a diagonal wipe.

import { pads } from '../input/devices.ts';
import { audio } from '../audio.ts';

export type ScreenId =
  | 'title' | 'main' | 'select' | 'stages' | 'versus' | 'campaign' | 'dialogue' | 'howto' | 'results' | 'match' | 'leaderboard';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const backHandlers = new Map<ScreenId, () => void>();
/** A panel over the screen (Settings): Back closes it first. */
let panelBack: (() => void) | null = null;
let current: ScreenId | null = null;
let busy = false;

export function currentScreen(): ScreenId | null {
  return current;
}

/** True while a wipe is switching screens (menu presses are ignored then). */
export function switching(): boolean {
  return busy;
}

/** What Back does while a panel is open over the screen, or null when it closes. */
export function onPanelBack(fn: (() => void) | null): void {
  panelBack = fn;
}

/** What Esc, Backspace or the B button does on a screen. */
export function onBack(id: ScreenId, fn: () => void): void {
  backHandlers.set(id, fn);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Switches screens behind a wipe. The callback runs while the screen is covered. */
export async function go(id: ScreenId, whileCovered?: () => void | Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  const wipe = document.getElementById('wipe')!;
  const first = current === null;
  if (!first) {
    audio.sfx('wipe');
    wipe.className = 'wipe in';
    await wait(reduceMotion ? 120 : 340);
  }
  await whileCovered?.();
  show(id);
  if (!first) {
    wipe.className = 'wipe out';
    await wait(reduceMotion ? 120 : 360);
    wipe.className = 'wipe';
  }
  busy = false;
  focusFirst();
}

function show(id: ScreenId): void {
  current = id;
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    el.hidden = el.id !== id;
  });
  document.body.dataset.screen = id;
}

export function screenEl(id: ScreenId): HTMLElement {
  return document.getElementById(id)!;
}

// --------------------------------------------------------------- navigation

const FOCUSABLE = 'button:not([disabled]), a[href], select, [tabindex="0"]';

function candidates(): HTMLElement[] {
  const root = current ? screenEl(current) : document.body;
  const overlay = document.querySelector<HTMLElement>('.overlay:not([hidden])');
  const scope = overlay ?? root;
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
}

/** The Tap to play prompt (Game/index.html), while it is up: it keeps focus, so Enter or a pad button taps it. */
function tapPrompt(): HTMLElement | null {
  const prompt = document.getElementById('tap-to-play');
  return prompt && !prompt.hidden ? prompt : null;
}

export function focusFirst(): void {
  const prompt = tapPrompt();
  if (prompt) {
    prompt.focus();
    return;
  }
  const list = candidates();
  const preferred = list.find((el) => el.dataset.autofocus !== undefined) ?? list[0];
  preferred?.focus({ preventScroll: false });
}

/** Moves focus to the nearest control in a direction, by on-screen position. */
export function moveFocus(dx: number, dy: number): void {
  if (tapPrompt()) return;
  const list = candidates();
  if (!list.length) return;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !list.includes(active)) {
    list[0].focus();
    return;
  }
  const a = active.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === active) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    const along = dx ? (ex - ax) * dx : (ey - ay) * dy;
    if (along <= 4) continue;
    const across = dx ? Math.abs(ey - ay) : Math.abs(ex - ax);
    const score = along + across * 2.2;
    if (score < bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (best) audio.sfx('ui-move');
  best?.focus();
  best?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Runs the current screen's back action. */
export function back(): void {
  const fn = busy ? undefined : panelBack ?? (current ? backHandlers.get(current) : undefined);
  if (fn) {
    audio.sfx('ui-back');
    fn();
  }
}

/** Keyboard menu controls. Matches have their own input, so this stands down during play. */
/** A key press inside a text field. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search');
}

export function listenMenuKeys(inMatch: () => boolean): void {
  window.addEventListener('keydown', (e) => {
    if (inMatch() || busy) return;
    // Typing a name (Profile): letters are letters; only Esc still backs out.
    if (typing(e) && e.code !== 'Escape') return;
    if (e.target instanceof HTMLSelectElement && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) return;
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, -1], KeyS: [0, 1],
    };
    const d = dirs[e.code];
    if (d) {
      e.preventDefault();
      moveFocus(d[0], d[1]);
    } else if (e.code === 'Escape' && current === 'match') {
      // In a match Esc is the pause key, which the match loop reads (and which closes Settings there).
    } else if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'KeyK') {
      e.preventDefault();
      back();
    } else if (e.code === 'KeyJ') {
      (document.activeElement as HTMLElement | null)?.click();
    }
  });
}

// Gamepad menu controls, polled from the main loop.
let padHeld = '';
let padNext = 0;
let padButtons: boolean[] = [];

export function pollMenuPad(now: number): void {
  if (busy) return;
  const pad = pads()[0];
  if (!pad) return;
  const ax = pad.axes[0] ?? 0;
  const ay = pad.axes[1] ?? 0;
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  let dir = '';
  if (btn(14) || ax < -0.6) dir = 'l';
  else if (btn(15) || ax > 0.6) dir = 'r';
  else if (btn(12) || ay < -0.6) dir = 'u';
  else if (btn(13) || ay > 0.6) dir = 'd';
  if (dir && (dir !== padHeld || now >= padNext)) {
    moveFocus(dir === 'l' ? -1 : dir === 'r' ? 1 : 0, dir === 'u' ? -1 : dir === 'd' ? 1 : 0);
    padNext = now + (dir === padHeld ? 90 : 260);
  }
  padHeld = dir;
  const pressed = (i: number) => btn(i) && !padButtons[i];
  if (pressed(0) || pressed(9)) (document.activeElement as HTMLElement | null)?.click();
  if (pressed(1)) back();
  padButtons = pad.buttons.map((b) => b.pressed);
}

/** Resets edge tracking so a button held from a match doesn't fire in a menu. */
export function syncPad(): void {
  const pad = pads()[0];
  padButtons = pad ? pad.buttons.map((b) => b.pressed) : [];
}
