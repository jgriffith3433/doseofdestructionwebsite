// Maps: a side-on editor for content/stages.json. Drag platforms, their ends,
// spawn points, the blast zone and art layers; set colors, motion, depth,
// layers and effects in the inspector; check the stage for mistakes; preview
// it in the real renderer; playtest it.
//
// Concepts: every folder in C:\Projects\AllTheMaps (images + reference.txt).
// "Generate Map Idea" asks Claude for a few designs (tools/maps/idea.mjs) to
// pick from or revise. Paint: the GPU server paints each piece over its
// blockout in the concept's style (tools/maps/paint.mjs); takes are used or
// discarded here. Review: Claude critiques the result against the concept.

import { platformAt, type Platform, type StageDef, type StageEffect, type StageLayer } from '../../game/sim/stageMath.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api, pickFile } from '../api.ts';
import { gpu, gpuSnapshot, ready, refreshGpu, watchGpu, type GpuJob } from '../gpu.ts';
import { askToNotify, bar, duration, progressOf } from '../activity.ts';
import { attempt, checkbox, field, numberInput, select, textInput, toast } from '../ui.ts';
import { animate } from '../sprites.ts';
import type { Tab } from '../main.ts';

type Edge = 'left' | 'right' | 'top' | 'bottom';
type Selection =
  | { kind: 'platform'; index: number }
  | { kind: 'spawn'; index: number }
  | { kind: 'respawn' }
  | { kind: 'blast'; edge: Edge }
  | { kind: 'layer'; index: number }
  | null;

type Drag =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'platform'; index: number; part: 'body' | 'x1' | 'x2' | 'depth'; wx: number; wy: number; start: Platform }
  | { kind: 'spawn'; index: number }
  | { kind: 'respawn' }
  | { kind: 'blast'; edge: Edge }
  | { kind: 'layer'; index: number; part: 'body' | 'size'; wx: number; wy: number; start: StageLayer };

interface Concept {
  folder: string;
  id: string;
  name: string;
  reference: string;
  images: { file: string; size: number; mtime: number }[];
  stage: { id: string; name: string } | null;
}

const PROPS = ['frame', 'skyline', 'clouds', 'embers', 'pipes'] as const;
const PLAYER_COLORS = ['#ff5a1f', '#3fa7ff', '#ffd15a', '#5ce08a'];
/** Depth presets for layers: positive is behind the fighters. */
const DEPTHS: [string, string][] = [['24', 'Far backdrop (24)'], ['12', 'Distant (12)'], ['5', 'Behind the stage (5)'], ['0.3', 'Platform art (0.3)'], ['-2', 'In front (-2)'], ['-4', 'Close in front (-4)']];
/** How tall a placeholder looks, for its width (it has no image yet). */
const PLACEHOLDER_ASPECT = 0.56;

let root: HTMLElement;
let stages: StageDef[] = [];
let current = 0;
let selection: Selection = null;
let dirty = false;
let snap = 10;
let animating = true;
let showArt = true;
let artMode = false;
let seeThrough = false;
let frame = 0;
const view = { cx: 0, cy: 150, zoom: 0.35 };
let canvas: HTMLCanvasElement;
let listEl: HTMLElement;
let inspector: HTMLElement;
let drag: Drag | null = null;
let stopLoop: (() => void) | null = null;
let concepts: Concept[] = [];
let conceptsRoot = '';
let generating: string | null = null;
/** The design panel: designs to pick from for a concept folder. */
let designs: { folder: string; list: { stage: StageDef; preview: string }[]; ai: boolean; why?: string } | null = null;
const directions = new Map<string, string>();
let designCount = 3;
/** Painting: the pieces of the saved stage and their takes. */
interface Take { file: string; seed: number; mtime: number; recipe: { x: number; y: number; width: number; size: [number, number]; layers: string[]; kind: string; prompt: string; fit?: { score: number | null; platforms: (number | null)[] } } | null }
let paintInfo: { stage: string; pieces: { id: string; kind: string; layers: string[] }[]; takes: Record<string, Take[]> } | null = null;
let review: { stage: string; image: string; review: { score: number; summary: string; works: string; issues: { target: string; problem: string; fix: string; repaint: string }[] } } | null = null;
let reviewing = false;
let sounds: string[] = [];
const artFiles = new Map<string, string[]>();
const images = new Map<string, HTMLImageElement>();

const stage = () => stages[current];

// ------------------------------------------------------------- undo/redo

// A snapshot of the stage after the last change; a burst of changes (a drag,
// typing) becomes one undo step.
const undoStack: string[] = [];
const redoStack: string[] = [];
let snapshot = '';
let lastChange = 0;

function resetHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  snapshot = stage() ? JSON.stringify(stage()) : '';
}

function recordChange(): void {
  const now = Date.now();
  if (now - lastChange > 700 && snapshot) {
    undoStack.push(snapshot);
    if (undoStack.length > 120) undoStack.shift();
    redoStack.length = 0;
  }
  lastChange = now;
  snapshot = JSON.stringify(stage());
}

function undo(back: boolean): void {
  const from = back ? undoStack : redoStack;
  const to = back ? redoStack : undoStack;
  const prev = from.pop();
  if (!prev) return;
  to.push(JSON.stringify(stage()));
  stages[current] = JSON.parse(prev);
  snapshot = prev;
  lastChange = 0;
  selection = null;
  dirty = true;
  renderAll();
  schedulePreview();
}

// -------------------------------------------------------------- geometry

function toScreen(x: number, y: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(x - view.cx) * view.zoom + r.width / 2, r.height / 2 - (y - view.cy) * view.zoom];
}

function toWorld(sx: number, sy: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(sx - r.width / 2) / view.zoom + view.cx, (r.height / 2 - sy) / view.zoom + view.cy];
}

const snapTo = (v: number, free = false) => (free || snap <= 1 ? Math.round(v) : Math.round(v / snap) * snap);

function fit(): void {
  const b = stage().blast;
  const r = canvas.getBoundingClientRect();
  view.cx = (b.left + b.right) / 2;
  view.cy = (b.top + b.bottom) / 2;
  view.zoom = Math.min((r.width * 0.92) / (b.right - b.left), (r.height - 110) / (b.top - b.bottom));
  // Leave room for the toolbar along the top.
  view.cy += 18 / view.zoom;
}

/** Where a platform is drawn now: moving ones follow their motion while animating. */
function placed(p: Platform): { x1: number; x2: number; y: number } {
  if (!p.motion || !animating) return p;
  const at = platformAt(p, frame);
  return { x1: at.x1 / 1000, x2: at.x2 / 1000, y: at.y / 1000 };
}

function image(path: string): HTMLImageElement | null {
  if (!path) return null;
  let img = images.get(path);
  if (!img) {
    img = new Image();
    img.src = `/${path}`;
    images.set(path, img);
  }
  return img;
}

/** A layer's box in world units (y up), as the default camera sees it. */
function layerBox(l: StageLayer): { x1: number; x2: number; y1: number; y2: number } {
  const img = image(l.image);
  const aspect = img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : l.aspect ?? PLACEHOLDER_ASPECT;
  const hh = (l.width * aspect) / 2;
  return { x1: l.x - l.width / 2, x2: l.x + l.width / 2, y1: l.y - hh, y2: l.y + hh };
}

// ------------------------------------------------------------------ draw

/** Layer ids being painted right now (or waiting), and how far along. */
function paintingNow(): Map<string, { running: boolean; fraction: number }> {
  const out = new Map<string, { running: boolean; fraction: number }>();
  const st = stage();
  if (!st) return out;
  const all = gpuSnapshot()?.jobs ?? [];
  for (const j of paintJobs(st.id).filter(activeJob)) {
    const p = progressOf(j, all);
    for (const id of pieceLayers(j.piece!)) out.set(id, { running: j.status === 'running', fraction: p.fraction });
  }
  return out;
}

function drawPainting(ctx: CanvasRenderingContext2D, l: StageLayer, info: { running: boolean; fraction: number }): void {
  const b = layerBox(l);
  const [x1, y1] = toScreen(b.x1, b.y2);
  const [x2, y2] = toScreen(b.x2, b.y1);
  ctx.save();
  ctx.setLineDash([10, 6]);
  ctx.lineDashOffset = -frame * 0.6;
  ctx.lineWidth = 2;
  ctx.strokeStyle = info.running ? '#ffd15a' : 'rgba(255, 209, 90, 0.45)';
  ctx.strokeRect(x1 - 3, y1 - 3, x2 - x1 + 6, y2 - y1 + 6);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(16, 14, 12, 0.85)';
  const label = info.running ? `painting ${Math.round(info.fraction * 100)}%` : 'waiting to paint';
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  const w = ctx.measureText(label).width + 12;
  ctx.fillRect(x1, y1 - 20, w, 17);
  ctx.fillStyle = '#ffd15a';
  ctx.fillText(label, x1 + 6, y1 - 7);
  ctx.restore();
}

function drawLayer(ctx: CanvasRenderingContext2D, l: StageLayer, i: number): void {
  const b = layerBox(l);
  const [x1, y1] = toScreen(b.x1, b.y2);
  const [x2, y2] = toScreen(b.x2, b.y1);
  const img = image(l.image);
  const front = l.z < 0;
  ctx.save();
  ctx.globalAlpha = (l.opacity ?? 1) * (front && seeThrough ? 0.4 : 1);
  if (l.glow) ctx.globalCompositeOperation = 'lighter';
  if (img && img.complete && img.naturalWidth) {
    ctx.drawImage(img, x1, y1, x2 - x1, y2 - y1);
  } else {
    // A placeholder for art still to paint.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = front ? 'rgba(255, 90, 160, 0.10)' : 'rgba(120, 170, 255, 0.10)';
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = front ? 'rgba(255, 120, 180, 0.8)' : 'rgba(140, 180, 255, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    // The silhouette the painter paints over.
    for (const r of l.shape ?? []) {
      const [sx1, sy1] = toScreen(l.x + r.x1, l.y + r.y2);
      const [sx2, sy2] = toScreen(l.x + r.x2, l.y + r.y1);
      ctx.fillStyle = front ? 'rgba(255, 120, 180, 0.22)' : 'rgba(140, 180, 255, 0.22)';
      ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    }
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(`${l.id}${front ? ' (front)' : ''}`, x1 + 5, y1 + 14);
  }
  ctx.restore();
  if (selection?.kind === 'layer' && selection.index === i) {
    ctx.strokeStyle = '#ffd15a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x1 - 2, y1 - 2, x2 - x1 + 4, y2 - y1 + 4);
    ctx.fillStyle = '#ffd15a';
    ctx.fillRect(x2 - 5, y1 - 5, 10, 10);
  }
}

