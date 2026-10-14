// Maps: a side-on editor for content/stages.json. Drag platforms, their ends,
// spawn points and the blast zone; set colors, motion and depth in the
// inspector; check the stage for mistakes; playtest it.

import { platformAt, type Platform, type StageDef } from '../../game/sim/stageMath.ts';
import { h } from '../../game/ui/dom.ts';
import { api } from '../api.ts';
import { attempt, checkbox, field, numberInput, select, textInput, toast } from '../ui.ts';
import { animate } from '../sprites.ts';
import type { Tab } from '../main.ts';

type Selection =
  | { kind: 'platform'; index: number }
  | { kind: 'spawn'; index: number }
  | { kind: 'respawn' }
  | { kind: 'blast'; edge: 'left' | 'right' | 'top' | 'bottom' }
  | null;

type Drag =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'platform'; index: number; part: 'body' | 'x1' | 'x2' | 'depth'; wx: number; wy: number; start: Platform }
  | { kind: 'spawn'; index: number }
  | { kind: 'respawn' }
  | { kind: 'blast'; edge: 'left' | 'right' | 'top' | 'bottom' };

const PROPS = ['frame', 'skyline', 'clouds', 'embers', 'pipes'] as const;
const PLAYER_COLORS = ['#ff5a1f', '#3fa7ff', '#ffd15a', '#5ce08a'];

let root: HTMLElement;
let stages: StageDef[] = [];
let current = 0;
let selection: Selection = null;
let dirty = false;
let snap = 10;
let animating = true;
let frame = 0;
const view = { cx: 0, cy: 150, zoom: 0.35 };
let canvas: HTMLCanvasElement;
let listEl: HTMLElement;
let inspector: HTMLElement;
let drag: Drag | null = null;
let stopLoop: (() => void) | null = null;

const stage = () => stages[current];

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

// ------------------------------------------------------------------ draw

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
    if (p.solid) {
      const depth = (p.depth ?? 90) * view.zoom;
      ctx.fillStyle = t.body;
      ctx.fillRect(x1, y, x2 - x1, depth);
      ctx.fillStyle = t.under;
      ctx.fillRect(x1 + (x2 - x1) * 0.15, y + depth, (x2 - x1) * 0.7, depth * 0.9);
      ctx.fillStyle = t.edge;
      ctx.fillRect(x1, y - 1.5, x2 - x1, 3);
      // Ledges.
      ctx.fillStyle = '#7ee2a0';
      for (const lx of [x1, x2]) {
        ctx.beginPath();
        ctx.moveTo(lx, y - 1);
        ctx.lineTo(lx + (lx === x1 ? -7 : 7), y - 1);
        ctx.lineTo(lx, y + 7);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = t.body;
      ctx.fillRect(x1, y, x2 - x1, Math.max(3, 10 * view.zoom));
      ctx.fillStyle = t.thinEdge;
      ctx.fillRect(x1, y - 1.5, x2 - x1, 3);
    }
    if (sel) {
      ctx.strokeStyle = '#ffd15a';
      ctx.lineWidth = 1.5;
      const depth = p.solid ? (p.depth ?? 90) * view.zoom : Math.max(3, 10 * view.zoom);
      ctx.strokeRect(x1 - 3, y - 4, x2 - x1 + 6, depth + 8);
      ctx.fillStyle = '#ffd15a';
      ctx.fillRect(x1 - 5, y - 5, 10, 10);
      ctx.fillRect(x2 - 5, y - 5, 10, 10);
      if (p.solid) ctx.fillRect((x1 + x2) / 2 - 5, y + depth - 5, 10, 10);
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

function blastHandle(edge: 'left' | 'right' | 'top' | 'bottom'): [number, number] {
  const b = stage().blast;
  const mx = (b.left + b.right) / 2;
  const my = (b.top + b.bottom) / 2;
  if (edge === 'left') return toScreen(b.left, my);
  if (edge === 'right') return toScreen(b.right, my);
  if (edge === 'top') return toScreen(mx, b.top);
  return toScreen(mx, b.bottom);
}

// ------------------------------------------------------------- pointers

function hit(sx: number, sy: number): Drag | null {
  const st = stage();
  const near = (ax: number, ay: number, d = 8) => Math.abs(sx - ax) <= d && Math.abs(sy - ay) <= d;
  const [wx, wy] = toWorld(sx, sy);
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
      : found.kind === 'blast' ? { kind: 'blast', edge: found.edge } : null;
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
  }
}

function onUp(): void {
  if (drag && drag.kind !== 'pan') renderInspector();
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
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    void save();
    return;
  }
  if (selection?.kind !== 'platform') return;
  const p = st.platforms[selection.index];
  const step = e.shiftKey ? 1 : snap;
  const nudge = (dx: number, dy: number) => {
    p.x1 += dx;
    p.x2 += dx;
    p.y += dy;
    setDirty();
    renderInspector();
  };
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removePlatform(selection.index);
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    duplicatePlatform(selection.index);
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
  root.querySelector<HTMLButtonElement>('[data-save]')!.disabled = false;
  root.querySelector('[data-dirty]')!.textContent = 'Unsaved changes';
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
  selection = null;
  setDirty();
  renderInspector();
}

