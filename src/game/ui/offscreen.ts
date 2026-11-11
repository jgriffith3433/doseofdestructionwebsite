/**
 * Off-screen markers: when a fighter is knocked out of the view an edge bubble shows their portrait and an arrow
 * pointing at them (Smash's magnifier bubble). The bubble grows (and its ring goes red) the nearer the fighter is
 * to the blast zone, so it also says how close they are to dying. The bubble stays inside the safe area and out
 * from under the touch buttons and the damage cards (`placeMarker`, pure and tested).
 */

export interface Rect { l: number; t: number; r: number; b: number }

export interface MarkerPlace {
  /** The bubble's centre in CSS pixels. */
  x: number;
  y: number;
  /** The arrow's direction, radians (CSS: 0 points right, positive turns down). */
  angle: number;
  /** True when the bubble clears every blocked rect. */
  clear: boolean;
}

const inside = (x: number, y: number, r: Rect): boolean => x > r.l && x < r.r && y > r.t && y < r.b;

/**
 * Where a bubble of `size` px goes for a fighter at (px, py) in a w x h view: on the line from the view's centre to
 * the fighter, clamped to the safe rectangle `safe` (inset by the bubble's radius), then slid along the edge out of
 * every `blocked` rect (the touch stick and buttons, the pause button, the damage cards).
 */
export function placeMarker(px: number, py: number, w: number, h: number, size: number, safe: Rect, blocked: Rect[]): MarkerPlace {
  const half = size / 2;
  const box: Rect = { l: safe.l + half, t: safe.t + half, r: safe.r - half, b: safe.b - half };
  const cx = w / 2;
  const cy = h / 2;
  const dx = px - cx;
  const dy = py - cy;
  const angle = Math.atan2(dy, dx);
  let tx = Infinity;
  let ty = Infinity;
  if (dx > 0) tx = (box.r - cx) / dx;
  else if (dx < 0) tx = (box.l - cx) / dx;
  if (dy > 0) ty = (box.b - cy) / dy;
  else if (dy < 0) ty = (box.t - cy) / dy;
  const t = Math.min(tx, ty, 1);
  let x = cx + dx * t;
  let y = cy + dy * t;
  const gap = 6;
  const grown = blocked.map((r) => ({ l: r.l - half - gap, t: r.t - half - gap, r: r.r + half + gap, b: r.b + half + gap }));
  const sideEdge = tx <= ty;
  for (let pass = 0; pass < 6; pass++) {
    const hit = grown.find((r) => inside(x, y, r));
    if (!hit) break;
    if (sideEdge) {
      // On the left or right edge: slide up, or down when there is no room above.
      const up = hit.t;
      const down = hit.b;
      y = up >= box.t && (y - up <= down - y || down > box.b) ? up : Math.min(box.b, down);
    } else {
      const left = hit.l;
      const right = hit.r;
      x = left >= box.l && (x - left <= right - x || right > box.r) ? left : Math.min(box.r, right);
    }
  }
  x = Math.max(box.l, Math.min(box.r, x));
  y = Math.max(box.t, Math.min(box.b, y));
  const clear = !grown.some((r) => inside(x, y, r));
  return { x, y, angle, clear };
}

/** Bubble size in px from how near the fighter is to the blast zone (world units): far is small, at the line is large. */
export function markerSize(gap: number, compact: boolean): number {
  const near = 1 - Math.max(0, Math.min(1, gap / 600));
  const lo = compact ? 38 : 44;
  const hi = compact ? 54 : 68;
  return Math.round(lo + (hi - lo) * near);
}

/** A fighter this close to the blast line (world units) gets the red "about to die" ring. */
export const MARKER_DANGER = 220;

export interface MarkerIn {
  id: number;
  /** The fighter's screen point in CSS px (may be outside the view). */
  x: number;
  y: number;
  /** World-unit distance to the nearest blast line. */
  gap: number;
  /** The player colour and the portrait URL. */
  color: string;
  portrait: string;
}

