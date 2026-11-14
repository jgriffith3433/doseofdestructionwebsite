// On-screen touch controls for coarse-pointer devices: a floating left-thumb stick
// (spawns under the thumb in the left 40%, follows past its edge, flick-up jumps),
// right-thumb icon buttons in a thumb arc, and a pause button.

import { BTN } from '../sim/input.ts';
import { onShieldLatch, shieldLatched } from './shieldMode.ts';
import { onTouchSettings, touchSettings, touchUiForced, type TouchSettings } from '../touchSettings.ts';

/** Pointer capture keeps a drag on its control, but a pointer that is already gone (or a synthetic one) throws: play on. */
const capture = (el: Element, id: number) => {
  try {
    el.setPointerCapture(id);
  } catch {
    // Not an active pointer: the control still works from its own events.
  }
};

const BUTTONS: { label: string; bit: number; cls: string; icon: string }[] = [
  {
    label: 'Jump',
    bit: BTN.JUMP,
    cls: 'jump',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l7 8h-4v8h-6v-8H5l7-8z"/></svg>',
  },
  {
    label: 'Attack',
    bit: BTN.ATTACK,
    cls: 'attack',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/></svg>',
  },
  {
    label: 'Special',
    bit: BTN.SPECIAL,
    cls: 'special',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.4H19l-4.2 3.2 1.6 5.4L12 13.8 7.6 17l1.6-5.4L5 8.4h5.2z"/></svg>',
  },
  {
    label: 'Shield',
    bit: BTN.SHIELD,
    cls: 'shield',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5.2-3.4 9.8-8 11-4.6-1.2-8-5.8-8-11V5l8-3z"/></svg>',
  },
  {
    label: 'Smash',
    bit: BTN.C_NEUTRAL,
    cls: 'smash',
    // Burst / impact (not a star) so Smash stays distinct from Special.
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h6l-1 8 11-14h-7l0-6z"/></svg>',
  },
];

/** How far the knob travels, as a share of the stick's width (50px of the original 128px). */
const STICK_REACH = 50 / 128;
/** Left side of the screen that owns the floating stick (and flick-jump). */
const LEFT_ZONE = 0.4;
/** Quick upward flick on the left: max hold time and min upward travel (CSS px). */
const FLICK_MS = 200;
const FLICK_DY = 36;
/** Frames-worth of jump bit after a flick (~100 ms at 60 Hz presentation). */
const FLICK_JUMP_MS = 120;

let root: HTMLElement | null = null;
let stickEl: HTMLElement | null = null;
let knobEl: HTMLElement | null = null;
let stickX = 0;
let stickY = 0;
let buttons = 0;
let lastTouchEventAt = 0;
let stickCenterX = 0;
let stickCenterY = 0;
let stickId = -1;
let stickActive = false;
let flickOriginX = 0;
let flickOriginY = 0;
let flickAt = 0;
let flickJumpUntil = 0;

/** Returns and clears the timestamp of the most recent touch pointer event. */
export function consumeTouchEventAt(): number {
  const t = lastTouchEventAt;
  lastTouchEventAt = 0;
  return t;
}

export function touchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

const stickRadius = (): number => {
  if (!stickEl) return 50;
  return stickEl.getBoundingClientRect().width * STICK_REACH;
};

const placeStick = (cx: number, cy: number): void => {
  if (!stickEl) return;
  const r = stickEl.getBoundingClientRect();
  const w = r.width || 128;
  const h = r.height || w;
  stickCenterX = cx;
  stickCenterY = cy;
  stickEl.style.left = `${cx - w / 2}px`;
  stickEl.style.top = `${cy - h / 2}px`;
  stickEl.style.bottom = 'auto';
  stickEl.style.right = 'auto';
};

const setKnob = (dx: number, dy: number): void => {
  if (!knobEl) return;
  knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
};

