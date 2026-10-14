// Tiny DOM helpers for building screens without a framework.

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

/** Creates an element. Attributes starting with "on" become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
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

/** A large, cropped fighter image for previews, the VS screen and dialogue. */
export function largeUrl(id: string): string {
  return `/characters/large/${id}.webp`;
}

export function formatTime(frames: number): string {
  const secs = Math.max(0, Math.ceil(frames / 60));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

export function pct(tenths: number): string {
  return `${(tenths / 10).toFixed(1)}%`;
}
