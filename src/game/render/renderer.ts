// Draws a GameState with Babylon. Nothing here feeds back into the sim: the
// renderer only reads state and the events step() returns.

import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import '@babylonjs/core/Layers/effectLayerSceneComponent.js';

import { FX } from '../sim/fixed.ts';
import { CHARACTERS, MOVE } from '../sim/characters.ts';
import { STAGES, ledges, platformAt, type Platform, type StageDef } from '../sim/stage.ts';
import { ACT, SHIELD_MAX, type Fighter, type GameState } from '../sim/state.ts';
import { activeHitboxes, type SimEvent } from '../sim/step.ts';
import { clipFrame, loadAnimSet, pickClip, type AnimSet } from './anims.ts';

/** Sim units to scene units: 100 world units per scene unit. */
const S = 1 / (100 * FX);
const W = 1 / 100;
/** The art stands a little taller than the hurtbox. */
const ART_SCALE = 1.18;

export const PLAYER_COLORS = ['#ff5a1f', '#3fa7ff', '#ffd15a', '#5ce08a'];

interface FighterView {
  root: TransformNode;
  /** Squash, lean and facing pivot around the feet. */
  pose: TransformNode;
  body: Mesh;
  mat: StandardMaterial;
  still: DynamicTexture;
  stillAspect: number;
  anims: AnimSet | null;
  clipTex: Map<string, Texture>;
  ring: Mesh;
  shield: Mesh;
  flash: number;
}

interface Spark {
  mesh: Mesh;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

export class Renderer {
  readonly engine: Engine;
  readonly scene: Scene;
  private camera: FreeCamera;
  private views: FighterView[] = [];
  private sparks: Spark[] = [];
  private sparkMat: StandardMaterial;
  private debugMeshes: Mesh[] = [];
  private debugMat: StandardMaterial;
  private hurtMat: StandardMaterial;
  private glow: GlowLayer;
  private stageRoot: TransformNode | null = null;
  private movers: { platform: Platform; node: TransformNode }[] = [];
  private stage: StageDef = STAGES[0];
  private shake = 0;
  private camPos = new Vector3(0, 1.6, -14);
  private camTarget = new Vector3(0, 1.6, 0);
  debug = false;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.063, 0.055, 0.047, 1);

    this.camera = new FreeCamera('cam', this.camPos.clone(), this.scene);
    this.camera.fov = 0.55;
    this.camera.setTarget(this.camTarget);
    this.camera.inputs.clear();

    const light = new HemisphericLight('sky', new Vector3(0.2, 1, -0.6), this.scene);
    light.intensity = 0.95;
    light.groundColor = new Color3(0.18, 0.1, 0.08);

    this.glow = new GlowLayer('glow', this.scene, { mainTextureSamples: 2 });
    this.glow.intensity = 0.6;

    this.sparkMat = this.flatMaterial('spark', '#ffd15a');
    this.debugMat = this.flatMaterial('dbg-hit', '#ff2a2a', 0.45);
    this.hurtMat = this.flatMaterial('dbg-hurt', '#ffd15a', 0.22);