export interface MarkerShown { id: number; x: number; y: number; size: number; angle: number; danger: boolean; clear: boolean; rect: Rect }

/** What the markers did, for the playtest. */
export const markerLog: { shown: number; frames: number; unclear: number; last: MarkerShown | null; events: { id: number; size: number; danger: boolean }[] } = {
  shown: 0,
  frames: 0,
  unclear: 0,
  last: null,
  events: [],
};

const els = new Map<number, HTMLElement>();
const active = new Set<number>();
let layer: HTMLElement | null = null;

const rectOf = (el: Element): Rect | null => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
};

/** The safe area in px: env(safe-area-inset-*) read through a probe element, plus a small margin. */
function safeInsets(): Rect {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const pad = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  const m = 8;
  return { l: pad.l + m, t: pad.t + m, r: innerWidth - pad.r - m, b: innerHeight - pad.b - m };
}

/** Shows a bubble for each fighter in `list` and hides the rest. Called every drawn frame of a match; `list` is empty when nobody is off-screen. */
export function updateMarkers(list: MarkerIn[]): void {
  if (!layer) {
    layer = document.getElementById('edge-markers');
    if (!layer) return;
  }
  const w = innerWidth;
  const h = innerHeight;
  let safe: Rect | null = null;
  let blocked: Rect[] | null = null;
  const seen = new Set<number>();
  for (const m of list) {
    if (!safe) {
      safe = safeInsets();
      blocked = [];
      for (const sel of ['.touch-stick', '.touch-buttons', '.touch-pause', '.hud-card', '#match-top']) {
        document.querySelectorAll(sel).forEach((e) => {
          const r = rectOf(e);
          if (r) blocked!.push(r);
        });
      }
    }
    const compact = Math.min(w, h) <= 560;
    const size = markerSize(m.gap, compact);
    const p = placeMarker(m.x, m.y, w, h, size, safe, blocked!);
    const danger = m.gap < MARKER_DANGER;
    let el = els.get(m.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'edge-marker';
      el.dataset.fighter = String(m.id);
      const img = document.createElement('img');
      img.alt = '';
      img.src = m.portrait;
      const arrow = document.createElement('i');
      el.append(img, arrow);
      layer.appendChild(el);
      els.set(m.id, el);
    }
    el.style.setProperty('--player', m.color);
    el.style.width = el.style.height = `${size}px`;
    el.style.transform = `translate(${Math.round(p.x - size / 2)}px, ${Math.round(p.y - size / 2)}px)`;
    (el.lastElementChild as HTMLElement).style.transform = `rotate(${p.angle}rad) translateX(${size / 2 + 4}px)`;
    el.classList.toggle('danger', danger);
    el.hidden = false;
    seen.add(m.id);
    const shown: MarkerShown = { id: m.id, x: p.x, y: p.y, size, angle: p.angle, danger, clear: p.clear, rect: { l: p.x - size / 2, t: p.y - size / 2, r: p.x + size / 2, b: p.y + size / 2 } };
    markerLog.frames++;
    markerLog.last = shown;
    if (!p.clear) markerLog.unclear++;
    if (!active.has(m.id)) {
      active.add(m.id);
      markerLog.shown++;
      markerLog.events.push({ id: m.id, size, danger });
      if (markerLog.events.length > 40) markerLog.events.shift();
    }
  }
  for (const id of [...active]) {
    if (!seen.has(id)) {
      active.delete(id);
      const el = els.get(id);
      if (el) el.hidden = true;
    }
  }
}

/** Removes every bubble (a match ends or a scene starts). */
export function clearMarkers(): void {
  for (const el of els.values()) el.remove();
  els.clear();
  active.clear();
}

/** The bubbles on screen now, as rects, for the playtest. */
export function markerRects(): { id: number; rect: Rect; danger: boolean }[] {
  const out: { id: number; rect: Rect; danger: boolean }[] = [];
  for (const [id, el] of els) {
    if (el.hidden) continue;
    const r = rectOf(el);
    if (r) out.push({ id, rect: r, danger: el.classList.contains('danger') });
  }
  return out;
}
