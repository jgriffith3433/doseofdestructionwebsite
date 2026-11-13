// Character select: the hovered fighter's four specials by name, and a live inset that runs the real sim (specialSim.ts)
// against a training dummy in a 3 s loop. Each row is a button (tap, hover or focus it to pin that special); with
// nothing pinned the inset plays the signature (neutral) special. Fighters are drawn with the match's own clip picks
// and frames (render/anims.ts), from the sheets in characters/anim/<id>/.

import { MOVE, MOVE_KEYS, type CharacterDef, type Move, type SpecialKind } from '../sim/characters.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { clipFrame, loadAnimSet, pickClip, type AnimSet, type Clip } from '../render/anims.ts';
import { step } from '../sim/step.ts';
import { NO_INPUT } from '../sim/input.ts';
import type { Fighter, GameState } from '../sim/state.ts';
import { h } from './dom.ts';
import { LOOP_FRAMES, dummyFor, fighterPos, inputAt, shotPos, startLoop, type SimView, type Slot } from './specialSim.ts';

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
const W = 256;
const H = 160;
/** The view: 330 sim units across, the floor near the bottom. */
const VIEW: SimView = { k: W / 330, cx: W / 2, floor: H - 16 };
/** The art stands this much taller than the hurtbox (render/renderer.ts ART_SCALE). */
const ART_SCALE = 1.18;
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

/** The sheet if it has loaded (and starts the load if not). */
const loaded = new Map<string, HTMLImageElement | null>();
function sheetNow(url: string): HTMLImageElement | null {
  const got = loaded.get(url);
  if (got !== undefined) return got;
  loaded.set(url, null);
  void sheet(url).then((img) => loaded.set(url, img));
  return null;
}

const SLOT_KEYS: Slot[] = ['neutral', 'side', 'up', 'down'];

/** Builds the panel for one fighter. It stops animating by itself once it is out of the page. */
export function specialsPanel(c: CharacterDef): HTMLElement {
  const char = CHARACTERS.indexOf(c);
  const canvas = h('canvas', { class: 'sp-clip', width: Math.round(W * dpr()), height: Math.round(H * dpr()), 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const rows = SLOTS.map(({ slot, move }) => {
    const { name, kind } = specialLabel(c, move);
    return h(
      'button',
      { type: 'button', class: 'sp-row', 'data-slot': slot.toLowerCase(), 'data-special': name, title: `${slot} special: ${name}` },
      h('strong', { class: 'sp-name' }, name),
      h('em', { class: 'sp-kind' }, kind ? `${slot} · ${kind}` : slot),
    );
  });
  const panel = h(
    'div',
    { class: 'specials', 'data-fighter': c.id },
    h('div', { class: 'sp-stage' }, canvas, h('span', { class: 'sp-tag' }, 'Live · vs dummy')),
    h('div', { class: 'sp-list', role: 'group', 'aria-label': `${c.name}'s specials` }, ...rows),
  );

  let shown = 0;
  let sim: GameState = startLoop(char);
  let frame = 0;
  let last = 0;
  let acc = 0;
  const born = performance.now();
  const restart = () => {
    sim = startLoop(char);
    frame = 0;
    acc = 0;
  };
  const mark = (i: number) => {
    shown = i;
    rows.forEach((r, k) => r.classList.toggle('on', k === i));
    restart();
  };
  rows.forEach((row, i) => {
    const pin = () => { if (shown !== i) mark(i); };
    row.addEventListener('pointerenter', pin);
    row.addEventListener('focus', pin);
    row.addEventListener('click', pin);
  });
  mark(0);

  const ctx = canvas.getContext('2d');
  const sets: Record<string, AnimSet | null> = {};
  const dummy = dummyFor(char);
  void loadAnimSet(c.id).then((s) => { sets[c.id] = s; });
  void loadAnimSet(CHARACTERS[dummy].id).then((s) => { sets[CHARACTERS[dummy].id] = s; });

  const draw = (now: number) => {
    // A panel replaced by the next fighter's stops (it is not in the page any more).
    if (!panel.isConnected && now - born > 500) return;
    requestAnimationFrame(draw);
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    if (!ctx || document.hidden || !panel.offsetParent) return;
    // The sim runs at its own 60 Hz, a few steps at most per drawn frame.
    acc += dt;
    for (let n = 0; acc >= 1000 / 60 && n < 4; n++, acc -= 1000 / 60) {
      step(sim, [inputAt(char, SLOT_KEYS[shown], frame), NO_INPUT]);
      if (++frame >= LOOP_FRAMES) restart();
    }
    paint(ctx, sim, sets);
  };
  requestAnimationFrame(draw);
  return panel;
}

function dpr(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

/** One fighter of the sim, at its sim position, with the clip and frame the match would pick. */
function paintFighter(ctx: CanvasRenderingContext2D, f: Fighter, set: AnimSet | null, ghost: boolean): void {
  const { x, y } = fighterPos(f, VIEW);
  const pick = pickClip(f, set);
  const ch = CHARACTERS[f.char];
  if (!set || !pick) {
    // No clips yet: a plain block at the hurtbox.
    ctx.fillStyle = ghost ? '#667' : '#ffd15a';
    ctx.fillRect(x - (ch.width * VIEW.k) / 2, y - ch.height * VIEW.k, ch.width * VIEW.k, ch.height * VIEW.k);
    return;
  }
  const { clip } = pick;
  const img = sheetNow(`${set.base}${clip.file}?v=${set.version}`);
  if (!img) return;
  const i = clipFrame(f, pick);
  const scale = (ch.height * ART_SCALE * VIEW.k) / pick.refHeight;
  const col = i % clip.cols;
  const row = Math.floor(i / clip.cols);
  ctx.save();
  ctx.translate(x, y);
  if (f.facing < 0) ctx.scale(-1, 1);
  if (ghost) ctx.filter = 'grayscale(1) brightness(0.85)';
  ctx.drawImage(img, col * clip.fw, row * clip.fh, clip.fw, clip.fh, -clip.ax * scale, -clip.ay * scale, clip.fw * scale, clip.fh * scale);
  ctx.restore();
}

function paint(ctx: CanvasRenderingContext2D, s: GameState, sets: Record<string, AnimSet | null>): void {
  const k = dpr();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const back = ctx.createRadialGradient(W / 2, H * 0.35, 8, W / 2, H * 0.5, W * 0.65);
  back.addColorStop(0, 'rgba(255, 164, 92, 0.30)');
  back.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fillRect(8, VIEW.floor, W - 16, 2);
  const [you, dum] = s.fighters;
  paintFighter(ctx, dum, sets[CHARACTERS[dum.char].id] ?? null, true);
  paintFighter(ctx, you, sets[CHARACTERS[you.char].id] ?? null, false);
  for (const shot of s.shots) {
    if (shot.life <= 0) continue;
    const p = shotPos(shot.x, shot.y, VIEW);
    const r = Math.max(4, (shot.r / 1000) * VIEW.k);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
    g.addColorStop(0, '#fff6d0');
    g.addColorStop(0.45, '#ffd15a');
    g.addColorStop(1, 'rgba(255, 90, 31, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    if (shot.kind === 1) {
      ctx.strokeStyle = 'rgba(255, 209, 90, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