    this.setStage(0);
    window.addEventListener('resize', () => this.engine.resize());
  }

  private flatMaterial(name: string, hex: string, alpha = 1): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.emissiveColor = Color3.FromHexString(hex);
    m.alpha = alpha;
    m.backFaceCulling = false;
    return m;
  }

  // ------------------------------------------------------------------ stage

  setStage(index: number): void {
    this.stageRoot?.dispose(false, true);
    this.movers = [];
    this.stage = STAGES[index] ?? STAGES[0];
    const root = new TransformNode('stage', this.scene);
    this.stageRoot = root;
    const t = this.stage.theme;
    this.sparkMat.emissiveColor = Color3.FromHexString(t.thinEdge);

    this.buildBackdrop(root);

    const body = new StandardMaterial('stage-body', this.scene);
    body.diffuseColor = Color3.FromHexString(t.body);
    body.specularColor = new Color3(0.05, 0.04, 0.03);
    const under = new StandardMaterial('stage-under', this.scene);
    under.diffuseColor = Color3.FromHexString(t.under);
    under.specularColor = Color3.Black();
    const edge = this.flatMaterial('edge', t.edge);
    const thinEdge = this.flatMaterial('edge-thin', t.thinEdge);
    for (const m of [body, under, edge, thinEdge]) this.track(root, m);

    for (const p of this.stage.platforms) {
      const width = (p.x2 - p.x1) * W;
      const cx = ((p.x1 + p.x2) / 2) * W;
      const node = new TransformNode('platform', this.scene);
      node.parent = root;
      node.position.set(cx, p.y * W, 0);
      if (p.solid) {
        const depth = (p.depth ?? 90) * W;
        const top = CreateBox('block', { width, height: depth, depth: 3 }, this.scene);
        top.position.set(0, -depth / 2, 0.6);
        top.material = body;
        // A tapered underside so the stage reads as a floating rock.
        const keel = CreateBox('keel', { width: width * 0.7, height: depth * 1.4, depth: 2.4 }, this.scene);
        keel.position.set(0, -depth - depth * 0.55, 0.6);
        keel.material = under;
        // Only the front edge glows, so the top still reads as a floor.
        const lip = CreateBox('lip', { width: width + 0.04, height: 0.05, depth: 0.05 }, this.scene);
        lip.position.set(0, -0.02, 0.6 - 1.5);
        lip.material = edge;
        for (const m of [top, keel, lip]) m.parent = node;
      } else {
        const slab = CreateBox('plat', { width, height: 0.1, depth: 1.6 }, this.scene);
        slab.position.set(0, -0.06, 0.4);
        slab.material = body;
        const lip = CreateBox('plat-lip', { width: width + 0.02, height: 0.03, depth: 0.04 }, this.scene);
        lip.position.set(0, -0.01, 0.4 - 0.8);
        lip.material = thinEdge;
        for (const m of [slab, lip]) m.parent = node;
        if (p.motion) this.movers.push({ platform: p, node });
      }
    }
  }

  /** Disposes a material along with the stage. */
  private track(root: TransformNode, m: StandardMaterial): void {
    root.onDisposeObservable.add(() => m.dispose(true, true));
  }

  private buildBackdrop(root: TransformNode): void {
    const t = this.stage.theme;
    const tex = new DynamicTexture('sky', { width: 1024, height: 512 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(512, 380, 20, 512, 380, 640);
    g.addColorStop(0, t.sky[0]);
    g.addColorStop(0.45, t.sky[1]);
    g.addColorStop(1, t.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);
    paintProps(ctx, t.props, t.glow, t.thinEdge);
    tex.update();
    const mat = new StandardMaterial('sky', this.scene);
    mat.disableLighting = true;
    mat.emissiveTexture = tex;
    this.track(root, mat);
    const plane = CreatePlane('sky', { width: 64, height: 32 }, this.scene);
    plane.material = mat;
    plane.position.set(0, 2, 18);
    plane.parent = root;
    this.glow.addExcludedMesh(plane);
  }

  // --------------------------------------------------------------- fighters

  /** Builds a sprite for each fighter. Still art is cropped to its visible pixels first. */
  async setFighters(state: GameState): Promise<void> {
    for (const v of this.views) v.root.dispose(false, true);
    this.views = [];
    if (this.stage !== STAGES[state.stage]) this.setStage(state.stage);
    for (const f of state.fighters) {
      const ch = CHARACTERS[f.char];
      const [art, anims] = await Promise.all([loadArt(`/characters/large/${ch.id}.webp`), loadAnimSet(ch.id)]);
      const still = new DynamicTexture(`art-${f.id}`, { width: art.width, height: art.height }, this.scene, true);
      (still.getContext() as CanvasRenderingContext2D).drawImage(art, 0, 0);
      still.update();
      still.hasAlpha = true;

      const root = new TransformNode(`fighter-${f.id}`, this.scene);
      const pose = new TransformNode(`pose-${f.id}`, this.scene);
      pose.parent = root;
      const mat = new StandardMaterial(`fighter-${f.id}`, this.scene);
      mat.useAlphaFromDiffuseTexture = true;
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.emissiveColor = Color3.White();
      setTexture(mat, still);

      const body = CreatePlane(`body-${f.id}`, { size: 1 }, this.scene);
      body.position.z = -0.05 * f.id;
      body.material = mat;
      body.parent = pose;
      this.glow.addExcludedMesh(body);

      const k = f.scale / 100;
      const color = PLAYER_COLORS[f.id % PLAYER_COLORS.length];
      const ring = CreateDisc(`ring-${f.id}`, { radius: ch.width * W * 0.8 * k, tessellation: 32 }, this.scene);
      ring.rotation.x = Math.PI / 2;
      ring.scaling.y = 0.35;
      ring.position.y = 0.01;
      ring.material = this.flatMaterial(`ring-${f.id}`, color, 0.55);
      ring.parent = root;

      const shield = CreateDisc(`shield-${f.id}`, { radius: ch.height * W * 0.62 * k, tessellation: 40 }, this.scene);
      shield.position.set(0, ch.height * W * 0.5 * k, -0.3);
      shield.material = this.flatMaterial(`shield-${f.id}`, color, 0.35);
      shield.parent = root;

      this.views.push({
        root, pose, body, mat, still, stillAspect: art.width / art.height, anims, clipTex: new Map(), ring, shield, flash: 0,
      });
    }
  }

  private clipTexture(v: FighterView, key: string): Texture | null {
    if (!v.anims) return null;
    let tex = v.clipTex.get(key);
    if (!tex) {
      const url = `${v.anims.base}${v.anims.clips[key].file}?v=${v.anims.version}`;
      tex = new Texture(url, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.hasAlpha = true;
      v.clipTex.set(key, tex);
    }
    return tex;
  }

  /** Reacts to sim events with sparks and camera shake. */
  onEvents(events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'hit') {
        const n = e.shield ? 6 : 8 + Math.min(16, e.kb >> 3);
        this.burst(e.x * S, e.y * S, n, e.shield ? 0.06 : 0.09 + e.kb * 0.0006);
        if (!e.shield && this.views[e.victim]) {
          this.views[e.victim].flash = 10;
          this.shake = Math.max(this.shake, Math.min(0.5, e.kb * 0.003));
        }
      } else if (e.type === 'ko') {
        const b = this.stage.blast;
        const x = Math.max(b.left + 40, Math.min(b.right - 40, e.x / FX)) * W;
        const y = Math.max(b.bottom + 40, Math.min(b.top - 40, e.y / FX)) * W;
        this.burst(x, y, 40, 0.25);
        this.shake = 0.9;
      } else if (e.type === 'shieldbreak') {
        this.burst(e.x * S, e.y * S + 0.6, 24, 0.16);
        this.shake = 0.5;
      } else if (e.type === 'land' || e.type === 'jump') {
        this.burst(e.x * S, e.y * S + 0.02, 3, 0.03);
      }
    }
  }

  private burst(x: number, y: number, n: number, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const mesh = CreatePlane('spark', { size: 0.06 + Math.random() * 0.08 }, this.scene);
      mesh.material = this.sparkMat;
      mesh.position.set(x, y, -0.4);
      mesh.rotation.z = a;
      const life = 14 + Math.floor(Math.random() * 14);
      this.sparks.push({ mesh, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life });
    }
  }

  /** Draws one frame. */
  render(state: GameState): void {
    for (const m of this.movers) {
      const p = platformAt(m.platform, state.frame);
      m.node.position.set(((p.x1 + p.x2) / 2) * S, p.y * S, 0);
    }
    for (const f of state.fighters) this.drawFighter(f, this.views[f.id]);
    this.updateSparks();
    this.drawDebug(state);
    this.updateCamera(state);
    this.scene.render();
  }

  private drawFighter(f: Fighter, v: FighterView | undefined): void {
    if (!v) return;
    const ch = CHARACTERS[f.char];
    const dead = f.action === ACT.DEAD;
    v.root.setEnabled(!dead);
    if (dead) return;

    const k = f.scale / 100;
    const height = ch.height * W * ART_SCALE * k;
    let x = f.x * S;
    if (f.hitlag > 0 && f.action === ACT.HITSTUN) x += (f.hitlag & 1 ? 1 : -1) * 0.04;
    v.root.position.set(x, f.y * S, 0);

    // A clip if there is one, else the still with procedural motion.
    const pick = pickClip(f, v.anims);
    const tex = pick ? this.clipTexture(v, pick.key) : null;
    if (pick && tex && v.anims) {
      const c = pick.clip;
      const i = clipFrame(f, pick);
      tex.uScale = 1 / c.cols;
      tex.vScale = 1 / c.rows;
      tex.uOffset = (i % c.cols) / c.cols;
      tex.vOffset = 1 - (Math.floor(i / c.cols) + 1) / c.rows;
      setTexture(v.mat, tex);
      const px = height / v.anims.refHeight;
      v.body.scaling.set(c.fw * px, c.fh * px, 1);
      v.body.position.x = (c.fw / 2 - c.ax) * px;
      v.body.position.y = (c.ay - c.fh / 2) * px;
    } else {
      setTexture(v.mat, v.still);
      v.body.scaling.set(height * v.stillAspect, height, 1);
      v.body.position.x = 0;
      v.body.position.y = height / 2;
    }

    const [sx, sy, rot, lift] = pick?.exact ? [1, 1, 0, 0] : proceduralPose(f, this.stage);
    v.pose.scaling.set(f.facing * sx, sy, 1);
    v.pose.rotation.z = rot;
    v.pose.position.y = lift;

    const flicker = f.intangible > 0 && f.action !== ACT.LEDGE ? (f.frame & 4 ? 0.45 : 0.8) : 1;
    v.mat.alpha = flicker;
    if (v.flash > 0) {
      v.flash--;
      v.mat.emissiveColor.set(1, 0.55 + (10 - v.flash) * 0.045, 0.45 + (10 - v.flash) * 0.055);
    } else {
      v.mat.emissiveColor.set(1, 1, 1);
    }

    v.ring.setEnabled(f.grounded === 1 || f.action === ACT.RESPAWN);
    const shielding = f.action === ACT.SHIELD || f.action === ACT.SHIELD_STUN;
    v.shield.setEnabled(shielding);
    if (shielding) {
      const s = 0.45 + 0.55 * (f.shield / SHIELD_MAX);
      v.shield.scaling.set(s, s, 1);
    }
  }

  private updateSparks(): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.mesh.position.x += s.vx;
      s.mesh.position.y += s.vy;
      s.vx *= 0.9;
      s.vy *= 0.9;
      s.vy -= 0.002;
      const k = --s.life / s.max;
      s.mesh.scaling.set(k, k, 1);
      if (s.life <= 0) {
        s.mesh.dispose();
        this.sparks.splice(i, 1);
      }
    }
  }

  private drawDebug(state: GameState): void {
    for (const m of this.debugMeshes) m.dispose();
    this.debugMeshes = [];
    if (!this.debug) return;
    for (const f of state.fighters) {
      if (f.action === ACT.DEAD) continue;
      const ch = CHARACTERS[f.char];
      const k = f.scale / 100;
      const hurt = CreatePlane('hurt', { width: ch.width * W * k, height: ch.height * W * k }, this.scene);
      hurt.position.set(f.x * S, f.y * S + (ch.height * W * k) / 2, -0.6);
      hurt.material = this.hurtMat;
      this.debugMeshes.push(hurt);
      for (const hb of activeHitboxes(f)) {
        const disc = CreateDisc('hit', { radius: hb.r * S, tessellation: 24 }, this.scene);
        disc.position.set(hb.x * S, hb.y * S, -0.7);
        disc.material = this.debugMat;
        this.debugMeshes.push(disc);
      }
    }
  }

  private updateCamera(state: GameState): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const b = this.stage.blast;
    for (const f of state.fighters) {
      if (f.action === ACT.DEAD) continue;
      const x = Math.max(b.left + 200, Math.min(b.right - 200, f.x / FX)) * W;
      const y = Math.max(b.bottom + 200, Math.min(b.top - 150, f.y / FX)) * W;
      const h = CHARACTERS[f.char].height * W * (f.scale / 100);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + h);
    }
    if (minX === Infinity) {
      minX = -3;
      maxX = 3;
      minY = 0;
      maxY = 2;
    }
    // Keep some of the stage in frame so players never lose their footing.
    minX = Math.min(minX, -2.5);
    maxX = Math.max(maxX, 2.5);
    minY = Math.min(minY, -0.4);
    const pad = 1.6;
    const width = maxX - minX + pad * 2;
    const height = maxY - minY + pad * 2;
    const aspect = this.engine.getAspectRatio(this.camera);
    const tan = Math.tan(this.camera.fov / 2);
    const dist = Math.max(10, Math.min(30, Math.max(height / (2 * tan), width / (2 * tan * aspect))));
    const tx = (minX + maxX) / 2;
    const ty = (minY + maxY) / 2 + 0.3;

    const ease = 0.08;
    this.camTarget.x += (tx - this.camTarget.x) * ease;
    this.camTarget.y += (ty - this.camTarget.y) * ease;
    this.camPos.x = this.camTarget.x;
    this.camPos.y = this.camTarget.y + dist * 0.06;
    this.camPos.z += (-dist - this.camPos.z) * ease;

    this.shake *= 0.86;
    const jx = (Math.random() - 0.5) * this.shake * 0.4;
    const jy = (Math.random() - 0.5) * this.shake * 0.4;
    this.camera.position.set(this.camPos.x + jx, this.camPos.y + jy, this.camPos.z);
    this.camera.setTarget(new Vector3(this.camTarget.x + jx, this.camTarget.y + jy, 0));
  }

  /** Points the camera at the stage, for menus that show it behind them. */
  frameStage(): void {
    this.camTarget.set(0, 1.4, 0);
    this.camPos.set(0, 1.9, -16);
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(this.camTarget);
  }
}