const applyStickAxes = (dx: number, dy: number, radius: number): void => {
  const nx = Math.round((dx / radius) * 100);
  const ny = Math.round((-dy / radius) * 100);
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

const resetStickHome = (): void => {
  if (!stickEl) return;
  stickEl.classList.remove('active', 'floating');
  stickEl.style.left = '';
  stickEl.style.top = '';
  stickEl.style.bottom = '';
  stickEl.style.right = '';
  setKnob(0, 0);
  stickActive = false;
  stickId = -1;
  stickX = 0;
  stickY = 0;
};

const moveStickPointer = (e: PointerEvent): void => {
  if (!stickEl) return;
  const radius = stickRadius();
  let dx = e.clientX - stickCenterX;
  let dy = e.clientY - stickCenterY;
  let len = Math.hypot(dx, dy);
  // Thumb past the edge: the stick base follows so the knob stays at the rim (Brawl Stars / Shadow Fight).
  if (len > radius && radius > 0) {
    const excess = len - radius;
    stickCenterX += (dx / len) * excess;
    stickCenterY += (dy / len) * excess;
    // Keep the stick inside the window and clear of the right-thumb zone.
    const half = stickEl.getBoundingClientRect().width / 2;
    const maxX = innerWidth * LEFT_ZONE + half;
    stickCenterX = Math.min(maxX, Math.max(half, stickCenterX));
    stickCenterY = Math.min(innerHeight - half, Math.max(half, stickCenterY));
    placeStick(stickCenterX, stickCenterY);
    dx = e.clientX - stickCenterX;
    dy = e.clientY - stickCenterY;
    len = Math.hypot(dx, dy);
  }
  if (len > radius && radius > 0) {
    dx = (dx / len) * radius;
    dy = (dy / len) * radius;
  }
  setKnob(dx, dy);
  applyStickAxes(dx, dy, radius || 1);
};

const beginStick = (e: PointerEvent, floating: boolean): void => {
  if (!stickEl) return;
  e.preventDefault();
  stickId = e.pointerId;
  stickActive = true;
  flickAt = performance.now();
  flickOriginX = e.clientX;
  flickOriginY = e.clientY;
  stickEl.classList.add('active');
  if (floating) {
    stickEl.classList.add('floating');
    placeStick(e.clientX, e.clientY);
  } else {
    const r = stickEl.getBoundingClientRect();
    stickCenterX = r.left + r.width / 2;
    stickCenterY = r.top + r.height / 2;
  }
  capture(stickEl, e.pointerId);
  moveStickPointer(e);
};

const endStick = (e: PointerEvent): void => {
  if (e.pointerId !== stickId) return;
  const held = performance.now() - flickAt;
  const up = flickOriginY - e.clientY;
  const sideways = Math.abs(e.clientX - flickOriginX);
  // Quick upward flick on the left: jump, Jump button still works the same way.
  if (held <= FLICK_MS && up >= FLICK_DY && up > sideways * 0.85) {
    buttons |= BTN.JUMP;
    lastTouchEventAt = performance.now();
    flickJumpUntil = performance.now() + FLICK_JUMP_MS;
    window.setTimeout(() => {
      if (performance.now() >= flickJumpUntil) buttons &= ~BTN.JUMP;
    }, FLICK_JUMP_MS + 16);
  }
  resetStickHome();
};

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
  stickEl = stick;
  knobEl = knob;

  // Invisible left-40% hit zone (the overlay itself is pointer-events:none; only children receive).
  const zone = document.createElement('div');
  zone.className = 'touch-move-zone';
  zone.setAttribute('aria-hidden', 'true');

  const onStickMove = (e: PointerEvent) => {
    if (e.pointerId === stickId && stickActive) moveStickPointer(e);
  };
  const onStickEnd = (e: PointerEvent) => {
    if (e.pointerId === stickId) endStick(e);
  };

  stick.addEventListener('pointerdown', (e) => {
    if (stickId >= 0) return;
    beginStick(e, false);
  });
  stick.addEventListener('pointermove', onStickMove);
  stick.addEventListener('pointerup', onStickEnd);
  stick.addEventListener('pointercancel', onStickEnd);

  zone.addEventListener('pointerdown', (e) => {
    if (stickId >= 0) return;
    beginStick(e, true);
  });
  // Capture is on the stick, but synthetic playtest events may keep targeting the zone.
  zone.addEventListener('pointermove', onStickMove);
  zone.addEventListener('pointerup', onStickEnd);
  zone.addEventListener('pointercancel', onStickEnd);

  const pad = document.createElement('div');
  pad.className = 'touch-buttons';
  for (const b of BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `touch-btn ${b.cls}`;
    el.setAttribute('aria-label', b.label);
    el.innerHTML = b.icon;
    const ids = new Set<number>();
    const sync = () => {
      // Flick jump may hold JUMP briefly without the Jump button down.
      const fromBtn = ids.size > 0;
      if (fromBtn) buttons |= b.bit;
      else if (!(b.bit === BTN.JUMP && performance.now() < flickJumpUntil)) buttons &= ~b.bit;
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
    if (b.bit === BTN.SHIELD) {
      // Toggle: the button stays lit (and reads as pressed to assistive tech) while the shield is latched up.
      const showLatch = (on: boolean) => {
        el.classList.toggle('latched', on);
        el.setAttribute('aria-pressed', String(on));
      };
      showLatch(shieldLatched());
      onShieldLatch(showLatch);
    }
    pad.append(el);
  }

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'touch-pause';
  pause.setAttribute('aria-label', 'Pause');
  pause.textContent = 'Pause';
  pause.addEventListener('click', onPause);

  root.append(zone, stick, pad, pause);
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
  // CSS keys off this (not only `pointer: coarse`, which an emulated or hybrid phone may not report).
  document.body.classList.toggle('touch-ui', show);
  if (!show) {
    resetStickHome();
    buttons = 0;
    flickJumpUntil = 0;
    root.querySelectorAll('.touch-btn.down').forEach((el) => el.classList.remove('down'));
  }
}

export function touchOverlay(): HTMLElement | null {
  return root;
}

/** The touch controls' current stick and buttons. */
export function readTouch(): [number, number, number] {
  if (flickJumpUntil && performance.now() >= flickJumpUntil) {
    flickJumpUntil = 0;
    buttons &= ~BTN.JUMP;
  }
  return [stickX, stickY, buttons];
}