function duplicatePlatform(i: number): void {
  const p = structuredClone(stage().platforms[i]);
  p.x1 += 60;
  p.x2 += 60;
  p.y += 40;
  stage().platforms.push(p);
  selection = { kind: 'platform', index: stage().platforms.length - 1 };
  setDirty();
  renderInspector();
}

/** Stage data the sim can read: integers only, motion periods at least one frame. */
function cleaned(): StageDef[] {
  const out = structuredClone(stages);
  const round = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') o[k] = Math.round(v);
      else if (v && typeof v === 'object' && !Array.isArray(v)) round(v as Record<string, unknown>);
      else if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && round(x as Record<string, unknown>));
    }
  };
  for (const s of out) {
    round(s as unknown as Record<string, unknown>);
    for (const p of s.platforms) {
      if (p.motion) p.motion.period = Math.max(1, p.motion.period);
      if (!p.solid) delete p.depth;
    }
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
  return out;
}

async function save(): Promise<void> {
  const ok = await attempt(() => api.save('stages', cleaned()), 'Stages saved. Open game tabs reload.');
  if (ok) {
    stages = cleaned();
    dirty = false;
    renderAll();
  }
}

async function load(): Promise<void> {
  stages = await api.content<StageDef[]>('stages');
  current = Math.min(current, stages.length - 1);
  dirty = false;
  selection = null;
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
  stages.push(base);
  current = stages.length - 1;
  selection = null;
  dirty = true;
  renderAll();
  fit();
}

// ------------------------------------------------------------- inspector