function draw(): void {
  const st = stage();
  if (!st || !canvas.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = st.theme;

  const g = ctx.createRadialGradient(r.width / 2, r.height * 0.7, 10, r.width / 2, r.height * 0.7, Math.max(r.width, r.height) * 0.8);
  g.addColorStop(0, t.sky[0]);
  g.addColorStop(0.5, t.sky[1]);
  g.addColorStop(1, t.sky[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, r.width, r.height);

  // Art behind the fighters, farthest first.
  const layers = (st.layers ?? []).map((l, i) => ({ l, i })).filter(({ l }) => !l.hidden);
  if (showArt) for (const { l, i } of layers.filter(({ l }) => l.z > 0).sort((a, b) => b.l.z - a.l.z)) drawLayer(ctx, l, i);

  // Grid every 50 units, stronger every 250, axes brightest.
  const [wl, wt] = toWorld(0, 0);
  const [wr, wb] = toWorld(r.width, r.height);
  for (const [stepU, alpha] of [[50, 0.04], [250, 0.09]] as const) {
    if (stepU * view.zoom < 6) continue;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(wl / stepU) * stepU; x <= wr; x += stepU) {
      const [sx] = toScreen(x, 0);
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, r.height);
    }
    for (let y = Math.ceil(wb / stepU) * stepU; y <= wt; y += stepU) {
      const [, sy] = toScreen(0, y);
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(r.width, Math.round(sy) + 0.5);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  const [ax0, ay0] = toScreen(0, 0);
  ctx.moveTo(Math.round(ax0) + 0.5, 0);
  ctx.lineTo(Math.round(ax0) + 0.5, r.height);
  ctx.moveTo(0, Math.round(ay0) + 0.5);
  ctx.lineTo(r.width, Math.round(ay0) + 0.5);
  ctx.stroke();

  // Blast zone.
  const b = st.blast;
  const [bl, bt] = toScreen(b.left, b.top);
  const [br, bb] = toScreen(b.right, b.bottom);
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = 'rgba(255, 90, 60, 0.75)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bl, bt, br - bl, bb - bt);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255, 90, 60, 0.85)';
  ctx.font = '11px Segoe UI, sans-serif';
  ctx.fillText('blast zone', bl + 6, bt + 14);
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const [hx, hy] = blastHandle(edge);
    const on = selection?.kind === 'blast' && selection.edge === edge;
    ctx.fillStyle = on ? '#ffd15a' : 'rgba(255, 90, 60, 0.9)';
    ctx.fillRect(hx - 5, hy - 5, 10, 10);
  }

  // Platforms.
  st.platforms.forEach((p, i) => {
    const sel = selection?.kind === 'platform' && selection.index === i;
    if (p.motion) {
      const [c1x, c1y] = toScreen((p.x1 + p.x2) / 2 - p.motion.ax, p.y - p.motion.ay);
      const [c2x, c2y] = toScreen((p.x1 + p.x2) / 2 + p.motion.ax, p.y + p.motion.ay);
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(c1x, c1y);
      ctx.lineTo(c2x, c2y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (animating) {
        // Ghost of the rest position.
        const [gx1, gy] = toScreen(p.x1, p.y);
        const [gx2] = toScreen(p.x2, p.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(gx1, gy);
        ctx.lineTo(gx2, gy);
        ctx.stroke();
      }
    }
    const at = placed(p);
    const [x1, y] = toScreen(at.x1, at.y);
    const [x2] = toScreen(at.x2, at.y);
    const depthPx = p.solid ? (p.depth ?? 90) * view.zoom : Math.max(3, 10 * view.zoom);
    if (p.hidden) {
      // Collision only: the art draws it.
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = p.solid ? t.edge : t.thinEdge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1, y, x2 - x1, depthPx);
      ctx.setLineDash([]);
      ctx.fillStyle = p.solid ? t.edge : t.thinEdge;
      ctx.fillRect(x1, y - 1, x2 - x1, 2);
    } else if (p.solid) {
      ctx.fillStyle = t.body;
      ctx.fillRect(x1, y, x2 - x1, depthPx);
      ctx.fillStyle = t.under;
      ctx.fillRect(x1 + (x2 - x1) * 0.15, y + depthPx, (x2 - x1) * 0.7, depthPx * 0.9);
      ctx.fillStyle = t.edge;
      ctx.fillRect(x1, y - 1.5, x2 - x1, 3);
    } else {
      ctx.fillStyle = t.body;
      ctx.fillRect(x1, y, x2 - x1, depthPx);
      ctx.fillStyle = t.thinEdge;
      ctx.fillRect(x1, y - 1.5, x2 - x1, 3);
    }
    if (p.solid) {
      // Ledges.
      ctx.fillStyle = '#7ee2a0';
      for (const lx of [x1, x2]) {
        ctx.beginPath();
        ctx.moveTo(lx, y - 1);
        ctx.lineTo(lx + (lx === x1 ? -7 : 7), y - 1);
        ctx.lineTo(lx, y + 7);
        ctx.fill();
      }
    }
    if (sel) {
      ctx.strokeStyle = '#ffd15a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 - 3, y - 4, x2 - x1 + 6, depthPx + 8);
      ctx.fillStyle = '#ffd15a';
      ctx.fillRect(x1 - 5, y - 5, 10, 10);
      ctx.fillRect(x2 - 5, y - 5, 10, 10);
      if (p.solid) ctx.fillRect((x1 + x2) / 2 - 5, y + depthPx - 5, 10, 10);
    }
  });

  // A 110-unit fighter at the first spawn, for scale.
  const s0 = st.spawns[0];
  if (s0) {
    const [fx, fy] = toScreen(s0.x - 23, s0.y + 110);
    ctx.strokeStyle = 'rgba(255, 209, 90, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(fx, fy, 46 * view.zoom, 110 * view.zoom);
    ctx.setLineDash([]);
  }

  // Art in front of the fighters, farthest first.
  if (showArt) for (const { l, i } of layers.filter(({ l }) => l.z <= 0).sort((a, b) => b.l.z - a.l.z)) drawLayer(ctx, l, i);

  // Spawns and respawn.
  st.spawns.forEach((s, i) => {
    const [sx, sy] = toScreen(s.x, s.y);
    const sel = selection?.kind === 'spawn' && selection.index === i;
    ctx.fillStyle = PLAYER_COLORS[i % 4];
    ctx.beginPath();
    ctx.arc(sx, sy - 10, sel ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#100e0c';
    ctx.font = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), sx, sy - 6.5);
    ctx.textAlign = 'start';
  });
  // Pieces the GPU is painting, on top of everything.
  const painting = paintingNow();
  for (const l of st.layers ?? []) {
    const info = painting.get(l.id);
    if (info && (!l.hidden || l.platforms?.length)) drawPainting(ctx, l, info);
  }

  const [rx, ry] = toScreen(st.respawn.x, st.respawn.y);
  const rsel = selection?.kind === 'respawn';
  ctx.fillStyle = rsel ? '#ffd15a' : '#c9bfff';
  ctx.beginPath();
  ctx.moveTo(rx, ry - 9);
  ctx.lineTo(rx + 9, ry);
  ctx.lineTo(rx, ry + 9);
  ctx.lineTo(rx - 9, ry);
  ctx.fill();
  ctx.fillStyle = 'rgba(201, 191, 255, 0.8)';
  ctx.font = '11px Segoe UI, sans-serif';
  ctx.fillText('respawn', rx + 12, ry + 4);
}

function blastHandle(edge: Edge): [number, number] {
  const b = stage().blast;
  const mx = (b.left + b.right) / 2;
  const my = (b.top + b.bottom) / 2;
  if (edge === 'left') return toScreen(b.left, my);
  if (edge === 'right') return toScreen(b.right, my);
  if (edge === 'top') return toScreen(mx, b.top);
  return toScreen(mx, b.bottom);
}

// ------------------------------------------------------------- pointers

function hitLayer(sx: number, sy: number, wx: number, wy: number): Drag | null {
  const st = stage();
  const layers = st.layers ?? [];
  if (selection?.kind === 'layer' && layers[selection.index]) {
    const l = layers[selection.index];
    const b = layerBox(l);
    const [hx, hy] = toScreen(b.x2, b.y2);
    if (Math.abs(sx - hx) <= 8 && Math.abs(sy - hy) <= 8) return { kind: 'layer', index: selection.index, part: 'size', wx, wy, start: { ...l } };
  }
  // Nearest first: what's in front gets the click.
  const order = layers.map((l, i) => ({ l, i })).filter(({ l }) => !l.hidden).sort((a, b) => a.l.z - b.l.z);
  for (const { l, i } of order) {
    const b = layerBox(l);
    if (wx >= b.x1 && wx <= b.x2 && wy >= b.y1 && wy <= b.y2) return { kind: 'layer', index: i, part: 'body', wx, wy, start: { ...l } };
  }
  return null;
}

function hit(sx: number, sy: number): Drag | null {
  const st = stage();
  const near = (ax: number, ay: number, d = 8) => Math.abs(sx - ax) <= d && Math.abs(sy - ay) <= d;
  const [wx, wy] = toWorld(sx, sy);
  // Art mode: layers come first, so the big ones can be grabbed anywhere.
  if (artMode && showArt) return hitLayer(sx, sy, wx, wy);
  if (selection?.kind === 'platform') {
    const p = st.platforms[selection.index];
    const at = placed(p);
    const [x1, y] = toScreen(at.x1, at.y);
    const [x2] = toScreen(at.x2, at.y);
    if (near(x1, y)) return { kind: 'platform', index: selection.index, part: 'x1', wx, wy, start: { ...p } };
    if (near(x2, y)) return { kind: 'platform', index: selection.index, part: 'x2', wx, wy, start: { ...p } };
    if (p.solid && near((x1 + x2) / 2, y + (p.depth ?? 90) * view.zoom)) return { kind: 'platform', index: selection.index, part: 'depth', wx, wy, start: { ...p } };
  }
  for (let i = 0; i < st.spawns.length; i++) {
    const [px, py] = toScreen(st.spawns[i].x, st.spawns[i].y);
    if (near(px, py - 10, 10)) return { kind: 'spawn', index: i };
  }
  const [rx, ry] = toScreen(st.respawn.x, st.respawn.y);
  if (near(rx, ry, 10)) return { kind: 'respawn' };
  // Topmost platform first: later ones draw over earlier ones.
  for (let i = st.platforms.length - 1; i >= 0; i--) {
    const p = st.platforms[i];
    const at = placed(p);
    const [x1, y] = toScreen(at.x1, at.y);
    const [x2] = toScreen(at.x2, at.y);
    const bottom = y + (p.solid ? (p.depth ?? 90) * view.zoom : 12);
    if (sx >= x1 - 4 && sx <= x2 + 4 && sy >= y - 8 && sy <= bottom) return { kind: 'platform', index: i, part: 'body', wx, wy, start: { ...p } };
  }
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const [hx, hy] = blastHandle(edge);
    if (near(hx, hy, 9)) return { kind: 'blast', edge };
  }
  return null;
}

