// Stage select's live preview: each stage tile plays a 2 s camera pan over the stage's own painted layers, drawn
// by parallax on a small canvas (no video files, no second Babylon engine). Layers carry their apparent x, y and
// width as seen from the default camera and a depth z (content/stages.json), so a pan slides near layers more than far ones.
// The same camera move opens a match (campaign/intro.ts), so the tile shows what the fly-in will start from.

import type { StageDef, StageLayer } from '../sim/stage.ts';

/** One pan, there and back. */
export const PREVIEW_MS = 2000;
const W = 320;
const H = 150;
/** The pan's reach in stage units, either side of the middle. */
const PAN = 260;
/** Draw this often (ms): a tile is small, and a phone has nine of them. */
const FRAME_MS = 33;

/** The preview camera `ms` into the loop: the pan (-1..1) and the push-in (1 wide, up to 1.12 close). Smooth and seamless at the loop. */
export function previewCamera(ms: number): { pan: number; zoom: number } {
  const t = (((ms % PREVIEW_MS) + PREVIEW_MS) % PREVIEW_MS) / PREVIEW_MS;
  const e = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  return { pan: -Math.cos(t * Math.PI * 2), zoom: 1 + 0.12 * e };
}

/** How much of the camera's pan a layer at depth z shows: the plane of the fighters moves fully, far layers hardly, near ones more. */
export function layerShift(z: number): number {
  return 1 / Math.max(0.35, 1 + z * 0.15);
}

/** The layers a preview draws, back to front: painted, shown, and the low-quality set (the High-only bands stay out of a tile). */
export function previewLayers(stage: StageDef): StageLayer[] {
  return (stage.layers ?? []).filter((l) => l.image && !l.hidden && !l.high).sort((a, b) => b.z - a.z);
}

interface Loaded {
  layer: StageLayer;
  /** The picture, pre-scaled to its size on the tile (so the 30 fps loop only blits). */
  pic: HTMLCanvasElement;
}

const loaded = new Map<string, Promise<Loaded[]>>();

function frameOf(stage: StageDef): { left: number; sx: number } {
  const left = Math.min(...stage.platforms.map((p) => p.x1 - (p.motion?.ax ?? 0))) - 160;
  const right = Math.max(...stage.platforms.map((p) => p.x2 + (p.motion?.ax ?? 0))) + 160;
  return { left, sx: W / (right - left) };
}

function loadLayers(stage: StageDef): Promise<Loaded[]> {
  let p = loaded.get(stage.id);
  if (!p) {
    const { sx } = frameOf(stage);
    p = Promise.all(
      previewLayers(stage).map(
        (layer) =>
          new Promise<Loaded | null>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const w = Math.max(2, Math.min(W * 3, Math.round(layer.width * sx * 1.12)));
              const hh = Math.max(2, Math.round(w * (img.naturalHeight / img.naturalWidth)));
              const pic = document.createElement('canvas');
              pic.width = w;
              pic.height = hh;
              pic.getContext('2d')!.drawImage(img, 0, 0, w, hh);
              resolve({ layer, pic });
            };
            img.onerror = () => resolve(null);
            img.src = `/${layer.image}`;
          }),
      ),
    ).then((all) => all.filter((x): x is Loaded => x !== null));
    loaded.set(stage.id, p);
  }
  return p;
}

/** Paints the tile at `ms` into the pan. Returns the pan it drew (the playtest reads it off the canvas). */
export function drawPreview(ctx: CanvasRenderingContext2D, stage: StageDef, layers: Loaded[], ms: number): number {
  const { left, sx } = frameOf(stage);
  const { pan, zoom } = previewCamera(ms);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, stage.theme.sky[0]);
  sky.addColorStop(0.6, stage.theme.sky[1]);
  sky.addColorStop(1, stage.theme.sky[2]);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const cam = pan * PAN;
  ctx.save();
  // The push-in is about the middle of the play area.
  ctx.translate(W / 2, H * 0.68);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H * 0.68);
  for (const { layer, pic } of layers) {
    const w = layer.width * sx;
    const hh = w * (pic.height / pic.width);
    const cx = (layer.x - cam * layerShift(layer.z) - left) * sx;
    const cy = H * 0.68 - layer.y * sx;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.globalCompositeOperation = layer.glow ? 'lighter' : 'source-over';
    ctx.drawImage(pic, cx - w / 2, cy - hh / 2, w, hh);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return pan;
}

interface Tile {
  canvas: HTMLCanvasElement;
  stage: StageDef;
  layers: Loaded[] | null;
  /** On screen (the stage screen is up and the tile is in view): only those are drawn. */
  visible: boolean;
}

const tiles = new Set<Tile>();
let watcher: IntersectionObserver | null | undefined;
const owner = new WeakMap<Element, Tile>();
let raf = 0;
let lastDraw = 0;
const still = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function loop(now: number): void {
  raf = 0;
  for (const t of tiles) {
    if (t.canvas.isConnected) continue;
    tiles.delete(t);
    watcher?.unobserve(t.canvas);
  }
  if (tiles.size === 0) return;
  // Nothing on screen (a match, another menu): the loop ends, and the next tile to come into view starts it again.
  if (![...tiles].some((t) => t.visible)) return;
  if (!document.hidden && now - lastDraw >= FRAME_MS) {
    lastDraw = now;
    for (const t of tiles) {
      if (!t.layers || !t.visible) continue;
      const ctx = t.canvas.getContext('2d');
      if (!ctx) continue;
      const pan = drawPreview(ctx, t.stage, t.layers, now);
      t.canvas.dataset.pan = pan.toFixed(3);
      t.canvas.dataset.frames = String(Number(t.canvas.dataset.frames ?? 0) + 1);
    }
  }
  if (!still()) raf = requestAnimationFrame(loop);
}

/**
 * A tile's preview canvas, panning as soon as its layers have loaded; it stops by itself when the tile leaves the page.
 * With reduced motion it shows one still frame.
 */
export function stagePreview(stage: StageDef): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.className = 'stage-preview';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.stage = stage.id;
  canvas.dataset.frames = '0';
  const tile: Tile = { canvas, stage, layers: null, visible: typeof IntersectionObserver === 'undefined' };
  tiles.add(tile);
  if (watcher === undefined) {
    watcher = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = owner.get(e.target);
        if (t) t.visible = e.isIntersecting;
      }
      if (!raf && [...tiles].some((t) => t.visible && t.layers)) raf = requestAnimationFrame(loop);
    });
  }
  owner.set(canvas, tile);
  watcher?.observe(canvas);
  void loadLayers(stage).then((layers) => {
    tile.layers = layers;
    canvas.dataset.layers = String(layers.length);
    const ctx = canvas.getContext('2d');
    if (ctx) drawPreview(ctx, stage, layers, 0);
    if (!raf && tile.visible) raf = requestAnimationFrame(loop);
  });
  return canvas;
}
