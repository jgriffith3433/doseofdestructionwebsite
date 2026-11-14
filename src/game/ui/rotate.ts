// "Rotate your phone": on a touch device held upright the fighter is too small to play, so a full-screen
// prompt covers the game and the match waits (main.ts reads `rotateShowing()` in its loop). It follows the
// orientation media query (no polling) and goes away by itself when the phone turns to landscape.
// Fullscreen asks the browser for a landscape lock where it has one (Android Chrome); iOS Safari has none and
// keeps working: the lock is always inside try/catch.

import { touchDevice } from '../input/touch.ts';

let el: HTMLElement | null = null;
let showing = false;
let forced = false;
let suppressed = false;
const listeners: Array<(showing: boolean) => void> = [];

/** The playtest bot runs on a desktop browser: it asks to be treated as a touch device for this check. */
export function forceTouchPrompt(on: boolean): void {
  forced = on;
  sync();
}

/** Suppresses the rotate prompt (e.g. while watching a replay in portrait or running a portrait replay playtest). */
export function suppressRotate(on: boolean): void {
  suppressed = on;
  sync();
}

export function rotateSuppressed(): boolean {
  return suppressed;
}

export function rotateShowing(): boolean {
  return showing;
}

export function onRotateChange(fn: (showing: boolean) => void): void {
  listeners.push(fn);
}

function portrait(): boolean {
  const mq = window.matchMedia?.('(orientation: portrait)');
  return mq ? mq.matches : innerHeight > innerWidth;
}

/** Asks for a landscape lock; a browser without screen.orientation.lock (iOS Safari) is simply left alone. */
export async function lockLandscape(): Promise<boolean> {
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (!o || typeof o.lock !== 'function') return false;
    await o.lock('landscape');
    return true;
  } catch {
    return false;
  }
}

function fullscreenOn(): boolean {
  return !!(document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement);
}

async function goFullscreen(): Promise<void> {
  try {
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    if (root.requestFullscreen) await root.requestFullscreen();
    else root.webkitRequestFullscreen?.();
  } catch {
    // no fullscreen here (iPhone Safari): turning the phone is all there is
  }
}

function build(): HTMLElement {
  const d = document.createElement('div');
  d.id = 'rotate-prompt';
  d.className = 'rotate-prompt';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-label', 'Rotate your phone');
  d.hidden = true;
  d.innerHTML =
    '<div><div class="rotate-icon" aria-hidden="true"></div><h2>Rotate your phone</h2>' +
    '<p>The fight is shot widescreen. Turn it sideways and the match picks up where it stopped.</p>' +
    '<button type="button" class="secondary rotate-full">Go full screen</button></div>';
  d.querySelector('.rotate-full')!.addEventListener('click', () => void goFullscreen());
  document.body.append(d);
  return d;
}

function sync(): void {
  const want = !suppressed && (touchDevice() || forced) && portrait();
  if (want === showing) return;
  showing = want;
  el ??= build();
  el.hidden = !want;
  for (const fn of listeners) fn(want);
}

export function initRotatePrompt(): void {
  const mq = window.matchMedia?.('(orientation: portrait)');
  if (mq?.addEventListener) mq.addEventListener('change', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  // Entering fullscreen by any route (the prompt's button, a browser menu) asks for landscape.
  const onFs = () => {
    if (fullscreenOn()) void lockLandscape();
  };
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);
  sync();
}