function onDown(e: PointerEvent): void {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const found = e.button === 0 ? hit(sx, sy) : null;
  if (found) {
    drag = found;
    selection = found.kind === 'platform' ? { kind: 'platform', index: found.index }
      : found.kind === 'spawn' ? { kind: 'spawn', index: found.index }
      : found.kind === 'respawn' ? { kind: 'respawn' }
      : found.kind === 'blast' ? { kind: 'blast', edge: found.edge }
      : found.kind === 'layer' ? { kind: 'layer', index: found.index } : null;
    renderInspector();
  } else {
    drag = { kind: 'pan', sx, sy, cx: view.cx, cy: view.cy };
    if (e.button === 0) {
      selection = null;
      renderInspector();
    }
  }
}

function onMove(e: PointerEvent): void {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  if (!drag) {
    canvas.style.cursor = hit(sx, sy) ? 'move' : 'default';
    return;
  }
  const free = e.shiftKey;
  const [wx, wy] = toWorld(sx, sy);
  const st = stage();
  switch (drag.kind) {
    case 'pan':
      view.cx = drag.cx - (sx - drag.sx) / view.zoom;
      view.cy = drag.cy + (sy - drag.sy) / view.zoom;
      break;
    case 'platform': {
      const p = st.platforms[drag.index];
      const s0 = drag.start;
      if (drag.part === 'body') {
        const dx = snapTo(wx - drag.wx, free);
        const dy = snapTo(wy - drag.wy, free);
        p.x1 = s0.x1 + dx;
        p.x2 = s0.x2 + dx;
        p.y = s0.y + dy;
      } else if (drag.part === 'x1') p.x1 = Math.min(snapTo(wx, free), p.x2 - 20);
      else if (drag.part === 'x2') p.x2 = Math.max(snapTo(wx, free), p.x1 + 20);
      else p.depth = Math.max(10, snapTo(p.y - wy, free));
      setDirty();
      break;
    }
    case 'spawn': {
      const sp = st.spawns[drag.index];
      sp.x = snapTo(wx, free);
      // Spawns snap onto the platform under them, so fighters start standing.
      const y = snapTo(wy, true);
      const on = st.platforms.filter((p) => sp.x >= p.x1 && sp.x <= p.x2 && Math.abs(p.y - y) < 25 / view.zoom);
      sp.y = on.length ? on.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0].y : snapTo(wy, free);
      setDirty();
      break;
    }
    case 'respawn':
      st.respawn.x = snapTo(wx, free);
      st.respawn.y = snapTo(wy, free);
      setDirty();
      break;
    case 'blast': {
      const b = st.blast;
      if (drag.edge === 'left') b.left = Math.min(snapTo(wx, free), b.right - 200);
      if (drag.edge === 'right') b.right = Math.max(snapTo(wx, free), b.left + 200);
      if (drag.edge === 'top') b.top = Math.max(snapTo(wy, free), b.bottom + 200);
      if (drag.edge === 'bottom') b.bottom = Math.min(snapTo(wy, free), b.top - 200);
      setDirty();
      break;
    }
    case 'layer': {
      const l = st.layers![drag.index];
      const s0 = drag.start;
      if (drag.part === 'body') {
        l.x = s0.x + snapTo(wx - drag.wx, free);
        l.y = s0.y + snapTo(wy - drag.wy, free);
      } else {
        // The corner handle scales around the center, keeping the image's shape.
        l.width = Math.max(20, snapTo(Math.abs(wx - s0.x) * 2, free));
      }
      setDirty();
      break;
    }
  }
}

function onUp(): void {
  if (drag && drag.kind !== 'pan') {
    renderInspector();
    schedulePreview();
  }
  drag = null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const [wx, wy] = toWorld(sx, sy);
  view.zoom = Math.max(0.05, Math.min(4, view.zoom * Math.exp(-e.deltaY * 0.0015)));
  // Keep the point under the cursor still.
  view.cx = wx - (sx - r.width / 2) / view.zoom;
  view.cy = wy - (r.height / 2 - sy) / view.zoom;
}

function onKey(e: KeyboardEvent): void {
  if (root.hidden || (e.target as HTMLElement).closest('input, textarea, select')) return;
  const st = stage();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') {
    e.preventDefault();
    void save();
    return;
  }
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undo(!e.shiftKey);
    return;
  }
  if (mod && e.key === 'y') {
    e.preventDefault();
    undo(false);
    return;
  }
  const sel = selection;
  if (sel?.kind !== 'platform' && sel?.kind !== 'layer') return;
  const step = e.shiftKey ? 1 : snap;
  const nudge = (dx: number, dy: number) => {
    if (sel.kind === 'platform') {
      const p = st.platforms[sel.index];
      p.x1 += dx;
      p.x2 += dx;
      p.y += dy;
    } else {
      const l = st.layers![sel.index];
      l.x += dx;
      l.y += dy;
    }
    setDirty();
    renderInspector();
  };
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (sel.kind === 'platform') removePlatform(sel.index);
    else removeLayer(sel.index);
  } else if (mod && e.key === 'd') {
    e.preventDefault();
    if (sel.kind === 'platform') duplicatePlatform(sel.index);
    else duplicateLayer(sel.index);
  } else if (e.key === 'ArrowLeft') nudge(-step, 0);
  else if (e.key === 'ArrowRight') nudge(step, 0);
  else if (e.key === 'ArrowUp') nudge(0, step);
  else if (e.key === 'ArrowDown') nudge(0, -step);
  else return;
  e.preventDefault();
}

// --------------------------------------------------------------- editing

function setDirty(): void {
  dirty = true;
  recordChange();
  root.querySelector<HTMLButtonElement>('[data-save]')!.disabled = false;
  root.querySelector('[data-dirty]')!.textContent = 'Unsaved changes';
  if (!drag) schedulePreview();
}

function addPlatform(solid: boolean): void {
  const st = stage();
  const x = snapTo(view.cx);
  const y = snapTo(Math.max(0, view.cy));
  st.platforms.push(solid ? { x1: x - 250, x2: x + 250, y, solid: true, depth: 90 } : { x1: x - 110, x2: x + 110, y, solid: false });
  selection = { kind: 'platform', index: st.platforms.length - 1 };
  setDirty();
  renderInspector();
}

function removePlatform(i: number): void {
  stage().platforms.splice(i, 1);
  relinkAfterRemoving(i);
  selection = null;
  setDirty();
  renderInspector();
}

function duplicatePlatform(i: number, mirror = false): void {
  const p = structuredClone(stage().platforms[i]);
  if (mirror) {
    [p.x1, p.x2] = [-p.x2, -p.x1];
    if (p.motion) p.motion.ax = -p.motion.ax;
  } else {
    p.x1 += 60;
    p.x2 += 60;
    p.y += 40;
  }
  stage().platforms.push(p);
  selection = { kind: 'platform', index: stage().platforms.length - 1 };
  setDirty();
  renderInspector();
}

function addLayer(l: Partial<StageLayer>): void {
  const st = stage();
  st.layers ??= [];
  const taken = new Set(st.layers.map((x) => x.id));
  let id = l.id || 'layer';
  for (let n = 2; taken.has(id); n++) id = `${l.id || 'layer'}-${n}`;
  st.layers.push({ image: '', x: snapTo(view.cx), y: snapTo(view.cy), width: 600, z: 5, ...l, id });
  selection = { kind: 'layer', index: st.layers.length - 1 };
  artMode = true;
  setDirty();
  renderAll();
}

/** Moves a layer later (in front, at the same depth) or earlier in the list. */
function moveLayer(i: number, by: number): void {
  const layers = stage().layers!;
  const j = i + by;
  if (j < 0 || j >= layers.length) return;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  if (selection?.kind === 'layer') selection = { kind: 'layer', index: selection.index === i ? j : selection.index === j ? i : selection.index };
  setDirty();
  renderInspector();
}

/** Platform indices shift when one is removed; layers that drew it let go. */
function relinkAfterRemoving(n: number): void {
  for (const l of stage().layers ?? []) {
    if (!l.platforms) continue;
    const next = l.platforms.filter((x) => x !== n).map((x) => (x > n ? x - 1 : x));
    l.platforms = next.length ? next : undefined;
  }
}

function removeLayer(i: number): void {
  stage().layers?.splice(i, 1);
  selection = null;
  setDirty();
  renderInspector();
}

function duplicateLayer(i: number, mirror = false): void {
  const l = structuredClone(stage().layers![i]);
  if (mirror) l.x = -l.x;
  else {
    l.x += 60;
    l.y -= 40;
  }
  addLayer({ ...l, id: `${l.id}-${mirror ? 'mirror' : 'copy'}` });
}

/** Uploads an image into the stage's art folder; resolves to its site path. */
async function uploadArt(): Promise<string | null> {
  const file = await pickFile('image/png,image/jpeg,image/webp');
  if (!file) return null;
  const st = stage();
  const out = await attempt(() => api.upload<{ path: string }>(`/maps/layer/upload?stage=${encodeURIComponent(st.id)}&name=${encodeURIComponent(file.name)}`, file));
  if (!out) return null;
  images.delete(out.path);
  artFiles.delete(st.id);
  return out.path;
}

async function loadArtFiles(id: string): Promise<void> {
  if (artFiles.has(id)) return;
  artFiles.set(id, []);
  const r = await api.get<{ files: { path: string }[] }>(`/maps/art?stage=${encodeURIComponent(id)}`).catch(() => ({ files: [] }));
  artFiles.set(id, r.files.map((f) => f.path));
  if (stage()?.id === id) renderInspector();
}

