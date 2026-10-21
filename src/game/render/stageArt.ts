// Stage art and stage effects: the picture layers a stage is made of, and the
// fireworks, bursts and embers its effects call for. Render only.
//
// Layers are authored as seen from the default camera (REF_DIST away, eye at
// REF_EYE): x, y and width in world units, like platforms. A layer at depth z
// is pushed back (or pulled forward) and scaled so it looks the same from
// there, and the real perspective camera then gives it parallax for free.
// Layers in front of the fighters with `occluder` write depth, so the
// renderer can draw a silhouette of anyone standing behind them.

import type { Scene } from '@babylonjs/core/scene.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import { eventOn, type StageClock, type StageDef, type StageEffect, type StageLayer } from '../sim/stageMath.ts';
import type { Placed } from './stageLive.ts';

/** World units per scene unit, as in the renderer. */
const W = 1 / 100;
/** The default camera the layers are authored against. */
export const REF_DIST = 16;
export const REF_EYE = 1.4;

/** Where a layer sits in the scene, in scene units. */
export function layerPlacement(l: Pick<StageLayer, 'x' | 'y' | 'width' | 'z'>): { x: number; y: number; z: number; width: number } {
  const k = (REF_DIST + l.z) / REF_DIST;
  return { x: l.x * W * k, y: REF_EYE + (l.y * W - REF_EYE) * k, z: l.z, width: l.width * W * k };
}

/** Which platforms have art with an image drawing them (the rest keep their default block). */
export function drawnPlatforms(stage: StageDef): Set<number> {
  const out = new Set<number>();
  for (const l of stage.layers ?? []) if (l.image && !l.hidden) for (const i of l.platforms ?? []) out.add(i);
  return out;
}

/**
 * Builds a stage's picture layers under root. Returns whether any is an
 * occluder, and every layer built (StageLive moves them each frame).
 */
export function buildLayers(scene: Scene, root: TransformNode, stage: StageDef, glow: GlowLayer): { occluders: boolean; placed: Placed[] } {
  let occluders = false;
  const placed: Placed[] = [];
  // Layers behind the fighters draw far to near; at the same depth, in list order.
  const behind = (stage.layers ?? []).map((l, i) => ({ l, i })).filter(({ l }) => l.z > 0).sort((a, b) => b.l.z - a.l.z || a.i - b.i);
  const rank = new Map(behind.map(({ l }, n) => [l, n]));
  for (const l of stage.layers ?? []) {
    if (l.hidden || !l.image) continue;
    const at = layerPlacement(l);
    const plane = CreatePlane(`layer-${l.id}`, { size: 1 }, scene);
    plane.parent = root;
    plane.position.set(at.x, at.y, at.z);
    plane.isPickable = false;
    const mat = new StandardMaterial(`layer-${l.id}`, scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = l.opacity ?? 1;
    const size = { w: 0, h: 0 };
    const tex = new Texture(`/${l.image}`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      const s = tex.getSize();
      size.w = at.width;
      size.h = (at.width * s.height) / Math.max(1, s.width);
      plane.scaling.set(size.w, size.h, 1);
    });
    tex.hasAlpha = true;
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor = Color3.Black();
    mat.emissiveColor = Color3.White();
    if (l.glow) mat.alphaMode = Constants.ALPHA_ADD;
    if (l.occluder && l.z < 0) {
      // Alpha tested so its solid pixels write depth (silhouettes test against it).
      mat.transparencyMode = Material.MATERIAL_ALPHATEST;
      mat.alphaCutOff = 0.5;
      occluders = true;
    }
    plane.material = mat;
    // Fixed draw order behind the fighters, so layers at one depth never flicker.
    if (rank.has(l)) plane.alphaIndex = rank.get(l)!;
    placed.push({ layer: l, mesh: plane, mat, x: at.x, y: at.y, k: (REF_DIST + l.z) / REF_DIST, size });
    root.onDisposeObservable.add(() => mat.dispose(true, true));
    glow.addExcludedMesh(plane);
  }
  return { occluders, placed };
}

// ------------------------------------------------------------------ effects

interface Part {
  mesh: Mesh;
  round: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  gravity: number;
  drag: number;
  size: number;
  /** A rocket bursts into this when it dies. */
  burst?: { colors: string[]; n: number };
  /** Fades out instead of shrinking (dust, splats), from this opacity. */
  fade?: number;
  /** Stretched along its motion (rain), height over width. */
  streak?: number;
}

/** Kinds that keep going while the event that started them runs. */
const STREAMS = new Set(['dust', 'rain', 'embers', 'confetti']);

