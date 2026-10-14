// Draws sprite-sheet clips onto canvases the way the game plays them, with
// optional hurtbox, hitbox and feet overlays. One animation loop drives every
// preview on the page.

import type { Clip } from '../game/render/anims.ts';
import type { CharacterDef, Move } from '../game/sim/fighterDefs.ts';

/** Matches ART_SCALE in render/renderer.ts: the art stands a little taller than the hurtbox. */
export const ART_SCALE = 1.18;

const images = new Map<string, HTMLImageElement>();

export function sheetImage(url: string): HTMLImageElement {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img;
}

export interface Overlay {
  hurtbox?: boolean;
  hitboxes?: boolean;
  feet?: boolean;
}

export interface DrawSpec {
  canvas: HTMLCanvasElement;
  url: string;
  clip: Clip;
  refHeight: number;
  /** Which frame of the clip, and the game frame of the move when it is one. */
  index: number;
  move?: Move;
  moveFrame?: number;
  ch?: CharacterDef;
  overlay?: Overlay;
}

/** Draws one frame, scaled to fit, feet on a ground line near the bottom. */
export function drawFrame(spec: DrawSpec): void {
  const { canvas, clip, refHeight } = spec;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr);
  const chH = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== chH) {
    canvas.width = cw;
    canvas.height = chH;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, cw, chH);
  const img = sheetImage(spec.url);
  // Scale so a standing fighter (refHeight) fills about 70% of the height,
  // and the whole frame still fits.
  const ground = chH * 0.9;
  const s = Math.min((chH * 0.7) / refHeight, (chH * 0.86) / clip.fh, (cw * 0.9) / clip.fw);
  const ox = cw / 2;

  ctx.strokeStyle = 'rgba(255, 209, 90, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, ground + 0.5);
  ctx.lineTo(cw, ground + 0.5);
  ctx.stroke();

  if (img.complete && img.naturalWidth) {
    const i = Math.max(0, Math.min(clip.frames - 1, spec.index));
    const sx = (i % clip.cols) * clip.fw;
    const sy = Math.floor(i / clip.cols) * clip.fh;
    ctx.drawImage(img, sx, sy, clip.fw, clip.fh, ox - clip.ax * s, ground - clip.ay * s, clip.fw * s, clip.fh * s);
  }

  const ov = spec.overlay ?? {};
  const ch = spec.ch;
  if (ch) {
    // World units to canvas pixels: the in-game sprite is ch.height * ART_SCALE tall at refHeight pixels.
    const ppu = (refHeight / (ch.height * ART_SCALE)) * s;
    if (ov.hurtbox) {
      ctx.strokeStyle = 'rgba(255, 209, 90, 0.85)';
      ctx.fillStyle = 'rgba(255, 209, 90, 0.08)';
      ctx.lineWidth = 1.5 * dpr;
      const w = ch.width * ppu;
      const hh = ch.height * ppu;
      ctx.fillRect(ox - w / 2, ground - hh, w, hh);
      ctx.strokeRect(ox - w / 2, ground - hh, w, hh);
    }
    if (ov.hitboxes && spec.move && spec.moveFrame !== undefined) {
      for (const win of spec.move.hits) {
        if (spec.moveFrame < win.start || spec.moveFrame > win.end) continue;
        for (const b of win.boxes) {
          ctx.fillStyle = 'rgba(255, 60, 40, 0.35)';
          ctx.strokeStyle = 'rgba(255, 90, 60, 0.95)';
          ctx.beginPath();
          ctx.arc(ox + b.x * ppu, ground - b.y * ppu, b.r * ppu, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }
  if (ov.feet) {
    ctx.fillStyle = '#7ee2a0';
    ctx.beginPath();
    ctx.arc(ox, ground, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Which clip frame shows at a given game frame, exactly as render/anims.ts picks it. */
export function frameAt(clip: Clip, gameFrame: number, moveTotal?: number): number {
  if (moveTotal) return Math.min(clip.frames - 1, Math.floor((gameFrame / moveTotal) * clip.frames));
  const i = Math.floor((gameFrame * clip.fps) / 60);
  return clip.loop ? i % clip.frames : Math.min(clip.frames - 1, i);
}

// ------------------------------------------------------------ the loop

type Animator = (now: number) => void;
const animators = new Set<Animator>();
let running = false;

function loop(now: number): void {
  // One animator failing must not stop the others (or the loop) for good.
  for (const a of animators) {
    try {
      a(now);
    } catch (e) {
      animators.delete(a);
      console.error('animation stopped:', e);
    }
  }
  if (animators.size) requestAnimationFrame(loop);
  else running = false;
}

/** Calls fn every animation frame until the returned stop function runs. */
export function animate(fn: Animator): () => void {
  animators.add(fn);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => animators.delete(fn);
}