/** Stage data the sim can read: integers where it needs them, nothing empty left behind. */
function cleaned(): StageDef[] {
  const out = structuredClone(stages);
  const r = Math.round;
  for (const s of out) {
    s.platforms = s.platforms.map((p) => {
      const q: Platform = { x1: r(p.x1), x2: r(p.x2), y: r(p.y), solid: p.solid };
      if (p.solid) q.depth = r(p.depth ?? 90);
      if (p.motion && !p.solid) q.motion = { ax: r(p.motion.ax), ay: r(p.motion.ay), period: Math.max(1, r(p.motion.period)), ...(p.motion.phase ? { phase: r(p.motion.phase) } : {}) };
      if (p.hidden) q.hidden = true;
      return q;
    });
    s.spawns = s.spawns.map((p) => ({ x: r(p.x), y: r(p.y) }));
    s.respawn = { x: r(s.respawn.x), y: r(s.respawn.y) };
    s.blast = { left: r(s.blast.left), right: r(s.blast.right), top: r(s.blast.top), bottom: r(s.blast.bottom) };
    if (s.layers?.length) {
      s.layers = s.layers.map((l) => {
        const q: StageLayer = { id: l.id, image: l.image ?? '', x: r(l.x), y: r(l.y), width: Math.max(1, r(l.width)), z: Math.round(l.z * 10) / 10 };
        if (l.opacity !== undefined && l.opacity < 1) q.opacity = Math.round(l.opacity * 100) / 100;
        if (l.occluder && l.z < 0) q.occluder = true;
        if (l.glow) q.glow = true;
        if (l.hidden) q.hidden = true;
        if (l.note) q.note = l.note;
        if (l.prompt) q.prompt = l.prompt;
        if (l.aspect) q.aspect = Math.round(l.aspect * 1000) / 1000;
        if (l.shape?.length) q.shape = l.shape.map((p) => ({ x1: r(p.x1), x2: r(p.x2), y1: r(p.y1), y2: r(p.y2) }));
        const links = (l.platforms ?? []).filter((n) => n >= 0 && n < s.platforms.length);
        if (links.length) q.platforms = [...new Set(links)].sort((a, b) => a - b);
        return q;
      });
    } else delete s.layers;
    if (!s.effects?.length) delete s.effects;
    if (!s.notes?.trim()) delete s.notes;
    if (!s.source) delete s.source;
  }
  return out;
}

function issues(st: StageDef): string[] {
  const out: string[] = [];
  const solids = st.platforms.filter((p) => p.solid);
  if (!solids.length) out.push('No solid platform: there is nowhere to grab a ledge or recover to.');
  if (st.spawns.length < 4) out.push(`Only ${st.spawns.length} spawn points; four-player matches need four.`);
  st.spawns.forEach((s, i) => {
    if (!st.platforms.some((p) => p.y === s.y && s.x >= p.x1 && s.x <= p.x2)) out.push(`Spawn ${i + 1} is not standing on a platform, so that fighter starts falling.`);
  });
  const b = st.blast;
  const inBlast = (x: number, y: number) => x > b.left && x < b.right && y > b.bottom && y < b.top;
  if (!inBlast(st.respawn.x, st.respawn.y)) out.push('The respawn point is outside the blast zone.');
  st.platforms.forEach((p, i) => {
    const reach = p.motion?.ax ?? 0;
    if (!inBlast(p.x1 - reach, p.y) || !inBlast(p.x2 + reach, p.y)) out.push(`Platform ${i + 1} reaches past the blast zone.`);
    if (p.motion && p.motion.period < 90) out.push(`Platform ${i + 1} moves very fast (period ${p.motion.period} frames).`);
    if (p.motion && p.solid) out.push(`Platform ${i + 1} is solid and moving; only thin platforms move in the game.`);
  });
  if (stages.filter((s) => s.id === st.id).length > 1) out.push(`Another stage already uses the id "${st.id}".`);
  if (b.right - b.left < 1600) out.push('The blast zone is narrow; launches will KO very early.');
  const layers = st.layers ?? [];
  const todo = layers.filter((l) => !l.image && !l.hidden).length;
  if (todo) out.push(`${todo} art layer${todo > 1 ? 's' : ''} still to paint (dashed outlines).`);
  const overlaps = (l: StageLayer, p: Platform, below: number) => {
    const bx = layerBox(l);
    const m = Math.min(60, Math.max(20, (bx.y2 - bx.y1) * 0.25));
    return p.x2 > bx.x1 && p.x1 < bx.x2 && p.y >= bx.y1 - m && p.y - below <= bx.y2 + m;
  };
  st.platforms.forEach((p, i) => {
    if (!p.hidden) return;
    const art = layers.filter((l) => !l.hidden && l.platforms?.includes(i));
    if (!art.length) out.push(`Platform ${i + 1} is collision only, but no layer draws it (a layer's "Draws platforms"), so it keeps its default block.`);
    else if (!art.some((l) => l.image)) out.push(`Platform ${i + 1}'s art (${art.map((l) => l.id).join(', ')}) isn't painted yet; it shows its default block until then.`);
  });
  layers.forEach((l) => {
    if (l.platforms?.length && Math.abs(l.z - 0.3) > 0.5) out.push(`Layer ${l.id} draws platforms but sits at depth ${l.z}: parallax slides it off them as the camera moves. Use the "Platform art (0.3)" depth.`);
  });
  layers.forEach((l) => {
    // Between -1.2 and 3 a layer cuts through the default blocks of visible platforms.
    const cuts = !l.platforms?.length && st.platforms.some((p) => !p.hidden && overlaps(l, p, p.solid ? (p.depth ?? 90) * 2.5 : 10));
    if (l.z > -1.2 && l.z < 3 && l.z !== 0 && cuts) out.push(`Layer ${l.id} at depth ${l.z} cuts through a platform's default block; use 3 or more behind, -1.5 or less in front, or make that platform collision only.`);
    if (l.occluder && l.z >= 0) out.push(`Layer ${l.id} is an occluder but sits behind the fighters; occluders only work in front.`);
  });
  return out;
}

async function save(): Promise<void> {
  const ok = await attempt(() => api.save('stages', cleaned()), 'Stages saved. Open game tabs reload.');
  if (ok) {
    stages = cleaned();
    dirty = false;
    // What can be painted comes from the saved stage: read it again.
    paintInfo = null;
    renderAll();
  }
}

async function load(): Promise<void> {
  stages = await api.content<StageDef[]>('stages');
  current = Math.min(current, stages.length - 1);
  dirty = false;
  selection = null;
  resetHistory();
}

function newStage(copyFrom?: StageDef): void {
  const name = prompt('Name of the stage?', copyFrom ? `${copyFrom.name} copy` : 'New stage');
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id || stages.some((s) => s.id === id)) {
    toast(`A stage with id ${id || '(empty)'} already exists.`, 'error');
    return;
  }
  const base: StageDef = copyFrom
    ? structuredClone(copyFrom)
    : {
        id, name, blurb: '',
        platforms: [{ x1: -560, x2: 560, y: 0, solid: true, depth: 90 }],
        blast: { left: -1400, right: 1400, top: 1150, bottom: -750 },
        spawns: [{ x: -300, y: 0 }, { x: 300, y: 0 }, { x: -110, y: 0 }, { x: 110, y: 0 }],
        respawn: { x: 0, y: 420 },
        theme: { ...stages[0].theme },
      };
  base.id = id;
  base.name = name;
  delete base.source;
  stages.push(base);
  current = stages.length - 1;
  selection = null;
  dirty = true;
  resetHistory();
  renderAll();
  fit();
}

// -------------------------------------------------------------- concepts

async function loadConcepts(): Promise<void> {
  const r = await api.get<{ root: string; exists: boolean; concepts: Concept[] }>('/maps/concepts');
  conceptsRoot = r.exists ? r.root : '';
  concepts = r.concepts;
}

const conceptUrl = (c: Concept, file: string, mtime = 0) => `/api/dev/maps/concept-file?folder=${encodeURIComponent(c.folder)}&file=${encodeURIComponent(file)}&v=${mtime}`;

/**
 * Asks Claude for designs for a concept folder (or revisions of base, with
 * feedback) and shows them to pick from.
 */
async function generate(c: Concept, revise?: { base: StageDef; feedback: string }): Promise<void> {
  generating = c.folder;
  renderList();
  renderDesigns();
  try {
    const out = await api.post<{ designs: { stage: StageDef; preview: string }[]; ai: boolean; why?: string }>('/maps/generate', {
      folder: c.folder, direction: directions.get(c.folder) ?? '', count: designCount,
      ...(revise ? { base: stripForClaude(revise.base), feedback: revise.feedback } : {}),
    });
    designs = { folder: c.folder, list: out.designs, ai: out.ai, why: out.why };
    if (!out.ai) toast(out.why ?? 'A plain draft.', 'error');
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    generating = null;
    renderList();
    renderDesigns();
  }
}

/** A design as Claude should see it to revise it: no file paths or editor-only fields. */
function stripForClaude(st: StageDef): unknown {
  const s = structuredClone(st);
  for (const l of s.layers ?? []) l.image = l.image ? '(painted)' : '';
  return s;
}

/** Opens a design in the editor (unsaved). */
function useDesign(stage: StageDef): void {
  const existing = stages.findIndex((s) => s.source === stage.source);
  if (existing >= 0 && !confirm(`Replace ${stages[existing].name} with this design? Nothing is saved until you Save stages.`)) return;
  const at = existing >= 0 ? existing : stages.findIndex((s) => s.id === stage.id);
  if (at >= 0) {
    stages[at] = structuredClone(stage);
    current = at;
  } else {
    stages.push(structuredClone(stage));
    current = stages.length - 1;
  }
  artFiles.delete(stage.id);
  dirty = true;
  selection = null;
  designs = null;
  paintInfo = null;
  review = null;
  resetHistory();
  renderAll();
  renderDesigns();
  fit();
  toast(`${stage.name} is open. Save stages, then paint it (Paint card on the right).`);
}

let designsEl: HTMLElement | null = null;
function renderDesigns(): void {
  designsEl?.remove();
  designsEl = null;
  const c = designs ? concepts.find((x) => x.folder === designs!.folder) : generating ? concepts.find((x) => x.folder === generating) : null;
  if (!c) return;
  const el = h('div', { class: 'map-designs' },
    h('div', { class: 'row' }, h('strong', {}, `${c.name}: designs`), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => { designs = null; renderDesigns(); } }, 'Close')),
    generating ? h('p', { class: 'hint' }, `Claude is designing ${designCount} take${designCount > 1 ? 's' : ''} on ${c.name}… (about a minute)`) : null,
    designs ? h('div', { class: 'design-grid' }, ...designs.list.map((d) => h('div', { class: 'design' },
      h('img', { src: d.preview, alt: d.stage.name }),
      h('strong', {}, d.stage.name),
      h('p', { class: 'hint' }, d.stage.blurb),
      d.stage.art?.style ? h('p', { class: 'hint' }, h('b', {}, 'Look: '), d.stage.art.style) : null,
      h('details', {}, h('summary', { class: 'muted' }, 'Design notes'), h('p', { class: 'hint', style: 'white-space:pre-wrap' }, d.stage.notes ?? '')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small primary', onclick: () => useDesign(d.stage) }, 'Use this'),
        h('button', { type: 'button', class: 'btn small', disabled: !!generating || !designs?.ai, onclick: () => {
          const feedback = prompt('What should change? (e.g. "more vertical, the fire escape higher, a cozier LA rooftop with palm trees")');
          if (feedback?.trim()) void generate(c, { base: d.stage, feedback });
        } }, 'Revise…'))))) : null,
  );
  root.querySelector('.map-view')!.append(el);
  designsEl = el;
}

// ----------------------------------------------------------------- paint

const activeJob = (j: GpuJob) => j.status === 'queued' || j.status === 'running';

