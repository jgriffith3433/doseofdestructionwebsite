// The rebinding screen (Settings → Controls): pick an action, press the new key or button, saved at once.
// Keyboard tab: two key slots per action. Gamepad tab: one button per action, read from any connected controller.
// Clashes take the key from the other action and say so; Reset puts every default back. Hidden on touch (own layout).

import { $, h } from './dom.ts';
import { holdMenuPad } from './screens.ts';
import { padFamily, pads } from '../input/devices.ts';
import {
  KEY_ACTIONS, PAD_ACTIONS, RESERVED_KEYS, applyBindings, bindButton, bindKey, bindings, clearKey, cloneBindings, isDefault, keyName,
  padNames, resetBindings, type KeyAction, type PadAction,
} from '../input/bindings.ts';

type Tab = 'keyboard' | 'gamepad';
let tab: Tab = 'keyboard';
/** What is waiting for a press: a keyboard slot or a pad action. */
let waiting: { kind: 'key'; action: KeyAction; slot: 0 | 1 } | { kind: 'pad'; action: PadAction } | null = null;
let stopCapture: (() => void) | null = null;
let notify: (kind: string, value: string) => void = () => {};

/** Called by main.ts: where a rebind is reported (analytics, playtest). */
export function onRebind(fn: (kind: string, value: string) => void): void {
  notify = fn;
}

export const rebindOpen = (): boolean => !$('rebind').hidden;

function say(text: string, warn = false): void {
  const el = $('rebind-note');
  el.textContent = text;
  el.dataset.warn = String(warn);
}

function cancelCapture(): void {
  stopCapture?.();
  stopCapture = null;
  waiting = null;
  holdMenuPad(false);
}

function render(): void {
  const b = bindings();
  const family = padFamily();
  $('rebind-tabs').querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => t.setAttribute('aria-checked', String(t.dataset.tab === tab)));
  const rows = $('rebind-rows');
  if (tab === 'keyboard') {
    rows.replaceChildren(
      ...KEY_ACTIONS.map(({ id, label }) =>
        h('div', { class: 'rebind-row', 'data-action': id },
          h('span', { class: 'rebind-label' }, label),
          h('span', { class: 'rebind-slots' },
            ...([0, 1] as const).map((slot) => {
              const on = waiting?.kind === 'key' && waiting.action === id && waiting.slot === slot;
              const code = b.keys[id][slot];
              return h('button', {
                class: 'switch rebind-key', type: 'button', 'data-slot': slot, 'aria-label': `${label}, key ${slot + 1}: ${code ? keyName(code) : 'empty'}. Press to change.`,
                'data-waiting': on, onClick: () => begin({ kind: 'key', action: id, slot }),
              }, on ? 'Press a key…' : code ? keyName(code) : '—');
            }),
          ),
        ),
      ),
    );
    $('rebind-hint').textContent = 'Pick a slot, then press the key you want. Esc cancels. Right-click or Delete on a slot empties it.';
  } else {
    const connected = pads();
    rows.replaceChildren(
      h('p', { class: 'rebind-pads', 'data-pads': connected.length }, connected.length
        ? `${connected.length} controller${connected.length > 1 ? 's' : ''} connected. Any of them can play, and one binding covers them all.`
        : 'No controller found. Plug one in and press a button on it.'),
      ...PAD_ACTIONS.map(({ id, label }) => {
        const on = waiting?.kind === 'pad' && waiting.action === id;
        return h('div', { class: 'rebind-row', 'data-action': id },
          h('span', { class: 'rebind-label' }, label),
          h('span', { class: 'rebind-slots' },
            h('button', {
              class: 'switch rebind-key', type: 'button', 'data-slot': 0, 'aria-label': `${label}: ${padNames(b.pad[id], family)}. Press to change.`,
              'data-waiting': on, onClick: () => begin({ kind: 'pad', action: id }),
            }, on ? 'Press a button…' : padNames(b.pad[id], family)),
          ),
        );
      }),
    );
    $('rebind-hint').textContent = 'Pick an action, then press the button you want on any controller. Esc cancels. Sticks, the D-pad and Start (Pause) stay as they are.';
  }
  ($('rebind-reset') as HTMLButtonElement).disabled = isDefault(b);
}

function finish(text: string, warn: boolean, kind: string, value: string): void {
  cancelCapture();
  say(text, warn);
  render();
  notify(kind, value);
  // Focus goes back to the slot just set, so the screen stays driveable by keys and pad.
  const sel = kind === 'key' ? `[data-action="${value.split(':')[0]}"] [data-slot="${value.split(':')[1]}"]` : `[data-action="${value.split(':')[0]}"] .rebind-key`;
  $('rebind-rows').querySelector<HTMLElement>(sel)?.focus();
}

