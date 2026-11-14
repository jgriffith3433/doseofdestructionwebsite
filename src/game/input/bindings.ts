/**
 * Rebindable controls (Settings → Controls). Pure data and rules: no DOM, so `test/bindings.test.ts` runs it in node.
 *
 * Keyboard: each action has two key slots (the defaults keep WASD + arrows). Gamepad: each action has a list of
 * standard-mapping button indexes (the defaults keep Shield on all four bumpers and triggers); pressing a new button
 * in the rebind screen replaces the list. Sticks, the D-pad's left/right and Escape / Start for Pause stay fixed.
 * Saved in localStorage "dod.bindings" (one JSON, the same for every pad), so a rebind survives a reload.
 */

export type KeyAction = 'left' | 'right' | 'up' | 'down' | 'jump' | 'attack' | 'special' | 'shield' | 'smash' | 'taunt';
export type PadAction = 'jump' | 'attack' | 'special' | 'shield' | 'taunt';

export const KEY_ACTIONS: { id: KeyAction; label: string }[] = [
  { id: 'left', label: 'Move left' },
  { id: 'right', label: 'Move right' },
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
  { id: 'jump', label: 'Jump' },
  { id: 'attack', label: 'Attack' },
  { id: 'special', label: 'Special' },
  { id: 'shield', label: 'Shield / dodge' },
  { id: 'smash', label: 'Smash' },
  { id: 'taunt', label: 'Taunt' },
];

export const PAD_ACTIONS: { id: PadAction; label: string }[] = [
  { id: 'jump', label: 'Jump' },
  { id: 'attack', label: 'Attack' },
  { id: 'special', label: 'Special' },
  { id: 'shield', label: 'Shield / dodge' },
  { id: 'taunt', label: 'Taunt' },
];

export interface Bindings {
  /** Two key codes (KeyboardEvent.code) per action; '' is an empty slot. */
  keys: Record<KeyAction, [string, string]>;
  /** Button indexes per action. */
  pad: Record<PadAction, number[]>;
}

export const DEFAULT_BINDINGS: Bindings = {
  keys: {
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    jump: ['Space', 'KeyU'],
    attack: ['KeyJ', ''],
    special: ['KeyK', ''],
    shield: ['KeyL', ''],
    smash: ['KeyI', ''],
    taunt: ['KeyT', ''],
  },
  pad: { jump: [2, 3], attack: [0], special: [1], shield: [4, 5, 6, 7], taunt: [12] },
};

export const cloneBindings = (b: Bindings): Bindings => JSON.parse(JSON.stringify(b)) as Bindings;

/** Keys that can't be bound: Escape is Back / Pause, M is the sound switch. */
export const RESERVED_KEYS = new Set(['Escape', 'KeyM']);

const KEY = 'dod.bindings';
let current: Bindings = load();
const listeners = new Set<(b: Bindings) => void>();

function sane(raw: unknown): Bindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  const r = raw as Partial<Bindings> | null;
  if (!r || typeof r !== 'object') return out;
  for (const { id } of KEY_ACTIONS) {
    const v = r.keys?.[id];
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string' && !RESERVED_KEYS.has(x))) out.keys[id] = [v[0], v[1]];
  }
  for (const { id } of PAD_ACTIONS) {
    const v = r.pad?.[id];
    if (Array.isArray(v) && v.length <= 8 && v.every((x) => Number.isInteger(x) && x >= 0 && x < 17 && x !== 9)) out.pad[id] = [...v];
  }
  return out;
}