/** The paint jobs for a stage, oldest first. */
function paintJobs(stageId: string): GpuJob[] {
  return (gpuSnapshot()?.jobs ?? []).filter((j) => j.type === 'paint' && j.stage === stageId);
}

/** The latest job for a piece (running or waiting first). */
function pieceJob(stageId: string, piece: string): GpuJob | undefined {
  const jobs = paintJobs(stageId).filter((j) => j.piece === piece);
  return jobs.filter(activeJob).pop() ?? jobs.pop();
}

/** Layer ids a piece paints (the stage piece covers several). */
function pieceLayers(piece: string): string[] {
  return paintInfo?.pieces.find((p) => p.id === piece)?.layers ?? [piece];
}

/** A piece's job, as a status line with a progress bar; updates itself every second. */
function jobState(j: GpuJob | undefined, st: StageDef): HTMLElement | null {
  if (!j) return null;
  const all = gpuSnapshot()?.jobs ?? [];
  if (j.status === 'failed' || j.status === 'interrupted') {
    return h('div', { class: 'job-state' },
      h('span', { class: 'hint warn' }, `${j.status === 'failed' ? 'Failed' : 'Interrupted'}: ${j.detail}`),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: async () => {
        askToNotify();
        if (await attempt(() => gpu.rerun(j.id), 'Queued again.')) await refreshGpu();
      } }, 'Retry')));
  }
  if (!activeJob(j)) return null;
  const p = progressOf(j, all);
  const text = h('span', { class: 'muted' }, j.status === 'running' ? `${j.detail || 'painting'} · ${p.label} · about ${duration(p.left)} left` : `${p.label} · about ${duration(p.left)}`);
  const b = bar(p.fraction, 'wide');
  const el = h('div', { class: 'job-state', 'data-job': j.id }, b, text);
  // Move the bar between polls without redrawing the inspector.
  const timer = window.setInterval(() => {
    if (!el.isConnected) return clearInterval(timer);
    const now = gpuSnapshot()?.jobs.find((x) => x.id === j.id);
    if (!now || !activeJob(now)) return clearInterval(timer);
    const q = progressOf(now, gpuSnapshot()!.jobs);
    (b.firstChild as HTMLElement).style.width = `${Math.round(q.fraction * 100)}%`;
    text.textContent = now.status === 'running' ? `${now.detail || 'painting'} · ${q.label} · about ${duration(q.left)} left` : `${q.label} · about ${duration(q.left)}`;
  }, 1000);
  void st;
  return el;
}

/** Everything about this stage's paint jobs that should redraw the Paint card. */
function paintSignature(stageId: string): string {
  return JSON.stringify(paintJobs(stageId).map((j) => [j.id, j.status, j.outputs?.length ?? 0]));
}

async function loadPaint(id: string): Promise<void> {
  paintInfo = { stage: id, ...(await api.get<{ pieces: { id: string; kind: string; layers: string[] }[]; takes: Record<string, Take[]> }>(`/maps/takes?stage=${encodeURIComponent(id)}`)) };
  if (stage()?.id === id) renderInspector();
}

/** Queues painting pieces of the saved stage (all of them when ids is 'all'). */
async function paintPieces(ids: string[] | 'all', promptFor?: string): Promise<void> {
  const st = stage();
  if (dirty) {
    toast('Save stages first: painting uses the saved stage.', 'error');
    return;
  }
  askToNotify();
  // The pieces as saved right now, not as they were when the card was drawn.
  await loadPaint(st.id);
  const known = new Set(paintInfo?.pieces.map((p) => p.id));
  // A piece already waiting or painting isn't queued twice.
  const busy = new Set(paintJobs(st.id).filter(activeJob).map((j) => j.piece));
  const skipped = (ids === 'all' ? [...known] : ids).filter((id) => busy.has(id));
  ids = (ids === 'all' ? [...known] : ids.filter((id) => known.has(id))).filter((id) => !busy.has(id));
  if (!ids.length) {
    toast(skipped.length ? 'Those pieces are already painting.' : 'Nothing to paint in the saved stage.', skipped.length ? 'ok' : 'error');
    return;
  }
  const specs = ids.map((piece) => ({ type: 'paint' as const, stage: st.id, piece, takes: 2, ...(promptFor ? { prompt: promptFor } : {}) }));
  const ok = await attempt(() => gpu.queue(specs as never));
  if (!ok) return;
  await refreshGpu().catch(() => undefined);
  const live = ready(gpuSnapshot()?.server);
  toast(`Queued ${ids.length} piece${ids.length > 1 ? 's' : ''} (2 takes each).${live ? '' : ' They paint once the GPU server is running (GPU tab).'}`);
}

/** Puts a painted take into the stage (unsaved). */
function useTake(pieceId: string, t: Take): void {
  const st = stage();
  const r = t.recipe;
  if (!r) return;
  const place = { image: t.file, x: r.x, y: r.y, width: r.width, aspect: Math.round((r.size[1] / r.size[0]) * 1000) / 1000 };
  st.layers ??= [];
  if (r.kind === 'stage') {
    // One painting for every piece that draws platforms; the placeholders stay, hidden, as notes.
    const members = st.layers.filter((l) => r.layers.includes(l.id) && l.id !== 'stage-art');
    const links = [...new Set(members.flatMap((l) => l.platforms ?? []))].sort((a, b) => a - b);
    let art = st.layers.find((l) => l.id === 'stage-art');
    if (!art) {
      art = { id: 'stage-art', image: '', x: 0, y: 0, width: 1, z: 0.3, note: 'The painted stage: every piece that draws platforms.' };
      st.layers.push(art);
    }
    Object.assign(art, place, { z: 0.3, platforms: links, hidden: undefined });
    for (const m of members) m.hidden = true;
  } else {
    const l = st.layers.find((x) => x.id === pieceId);
    if (!l) return;
    Object.assign(l, place);
    if (r.kind === 'backdrop') delete l.shape;
  }
  images.delete(t.file);
  setDirty();
  renderAll();
  toast('Using that take. Save stages to keep it.');
}

async function runReview(): Promise<void> {
  const st = cleaned()[current];
  reviewing = true;
  renderInspector();
  try {
    const out = await api.post<{ review: NonNullable<typeof review>['review']; image: string }>('/maps/review', { stage: st });
    review = { stage: st.id, image: out.image, review: out.review };
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    reviewing = false;
    renderInspector();
  }
}

function paintCard(st: StageDef): HTMLElement {
  if (paintInfo?.stage !== st.id) {
    paintInfo = { stage: st.id, pieces: [], takes: {} };
    void loadPaint(st.id).catch(() => undefined);
  }
  const info = paintInfo;
  const server = gpuSnapshot()?.server;
  const live = ready(server);
  const style = h('textarea', { placeholder: 'Rendering style, palette, lighting, mood: every piece is painted in it.', style: 'min-height:56px' });
  style.value = st.art?.style ?? '';
  style.addEventListener('input', () => { st.art = { ...(st.art ?? {}), style: style.value }; setDirty(); });
  const pieceRow = (p: { id: string; kind: string; layers: string[] }) => {
    // Takes that draw platforms are scored on how well they land on them: best first.
    const fitOf = (t: Take) => t.recipe?.fit?.score ?? null;
    const takes = [...(info.takes[p.id] ?? [])].sort((a, b) => (fitOf(b) ?? -1) - (fitOf(a) ?? -1) || b.mtime - a.mtime);
    const job = pieceJob(st.id, p.id);
    const working = !!job && activeJob(job);
    return h('div', { class: `paint-piece${working ? ' working' : ''}` },
      h('div', { class: 'row' }, h('strong', {}, p.id), h('span', { class: 'muted' }, p.kind === 'stage' ? `${p.layers.length} pieces, one painting` : p.kind), h('span', { class: 'spacer' }),
        working ? h('span', { class: `badge ${job!.status === 'running' ? 'warn' : ''}` }, job!.status === 'running' ? 'painting' : 'waiting')
          : h('button', { type: 'button', class: 'btn small', onclick: () => paintPieces([p.id]) }, takes.length ? 'Paint more' : 'Paint')),
      jobState(job, st),
      takes.length ? h('div', { class: 'take-grid small' }, ...takes.slice(0, 6).map((t) => h('div', { class: 'take' },
        h('a', { href: `/${t.file}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/${t.file}?v=${t.mtime}`, alt: `seed ${t.seed}`, title: t.recipe?.prompt ?? '', class: 'checker' })),
        fitOf(t) !== null ? h('span', {
          class: `badge ${fitOf(t)! >= 0.85 ? 'ok' : fitOf(t)! >= 0.6 ? 'warn' : 'bad'}`,
          title: `How well its walkable tops land on the platforms (per platform: ${(t.recipe!.fit!.platforms).map((v, i) => `${i + 1}: ${v === null ? '—' : Math.round(v * 100) + '%'}`).join(', ')}). Below about 60% it will look off in the game.`,
        }, `fits ${Math.round(fitOf(t)! * 100)}%`) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => useTake(p.id, t) }, 'Use'),
          h('button', { type: 'button', class: 'btn small', onclick: async () => { if (await attempt(() => api.post('/maps/take/discard', { stage: st.id, file: t.file }))) await loadPaint(st.id); } }, '×'))))) : null);
  };
  return h('div', { class: 'card' },
    h('h3', {}, 'Paint', h('span', { class: 'spacer' }), h('span', { class: `badge ${live ? 'ok' : 'warn'}` }, live ? 'GPU ready' : server?.exists ? `GPU ${server.state}` : 'no GPU server')),
    h('p', { class: 'hint' }, 'The GPU server paints each piece over its blockout, in the style of the concept, so the art lands on the platforms. Two takes per piece; Use one.'),
    paintJobs(st.id).some(activeJob) ? h('div', { class: 'paint-banner' },
      h('strong', {}, `Painting: ${paintJobs(st.id).filter((j) => j.status === 'done' && j.created >= (paintJobs(st.id).filter(activeJob)[0]?.created ?? 0)).length} of ${paintJobs(st.id).filter((j) => j.created >= (paintJobs(st.id).filter(activeJob)[0]?.created ?? 0)).length} pieces done. `),
      'It runs on the dev server: keep working, refresh, playtest or close devtools, and new takes show up here (and as a notification). Each piece paints the stage as saved when it starts; just don’t stop the dev server.') : null,
    field('Art direction', style, { wide: true }),
    !st.art?.reference ? h('p', { class: 'hint warn' }, 'No concept image to paint from: generate this stage from its AllTheMaps folder.') : null,
    dirty ? h('p', { class: 'hint warn' }, 'Save stages first: painting uses the saved stage.') : null,
    info.pieces.length ? h('div', {}, ...info.pieces.map(pieceRow)) : h('p', { class: 'hint' }, 'Nothing to paint yet (save the stage first).'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small primary', disabled: !info.pieces.length || dirty || info.pieces.every((p) => { const j = pieceJob(st.id, p.id); return !!j && activeJob(j); }), onclick: () => paintPieces('all') }, `Paint everything (${info.pieces.length})`),
      h('button', { type: 'button', class: 'btn small', onclick: () => loadPaint(st.id) }, 'Refresh takes'),
      h('a', { class: 'btn small', href: '#gpu' }, 'GPU tab')),
  );
}