function setTexture(mat: StandardMaterial, tex: Texture | DynamicTexture): void {
  if (mat.diffuseTexture === tex) return;
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
}

/** Squash, stretch, lean and spin that stand in for animation: [scaleX, scaleY, rotation, lift]. */
function proceduralPose(f: Fighter, stage: StageDef): [number, number, number, number] {
  const ch = CHARACTERS[f.char];
  const t = f.frame;
  switch (f.action) {
    case ACT.WALK:
      return [1, 1, -f.facing * 0.06, Math.abs(Math.sin(t * 0.35)) * 0.04];
    case ACT.CROUCH:
      return [1.08, 0.78, 0, 0];
    case ACT.JUMPSQUAT:
      return [1.12, 0.82, 0, 0];
    case ACT.LAND:
      return t < 4 ? [1.08, 0.86, 0, 0] : [1.02, 0.96, 0, 0];
    case ACT.AIR:
      return f.vy > 0 ? [0.96, 1.05, 0, 0] : [1.02, 0.98, 0, 0];
    case ACT.ATTACK: {
      const m = ch.moves[f.move];
      const w = m.hits[0];
      const b = w.boxes[0];
      const ang = Math.atan2(b.y - ch.height * 0.5, b.x);
      if (f.move === MOVE.UPB && t > w.start) return [1, 1, f.facing * t * 0.5, 0];
      if (t < w.start) {
        // Wind up away from the hit.
        const k = t / w.start;
        return [1, 1 - 0.06 * k, f.facing * Math.cos(ang) * 0.14 * k, 0];
      }
      if (t <= w.end + 2) return [1.12, 1 + Math.sin(ang) * 0.12, -f.facing * Math.cos(ang) * 0.28, 0];
      return [1, 1, 0, 0];
    }
    case ACT.HITSTUN: {
      const speed = Math.hypot(f.kbx, f.kby) / FX;
      return [1, 1, speed > 8 ? f.facing * t * 0.35 : f.facing * 0.25, 0];
    }
    case ACT.HELPLESS:
      return [1, 1, Math.sin(t * 0.3) * 0.15, 0];
    case ACT.DIZZY:
      return [1, 1, Math.sin(t * 0.2) * 0.2, 0];
    case ACT.LEDGE: {
      const l = ledges(stage)[f.ledge - 1];
      return [1, 1, (l?.side ?? 1) * 0.25, 0];
    }
    case ACT.ROLL:
      return [1, 1, -f.dir * t * 0.21, 0];
    case ACT.SPOTDODGE:
      return [0.7, 1, 0, 0];
    case ACT.AIRDODGE:
      return [0.9, 1, 0, 0];
    default:
      return [1, 1, 0, 0];
  }
}

