// Character select: the hovered fighter's four specials by name, with a short looping clip of the one in focus.
// Each row is a button (tap, hover or focus it to pin that special); with nothing pinned the preview walks through
// the four on its own, one clip loop each. The clip is the move's own sheet from characters/anim/<id>/, or the
// stand-in clip the game plays for it (render/anims.ts), drawn on a canvas at the clip's frame rate.

import { MOVE, MOVE_KEYS, type CharacterDef, type Move, type SpecialKind } from '../sim/characters.ts';
import { loadAnimSet, type AnimSet, type Clip } from '../render/anims.ts';
import { h } from './dom.ts';

const SLOTS = [
  { slot: 'Neutral', move: MOVE.NSPECIAL },
  { slot: 'Side', move: MOVE.SSPECIAL },
  { slot: 'Up', move: MOVE.UPB },
  { slot: 'Down', move: MOVE.DSPECIAL },
] as const;

const KIND_LABEL: Record<SpecialKind, string> = {
  projectile: 'Projectile',
  dash: 'Dash',
  counter: 'Counter',
  grab: 'Command grab',
  trap: 'Trap',
  flurry: 'Flurry',
  recovery: 'Recovery',
};

/** Canvas size in CSS pixels; the drawing is sharpened for the screen's pixel ratio. */
const W = 176;
const H = 132;
/** The standing figure takes this much of the canvas height. */
const FIGURE = 0.64;
const sheets = new Map<string, Promise<HTMLImageElement | null>>();

function sheet(url: string): Promise<HTMLImageElement | null> {
  let p = sheets.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    sheets.set(url, p);
  }
  return p;
}

/** The clip that plays a move: its own, else the stand-ins the game falls back to. */
export function clipFor(set: AnimSet, index: number, move: Move): { key: string; clip: Clip } | null {
  for (const key of [MOVE_KEYS[index], ...(move.clips ?? []), 'nspecial', 'idle']) {
    const clip = set.clips[key];
    if (clip) return { key, clip };
  }
  return null;
}

/** The move's name and what it is, for the list (a shared move has no archetype). */
export function specialLabel(c: CharacterDef, move: number): { name: string; kind: string } {
  const m = c.moves[move];
  return { name: m.name, kind: c.specials && m.kind ? KIND_LABEL[m.kind] : '' };
}

/** Builds the panel for one fighter. It stops animating by itself once it is out of the page. */
export function specialsPanel(c: CharacterDef): HTMLElement {
  const canvas = h('canvas', { class: 'sp-clip', width: Math.round(W * dpr()), height: Math.round(H * dpr()), 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const rows = SLOTS.map(({ slot, move }) => {
    const { name, kind } = specialLabel(c, move);
    const row = h(
      'button',
      { type: 'button', class: 'sp-row', 'data-slot': slot.toLowerCase(), 'data-special': name, title: `${slot} special: ${name}` },
      h('strong', { class: 'sp-name' }, name),
      h('em', { class: 'sp-kind' }, kind ? `${slot} · ${kind}` : slot),
    );
    return row;
  });
  const panel = h('div', { class: 'specials', 'data-fighter': c.id }, h('div', { class: 'sp-stage' }, canvas), h('div', { class: 'sp-list', role: 'group', 'aria-label': `${c.name}'s specials` }, ...rows));

  let pinned = -1;
  let shown = 0;
  const born = performance.now();
  let began = born;
  const mark = (i: number) => {
    shown = i;
    began = performance.now();
    rows.forEach((r, k) => r.classList.toggle('on', k === i));
  };
  rows.forEach((row, i) => {
    const pin = () => { pinned = i; mark(i); };
    row.addEventListener('pointerenter', pin);
    row.addEventListener('focus', pin);
    row.addEventListener('click', pin);
  });
  mark(0);

  const ctx = canvas.getContext('2d');
  let set: AnimSet | null = null;
  void loadAnimSet(c.id).then((s) => { set = s; });

  const draw = (now: number) => {
    // A panel replaced by the next fighter's stops (it is not in the page any more).
    if (!panel.isConnected && now - born > 500) return;
    requestAnimationFrame(draw);
    if (!ctx || !set || document.hidden || !panel.offsetParent) return;
    const move = SLOTS[shown].move;
    const found = clipFor(set, move, c.moves[move]);
    if (!found) return;
    const { clip } = found;
    const url = `${set.base}${clip.file}?v=${set.version}`;
    const cached = sheets.get(url);
    if (!cached) void sheet(url);
    // The loop plays at the clip's frame rate, with a short beat before it starts again.
    const length = (clip.frames / clip.fps) * 1000;
    const t = now - began;
    const cycle = length + 350;
    if (pinned < 0 && t >= cycle * 2) {
      mark((shown + 1) % SLOTS.length);
      return;
    }
    const inLoop = t - Math.floor(t / cycle) * cycle;
    const frame = Math.min(clip.frames - 1, Math.floor((inLoop / 1000) * clip.fps));
    void sheet(url).then((img) => {
      if (!img) return;
      paint(ctx, img, clip, frame, set!.refHeight);
    });
  };
  requestAnimationFrame(draw);
  return panel;
}

function dpr(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, clip: Clip, frame: number, refHeight: number): void {
  const k = dpr();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const scale = (H * FIGURE) / refHeight;
  const col = frame % clip.cols;
  const row = Math.floor(frame / clip.cols);
  // The feet stand left of centre so a reach to the right has room; a floor line under them.
  const feetX = W * 0.36;
  const feetY = H - 12;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(10, feetY, W - 20, 2);
  ctx.drawImage(img, col * clip.fw, row * clip.fh, clip.fw, clip.fh, feetX - clip.ax * scale, feetY - clip.ay * scale, clip.fw * scale, clip.fh * scale);
}
