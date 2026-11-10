// On-screen touch controls for coarse-pointer devices: a left-thumb stick, right-thumb buttons and a pause button.

import { BTN } from '../sim/input.ts';
import { onTouchSettings, touchSettings, touchUiForced, type TouchSettings } from '../touchSettings.ts';

/** Pointer capture keeps a drag on its control, but a pointer that is already gone (or a synthetic one) throws: play on. */
const capture = (el: Element, id: number) => {
  try {
    el.setPointerCapture(id);
  } catch {
    // Not an active pointer: the control still works from its own events.
  }
};

const BUTTONS: { label: string; bit: number; cls: string }[] = [
  { label: 'Jump', bit: BTN.JUMP, cls: 'jump' },
  { label: 'Attack', bit: BTN.ATTACK, cls: 'attack' },
  { label: 'Special', bit: BTN.SPECIAL, cls: 'special' },
  { label: 'Shield', bit: BTN.SHIELD, cls: 'shield' },
  { label: 'Smash', bit: BTN.C_NEUTRAL, cls: 'smash' },
];

/** How far the knob travels, as a share of the stick's width (50px of the original 128px). */
const STICK_REACH = 50 / 128;
let root: HTMLElement | null = null;
let stickX = 0;
let stickY = 0;
let buttons = 0;
let lastTouchEventAt = 0;

/** Returns and clears the timestamp of the most recent touch pointer event. */
export function consumeTouchEventAt(): number {
  const t = lastTouchEventAt;
  lastTouchEventAt = 0;
  return t;
}

export function touchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

/** Builds the overlay once. On non-touch devices it stays hidden unless force-shown by a playtest. */
export function initTouchControls(onPause: () => void, forceBuild = false): void {
  if (root || (!touchDevice() && !forceBuild)) return;
  root = document.createElement('div');
  root.className = 'touch';
  root.hidden = true;
  // Touch size and opacity (Settings): CSS variables on the overlay, applied now and on every change.
  const target = root;
  const applyLook = (t: TouchSettings) => {
    target.style.setProperty('--touch-scale', String(t.size / 100));
    target.style.setProperty('--touch-opacity', String(t.opacity / 100));
  };
  applyLook(touchSettings());
  onTouchSettings(applyLook);

  const stick = document.createElement('div');
  stick.className = 'touch-stick';
  stick.setAttribute('aria-label', 'Move');
  const knob = document.createElement('div');
  knob.className = 'touch-knob';
  stick.append(knob);
  let stickId = -1;
  const moveStick = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    const STICK_RADIUS = r.width * STICK_REACH;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = Math.round((dx / STICK_RADIUS) * 100);
    const ny = Math.round((-dy / STICK_RADIUS) * 100);
    const prevSx = Math.abs(stickX) > 20 ? Math.sign(stickX) : 0;
    const prevSy = Math.abs(stickY) > 60 ? Math.sign(stickY) : 0;
    const nextSx = Math.abs(nx) > 20 ? Math.sign(nx) : 0;
    const nextSy = Math.abs(ny) > 60 ? Math.sign(ny) : 0;
    if ((nextSx !== 0 && nextSx !== prevSx) || (nextSy !== 0 && nextSy !== prevSy)) {
      lastTouchEventAt = performance.now();
    }
    stickX = nx;
    stickY = ny;
  };
  const releaseStick = () => {
    stickId = -1;
    stickX = 0;
    stickY = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stickId = e.pointerId;
    capture(stick, e.pointerId);
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) moveStick(e);
  });
  stick.addEventListener('pointerup', (e) => e.pointerId === stickId && releaseStick());
  stick.addEventListener('pointercancel', (e) => e.pointerId === stickId && releaseStick());

  const pad = document.createElement('div');
  pad.className = 'touch-buttons';
  for (const b of BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `touch-btn ${b.cls}`;
    el.textContent = b.label;
    const ids = new Set<number>();
    const sync = () => {
      buttons = ids.size ? buttons | b.bit : buttons & ~b.bit;
      el.classList.toggle('down', ids.size > 0);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      lastTouchEventAt = performance.now();
      capture(el, e.pointerId);
      ids.add(e.pointerId);
      sync();
    });
    const up = (e: PointerEvent) => {
      ids.delete(e.pointerId);
      sync();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.append(el);
  }

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'touch-pause';
  pause.textContent = 'Pause';
  pause.addEventListener('click', onPause);

  root.append(stick, pad, pause);
  document.body.append(root);

  // iOS Safari ignores user-scalable=no: stop double-tap zoom on the controls and pinch zoom on the page.
  let lastTap = 0;
  root.addEventListener(
    'touchend',
    (e) => {
      const now = e.timeStamp;
      if (now - lastTap < 350) e.preventDefault();
      lastTap = now;
    },
    { passive: false },
  );
  root.addEventListener('dblclick', (e) => e.preventDefault());
  for (const type of ['gesturestart', 'gesturechange'])
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

export function showTouchControls(show: boolean): void {
  // Playtests can force the overlay on a desktop browser (touchUiForced); real phones use touchDevice().
  if (!root || (!touchDevice() && !touchUiForced() && show)) return;
  root.hidden = !show;
  if (!show) {
    stickX = 0;
    stickY = 0;
    buttons = 0;
    root.querySelectorAll('.touch-btn.down').forEach((el) => el.classList.remove('down'));
    (root.querySelector('.touch-knob') as HTMLElement).style.transform = '';
  }
}

export function touchOverlay(): HTMLElement | null {
  return root;
}

/** The touch controls' current stick and buttons. */
export function readTouch(): [number, number, number] {
  return [stickX, stickY, buttons];
}
