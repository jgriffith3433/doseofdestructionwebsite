// Special-effect flipbooks: one short painted burst per special archetype (docs/specials.md), played on the special's
// startup, active and impact frames, tinted per fighter and drawn additive.
//
// The art is a grid atlas (content/flipbooks.json): High 16 frames of 256 px cells, Low 8 frames of 128 px cells.
// STAND-IN: until the Hawkes Gen sheets are made (keyframe -> video.i2v -> sprite.sheet), every kind is drawn in code
// into the same atlas layout (`standInSheet`). A manifest entry with a `file` loads a real sheet through the same
// path, so the art pass only swaps files.

import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import flipbookJson from '../../../content/flipbooks.json' with { type: 'json' };
import type { SpecialKind } from '../sim/fighterDefs.ts';

export const FLIPBOOK_KINDS: readonly SpecialKind[] = ['projectile', 'dash', 'counter', 'grab', 'trap', 'flurry', 'recovery'];
export type FlipQuality = 'high' | 'low';

export interface Atlas {
  frames: number;
  cell: number;
  cols: number;
  rows: number;
}
interface SheetEntry {
  high?: { file: string } & Partial<Atlas>;
  low?: { file: string } & Partial<Atlas>;
}
const MANIFEST = flipbookJson as unknown as { high: Atlas; low: Atlas; sheets: Partial<Record<SpecialKind, SheetEntry>> };

/** The atlas layout for a quality (a real sheet may override it in the manifest). */
export function atlasFor(kind: SpecialKind, quality: FlipQuality): Atlas {
  const base = MANIFEST[quality];
  const real = MANIFEST.sheets[kind]?.[quality];
  return real ? { ...base, ...real } : base;
}
export const realFile = (kind: SpecialKind, quality: FlipQuality): string | null => MANIFEST.sheets[kind]?.[quality]?.file ?? null;

/** Sim frames each image frame stays up: 16 frames over 32 frames (~0.53 s), 8 over 32 (4 each) on Low. */
export const holdFor = (quality: FlipQuality): number => (quality === 'high' ? 2 : 4);

/** UV rectangle of frame i (v counts up from the bottom, the atlas rows from the top). */
export function frameUV(a: Atlas, i: number): { u0: number; v0: number; u1: number; v1: number } {
  const n = Math.max(0, Math.min(a.frames - 1, i | 0));
  const cx = n % a.cols;
  const cy = (n / a.cols) | 0;
  return { u0: cx / a.cols, u1: (cx + 1) / a.cols, v1: 1 - cy / a.rows, v0: 1 - (cy + 1) / a.rows };
}

// ------------------------------------------------------------------ the tint

/** A fighter's own colour for its effects: the hue of its main outfit colour (content/fighters.json looks[].from); dark fighters get warm white. */
export function fighterTint(looks: ReadonlyArray<{ from?: number }> | undefined, id: string): Color3 {
  let hue = looks?.find((l) => typeof l.from === 'number' && l.from >= 0)?.from;
  if (hue === undefined) {
    // No outfit hue on file (a dark fighter, tinted grey): a stable hue from the id, so it still reads as its own.
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    hue = h;
  }
  return hsl(hue, 0.9, 0.58);
}
export const COUNTER_TINT = new Color3(0.72, 0.9, 1);

function hsl(h: number, s: number, l: number): Color3 {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return new Color3(f(0), f(8), f(4));
}

// ------------------------------------------------------------------ the stand-in art (procedural)

type Ctx = CanvasRenderingContext2D;