function renderList(): void {
  listEl.replaceChildren(
    ...stages.map((s, i) =>
      h('button', { type: 'button', class: `fighter-item stage-item${i === current ? ' active' : ''}`, style: 'grid-template-columns:1fr auto', onclick: () => {
        current = i;
        selection = null;
        renderAll();
        fit();
      } }, h('div', {}, h('strong', {}, s.name), h('span', {}, s.id)), h('span', { class: 'badge' }, `${s.platforms.length}`)),
    ),
    h('div', { class: 'row', style: 'padding:6px 2px' },
      h('button', { type: 'button', class: 'btn small', onclick: () => newStage() }, 'New'),
      h('button', { type: 'button', class: 'btn small', onclick: () => newStage(stage()) }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn small danger', disabled: stages.length < 2, onclick: () => {
        if (!confirm(`Delete ${stage().name}? Campaign chapters that use it fall back to the first stage.`)) return;
        stages.splice(current, 1);
        current = 0;
        dirty = true;
        renderAll();
        fit();
      } }, 'Delete')),
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
        h('h3', {}, `Platform ${sel.index + 1} · ${p.solid ? 'solid' : 'thin'}`),
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
  }

  const problems = issues(st);
  inspector.replaceChildren(
    h('h3', {}, 'Stage'),
    h('div', { class: 'form' },
      field('Name', textInput(st.name, (v) => { st.name = v; touch(); })),
      field('Id', textInput(st.id, (v) => { st.id = v.toLowerCase().replace(/[^a-z0-9-]/g, ''); touch(); }), { sub: 'Music plays music-<id>' }),
      field('Blurb', textInput(st.blurb, (v) => { st.blurb = v; setDirty(); }), { wide: true }),
    ),
    selected ?? h('p', { class: 'hint' }, 'Click a platform, spawn point, the respawn diamond or a blast zone handle to edit it.'),
    h('h3', {}, 'Checks'),
    h('ul', { class: `issues${problems.length ? '' : ' clean'}`, style: 'margin:0;padding-left:16px' }, ...(problems.length ? problems.map((p) => h('li', {}, p)) : [h('li', {}, 'No problems found.')])),
    h('h3', {}, 'Blast zone'),
    h('div', { class: 'form' },
      field('Left', num(st.blast as unknown as Record<string, number>, 'left')),
      field('Right', num(st.blast as unknown as Record<string, number>, 'right')),
      field('Top', num(st.blast as unknown as Record<string, number>, 'top')),
      field('Bottom', num(st.blast as unknown as Record<string, number>, 'bottom')),
    ),
    h('h3', {}, 'Look'),
    h('div', { class: 'form' },
      field('Sky center', color('sky0')), field('Sky middle', color('sky1')), field('Sky edge', color('sky2')),
      field('Glow', color('glow')), field('Platform', color('body')), field('Underside', color('under')),
      field('Solid edge', color('edge')), field('Thin edge', color('thinEdge')),
      field('Backdrop', select([...PROPS], st.theme.props, (v) => { st.theme.props = v; setDirty(); })),
    ),
  );
}

function renderAll(): void {
  renderList();
  renderInspector();
  const save = root.querySelector<HTMLButtonElement>('[data-save]');
  if (save) save.disabled = !dirty;
  const d = root.querySelector('[data-dirty]');
  if (d) d.textContent = dirty ? 'Unsaved changes' : '';
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
    const animBox = checkbox('Animate moving platforms', animating, (v) => (animating = v));
    animBox.classList.add('btn');
    el.append(
      h('aside', { class: 'side' }, h('div', { class: 'side-head' }, h('strong', {}, 'Stages')), listEl),
      h('div', { class: 'map-view' },
        canvas,
        h('div', { class: 'map-toolbar' },
          h('button', { type: 'button', class: 'btn', onclick: () => addPlatform(true) }, '+ Solid platform'),
          h('button', { type: 'button', class: 'btn', onclick: () => addPlatform(false) }, '+ Thin platform'),
          snapSel,
          animBox,
          h('button', { type: 'button', class: 'btn', onclick: fit }, 'Fit'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'pill warn', 'data-dirty': '' }),
          h('button', { type: 'button', class: 'btn', onclick: async () => {
            if (dirty && !confirm('Throw away unsaved stage changes?')) return;
            await load();
            renderAll();
          } }, 'Revert'),
          h('button', { type: 'button', class: 'btn', onclick: () => {
            if (dirty) toast('Save first: playtests load the saved stage.', 'error');
            window.open(`/Game/?play&stage=${stage().id}&fighter=exit-punk&vs=break&level=5`, 'dod-playtest');
          } }, 'Playtest'),
          h('button', { type: 'button', class: 'btn primary', 'data-save': '', disabled: true, onclick: save }, 'Save stages'),
        ),
        h('div', { class: 'map-help' }, 'Drag to move · drag the yellow ends to resize · empty space pans · wheel zooms · Shift ignores snap · arrows nudge · Delete removes · Ctrl+D duplicates · Ctrl+S saves'),
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
    await attempt(load);
    renderAll();
    requestAnimationFrame(() => {
      fit();
      draw();
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