function load(): Bindings {
  try {
    return sane(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return cloneBindings(DEFAULT_BINDINGS);
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage can be blocked: the choice lasts for this visit.
  }
  for (const fn of listeners) fn(current);
}

export const bindings = (): Bindings => current;
export const onBindings = (fn: (b: Bindings) => void): (() => boolean) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Whether anything differs from the defaults. */
export const isDefault = (b: Bindings = current): boolean => JSON.stringify(b) === JSON.stringify(DEFAULT_BINDINGS);

export interface Clash {
  /** The other action that had the key or button and lost it. */
  action: string;
}

/** Puts `code` on a key slot. A key another action had is taken from it (the clash is returned for the warning). */
export function bindKey(b: Bindings, action: KeyAction, slot: 0 | 1, code: string): Clash | null {
  if (RESERVED_KEYS.has(code) || !code) return null;
  let clash: Clash | null = null;
  const old = b.keys[action][slot];
  for (const { id, label } of KEY_ACTIONS) {
    for (const s of [0, 1] as const) {
      if (b.keys[id][s] !== code) continue;
      if (id === action && s === slot) continue;
      b.keys[id][s] = '';
      if (id !== action) clash = { action: label };
    }
  }
  b.keys[action][slot] = code;
  // An action never ends up with no key at all: one that lost its last key takes the key just freed (a swap),
  // else a default nobody is using.
  const used = new Set(KEY_ACTIONS.flatMap(({ id }) => b.keys[id]));
  for (const { id } of KEY_ACTIONS) {
    if (b.keys[id][0] || b.keys[id][1]) continue;
    const free = [old, ...DEFAULT_BINDINGS.keys[id]].find((k) => k && !used.has(k));
    if (free) {
      b.keys[id][0] = free;
      used.add(free);
    }
  }
  return clash;
}

/** Clears a key slot, unless it is the action's only key. */
export function clearKey(b: Bindings, action: KeyAction, slot: 0 | 1): boolean {
  if (!b.keys[action][slot] || !b.keys[action][slot ? 0 : 1]) return false;
  b.keys[action][slot] = '';
  return true;
}

/** Puts a button on a pad action (replacing its list); the action that had it loses it. */
export function bindButton(b: Bindings, action: PadAction, index: number): Clash | null {
  if (index === 9 || index < 0) return null;
  let clash: Clash | null = null;
  const old = b.pad[action];
  for (const { id, label } of PAD_ACTIONS) {
    if (id === action) continue;
    const had = b.pad[id].includes(index);
    if (!had) continue;
    b.pad[id] = b.pad[id].filter((x) => x !== index);
    // The action that lost its only button takes the one just freed (a swap), so it can still be played.
    if (b.pad[id].length === 0) b.pad[id] = old.filter((x) => x !== index).slice(0, 1);
    if (b.pad[id].length === 0) b.pad[id] = DEFAULT_BINDINGS.pad[id].filter((x) => x !== index).slice(0, 1);
    clash = { action: label };
  }
  b.pad[action] = [index];
  return clash;
}

export function applyBindings(b: Bindings): void {
  current = sane(b);
  save();
}

export function resetBindings(): void {
  current = cloneBindings(DEFAULT_BINDINGS);
  save();
}

// ------------------------------------------------------------------ names

const KEY_NAMES: Record<string, string> = {
  Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Tab: 'Tab',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
  Backspace: 'Backspace', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
};

/** A key code as the player reads it (KeyJ → J, Digit1 → 1, ArrowLeft → ←). */
export function keyName(code: string): string {
  if (!code) return 'None';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

export type NamedPadFamily = 'xbox' | 'playstation' | 'switch';

const PAD_LABELS: Record<NamedPadFamily, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'PS'],
  switch: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '-', '+', 'L stick', 'R stick', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'],
};

export function padButtonName(index: number, family: NamedPadFamily): string {
  return PAD_LABELS[family][index] ?? `Button ${index}`;
}

/** The buttons of an action as the player reads them: "X / Y". */
export function padNames(list: number[], family: NamedPadFamily): string {
  return list.length ? list.map((i) => padButtonName(i, family)).join(' / ') : 'None';
}

/** The keys of an action as the player reads them: "A / ←". */
export function keyNames(slots: [string, string]): string {
  const n = slots.filter(Boolean).map(keyName);
  return n.length ? n.join(' / ') : 'None';
}
