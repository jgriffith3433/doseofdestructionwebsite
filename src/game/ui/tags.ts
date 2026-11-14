/**
 * Name tags over the fighters (Smash's P1/CPU tag): a small label above each head in the player colour with a dark
 * outline, so you know which fighter is yours without relying on colour. `tagText` says what it reads (P1-P4 for people,
 * CPU for bots, the profile name online), `placeTag` is the pure clamp (inside the safe window, and nudged up off the
 * touch controls), `updateTags` draws them. A fighter that is off the view has no tag over its head: the same text rides
 * the edge bubble (ui/offscreen.ts).
 */

import type { Rect } from './offscreen.ts';

export interface TagSlot { cpu: number | null; remote?: boolean }

/** What a slot's tag reads. Online: the profile name (short), else P<slot>, CPU for bots, DUMMY for the training dummy. */
export function tagText(slots: TagSlot[], i: number, onlineName?: string): string {
  const s = slots[i];
  if (!s) return '';
  if (onlineName && s.cpu === null) {
    const n = onlineName.trim();
    if (n) return n.length > 10 ? `${n.slice(0, 9)}…` : n;
  }
  if (s.cpu === 0) return 'DUMMY';
  if (s.cpu !== null) return 'CPU';
  return `P${i + 1}`;
}

export interface TagPlace { x: number; y: number; clear: boolean }

/**
 * Where a tag of w x h px goes for a head at (hx, hy): centred above it, kept inside `safe`, and moved up in steps while it
 * overlaps a `blocked` rect (touch stick, buttons, damage cards). `y` is the tag's bottom edge.
 */
export function placeTag(hx: number, hy: number, w: number, h: number, safe: Rect, blocked: Rect[]): TagPlace {
  const x = Math.max(safe.l + w / 2, Math.min(safe.r - w / 2, hx));
  let y = Math.max(safe.t + h, Math.min(safe.b, hy - 4));
  const hits = (yy: number) => blocked.some((r) => x + w / 2 > r.l && x - w / 2 < r.r && yy > r.t && yy - h < r.b);
  for (let pass = 0; pass < 8 && hits(y); pass++) {
    const r = blocked.find((q) => x + w / 2 > q.l && x - w / 2 < q.r && y > q.t && y - h < q.b)!;
    // Up above the blocker, or down below it when there is no room above.
    const up = r.t - 4;
    y = up - h >= safe.t ? up : Math.min(safe.b, r.b + 4 + h);
  }
  return { x, y, clear: !hits(y) };
}

export interface TagIn { shape?: string; id: number; x: number; y: number; text: string; color: string }

/** What the tags did, for the playtest. */
export const tagLog: { frames: number; unclear: number; minHeight: number; texts: Record<number, string> } = { frames: 0, unclear: 0, minHeight: 999, texts: {} };

const els = new Map<number, HTMLElement>();
let layer: HTMLElement | null = null;

function tagLayer(): HTMLElement | null {
  if (layer && layer.isConnected) return layer;
  layer = document.getElementById('fighter-tags');
  return layer;
}

/** Shows a tag for each fighter in `list` (head point in CSS px) and hides the rest. Called every drawn frame of a match. */
export function updateTags(list: TagIn[], safe: Rect, blocked: Rect[]): void {
  const host = tagLayer();
  if (!host) return;
  const seen = new Set<number>();
  for (const t of list) {
    let el = els.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'fighter-tag';
      el.dataset.fighter = String(t.id);
      host.appendChild(el);
      els.set(t.id, el);
    }
    if (el.textContent !== t.text) el.textContent = t.text;
    el.style.setProperty('--player', t.color);
    if (t.shape) el.dataset.shape = t.shape;
    el.hidden = false;
    const w = el.offsetWidth || 32;
    const h = el.offsetHeight || 16;
    const p = placeTag(t.x, t.y, w, h, safe, blocked);
    el.style.transform = `translate(${Math.round(p.x - w / 2)}px, ${Math.round(p.y - h)}px)`;
    seen.add(t.id);
    tagLog.frames++;
    if (!p.clear) tagLog.unclear++;
    tagLog.minHeight = Math.min(tagLog.minHeight, h);
    tagLog.texts[t.id] = t.text;
  }
  for (const [id, el] of els) if (!seen.has(id)) el.hidden = true;
}

/** Removes every tag (a match ends or a scene starts). */
export function clearTags(): void {
  for (const el of els.values()) el.remove();
  els.clear();
}

/** The tags on screen now, as rects, for the playtest. */
export function tagRects(): { id: number; text: string; fontPx: number; rect: Rect }[] {
  const out: { id: number; text: string; fontPx: number; rect: Rect }[] = [];
  for (const [id, el] of els) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0) out.push({ id, text: el.textContent ?? '', fontPx: parseFloat(getComputedStyle(el).fontSize) || 0, rect: { l: r.left, t: r.top, r: r.right, b: r.bottom } });
  }
  return out;
}