const DEFAULT_COLORS = ['#ffd15a', '#ff5a1f', '#3fa7ff', '#ff4fd8', '#7ee2a0', '#ffffff'];
/** Fireworks happen this far behind the fighters. */
const SKY_Z = 6;
/** Maximum live stage-effect particles (and dust discs) at once, so long bursts never stack or wash out the screen. */
const MAX_PARTS = 120;
const MAX_DUST = 24;

export interface FxHooks {
  sound?: (id: string) => void;
  shake?: (amount: number) => void;
  /** Lights the screen up in a color. */
  flash?: (color: string) => void;
}

/** Runs a stage's effects. trigger() on match events; update() every rendered frame. */
export class StageFx {
  private parts: Part[] = [];
  private planePool: Mesh[] = [];
  private discPool: Mesh[] = [];
  private mats = new Map<string, StandardMaterial>();
  private pending: { at: number; run: () => void }[] = [];
  private ambient: { fx: StageEffect; next: number }[] = [];
  private last = performance.now();
  private scene: Scene;
  private stage: StageDef;
  private glow?: GlowLayer;
  private hooks: FxHooks;
  /** Effects that keep spawning while their event runs. */
  private streams: { fx: StageEffect; id: string; next: number }[] = [];
  private clock: StageClock | null = null;

  constructor(scene: Scene, stage: StageDef, hooks: FxHooks = {}, glow?: GlowLayer) {
    this.scene = scene;
    this.stage = stage;
    this.hooks = hooks;
    this.glow = glow;
    const now = performance.now();
    for (const fx of stage.effects ?? []) if (fx.on === 'ambient') this.ambient.push({ fx, next: now + (fx.every ?? 4) * 500 });
  }

  /** Number of active stage particles and how many sit behind the fighters (z > 0.5). */
  stats(): { active: number; dustBehind: number; dustInFront: number; maxCap: number } {
    let dustBehind = 0;
    let dustInFront = 0;
    for (const p of this.parts) {
      if (p.round && p.size >= 0.4) {
        if (p.mesh.position.z > 0.5) dustBehind++;
        else dustInFront++;
      }
    }
    return { active: this.parts.length, dustBehind, dustInFront, maxCap: MAX_PARTS };
  }

  /** Pre-builds every effect material and particle mesh pool for this stage during the VS screen. */
  warmUp(): void {
    const colors = new Set<string>(['#fff2c0', ...DEFAULT_COLORS]);
    for (const fx of this.stage.effects ?? []) {
      for (const c of fx.colors ?? []) colors.add(c);
    }
    const colorList = [...colors];
    for (const c of colorList) this.mat(c);
    const wantPlanes = Math.max(48, colorList.length * 2);
    const wantDiscs = Math.max(24, colorList.length);
    for (let i = 0; i < wantPlanes; i++) {
      const m = this.acquire(false);
      m.material = this.mat(colorList[i % colorList.length]);
      m.position.set(0, REF_EYE, SKY_Z);
      m.scaling.setAll(0.1);
      m.visibility = 0.01;
      m.setEnabled(true);
      this.planePool.push(m);
    }
    for (let i = 0; i < wantDiscs; i++) {
      const m = this.acquire(true);
      m.material = this.mat(colorList[i % colorList.length]);
      m.position.set(0, REF_EYE, 2);
      m.scaling.setAll(0.2);
      m.visibility = 0.01;
      m.setEnabled(true);
      this.discPool.push(m);
    }
  }

  /** Parks warmed-up pool meshes after the warm-up frames have compiled their shaders. */
  endWarmUp(): void {
    for (const m of this.planePool) {
      m.visibility = 1;
      m.setEnabled(false);
    }
    for (const m of this.discPool) {
      m.visibility = 1;
      m.setEnabled(false);
    }
  }

  /** The sim state, so effects tied to an event know when it ends. */
  setClock(c: StageClock): void {
    this.clock = c;
  }

  /**
   * on: 'start', 'ko', 'hit', 'end', or a stage event ('event:<id>',
   * 'warn:<id>', 'eventEnd:<id>'). where: the KO or hit position in scene
   * units, for effects there.
   */
  trigger(on: string, where?: { x: number; y: number }): void {
    for (const fx of this.stage.effects ?? []) {
      if (fx.on !== on) continue;
      if (on.startsWith('event:') && STREAMS.has(fx.kind)) {
        // Dust, rain, embers and confetti keep coming until the event ends.
        this.streams.push({ fx, id: on.slice(6), next: 0 });
        if (fx.sound) this.hooks.sound?.(fx.sound);
        continue;
      }
      // Dust already spawns fx.count puffs inside play(); only fireworks/bursts repeat play() n times.
      const n = fx.kind === 'dust' ? 1 : Math.max(1, fx.count ?? (on === 'end' ? 12 : 1));
      const spread = on === 'end' ? 1800 : n > 1 ? 400 : 0;
      for (let i = 0; i < n; i++) this.later(i === 0 ? 0 : Math.random() * spread, () => this.play(fx, where));
      if (fx.sound) this.hooks.sound?.(fx.sound);
    }
  }