function reviewCard(st: StageDef): HTMLElement {
  const r = review?.stage === st.id ? review : null;
  return h('div', { class: 'card' },
    h('h3', {}, 'Art director', h('span', { class: 'spacer' }), r ? h('span', { class: `badge ${r.review.score >= 7 ? 'ok' : 'warn'}` }, `${r.review.score}/10`) : null),
    h('p', { class: 'hint' }, 'Claude looks at the stage next to the concept and the reference, and says what to fix. About 5¢.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', disabled: reviewing, onclick: runReview }, reviewing ? 'Looking…' : r ? 'Review again' : 'Review this stage')),
    r ? h('div', { class: 'review' },
      h('a', { href: r.image, target: '_blank', rel: 'noopener' }, h('img', { src: r.image, alt: 'What the review saw', style: 'width:100%;border-radius:6px' })),
      h('p', {}, r.review.summary),
      h('p', { class: 'hint' }, h('b', {}, 'Works: '), r.review.works),
      h('ol', { style: 'margin:0;padding-left:18px;display:grid;gap:8px' }, ...r.review.issues.map((i) => h('li', {},
        h('strong', {}, i.target), ': ', i.problem, h('div', { class: 'hint' }, i.fix),
        i.repaint && (paintInfo?.pieces.some((p) => p.id === i.target)) ? h('button', { type: 'button', class: 'btn small', title: i.repaint, onclick: () => paintPieces([i.target], i.repaint) }, 'Repaint with this') : null,
        i.target === 'style' && i.repaint ? h('button', { type: 'button', class: 'btn small', onclick: () => { st.art = { ...(st.art ?? {}), style: i.repaint }; setDirty(); renderInspector(); } }, 'Use as art direction') : null)))) : null,
  );
}

// ------------------------------------------------------------ 3D preview

interface Preview {
  el: HTMLElement;
  renderer: import('../../game/render/renderer.ts').Renderer;
  state: import('../../game/sim/state.ts').GameState;
  stop: () => void;
  walker: { x: number; y: number };
}
let pv: Preview | null = null;
let pvTimer = 0;
let pvBusy = false;

async function togglePreview(): Promise<void> {
  if (pv) {
    closePreview();
    return;
  }
  const [{ Renderer }, { newGame }, { CHARACTERS }] = await Promise.all([
    import('../../game/render/renderer.ts'),
    import('../../game/sim/state.ts'),
    import('../../game/sim/characters.ts'),
  ]);
  const cv = h('canvas', {});
  const renderer = new Renderer(cv);
  const pick = (id: string, d: number) => Math.max(0, CHARACTERS.findIndex((c) => c.id === id)) || d;
  const state = newGame([{ char: pick('exit-punk', 0) }, { char: pick('break', 1) }], { stocks: 3, seed: 1, stage: 0 });
  const walker = { x: stage().spawns[0]?.x ?? -200, y: stage().spawns[0]?.y ?? 0 };
  const sx = h('input', { type: 'range', min: stage().blast.left, max: stage().blast.right, step: 5, value: walker.x, style: 'flex:1' });
  const sy = h('input', { type: 'range', min: -300, max: Math.max(600, stage().blast.top - 200), step: 5, value: walker.y, style: 'flex:1' });
  sx.addEventListener('input', () => (walker.x = Number(sx.value)));
  sy.addEventListener('input', () => (walker.y = Number(sy.value)));
  const el = h(
    'div',
    { class: 'map-preview' },
    h('div', { class: 'row' }, h('strong', {}, '3D preview'), h('span', { class: 'muted' }, 'the game renderer, unsaved changes included'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => { el.classList.toggle('big'); requestAnimationFrame(() => pv?.renderer.engine.resize()); } }, 'Expand'),
      h('button', { type: 'button', class: 'btn small', onclick: closePreview }, 'Close')),
    cv,
    h('div', { class: 'row' }, h('span', { class: 'muted', style: 'width:64px' }, 'Fighter x'), sx),
    h('div', { class: 'row' }, h('span', { class: 'muted', style: 'width:64px' }, 'Fighter y'), sy),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', title: 'What a KO looks like here', onclick: () => {
        const f = pv?.state.fighters[1];
        if (f) pv!.renderer.onEvents([{ type: 'ko', victim: 1, by: 0, x: f.x, y: f.y + 600 * 1000 }]);
      } }, 'KO'),
      h('button', { type: 'button', class: 'btn small', onclick: () => pv?.renderer.stageEvent('start') }, 'Match start'),
      h('button', { type: 'button', class: 'btn small', onclick: () => pv?.renderer.stageEvent('end') }, 'Finale'),
      h('span', { class: 'hint' }, 'Move the fighter behind front art to check the silhouette.')),
  );
  root.querySelector('.map-view')!.append(el);
  const stop = animate(() => {
    if (!pv || root.hidden) return;
    const f = pv.state.fighters[0];
    f.x = Math.round(pv.walker.x) * 1000;
    f.y = Math.round(pv.walker.y) * 1000;
    pv.state.frame++;
    pv.renderer.render(pv.state);
  });
  pv = { el, renderer, state, stop, walker };
  // For poking at from the browser console.
  (window as unknown as { dodPreview: Preview }).dodPreview = pv;
  await rebuildPreview();
  renderer.engine.resize();
}

function closePreview(): void {
  if (!pv) return;
  pv.stop();
  pv.renderer.dispose();
  pv.el.remove();
  pv = null;
}

function schedulePreview(): void {
  if (!pv) return;
  clearTimeout(pvTimer);
  pvTimer = window.setTimeout(() => void rebuildPreview(), 500);
}

async function rebuildPreview(): Promise<void> {
  if (!pv || pvBusy) return;
  pvBusy = true;
  try {
    const st = cleaned()[current];
    // Fighters stand on the edited stage's spawns.
    pv.state.fighters.forEach((f, i) => {
      const sp = st.spawns[i % st.spawns.length];
      if (i > 0) {
        f.x = sp.x * 1000;
        f.y = sp.y * 1000;
      }
      f.grounded = 1;
    });
    pv.renderer.showStage(st);
    await pv.renderer.setFighters(pv.state, true);
  } finally {
    pvBusy = false;
  }
}

// ------------------------------------------------------------- inspector

function renderList(): void {
  const imported = (c: Concept) => stages.find((s) => s.source === c.folder);
  listEl.replaceChildren(
    ...stages.map((s, i) =>
      h('button', { type: 'button', class: `fighter-item stage-item${i === current ? ' active' : ''}`, style: 'grid-template-columns:1fr auto', onclick: () => {
        current = i;
        selection = null;
        resetHistory();
        renderAll();
        fit();
        schedulePreview();
      } }, h('div', {}, h('strong', {}, s.name), h('span', {}, s.id)), (() => {
        const jobs = paintJobs(s.id).filter(activeJob);
        return jobs.length ? h('span', { class: 'badge warn', title: 'Pieces painting or waiting' }, `🎨 ${jobs.length}`) : h('span', { class: 'badge' }, `${s.platforms.length}`);
      })()),
    ),
    h('div', { class: 'row', style: 'padding:6px 2px' },
      h('button', { type: 'button', class: 'btn small', onclick: () => newStage() }, 'New'),
      h('button', { type: 'button', class: 'btn small', onclick: () => newStage(stage()) }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn small danger', disabled: stages.length < 2, onclick: () => {
        if (!confirm(`Delete ${stage().name}? Campaign chapters that use it fall back to the first stage.`)) return;
        stages.splice(current, 1);
        current = 0;
        dirty = true;
        resetHistory();
        renderAll();
        fit();
      } }, 'Delete')),
    h('div', { class: 'side-head', style: 'margin-top:10px' }, h('strong', {}, 'Concepts'), h('span', { class: 'spacer' }),
      select<string>([['1', '1 design'], ['2', '2 designs'], ['3', '3 designs'], ['4', '4 designs']], String(designCount), (v) => (designCount = Number(v))),
      h('button', { type: 'button', class: 'btn small', title: 'Read the maps folder again', onclick: async () => { await attempt(loadConcepts); renderList(); } }, 'Rescan')),
    conceptsRoot
      ? concepts.length
        ? h('div', {}, ...concepts.map((c) => {
            const st = imported(c);
            const busy = generating === c.folder;
            return h('div', { class: 'concept-item' },
              c.images[0] ? h('img', { src: conceptUrl(c, c.images[0].file, c.images[0].mtime), alt: '', loading: 'lazy' }) : h('div', { class: 'concept-empty' }, 'no image'),
              h('div', {},
                h('strong', {}, c.name),
                h('span', { class: 'muted' }, st ? `stage: ${st.name}` : `${c.images.length} image${c.images.length === 1 ? '' : 's'}${c.reference ? ' · reference' : ''}`),
                h('details', {}, h('summary', { class: 'muted' }, 'Reference'), h('p', { class: 'hint', style: 'white-space:pre-wrap' }, c.reference.trim() || 'No reference.txt yet.'),
                  h('div', { class: 'concept-thumbs' }, ...c.images.map((im) => h('a', { href: conceptUrl(c, im.file, im.mtime), target: '_blank', rel: 'noopener' }, h('img', { src: conceptUrl(c, im.file, im.mtime), alt: im.file, loading: 'lazy' }))))),
                h('details', {}, h('summary', { class: 'muted' }, 'How you imagine it'),
                  (() => {
                    const t = h('textarea', { placeholder: 'Anything reference.txt doesn\'t say: "rooftops at very different heights, a water tower you can stand on, the city glowing below".', style: 'min-height:60px;width:100%' });
                    t.value = directions.get(c.folder) ?? '';
                    t.addEventListener('input', () => directions.set(c.folder, t.value));
                    return t;
                  })()),
                h('div', { class: 'row' },
                  st && h('button', { type: 'button', class: 'btn small', onclick: () => { current = stages.indexOf(st); selection = null; resetHistory(); renderAll(); fit(); } }, 'Open'),
                  h('button', { type: 'button', class: `btn small${st ? '' : ' primary'}`, disabled: !!generating || !c.images.length, title: c.images.length ? `${designCount} designs from the concept and reference, to pick from (about ${designCount * 15}¢)` : 'Add concept images to the folder first', onclick: () => generate(c) },
                    busy ? 'Designing…' : st ? 'New designs' : 'Generate Map Idea'),
                  st && h('button', { type: 'button', class: 'btn small', disabled: !!generating, title: 'Revisions of the stage as it is now', onclick: () => {
                    const feedback = prompt(`What should change about ${st.name}?`);
                    if (feedback?.trim()) void generate(c, { base: cleaned()[stages.indexOf(st)], feedback });
                  } }, 'Revise…'))));
          }))
        : h('p', { class: 'hint' }, 'No folders yet. Make one per stage with concept images and a reference.txt.')
      : h('p', { class: 'hint warn' }, 'No maps folder (C:\\Projects\\AllTheMaps, or DOD_MAPS_ROOT).'),
  );
}