function begin(w: NonNullable<typeof waiting>): void {
  cancelCapture();
  waiting = w;
  say(w.kind === 'key' ? 'Press the new key…' : 'Press the new button…');
  render();
  $('rebind-rows').querySelector<HTMLElement>('[data-waiting="true"]')?.focus();
  const ac = new AbortController();
  stopCapture = () => ac.abort();
  if (w.kind === 'key') {
    window.addEventListener(
      'keydown',
      (e) => {
        // First in line: nothing else (menu keys, Back) sees this press.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        if (e.code === 'Escape') {
          cancelCapture();
          say('Cancelled. Nothing changed.');
          render();
          $('rebind-rows').querySelector<HTMLElement>(`[data-action="${w.action}"] [data-slot="${w.slot}"]`)?.focus();
          return;
        }
        if (RESERVED_KEYS.has(e.code)) {
          say(`${keyName(e.code)} is kept for ${e.code === 'KeyM' ? 'the sound switch' : 'Back and Pause'}. Press another key.`, true);
          return;
        }
        const next = cloneBindings(bindings());
        const clash = bindKey(next, w.action, w.slot, e.code);
        applyBindings(next);
        const label = KEY_ACTIONS.find((a) => a.id === w.action)!.label;
        finish(
          clash ? `${keyName(e.code)} was ${clash.action}. It is ${label} now, and ${clash.action} lost it.` : `${label} is ${keyName(e.code)}.`,
          !!clash, 'key', `${w.action}:${w.slot}:${e.code}`,
        );
      },
      { capture: true, signal: ac.signal },
    );
    return;
  }
  // A button on any controller: wait for a press that wasn't already down when the capture began.
  holdMenuPad(true);
  let down = new Set<string>();
  for (const p of pads()) p.buttons.forEach((bt, i) => bt.pressed && down.add(`${p.index}:${i}`));
  let raf = 0;
  const poll = () => {
    const now = new Set<string>();
    let hit = -1;
    for (const p of pads()) {
      p.buttons.forEach((bt, i) => {
        if (!bt.pressed) return;
        const k = `${p.index}:${i}`;
        now.add(k);
        if (!down.has(k) && hit < 0 && i !== 9) hit = i;
      });
    }
    down = now;
    if (hit >= 0) {
      const next = cloneBindings(bindings());
      const clash = bindButton(next, w.action, hit);
      applyBindings(next);
      const label = PAD_ACTIONS.find((a) => a.id === w.action)!.label;
      const name = padNames([hit], padFamily());
      finish(clash ? `${name} was ${clash.action}. It is ${label} now, and ${clash.action} lost it.` : `${label} is ${name}.`, !!clash, 'pad', `${w.action}:${hit}`);
      return;
    }
    raf = requestAnimationFrame(poll);
  };
  raf = requestAnimationFrame(poll);
  ac.signal.addEventListener('abort', () => cancelAnimationFrame(raf));
}

export function openRebind(): void {
  tab = 'keyboard';
  say('');
  render();
  $('rebind').hidden = false;
}

export function closeRebind(): void {
  cancelCapture();
  $('rebind').hidden = true;
}

/** Esc / B while the screen is up: cancels a pending press first, else closes. Returns true when it closed. */
export function backRebind(): boolean {
  if (waiting) {
    cancelCapture();
    say('Cancelled. Nothing changed.');
    render();
    return false;
  }
  closeRebind();
  return true;
}

export function wireRebind(onClose: () => void): void {
  $('rebind-tabs').querySelectorAll<HTMLElement>('[data-tab]').forEach((t) =>
    t.addEventListener('click', () => {
      cancelCapture();
      tab = t.dataset.tab as Tab;
      say('');
      render();
    }),
  );
  $('rebind-rows').addEventListener('contextmenu', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.rebind-key');
    if (!btn || tab !== 'keyboard') return;
    e.preventDefault();
    clearSlot(btn);
  });
  $('rebind-rows').addEventListener('keydown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.rebind-key');
    if (btn && tab === 'keyboard' && !waiting && (e.code === 'Delete' || e.code === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      clearSlot(btn);
    }
  }, true);
  $('rebind-reset').addEventListener('click', () => {
    cancelCapture();
    resetBindings();
    say('Back to the defaults.');
    render();
    notify('reset', '');
  });
  $('rebind-done').addEventListener('click', () => {
    closeRebind();
    onClose();
  });
}

function clearSlot(btn: HTMLElement): void {
  const row = btn.closest<HTMLElement>('.rebind-row');
  const action = row?.dataset.action as KeyAction | undefined;
  if (!action) return;
  const next = cloneBindings(bindings());
  if (!clearKey(next, action, Number(btn.dataset.slot) as 0 | 1)) {
    say('Every action keeps at least one key.', true);
    return;
  }
  applyBindings(next);
  say(`${KEY_ACTIONS.find((a) => a.id === action)!.label}: slot emptied.`);
  render();
  notify('clear', action);
  row?.querySelector<HTMLElement>(`[data-slot="${btn.dataset.slot}"]`)?.focus();
}