  private later(ms: number, run: () => void): void {
    if (ms <= 0) run();
    else this.pending.push({ at: performance.now() + ms, run });
  }

  private play(fx: StageEffect, where?: { x: number; y: number }): void {
    const colors = fx.colors?.length ? fx.colors : DEFAULT_COLORS;
    const pick = () => colors[Math.floor(Math.random() * colors.length)];
    const b = this.stage.blast;
    const dir = fx.dir === -1 ? -1 : 1;
    if (fx.kind === 'shake') {
      this.hooks.shake?.(0.6);
    } else if (fx.kind === 'flash') {
      this.hooks.flash?.(pick());
    } else if (fx.kind === 'splat') {
      // Paint blobs where it happened; they cling to the stage plane and fade.
      const p = where ?? { x: 0, y: REF_EYE };
      const n = fx.count ?? 7;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.35;
        const life = 120 + Math.random() * 90;
        this.spawn({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: Math.cos(a) * 0.01, vy: Math.sin(a) * 0.01, life, max: life, gravity: 0.0004, drag: 0.85, size: 0.12 + Math.random() * 0.22, fade: 0.9 }, pick(), -0.35, true);
      }
    } else if (fx.kind === 'dust') {
      const n = Math.min(8, fx.count ?? 4);
      let dustActive = 0;
      for (const p of this.parts) if (p.round && p.size >= 0.4) dustActive++;
      for (let i = 0; i < n && dustActive < MAX_DUST; i++, dustActive++) {
        const y = REF_EYE + (Math.random() * 1.4 - 0.5) * 2.5;
        const x = (dir > 0 ? b.left : b.right) * W * 0.8;
        const life = 140 + Math.random() * 70;
        // Behind the fighters and stage platforms (z >= 1.5), subtle alpha so the lower screen never washes out.
        this.spawn({ x, y, vx: dir * (0.06 + Math.random() * 0.04), vy: (Math.random() - 0.5) * 0.004, life, max: life, gravity: 0, drag: 1, size: 0.5 + Math.random() * 0.9, fade: 0.14 }, pick(), 1.5 + Math.random() * 2.5, true);
      }
    } else if (fx.kind === 'rain') {
      const n = fx.count ?? 10;
      for (let i = 0; i < n; i++) {
        const x = (b.left + Math.random() * (b.right - b.left)) * W * 0.8;
        const life = 70;
        this.spawn({ x, y: REF_EYE + 6, vx: dir * 0.03, vy: -0.16, life, max: life, gravity: 0, drag: 1, size: 0.03, fade: 0.6, streak: 9 }, pick(), -1 + Math.random() * 3);
      }
    } else if (fx.kind === 'confetti') {
      const n = fx.count ?? 24;
      for (let i = 0; i < n; i++) {
        const x = (b.left + Math.random() * (b.right - b.left)) * W * 0.6;
        const life = 200 + Math.random() * 100;
        this.spawn({ x, y: REF_EYE + 4.5 + Math.random(), vx: (Math.random() - 0.5) * 0.01, vy: -0.015 - Math.random() * 0.01, life, max: life, gravity: 0, drag: 1, size: 0.09, fade: 1 }, pick(), -1);
      }
    } else if (fx.kind === 'burst') {
      const p = where && fx.at !== 'sky' ? where : this.skyPoint();
      this.burst(p.x, p.y, where && fx.at !== 'sky' ? -0.4 : SKY_Z, [pick(), pick()], 24);
    } else if (fx.kind === 'firework') {
      const target = this.skyPoint();
      const start = { x: target.x + (Math.random() - 0.5) * 1.2, y: REF_EYE - 4 };
      const frames = 50 + Math.random() * 20;
      const g = 0.0012;
      // Launch speed that peaks at the target height after `frames` frames.
      const vy = (target.y - start.y) / frames + (g * frames) / 2;
      this.spawn({ x: start.x, y: start.y, vx: (target.x - start.x) / frames, vy, life: frames, max: frames, gravity: g, drag: 1, size: 0.12, burst: { colors: [pick(), pick()], n: 28 } }, '#fff2c0', SKY_Z);
    } else if (fx.kind === 'embers') {
      const n = fx.count ?? 6;
      const b = this.stage.blast;
      for (let i = 0; i < n; i++) {
        const x = (b.left + Math.random() * (b.right - b.left)) * W * 0.7;
        const life = 160 + Math.random() * 120;
        this.spawn({ x, y: -1.5, vx: (Math.random() - 0.5) * 0.004, vy: 0.012 + Math.random() * 0.01, life, max: life, gravity: -0.00002, drag: 0.999, size: 0.06 }, pick(), 2.5);
      }
    }
  }

  /** A random point in the sky over the stage, in scene units at SKY_Z. */
  private skyPoint(): { x: number; y: number } {
    const b = this.stage.blast;
    const k = (REF_DIST + SKY_Z) / REF_DIST;
    const x = (b.left + (0.2 + Math.random() * 0.6) * (b.right - b.left)) * W * k;
    // Low enough to stay in frame: the camera mostly shows up to about y = 600.
    const y = REF_EYE + ((Math.min(b.top, 1200) * (0.28 + Math.random() * 0.3)) * W - REF_EYE) * k;
    return { x, y };
  }

  private burst(x: number, y: number, z: number, colors: string[], n: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const sp = 0.05 + Math.random() * 0.05;
      const life = 50 + Math.random() * 30;
      this.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, gravity: 0.0012, drag: 0.955, size: 0.2 }, colors[i % colors.length], z);
    }
  }

  private acquire(round: boolean): Mesh {
    const pool = round ? this.discPool : this.planePool;
    const reused = pool.pop();
    if (reused) return reused;
    const mesh = round ? CreateDisc('fx', { radius: 0.5, tessellation: 18 }, this.scene) : CreatePlane('fx', { size: 1 }, this.scene);
    mesh.isPickable = false;
    if (round && this.glow) this.glow.addExcludedMesh(mesh);
    return mesh;
  }

  private release(p: Part): void {
    p.mesh.setEnabled(false);
    (p.round ? this.discPool : this.planePool).push(p.mesh);
  }

  private spawn(p: Omit<Part, 'mesh' | 'round'>, color: string, z: number, round = false): void {
    if (this.parts.length >= MAX_PARTS) {
      const oldest = this.parts.shift();
      if (oldest) this.release(oldest);
    }
    const mesh = this.acquire(round);
    mesh.material = this.mat(color);
    mesh.setEnabled(true);
    mesh.position.set(p.x, p.y, z);
    mesh.scaling.set(p.size, p.size * (p.streak ?? 1), 1);
    mesh.visibility = p.fade ?? 1;
    mesh.rotation.z = p.streak ? Math.atan2(p.vx, -p.vy) : 0;
    this.parts.push({ ...p, mesh, round });
  }

  private mat(color: string): StandardMaterial {
    let m = this.mats.get(color);
    if (!m) {
      m = new StandardMaterial(`fx-${color}`, this.scene);
      m.disableLighting = true;
      m.emissiveColor = Color3.FromHexString(color);
      m.backFaceCulling = false;
      m.alphaMode = Constants.ALPHA_COMBINE;
      m.disableDepthWrite = true;
      this.mats.set(color, m);
    }
    return m;
  }

  update(): void {
    const now = performance.now();
    // Steps in 60ths of a second, whatever the frame rate.
    const steps = Math.min(4, Math.max(1, Math.round((now - this.last) / (1000 / 60))));
    this.last = now;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= now) {
        const run = this.pending[i].run;
        this.pending.splice(i, 1);
        run();
      }
    }
    for (let i = this.streams.length - 1; i >= 0; i--) {
      const st = this.streams[i];
      if (!this.clock || !eventOn(this.stage, this.clock, st.id)) {
        this.streams.splice(i, 1);
        continue;
      }
      if (now >= st.next) {
        st.next = now + (st.fx.every ?? (st.fx.kind === 'rain' ? 0.1 : st.fx.kind === 'dust' ? 0.45 : 0.5)) * 1000;
        this.play(st.fx);
      }
    }
    for (const a of this.ambient) {
      if (now >= a.next) {
        a.next = now + (a.fx.every ?? 4) * 1000 * (0.7 + Math.random() * 0.6);
        this.play(a.fx);
        if (a.fx.sound) this.hooks.sound?.(a.fx.sound);
      }
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      for (let s = 0; s < steps; s++) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= p.drag;
        p.vy = p.vy * p.drag - p.gravity;
        p.life--;
      }
      p.mesh.position.x = p.x;
      p.mesh.position.y = p.y;
      const k = p.burst ? 1 : Math.max(0, p.life / p.max);
      if (p.fade !== undefined) p.mesh.visibility = p.fade * Math.min(1, k * 3);
      else p.mesh.scaling.setAll(p.size * (0.4 + 0.6 * k));
      if (p.life <= 0) {
        if (p.burst) this.burst(p.x, p.y, p.mesh.position.z, p.burst.colors, p.burst.n);
        this.release(p);
        this.parts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const p of this.parts) p.mesh.dispose();
    for (const m of this.planePool) m.dispose();
    for (const m of this.discPool) m.dispose();
    this.parts = [];
    this.planePool = [];
    this.discPool = [];
    this.pending = [];
    this.streams = [];
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}