function layerCard(st: StageDef, l: StageLayer, index: number): HTMLElement {
  void loadArtFiles(st.id);
  const files = artFiles.get(st.id) ?? [];
  const num = (key: 'x' | 'y' | 'width' | 'z', attrs: Record<string, number> = {}) =>
    numberInput(l[key], (v) => { if (v === null) return; l[key] = v; setDirty(); if (key === 'z') renderInspector(); }, { step: 1, ...attrs });
  const note = h('textarea', { placeholder: 'What this layer is for, for the artist', style: 'min-height:48px' });
  note.value = l.note ?? '';
  note.addEventListener('input', () => { l.note = note.value || undefined; setDirty(); });
  const imgOpts: [string, string][] = [['', 'None yet (placeholder)'], ...files.map((f): [string, string] => [f, f.split('/').pop()!])];
  if (l.image && !files.includes(l.image)) imgOpts.push([l.image, l.image.split('/').pop()!]);
  const front = l.z < 0;
  return h('div', { class: 'card' },
    h('h3', {}, `Layer · ${l.id}`, h('span', { class: 'spacer' }), h('span', { class: `badge${l.image ? '' : ' warn'}` }, l.image ? (front ? 'in front' : 'behind') : 'to paint')),
    l.note && !l.image ? h('p', { class: 'hint' }, l.note) : null,
    h('div', { class: 'form' },
      field('Id', textInput(l.id, (v) => { l.id = v.toLowerCase().replace(/[^a-z0-9-]/g, ''); setDirty(); })),
      field('Image', select<string>(imgOpts, l.image, (v) => { l.image = v; setDirty(); renderInspector(); })),
      field('x', num('x')), field('y', num('y')),
      field('Width', num('width', { min: 1 })),
      field('Depth (z)', num('z', { step: 0.5 }), { sub: '+ behind the fighters, − in front' }),
      field('Preset', select<string>([['', 'Pick a depth…'], ...DEPTHS], '', (v) => { if (!v) return; l.z = Number(v); setDirty(); renderInspector(); })),
      field('Opacity', numberInput(l.opacity ?? 1, (v) => { l.opacity = v == null ? undefined : Math.max(0, Math.min(1, v)); setDirty(); }, { step: 0.05, min: 0, max: 1 })),
    ),
    h('div', { class: 'row' },
      checkbox('Occluder', !!l.occluder, (v) => { l.occluder = v || undefined; setDirty(); renderInspector(); }),
      checkbox('Glow (adds light)', !!l.glow, (v) => { l.glow = v || undefined; setDirty(); }),
      checkbox('Hidden', !!l.hidden, (v) => { l.hidden = v || undefined; setDirty(); })),
    l.occluder && !front ? h('p', { class: 'hint warn' }, 'Occluders only work in front of the fighters (negative depth).') : h('p', { class: 'hint' }, 'An occluder covers fighters who pass behind it; the game shows them as a silhouette in their color.'),
    h('div', { class: 'field' }, h('label', {}, 'Draws platforms'),
      h('div', { class: 'row' }, ...st.platforms.map((p, n) => checkbox(`${n + 1}${p.solid ? ' solid' : ''}`, !!l.platforms?.includes(n), (v) => {
        const set = new Set(l.platforms ?? []);
        if (v) {
          set.add(n);
          // Art that draws a platform lives at the fighters' depth, and the platform stops drawing its block.
          l.z = 0.3;
          p.hidden = true;
        } else set.delete(n);
        l.platforms = set.size ? [...set].sort((a, b) => a - b) : undefined;
        setDirty();
        renderInspector();
      }))),
      h('span', { class: 'sub' }, 'Its walkable tops are in this art. They follow it when they move, and show default blocks until it has an image.')),
    field('Note', note, { wide: true }),
    field('Paint as', (() => {
      const t = h('textarea', { placeholder: 'For the painter: what it looks like (materials, colors, details). Blank: the note.', style: 'min-height:48px' });
      t.value = l.prompt ?? '';
      t.addEventListener('input', () => { l.prompt = t.value || undefined; setDirty(); });
      return t;
    })(), { wide: true, sub: l.shape?.length ? `Painted over its ${l.shape.length}-part silhouette.` : 'Painted over its box.' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: async () => { const p = await uploadArt(); if (p) { l.image = p; setDirty(); renderInspector(); } } }, l.image ? 'Replace image…' : 'Upload image…'),
      h('button', { type: 'button', class: 'btn small', onclick: () => duplicateLayer(index) }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn small', title: 'A copy on the other side (x flipped)', onclick: () => duplicateLayer(index, true) }, 'Mirror'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => removeLayer(index) }, 'Delete')),
  );
}

function layersCard(st: StageDef): HTMLElement {
  const layers = (st.layers ?? []).map((l, i) => ({ l, i })).sort((a, b) => b.l.z - a.l.z);
  return h('div', { class: 'card' },
    h('h3', {}, 'Art layers', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, 'back to front')),
    layers.length
      ? h('div', { class: 'layer-list' }, ...layers.map(({ l, i }) =>
          h('div', { class: `layer-row${selection?.kind === 'layer' && selection.index === i ? ' active' : ''}` },
            h('input', { type: 'checkbox', checked: !l.hidden, title: 'Show', onchange: (e: Event) => { l.hidden = !(e.target as HTMLInputElement).checked || undefined; setDirty(); } }),
            h('button', { type: 'button', class: 'link', onclick: () => { selection = { kind: 'layer', index: i }; artMode = true; renderAll(); } }, l.id),
            h('span', { class: 'muted mono' }, `z ${l.z}`),
            !l.image && h('span', { class: 'badge warn' }, 'paint'),
            l.occluder && h('span', { class: 'badge' }, 'occluder'),
            !!l.platforms?.length && h('span', { class: 'badge', title: 'Draws these platforms' }, `▭ ${l.platforms.map((n) => n + 1).join(',')}`),
            h('button', { type: 'button', class: 'btn small', title: 'In front of the layer after it (same depth)', onclick: () => moveLayer(i, 1) }, '▲'),
            h('button', { type: 'button', class: 'btn small', title: 'Behind the layer before it (same depth)', onclick: () => moveLayer(i, -1) }, '▼'))))
      : h('p', { class: 'hint' }, 'No art yet: the theme’s painted backdrop shows. Add the concept or painted layers.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: async () => { const p = await uploadArt(); if (p) addLayer({ id: p.split('/').pop()!.replace(/\.\w+$/, ''), image: p }); } }, '+ Image layer…'),
      h('button', { type: 'button', class: 'btn small', title: 'A dashed box for art still to paint', onclick: () => addLayer({ id: 'to-paint', note: '' }) }, '+ Placeholder')),
  );
}

function effectsCard(st: StageDef): HTMLElement {
  const fx = (st.effects ??= []);
  const row = (e: StageEffect, i: number) => {
    const colors = h('input', { type: 'text', value: (e.colors ?? []).join(' '), placeholder: 'colors: #ffd15a #ff5a1f (blank: mixed)' });
    colors.addEventListener('input', () => {
      const list = colors.value.split(/[\s,]+/).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
      e.colors = list.length ? list : undefined;
      setDirty();
    });
    return h('div', { class: 'effect-row' },
      h('div', { class: 'row' },
        select<StageEffect['on']>([['ko', 'On a KO'], ['end', 'At the end (finale)'], ['start', 'At the start'], ['ambient', 'Every few seconds']], e.on, (v) => { e.on = v; setDirty(); renderInspector(); }),
        select<StageEffect['kind']>([['firework', 'Firework'], ['burst', 'Burst'], ['shake', 'Camera shake'], ['embers', 'Embers']], e.kind, (v) => { e.kind = v; setDirty(); }),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { fx.splice(i, 1); setDirty(); renderInspector(); } }, '×')),
      h('div', { class: 'form' },
        field('How many', numberInput(e.count ?? null, (v) => { e.count = v ?? undefined; setDirty(); }, { min: 1, max: 30, placeholder: e.on === 'end' ? '12' : '1' })),
        e.on === 'ambient' ? field('Every (s)', numberInput(e.every ?? 4, (v) => { e.every = v ?? undefined; setDirty(); }, { min: 1, step: 0.5 })) : null,
        e.kind === 'burst' ? field('Where', select<'ko' | 'sky'>([['ko', 'At the KO'], ['sky', 'In the sky']], e.at ?? 'ko', (v) => { e.at = v; setDirty(); })) : null,
        field('Sound', select<string>([['', 'None'], ...sounds.map((s): [string, string] => [s, s])], e.sound ?? '', (v) => { e.sound = v || undefined; setDirty(); }))),
      colors);
  };
  return h('div', { class: 'card' },
    h('h3', {}, 'Effects'),
    fx.length ? h('div', {}, ...fx.map(row)) : h('p', { class: 'hint' }, 'Nothing happens on KOs or at the end yet.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { fx.push({ on: 'ko', kind: 'firework' }); setDirty(); renderInspector(); } }, '+ Effect'),
      h('span', { class: 'hint' }, 'Try them in the 3D preview.')),
  );
}

