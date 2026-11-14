// Tiny DOM helpers for building screens without a framework.

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

/**
 * Adds a listener and remembers it on the element, so a page that updates in
 * place (devtools/morph.ts) can swap it for the new one. Read the element
 * from the event, not a closure: after an update the live element may be an
 * older one.
 */
export function listen(el: Element, type: string, fn: EventListener): void {
  el.addEventListener(type, fn);
  const store = el as unknown as { __on?: Record<string, EventListener> };
  (store.__on ??= {})[type] = fn;
}

/** Creates an element. Attributes starting with "on" become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') listen(el, k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Drops empty entries, for passing optional pieces to replaceChildren(). */
export function kids(...children: Child[]): (Node | string)[] {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** A small, cropped fighter image for grids, slots and the HUD. */
export function thumbUrl(id: string): string {
  return `/characters/thumb/${id}.webp`;
}

/** A square head-and-face crop for round profile pictures (tools/heads.mjs, boxes in content/heads.json). */
export function headUrl(id: string): string {
  return `/characters/head/${id}.webp`;
}

/** A large, cropped fighter image for previews, the VS screen and dialogue. */
export function largeUrl(id: string): string {
  return `/characters/large/${id}.webp`;
}

/**
 * A painted three-quarter bust, one style for every fighter (characters/portrait/<id>-512.webp and -256.webp, from
 * Hawkes Gen image.edit; docs/art-bible.md "Portraits"). Select, VS and results all show these.
 */
export function portraitUrl(id: string, size: 256 | 512 = 512): string {
  return `/characters/portrait/${id}-${size}.webp`;
}

/** Which portrait size to load: the 256 px file on a phone-sized window (landscape or portrait), else the 512 px one. */
export function portraitSize(): 256 | 512 {
  if (typeof window === 'undefined' || !window.matchMedia) return 512;
  return window.matchMedia('(max-height: 500px), (max-width: 700px)').matches ? 256 : 512;
}

export function formatTime(frames: number): string {
  const secs = Math.max(0, Math.ceil(frames / 60));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

export function pct(tenths: number): string {
  return `${(tenths / 10).toFixed(1)}%`;
}

// ------------------------------------------------------------ pressed state

/** What counts as a menu button for the shared pressed state (game.css `[data-pressed]`). */
const PRESSABLE = 'button, a[href], [role="button"]';
const SHOWN_MS = 110;
const timers = new WeakMap<HTMLElement, number>();

/** The menu control under an event target that shows a pressed state, or null (disabled, or part of the match's own controls). */
export function pressTarget(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(PRESSABLE) : null;
  if (!el || (el as HTMLButtonElement).disabled || el.closest('.match-screen, .touch, #tap-to-play')) return null;
  return el;
}

/** Shows the pressed state now (same task as the press) and keeps it up for at least SHOWN_MS; `holdUntilRelease` keeps it while a finger is down. */
export function setPressed(el: HTMLElement): void {
  window.clearTimeout(timers.get(el));
  el.dataset.pressed = '';
  el.dataset.pressedAt = String(Math.round(performance.now()));
}

export function releasePressed(el: HTMLElement, since: number): void {
  const wait = Math.max(0, SHOWN_MS - (performance.now() - since));
  window.clearTimeout(timers.get(el));
  timers.set(el, window.setTimeout(() => { delete el.dataset.pressed; }, wait));
}

/** A press with no pointer (key, pad button): pressed for a short beat. */
export function flashPressed(el: HTMLElement | null, ms = 150): void {
  if (!el) return;
  const t = pressTarget(el);
  if (!t) return;
  setPressed(t);
  releasePressed(t, performance.now() - (ms - SHOWN_MS));
}

/**
 * One pressed state for every menu control, for mouse, touch, keys and pad: pointer down marks it at once (CSS `:active`
 * is late or missing on touch), up, cancel or leaving clears it after a short beat. `onPress` runs on the same event
 * (the sound), so state and sound start together.
 */
export function installPressFeedback(onPress: (el: HTMLElement) => void): void {
  const down = new Map<number, { el: HTMLElement; at: number }>();
  document.addEventListener('pointerdown', (e) => {
    const el = pressTarget(e.target);
    if (!el) return;
    setPressed(el);
    down.set(e.pointerId, { el, at: performance.now() });
    onPress(el);
  }, true);
  const up = (e: PointerEvent) => {
    const d = down.get(e.pointerId);
    if (!d) return;
    down.delete(e.pointerId);
    releasePressed(d.el, d.at);
  };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', () => { for (const [id, d] of down) { down.delete(id); releasePressed(d.el, 0); } });
  // Keys: Enter, Space and J on the focused control.
  window.addEventListener('keydown', (e) => {
    if (e.repeat || (e.code !== 'Enter' && e.code !== 'Space' && e.code !== 'KeyJ')) return;
    const el = pressTarget(document.activeElement);
    if (el) flashPressed(el);
  }, true);
}
