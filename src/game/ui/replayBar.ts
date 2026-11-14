// The replay's control bar (Results → Watch replay): Pause, back 5 s, 0.5x / 1x / 2x, Camera (Follow / Free) and Exit,
// along the bottom of the arena. Every button is at least 48 px tall and wide enough for a thumb; on a phone the bar
// wraps into two rows inside the safe area. A tap on the arena (not a drag) hides or shows the bar. In Free camera a
// drag pans the camera and the mouse wheel zooms it. Keys: Space pauses, 1 / 2 / 3 pick the speed, C the camera,
// Left goes back 5 s, Esc leaves. The playtest reads `dod:replay` events (phase, speed, camera, paused, tick).

import type { ReplayCameraMode, ReplaySpeed } from '../replay.ts';
import { formatTime, h } from './dom.ts';

export interface ReplayBarEnv {
  /** Total ticks and the current tick (the clock label). */
  total(): number;
  tick(): number;
  paused(): boolean;
  speed(): ReplaySpeed;
  camera(): ReplayCameraMode;
  togglePause(): void;
  setSpeed(s: ReplaySpeed): void;
  toggleCamera(): void;
  back(seconds: number): void;
  exit(): void;
  /** Free camera drag, in screen pixels, and zoom steps (+ out, - in). */
  pan(dxPx: number, dyPx: number): void;
  zoom(step: number): void;
}

export interface ReplayBar {
  root: HTMLElement;
  /** Refresh labels (call each frame; cheap). */
  update(): void;
  hidden(): boolean;
  destroy(): void;
}

const SPEEDS: ReplaySpeed[] = [0.5, 1, 2];

export function emit(phase: string, detail: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent('dod:replay', { detail: { phase, ...detail } }));
}

export function openReplayBar(env: ReplayBarEnv, canvas: HTMLElement): ReplayBar {
  const btn = (label: string, id: string, run: () => void, extra: Record<string, string> = {}): HTMLButtonElement =>
    h('button', { type: 'button', class: 'secondary replay-btn', id: `replay-${id}`, 'data-replay': id, ...extra, onclick: () => run() }, label);

  const pause = btn('Pause', 'pause', () => env.togglePause());
  const back = btn('-5 s', 'back', () => env.back(5));
  const speeds = SPEEDS.map((s) => btn(`${s}x`, `speed-${s}`, () => env.setSpeed(s), { 'data-speed': String(s) }));
  const cam = btn('Camera: Follow', 'camera', () => env.toggleCamera());
  const exit = btn('Back to results', 'exit', () => env.exit());
  exit.classList.replace('secondary', 'primary');
  const clock = h('span', { class: 'replay-clock', id: 'replay-clock', 'aria-live': 'off' }, '0:00');

  const bar = h('div', { class: 'replay-bar', id: 'replay-bar', role: 'toolbar', 'aria-label': 'Replay controls' },
    h('div', { class: 'replay-row' }, pause, back, ...speeds),
    h('div', { class: 'replay-row' }, cam, exit),
  );
  const tag = h('div', { class: 'replay-tag', id: 'replay-tag' }, h('b', {}, 'Replay'), clock);
  const root = h('div', { class: 'replay', id: 'replay' }, tag, bar);
  document.body.append(root);
  document.body.classList.add('replaying');

  // Tap the arena to hide or show the bar; a drag in Free camera pans instead.
  let down: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean } | null = null;
  const onDown = (e: PointerEvent): void => {
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  };
  const onMove = (e: PointerEvent): void => {
    if (!down || e.pointerId !== down.id) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) down.moved = true;
    if (down.moved && env.camera() === 'free') env.pan(e.clientX - down.lx, e.clientY - down.ly);
    down.lx = e.clientX;
    down.ly = e.clientY;
  };
  const onUp = (e: PointerEvent): void => {
    if (!down || e.pointerId !== down.id) return;
    const tapped = !down.moved;
    down = null;
    if (tapped) {
      root.classList.toggle('bar-hidden');
      document.body.classList.toggle('replay-bar-off', root.classList.contains('bar-hidden'));
      emit('bar', { hidden: root.classList.contains('bar-hidden') });
    }
  };
  const onWheel = (e: WheelEvent): void => {
    if (env.camera() === 'free') env.zoom(e.deltaY > 0 ? 1 : -1);
  };
  const onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === 'Escape') env.exit();
    else if (k === ' ') env.togglePause();
    else if (k === '1') env.setSpeed(0.5);
    else if (k === '2') env.setSpeed(1);
    else if (k === '3') env.setSpeed(2);
    else if (k === 'c' || k === 'C') env.toggleCamera();
    else if (k === 'ArrowLeft') env.back(5);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('keydown', onKey, true);

  let shown = '';
  const update = (): void => {
    const p = env.paused();
    const key = `${p}|${env.speed()}|${env.camera()}|${Math.floor(env.tick() / 60)}`;
    if (key === shown) return;
    shown = key;
    pause.textContent = p ? 'Play' : 'Pause';
    pause.setAttribute('aria-pressed', String(p));
    for (const b of speeds) {
      const on = Number(b.dataset.speed) === env.speed();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    cam.textContent = env.camera() === 'free' ? 'Camera: Free' : 'Camera: Follow';
    cam.setAttribute('aria-pressed', String(env.camera() === 'free'));
    clock.textContent = `${formatTime(env.tick())} / ${formatTime(env.total())}`;
  };

  return {
    root,
    update,
    hidden: () => root.classList.contains('bar-hidden'),
    destroy: () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      document.body.classList.remove('replaying', 'replay-bar-off');
    },
  };
}