function renderInspector(): void {
  const st = stage();
  if (!st || !inspector) return;
  const touch = () => {
    setDirty();
    renderList();
  };
  const num = (obj: Record<string, number>, key: string, attrs: Record<string, number> = {}) =>
    numberInput(obj[key], (v) => {
      if (v === null) return;
      obj[key] = v;
      setDirty();
    }, { step: 1, ...attrs });
  const color = (key: keyof StageDef['theme'] | 'sky0' | 'sky1' | 'sky2') => {
    const t = st.theme;
    const value = key.startsWith('sky') ? t.sky[Number(key.slice(3))] : (t[key as Exclude<keyof StageDef['theme'], 'sky' | 'props'>] as string);
    const input = h('input', { type: 'color', value });
    input.addEventListener('input', () => {
      if (key.startsWith('sky')) t.sky[Number(key.slice(3))] = input.value;
      else (t as unknown as Record<string, string>)[key] = input.value;
      setDirty();
    });
    return input;
  };

  const sel = selection;
  let selected: HTMLElement | null = null;
  if (sel?.kind === 'platform') {
    const p = st.platforms[sel.index];
    if (p) {
      selected = h('div', { class: 'card' },
        h('h3', {}, `Platform ${sel.index + 1} · ${p.solid ? 'solid' : 'thin'}${p.hidden ? ' · collision only' : ''}`),
        h('div', { class: 'form' },
          field('Left x', num(p as unknown as Record<string, number>, 'x1')),
          field('Right x', num(p as unknown as Record<string, number>, 'x2')),
          field('Top y', num(p as unknown as Record<string, number>, 'y')),
          p.solid ? field('Depth', num(p as unknown as Record<string, number>, 'depth', { min: 10 })) : null,
        ),
        checkbox('Solid (sides, bottom and ledges)', p.solid, (v) => {
          p.solid = v;
          if (v) {
            p.depth ??= 90;
            delete p.motion;
          }
          setDirty();
          renderInspector();
        }),
        checkbox('Collision only (the art draws it)', !!p.hidden, (v) => {
          if (v) p.hidden = true;
          else delete p.hidden;
          setDirty();
          renderInspector();
        }),
        !p.solid && checkbox('Moves', !!p.motion, (v) => {
          if (v) p.motion = { ax: 200, ay: 0, period: 360 };
          else delete p.motion;
          setDirty();
          renderInspector();
        }),
        p.motion && h('div', { class: 'form' },
          field('Swing x', num(p.motion as unknown as Record<string, number>, 'ax'), { sub: 'Units each way' }),
          field('Swing y', num(p.motion as unknown as Record<string, number>, 'ay')),
          field('Period', num(p.motion as unknown as Record<string, number>, 'period', { min: 1 }), { sub: 'Frames per cycle; 60 = 1s' }),
          field('Phase', numberInput(p.motion.phase ?? 0, (v) => { p.motion!.phase = v ?? 0; setDirty(); }, { step: 15 }), { sub: 'Degrees into the cycle' }),
        ),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: () => duplicatePlatform(sel.index) }, 'Duplicate'),
          h('button', { type: 'button', class: 'btn small', title: 'A copy on the other side of x = 0', onclick: () => duplicatePlatform(sel.index, true) }, 'Mirror'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => removePlatform(sel.index) }, 'Delete')),
      );
    }
  } else if (sel?.kind === 'spawn') {
    const sp = st.spawns[sel.index];
    selected = h('div', { class: 'card' }, h('h3', {}, `Spawn ${sel.index + 1}`),
      h('div', { class: 'form' }, field('x', num(sp as unknown as Record<string, number>, 'x')), field('y', num(sp as unknown as Record<string, number>, 'y'))));
  } else if (sel?.kind === 'respawn') {
    selected = h('div', { class: 'card' }, h('h3', {}, 'Respawn point'), h('p', { class: 'hint' }, 'Where a fighter reappears after losing a stock. Others line up 90 units apart from here.'),
      h('div', { class: 'form' }, field('x', num(st.respawn as unknown as Record<string, number>, 'x')), field('y', num(st.respawn as unknown as Record<string, number>, 'y'))));
  } else if (sel?.kind === 'layer') {
    const l = st.layers?.[sel.index];
    if (l) selected = layerCard(st, l, sel.index);
  }

  const concept = st.source ? concepts.find((c) => c.folder === st.source) : null;
  const notes = h('textarea', { placeholder: 'How the stage plays, art to make…', style: 'min-height:80px' });
  notes.value = st.notes ?? '';
  notes.addEventListener('input', () => { st.notes = notes.value; setDirty(); });

  const problems = issues(st);
  inspector.replaceChildren(...kids(
    h('h3', {}, 'Stage'),
    h('div', { class: 'form' },
      field('Name', textInput(st.name, (v) => { st.name = v; touch(); })),
      field('Id', textInput(st.id, (v) => { st.id = v.toLowerCase().replace(/[^a-z0-9-]/g, ''); touch(); }), { sub: 'Music plays music-<id>; art lives in stages/<id>/' }),
      field('Blurb', textInput(st.blurb, (v) => { st.blurb = v; setDirty(); }), { wide: true }),
    ),
    concept ? h('details', { class: 'card' }, h('summary', {}, `Concept · ${concept.folder}`),
      h('p', { class: 'hint', style: 'white-space:pre-wrap' }, concept.reference.trim() || 'No reference.txt.'),
      h('div', { class: 'concept-thumbs' }, ...concept.images.map((im) => h('a', { href: conceptUrl(concept, im.file, im.mtime), target: '_blank', rel: 'noopener' }, h('img', { src: conceptUrl(concept, im.file, im.mtime), alt: im.file }))))) : null,
    selected ?? h('p', { class: 'hint' }, artMode ? 'Art mode: click a layer to select it; drag to move, the yellow corner to resize.' : 'Click a platform, spawn point, the respawn diamond or a blast zone handle to edit it. Turn on Art mode to edit layers.'),
    h('h3', {}, 'Checks'),
    h('ul', { class: `issues${problems.length ? '' : ' clean'}`, style: 'margin:0;padding-left:16px' }, ...(problems.length ? problems.map((p) => h('li', {}, p)) : [h('li', {}, 'No problems found.')])),
    paintCard(st),
    reviewCard(st),
    layersCard(st),
    effectsCard(st),
    h('h3', {}, 'Notes'),
    notes,
    h('h3', {}, 'Blast zone'),
    h('div', { class: 'form' },
      field('Left', num(st.blast as unknown as Record<string, number>, 'left')),
      field('Right', num(st.blast as unknown as Record<string, number>, 'right')),
      field('Top', num(st.blast as unknown as Record<string, number>, 'top')),
      field('Bottom', num(st.blast as unknown as Record<string, number>, 'bottom')),
    ),
    h('h3', {}, 'Look'),
    h('p', { class: 'hint' }, 'These color the default platform blocks, and the painted backdrop when the stage has no art.'),
    h('div', { class: 'form' },
      field('Sky center', color('sky0')), field('Sky middle', color('sky1')), field('Sky edge', color('sky2')),
      field('Glow', color('glow')), field('Platform', color('body')), field('Underside', color('under')),
      field('Solid edge', color('edge')), field('Thin edge', color('thinEdge')),
      field('Backdrop', select([...PROPS], st.theme.props, (v) => { st.theme.props = v; setDirty(); })),
    ),
  ));
}

function renderAll(): void {
  renderList();
  renderInspector();
  const save = root.querySelector<HTMLButtonElement>('[data-save]');
  if (save) save.disabled = !dirty;
  const d = root.querySelector('[data-dirty]');
  if (d) d.textContent = dirty ? 'Unsaved changes' : '';
  const art = root.querySelector<HTMLInputElement>('[data-artmode] input');
  if (art) art.checked = artMode;
}

// ------------------------------------------------------------------ mount

export const mapsTab: Tab = {
  async mount(el) {
    root = el;
    el.classList.add('maps');
    listEl = h('div', { class: 'side-list' });
    canvas = h('canvas', {});
    inspector = h('div', { class: 'inspector' });
    const snapSel = select<string>([['1', 'No snap'], ['5', 'Snap 5'], ['10', 'Snap 10'], ['25', 'Snap 25'], ['50', 'Snap 50']], String(snap), (v) => (snap = Number(v)));
    const box = (label: string, value: boolean, on: (v: boolean) => void, attr?: string) => {
      const b = checkbox(label, value, on);
      b.classList.add('btn');
      if (attr) b.setAttribute(attr, '');
      return b;
    };
    el.append(
      h('aside', { class: 'side' }, h('div', { class: 'side-head' }, h('strong', {}, 'Stages')), listEl),
      h('div', { class: 'map-view' },
        canvas,
        h('div', { class: 'map-toolbar' },
          h('button', { type: 'button', class: 'btn', onclick: () => addPlatform(true) }, '+ Solid'),
          h('button', { type: 'button', class: 'btn', onclick: () => addPlatform(false) }, '+ Thin'),
          snapSel,
          box('Animate', animating, (v) => (animating = v)),
          box('Art', showArt, (v) => (showArt = v)),
          box('Art mode', artMode, (v) => { artMode = v; if (!v && selection?.kind === 'layer') selection = null; renderInspector(); }, 'data-artmode'),
          box('See through front', seeThrough, (v) => (seeThrough = v)),
          h('button', { type: 'button', class: 'btn', onclick: fit }, 'Fit'),
          h('button', { type: 'button', class: 'btn', title: 'Ctrl+Z', onclick: () => undo(true) }, 'Undo'),
          h('button', { type: 'button', class: 'btn', title: 'Ctrl+Y', onclick: () => undo(false) }, 'Redo'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'pill warn', 'data-dirty': '' }),
          h('button', { type: 'button', class: 'btn', onclick: () => void togglePreview() }, '3D preview'),
          h('button', { type: 'button', class: 'btn', onclick: async () => {
            if (dirty && !confirm('Throw away unsaved stage changes?')) return;
            await load();
            renderAll();
            schedulePreview();
          } }, 'Revert'),
          h('button', { type: 'button', class: 'btn', onclick: () => {
            if (dirty) toast('Save first: playtests load the saved stage.', 'error');
            window.open(`/Game/?play&stage=${stage().id}&fighter=exit-punk&vs=break&level=5`, 'dod-playtest');
          } }, 'Playtest'),
          h('button', { type: 'button', class: 'btn primary', 'data-save': '', disabled: true, onclick: save }, 'Save stages'),
        ),
        h('div', { class: 'map-help' }, 'Drag to move · yellow handles resize · empty space pans · wheel zooms · Shift ignores snap · arrows nudge · Delete removes · Ctrl+D duplicates · Ctrl+Z undo · Ctrl+S saves · Art mode edits layers'),
      ),
      inspector,
    );
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', (e) => {
      if (dirty) e.preventDefault();
    });
    await attempt(async () => {
      await load();
      const [, s] = await Promise.all([loadConcepts(), api.content<{ id: string }[]>('sounds')]);
      sounds = s.map((x) => x.id);
    });
    renderAll();
    requestAnimationFrame(() => {
      fit();
      draw();
    });
    // Paint jobs: new takes appear as pieces finish; the card and list follow along.
    let seen = '';
    let doneBefore = new Set<string>();
    watchGpu(() => {
      const st = stage();
      if (!st) return;
      const sig = paintSignature(st.id) + JSON.stringify(stages.map((x) => paintJobs(x.id).filter(activeJob).length));
      if (sig === seen) return;
      seen = sig;
      const done = new Set(paintJobs(st.id).filter((j) => j.status === 'done').map((j) => j.id));
      const fresh = [...done].some((id) => !doneBefore.has(id));
      doneBefore = done;
      renderList();
      const typing = inspector.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement!.tagName);
      if (fresh) void loadPaint(st.id);
      else if (!typing) renderInspector();
    });
  },
  show() {
    stopLoop?.();
    stopLoop = animate(() => {
      if (root.hidden) return;
      frame++;
      draw();
    });
  },
};