/** Paints a stage's background details. Seeded so the same stage always looks the same. */
function paintProps(ctx: CanvasRenderingContext2D, props: StageDef['theme']['props'], glow: string, accent: string): void {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.save();
  switch (props) {
    case 'frame':
      // A dashed frame where the blast zones are, like the site's hero art.
      ctx.strokeStyle = 'rgba(255, 209, 90, 0.16)';
      ctx.setLineDash([10, 14]);
      ctx.lineWidth = 3;
      ctx.strokeRect(40, 30, 944, 452);
      break;
    case 'skyline':
      for (let i = 0; i < 160; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.5})`;
        ctx.fillRect(rand() * 1024, rand() * 220, 1.5, 1.5);
      }
      for (let x = -10; x < 1024; ) {
        const w = 30 + rand() * 60;
        const h = 90 + rand() * 200;
        ctx.fillStyle = '#0b0a16';
        ctx.fillRect(x, 512 - h, w - 4, h);
        ctx.fillStyle = 'rgba(201, 191, 255, 0.35)';
        for (let wy = 512 - h + 10; wy < 500; wy += 14) {
          for (let wx = x + 5; wx < x + w - 10; wx += 10) if (rand() < 0.3) ctx.fillRect(wx, wy, 4, 6);
        }
        x += w;
      }
      break;
    case 'clouds':
      for (let i = 0; i < 26; i++) {
        const x = rand() * 1024;
        const y = 120 + rand() * 360;
        const r = 40 + rand() * 90;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(184, 255, 242, 0.16)');
        g.addColorStop(1, 'rgba(184, 255, 242, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      break;
    case 'embers': {
      const lava = ctx.createLinearGradient(0, 380, 0, 512);
      lava.addColorStop(0, 'rgba(255, 59, 31, 0)');
      lava.addColorStop(1, 'rgba(255, 90, 31, 0.55)');
      ctx.fillStyle = lava;
      ctx.fillRect(0, 380, 1024, 132);
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = rand() < 0.5 ? accent : glow;
        ctx.globalAlpha = 0.25 + rand() * 0.5;
        const s = 1 + rand() * 2.5;
        ctx.fillRect(rand() * 1024, rand() * 512, s, s);
      }
      break;
    }
    case 'pipes':
      for (let x = 20; x < 1024; x += 70 + rand() * 60) {
        const w = 14 + rand() * 18;
        ctx.fillStyle = '#0c1408';
        ctx.fillRect(x, 0, w, 512);
        ctx.fillStyle = glow;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x + w * 0.35, 0, 2, 512);
        ctx.globalAlpha = 0.5;
        for (let y = 60 + rand() * 80; y < 512; y += 90 + rand() * 120) ctx.fillRect(x - 3, y, w + 6, 5);
        ctx.globalAlpha = 1;
      }
      break;
  }
  ctx.restore();
}

const artCache = new Map<string, Promise<HTMLCanvasElement>>();

/** Loads a character image and crops it to the pixels that are actually visible. */
export function loadArt(url: string): Promise<HTMLCanvasElement> {
  let p = artCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(cropToContent(img));
      img.onerror = () => reject(new Error(`Could not load ${url}`));
      img.src = url;
    });
    artCache.set(url, p);
  }
  return p;
}

function cropToContent(img: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, 640 / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let x1 = w;
  let y1 = h;
  let x2 = 0;
  let y2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 120) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < x1) return src;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext('2d')!.drawImage(src, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