function glow(c: Ctx, x: number, y: number, r: number, a: number): void {
  if (a <= 0 || r <= 0) return;
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.45, `rgba(255,255,255,${a * 0.45})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}
function ring(c: Ctx, x: number, y: number, rx: number, ry: number, w: number, a: number): void {
  if (a <= 0) return;
  c.strokeStyle = `rgba(255,255,255,${a})`;
  c.lineWidth = Math.max(1, w);
  c.beginPath();
  c.ellipse(x, y, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
  c.stroke();
}
function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, a: number): void {
  if (a <= 0) return;
  c.strokeStyle = `rgba(255,255,255,${a})`;
  c.lineWidth = Math.max(1, w);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}
const out = (t: number) => 1 - (1 - t) * (1 - t);
const fade = (t: number, from = 0.35) => Math.max(0, Math.min(1, (1 - t) / (1 - from)));

/** One frame of one kind, drawn centred on the origin; `u` is the cell half-size, t runs 0..1 over the burst. */
function drawFrame(kind: SpecialKind, c: Ctx, u: number, t: number): void {
  const e = out(t);
  switch (kind) {
    case 'projectile': {
      // Muzzle flash: a hot core, eight spikes (the long ones forward) and wisps trailing back.
      glow(c, u * 0.15, 0, u * (0.35 + 0.5 * e), 0.95 * fade(t, 0.2));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        const len = u * (i % 2 ? 0.45 : 0.85) * e * (i === 0 || i === 7 ? 1.15 : 1);
        line(c, Math.cos(a) * u * 0.1, Math.sin(a) * u * 0.1, Math.cos(a) * len, Math.sin(a) * len, u * 0.07 * (1 - t), 0.9 * fade(t, 0.15));
      }
      for (let i = 0; i < 4; i++) line(c, -u * 0.1, (i - 1.5) * u * 0.12, -u * (0.3 + 0.6 * e), (i - 1.5) * u * 0.2, u * 0.05, 0.5 * fade(t, 0.2));
      break;
    }
    case 'dash': {
      // Speed lines streaming back from the front, with a lunging flash.
      for (let i = 0; i < 9; i++) {
        const y = (i - 4) * u * 0.17;
        const len = u * (0.5 + ((i * 37) % 5) * 0.12) * (0.4 + 0.9 * e);
        const x1 = u * 0.7 - t * u * 0.35;
        line(c, x1, y, x1 - len, y + (i - 4) * u * 0.03, u * 0.06, 0.85 * fade(t, 0.2));
      }
      glow(c, u * 0.55 - t * u * 0.3, 0, u * 0.5, 0.7 * fade(t, 0.1));
      break;
    }
    case 'counter': {
      // The parry: a white-blue flash that blows out, a ring, a cross glint.
      glow(c, 0, 0, u * (0.5 + 0.5 * e), (t < 0.25 ? 1 : 0.9) * fade(t, 0.25));
      ring(c, 0, 0, u * 0.9 * e, u * 0.9 * e, u * 0.1 * (1 - t), fade(t, 0.1));
      ring(c, 0, 0, u * 0.55 * e, u * 0.55 * e, u * 0.05, 0.7 * fade(t, 0.1));
      const k = u * (0.2 + 0.8 * Math.sin(Math.min(1, t * 1.4) * Math.PI));
      line(c, -k, 0, k, 0, u * 0.05, 0.9 * fade(t, 0.3));
      line(c, 0, -k, 0, k, u * 0.05, 0.9 * fade(t, 0.3));
      break;
    }
    case 'grab': {
      // The slam: a shockwave ring on the floor (flat ellipses) with a dust crown and flying chips.
      ring(c, 0, u * 0.35, u * 0.95 * e, u * 0.28 * e, u * 0.12 * (1 - t), fade(t, 0.1));
      ring(c, 0, u * 0.35, u * 0.6 * e, u * 0.18 * e, u * 0.07, 0.8 * fade(t, 0.15));
      glow(c, 0, u * 0.3, u * (0.3 + 0.3 * e), 0.8 * fade(t, 0.1));
      for (let i = 0; i < 10; i++) {
        const a = Math.PI * (0.1 + 0.8 * (i / 9));
        const d = u * 0.7 * e * (0.7 + (i % 3) * 0.2);
        glow(c, Math.cos(a) * d * 1.1, u * 0.35 - Math.sin(a) * d * 0.9 + t * t * u * 0.4, u * 0.1, 0.8 * fade(t, 0.2));
      }
      break;
    }
    case 'trap': {
      // A glyph: two rings, a six-point star and rune ticks, turning as it fades in and out.
      const a = t < 0.3 ? t / 0.3 : fade(t, 0.55) ;
      const r = u * 0.8 * (0.6 + 0.4 * out(Math.min(1, t * 2.5)));
      const spin = t * 2.2;
      ring(c, 0, 0, r, r * 0.42, u * 0.05, a);
      ring(c, 0, 0, r * 0.72, r * 0.3, u * 0.03, a * 0.8);
      c.save();
      c.scale(1, 0.42);
      c.rotate(spin);
      for (let tri = 0; tri < 2; tri++) {
        c.beginPath();
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2 + tri * Math.PI;
          const px = Math.cos(ang) * r * 0.72;
          const py = Math.sin(ang) * r * 0.72;
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.closePath();
        c.strokeStyle = `rgba(255,255,255,${a * 0.9})`;
        c.lineWidth = u * 0.04 / 0.42;
        c.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2;
        line(c, Math.cos(ang) * r * 0.82, Math.sin(ang) * r * 0.82, Math.cos(ang) * r * 0.95, Math.sin(ang) * r * 0.95, u * 0.04 / 0.42, a);
      }
      c.restore();
      glow(c, 0, 0, r * 0.5, 0.5 * a);
      break;
    }
    case 'flurry': {
      // Three crossing slashes, each drawn in turn.
      for (let i = 0; i < 3; i++) {
        const s = Math.max(0, Math.min(1, (t - i * 0.18) / 0.4));
        if (s <= 0) continue;
        const a = (-0.9 + i * 0.9) + 0.35;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const len = u * 0.9;
        const head = out(s) * 2 - 1;
        const tail = Math.max(-1, head - 0.9);
        const w = u * 0.1 * Math.sin(Math.min(1, s * 1.2) * Math.PI) + 1;
        line(c, dx * len * tail, dy * len * tail, dx * len * head, dy * len * head, w, 0.95 * fade(s, 0.4));
        glow(c, dx * len * head, dy * len * head, u * 0.18, 0.8 * fade(s, 0.4));
      }
      break;
    }
    case 'recovery': {
      // A rising column: chevrons climbing, a hot base, streaks trailing down.
      glow(c, 0, u * 0.55 - e * u * 0.1, u * 0.35, 0.8 * fade(t, 0.2));
      for (let i = 0; i < 4; i++) {
        const p = (t * 1.4 + i * 0.25) % 1;
        const y = u * 0.7 - p * u * 1.5;
        const w = u * (0.45 - p * 0.2);
        const a = Math.sin(p * Math.PI) * fade(t, 0.5);
        line(c, -w, y + w * 0.5, 0, y, u * 0.07, a);
        line(c, w, y + w * 0.5, 0, y, u * 0.07, a);
      }
      for (let i = 0; i < 5; i++) line(c, (i - 2) * u * 0.13, u * 0.2 + e * u * 0.5, (i - 2) * u * 0.1, u * 0.7, u * 0.04, 0.6 * fade(t, 0.2));
      break;
    }
  }
}

/** The whole stand-in atlas for a kind: `frames` cells, white on transparent, on a canvas the atlas size. */
export function standInSheet(kind: SpecialKind, a: Atlas): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = a.cell * a.cols;
  canvas.height = a.cell * a.rows;
  const c = canvas.getContext('2d')!;
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < a.frames; i++) {
    c.save();
    c.translate((i % a.cols) * a.cell, ((i / a.cols) | 0) * a.cell);
    c.beginPath();
    c.rect(0, 0, a.cell, a.cell);
    c.clip();
    c.translate(a.cell / 2, a.cell / 2);
    drawFrame(kind, c, a.cell / 2, i / (a.frames - 1));
    c.restore();
  }
  return canvas;
}

// ------------------------------------------------------------------ the pool

interface Live {
  e: Entry;
  kind: SpecialKind;
  age: number;
  hold: number;
  atlas: Atlas;
  /** Which frame is on the plane now (-1: none yet). */
  shown: number;
}
interface Entry {
  mesh: Mesh;
  mat: StandardMaterial;
}
export interface FlipStats {
  /** Plays started per archetype. */
  played: Record<SpecialKind, number>;
  /** The latest tint used per archetype (r,g,b 0..255). */
  tint: Record<SpecialKind, [number, number, number] | null>;
  /** Plays dropped because the pool was empty (must stay 0 in a match). */
  dropped: number;
  /** Meshes the pool has and how many are free. */
  pool: number;
  free: number;
  quality: FlipQuality;
  frames: number;
  cell: number;
  standIn: boolean;
}

const POOL = 28;

/** Draws the flipbooks from a pool of planes built (with their textures) before the match, so no effect builds anything mid-fight. */
export class Flipbooks {
  private free: Entry[] = [];
  private live: Live[] = [];
  private textures = new Map<string, Texture>();
  private quality: FlipQuality = 'high';
  private played = Object.fromEntries(FLIPBOOK_KINDS.map((k) => [k, 0])) as Record<SpecialKind, number>;
  private tints = Object.fromEntries(FLIPBOOK_KINDS.map((k) => [k, null])) as Record<SpecialKind, [number, number, number] | null>;
  private dropped = 0;

  private readonly scene: Scene;
  private readonly onMesh: (m: Mesh) => void;

  constructor(scene: Scene, onMesh: (m: Mesh) => void) {
    this.scene = scene;
    this.onMesh = onMesh;
    for (let i = 0; i < POOL; i++) this.free.push(this.build(i));
  }

  private build(i: number): Entry {
    const mesh = CreatePlane(`flip-${i}`, { size: 1, updatable: true }, this.scene);
    mesh.isPickable = false;
    mesh.setEnabled(false);
    this.onMesh(mesh);
    const mat = new StandardMaterial(`flip-mat-${i}`, this.scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    mesh.material = mat;
    return { mesh, mat };
  }

  setQuality(q: FlipQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    for (const l of this.live) this.release(l);
    this.live = [];
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.prepare();
  }

  /** Builds every kind's texture now (the first special of a match must not upload one). */
  prepare(): void {
    for (const k of FLIPBOOK_KINDS) this.texture(k);
  }

  private texture(kind: SpecialKind): Texture {
    const key = `${kind}:${this.quality}`;
    let t = this.textures.get(key);
    if (t) return t;
    const a = atlasFor(kind, this.quality);
    const file = realFile(kind, this.quality);
    if (file) {
      t = new Texture(file, this.scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
    } else {
      const dt = new DynamicTexture(`flip-${key}`, standInSheet(kind, a), this.scene, false);
      dt.update();
      t = dt;
    }
    t.hasAlpha = true;
    t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.textures.set(key, t);
    return t;
  }

  /** Starts a burst. x, y, z in world units; size is the plane's width. Returns false when the pool was empty. */
  play(kind: SpecialKind, x: number, y: number, z: number, size: number, tint: Color3, opts: { flip?: number; rot?: number; hold?: number } = {}): boolean {
    const e = this.free.pop();
    if (!e) {
      this.dropped++;
      return false;
    }
    const tex = this.texture(kind);
    e.mat.diffuseTexture = tex;
    e.mat.opacityTexture = tex;
    e.mat.emissiveTexture = tex;
    e.mat.diffuseColor = Color3.Black();
    e.mat.emissiveColor = tint;
    e.mesh.position.set(x, y, z);
    e.mesh.scaling.set(size * (opts.flip ?? 1), size, 1);
    e.mesh.rotation.z = opts.rot ?? 0;
    e.mesh.setEnabled(true);
    const l: Live = { e, kind, age: 0, hold: opts.hold ?? holdFor(this.quality), atlas: atlasFor(kind, this.quality), shown: -1 };
    this.live.push(l);
    this.show(l);
    this.played[kind]++;
    this.tints[kind] = [Math.round(tint.r * 255), Math.round(tint.g * 255), Math.round(tint.b * 255)];
    return true;
  }

  private show(l: Live): void {
    const i = Math.min(l.atlas.frames - 1, (l.age / l.hold) | 0);
    if (i === l.shown) return;
    l.shown = i;
    const r = frameUV(l.atlas, i);
    l.e.mesh.updateVerticesData(VertexBuffer.UVKind, [r.u0, r.v0, r.u1, r.v0, r.u1, r.v1, r.u0, r.v1]);
  }

  private release(l: Live): void {
    l.e.mesh.setEnabled(false);
    this.free.push(l.e);
  }

  /** One render step: advance every burst (the renderer calls it with the sparks). */
  update(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.age++;
      if (l.age >= l.atlas.frames * l.hold) {
        this.release(l);
        this.live.splice(i, 1);
      } else this.show(l);
    }
  }

  clear(): void {
    for (const l of this.live) this.release(l);
    this.live = [];
  }

  stats(reset = false): FlipStats {
    const out: FlipStats = {
      played: { ...this.played },
      tint: { ...this.tints },
      dropped: this.dropped,
      pool: POOL,
      free: this.free.length,
      quality: this.quality,
      frames: atlasFor('projectile', this.quality).frames,
      cell: atlasFor('projectile', this.quality).cell,
      standIn: FLIPBOOK_KINDS.some((k) => !realFile(k, this.quality)),
    };
    if (reset) {
      for (const k of FLIPBOOK_KINDS) this.played[k] = 0;
      this.dropped = 0;
    }
    return out;
  }
}
