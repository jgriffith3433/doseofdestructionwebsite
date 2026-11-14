// Screens, the wipe between them, and menu navigation with keyboard or gamepad.
//
// Each screen is a <section class="screen" id="..."> in the page. Only one is
// shown at a time; go() covers the switch with the show's stinger.

import { pads, scanPads } from '../input/devices.ts';
import { audio } from '../audio.ts';
import { screen as trackScreen } from '../analytics.ts';
import { startStinger } from './stinger.ts';
import { flashPressed } from './dom.ts';
import { hintText } from './teach.ts';

export type ScreenId =
  | 'title' | 'main' | 'select' | 'stages' | 'versus' | 'campaign' | 'tour' | 'extras' | 'howto' | 'results' | 'match' | 'leaderboard';

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

/** Switches screens behind the show's stinger (ui/stinger.ts). The callback runs while the screen is covered. */
export async function go(id: ScreenId, whileCovered?: () => void | Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  const first = current === null;
  const from = current ?? 'none';
  const st = first ? null : startStinger(from, id);
  await st?.covered;
  try {
    await whileCovered?.();
  } finally {
    show(id);
    await st?.open();
    busy = false;
  }
  focusFirst();
}

function show(id: ScreenId): void {
  current = id;
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    el.hidden = el.id !== id;
  });
  document.body.dataset.screen = id;
  // Hints written with control tokens (`data-hint`) read for the device in hand when the screen opens.
  document.querySelectorAll<HTMLElement>(`#${id} [data-hint]`).forEach((el) => {
    el.textContent = hintText(el.dataset.hint ?? '');
  });
  trackScreen(id);
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
  preferred?.focus({ preventScroll: true });
}

const MOVE_SOUND_GAP_MS = 70;
let lastMoveSound = -Infinity;

/** Marks that keys or a pad drive the menu (game.css draws the focus ring on whatever has focus); a mouse or finger clears it. */
function setNav(on: boolean): void {
  if (on) document.body.dataset.nav = '1';
  else delete document.body.dataset.nav;
}
let navListening = false;
function listenNav(): void {
  if (navListening) return;
  navListening = true;
  window.addEventListener('keydown', () => setNav(true), true);
  window.addEventListener('pointerdown', () => setNav(false), true);
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
  // Holding a direction repeats fast: the tick is throttled, so it never turns into a buzz.
  const now = performance.now();
  if (best && now - lastMoveSound >= MOVE_SOUND_GAP_MS) {
    lastMoveSound = now;
    audio.sfx('ui-move');
  }
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
  listenNav();
  window.addEventListener('keydown', (e) => {
    if (inMatch() || busy) return;
    // Another player's pause: the keyboard belongs to player 1 and stands down.
    if (menuOwner !== null && menuOwner !== 0) return;
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
      const el = document.activeElement as HTMLElement | null;
      flashPressed(el);
      el?.click();
    }
  });
}

/**
 * Couch pause: while someone's pause menu is up, only that person's devices move it. `slot` is the player who paused
 * (null = no owner, every device works); slot 0 owns the keyboard and the pads nobody else holds.
 */
let menuOwner: number | null = null;
let ownerSlotOf: (p: Gamepad) => number = () => 0;
export function setMenuOwner(slot: number | null, slotOfPad?: (p: Gamepad) => number): void {
  menuOwner = slot;
  if (slotOfPad) ownerSlotOf = slotOfPad;
}

// Gamepad menu controls, polled from the main loop.
let padHeld = '';
let padNext = 0;
let padButtons: boolean[] = [];

/** The rebinding screen is listening for a button: the menu pad stands down so the press isn't also a menu press. */
let padHeldBack = false;
export function holdMenuPad(on: boolean): void {
  padHeldBack = on;
  if (!on) syncPad();
}

/** Versus select's joining pads: `skip` pads belong to another player and don't drive the menu; `noStart` pads' Start joins instead of pressing. */
let menuPadRules: { skip: (p: Gamepad) => boolean; noStart: (p: Gamepad) => boolean } | null = null;
export function setMenuPadRules(r: typeof menuPadRules): void {
  menuPadRules = r;
}

export function pollMenuPad(now: number): void {
  if (busy || padHeldBack) return;
  scanPads();
  // Any connected controller can drive the menus: the one in use right now, else the first.
  const all = (menuOwner === null ? pads() : pads().filter((p) => ownerSlotOf(p) === menuOwner)).filter((p) => !menuPadRules?.skip(p));
  const pad = all.find((p) => p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5)) ?? all[0];
  if (!pad) return;
  listenNav();
  const ax = pad.axes[0] ?? 0;
  const ay = pad.axes[1] ?? 0;
  const btn = (i: number) => !!pad.buttons[i]?.pressed;
  let dir = '';
  if (btn(14) || ax < -0.6) dir = 'l';
  else if (btn(15) || ax > 0.6) dir = 'r';
  else if (btn(12) || ay < -0.6) dir = 'u';
  else if (btn(13) || ay > 0.6) dir = 'd';
  if (dir || pad.buttons.some((b, i) => b.pressed && !padButtons[i])) setNav(true);
  if (dir && (dir !== padHeld || now >= padNext)) {
    moveFocus(dir === 'l' ? -1 : dir === 'r' ? 1 : 0, dir === 'u' ? -1 : dir === 'd' ? 1 : 0);
    padNext = now + (dir === padHeld ? 90 : 260);
  }
  padHeld = dir;
  const pressed = (i: number) => btn(i) && !padButtons[i];
  if (pressed(0) || (pressed(9) && !menuPadRules?.noStart(pad))) {
    const el = document.activeElement as HTMLElement | null;
    flashPressed(el);
    el?.click();
  }
  if (pressed(1)) back();
  padButtons = pad.buttons.map((b) => b.pressed);
}

/** Resets edge tracking so a button held from a match doesn't fire in a menu. */
export function syncPad(): void {
  const all = (menuOwner === null ? pads() : pads().filter((p) => ownerSlotOf(p) === menuOwner)).filter((p) => !menuPadRules?.skip(p));
  const pad = all.find((p) => p.buttons.some((b) => b.pressed)) ?? all[0];
  padButtons = pad ? pad.buttons.map((b) => b.pressed) : [];
}
