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
import { FX } from '../sim/fixed.ts';
import { platformOffset, type Platform, type StageDef, type StageEffect, type StageLayer } from '../sim/stageMath.ts';

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

/** Art that rides a moving platform. */
export interface Follower {
  mesh: Mesh;
  platform: Platform;
  x: number;
  y: number;
  k: number;
}

/**
 * Builds a stage's picture layers under root. Returns whether any is an
 * occluder, and the layers that follow moving platforms (move them with
 * followLayers each frame).
 */
export function buildLayers(scene: Scene, root: TransformNode, stage: StageDef, glow: GlowLayer): { occluders: boolean; followers: Follower[] } {
  let occluders = false;
  const followers: Follower[] = [];
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
    const tex = new Texture(`/${l.image}`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      const s = tex.getSize();
      plane.scaling.set(at.width, (at.width * s.height) / Math.max(1, s.width), 1);
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
    const moving = (l.platforms ?? []).map((i) => stage.platforms[i]).find((p) => p?.motion);
    if (moving) followers.push({ mesh: plane, platform: moving, x: at.x, y: at.y, k: (REF_DIST + l.z) / REF_DIST });
    root.onDisposeObservable.add(() => mat.dispose(true, true));
    glow.addExcludedMesh(plane);
  }
  return { occluders, followers };
}

/** Moves art with the moving platforms it draws. */
export function followLayers(followers: Follower[], frame: number): void {
  for (const f of followers) {
    const [dx, dy] = platformOffset(f.platform, frame);
    f.mesh.position.x = f.x + (dx / FX) * W * f.k;
    f.mesh.position.y = f.y + (dy / FX) * W * f.k;
  }
}

// ------------------------------------------------------------------ effects

interface Part {
  mesh: Mesh;
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
}

const DEFAULT_COLORS = ['#ffd15a', '#ff5a1f', '#3fa7ff', '#ff4fd8', '#7ee2a0', '#ffffff'];
/** Fireworks happen this far behind the fighters. */
const SKY_Z = 6;

/** Runs a stage's effects. trigger() on match events; update() every rendered frame. */
export class StageFx {
  private parts: Part[] = [];
  private mats = new Map<string, StandardMaterial>();
  private pending: { at: number; run: () => void }[] = [];
  private ambient: { fx: StageEffect; next: number }[] = [];
  private last = performance.now();
  private scene: Scene;
  private stage: StageDef;
  private hooks: { sound?: (id: string) => void; shake?: (amount: number) => void };

  constructor(scene: Scene, stage: StageDef, hooks: { sound?: (id: string) => void; shake?: (amount: number) => void } = {}) {
    this.scene = scene;
    this.stage = stage;
    this.hooks = hooks;
    const now = performance.now();
    for (const fx of stage.effects ?? []) if (fx.on === 'ambient') this.ambient.push({ fx, next: now + (fx.every ?? 4) * 500 });
  }

  /** where: the KO position in scene units, for effects at the KO. */
  trigger(on: 'start' | 'ko' | 'end', where?: { x: number; y: number }): void {
    for (const fx of this.stage.effects ?? []) {
      if (fx.on !== on) continue;
      // The finale spreads its fireworks over the two seconds before the results.
      const n = Math.max(1, fx.count ?? (on === 'end' ? 12 : 1));
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
    if (fx.kind === 'shake') {
      this.hooks.shake?.(0.6);
    } else if (fx.kind === 'burst') {
      const p = where && fx.at !== 'sky' ? where : this.skyPoint();
      this.burst(p.x, p.y, where && fx.at !== 'sky' ? -0.4 : SKY_Z, [pick(), pick()], 40);
    } else if (fx.kind === 'firework') {
      const target = this.skyPoint();
      const start = { x: target.x + (Math.random() - 0.5) * 1.2, y: REF_EYE - 4 };
      const frames = 50 + Math.random() * 20;
      const g = 0.0012;
      // Launch speed that peaks at the target height after `frames` frames.
      const vy = (target.y - start.y) / frames + (g * frames) / 2;
      this.spawn({ x: start.x, y: start.y, vx: (target.x - start.x) / frames, vy, life: frames, max: frames, gravity: g, drag: 1, size: 0.12, burst: { colors: [pick(), pick()], n: 36 } }, '#fff2c0', SKY_Z);
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

  private spawn(p: Omit<Part, 'mesh'>, color: string, z: number): void {
    const mesh = CreatePlane('fx', { size: 1 }, this.scene);
    mesh.material = this.mat(color);
    mesh.position.set(p.x, p.y, z);
    mesh.scaling.setAll(p.size);
    mesh.isPickable = false;
    this.parts.push({ ...p, mesh });
  }

  private mat(color: string): StandardMaterial {
    let m = this.mats.get(color);
    if (!m) {
      m = new StandardMaterial(`fx-${color}`, this.scene);
      m.disableLighting = true;
      m.emissiveColor = Color3.FromHexString(color);
      m.backFaceCulling = false;
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
      p.mesh.scaling.setAll(p.size * (0.4 + 0.6 * k));
      if (p.life <= 0) {
        if (p.burst) this.burst(p.x, p.y, p.mesh.position.z, p.burst.colors, p.burst.n);
        p.mesh.dispose();
        this.parts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const p of this.parts) p.mesh.dispose();
    this.parts = [];
    this.pending = [];
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}
