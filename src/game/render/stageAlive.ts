// Procedural life for every stage, made from no new art: sweeping and blinking rig lights, a bobbing and waving
// crowd silhouette, a crane arm and a crew member crossing, and a stage screen that shows a live low-res render of
// the fighters (High) or a looping graphic (Low). Every piece sits on its own fixed depth slot behind the fighters
// (z 11 to 16, never the same z twice), so nothing is coplanar and fighters always draw over it. Render only.

import type { Scene } from '@babylonjs/core/scene.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import type { StageDef } from '../sim/stageMath.ts';
import { layerPlacement } from './stageArt.ts';
import type { Quality } from '../graphics.ts';

const W = 1 / 100;

/** Fixed depth slots, far to near; the stage's own art sits at 0.3 and below 10 or at the backdrop's 18 and up. */
const Z = { screenFrame: 16.4, screen: 16, beams: 15, crane: 14, crew: 13, crowd: 12, crowdFront: 11.5 };

interface Mover {
  name: string;
  node: TransformNode;
  move: (t: number) => void;
  x: number;
  y: number;
  rot: number;
}

const tex = (scene: Scene, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): DynamicTexture => {
  const t = new DynamicTexture('alive', { width: w, height: h }, scene, false);
  const c = t.getContext() as CanvasRenderingContext2D;
  draw(c);
  t.hasAlpha = true;
  t.update();
  return t;
};

export class StageAlive {
  private movers: Mover[] = [];
  private blink: { mat: StandardMaterial; base: number; period: number; phase: number }[] = [];
  private screenMat: StandardMaterial | null = null;
  private screenTex: DynamicTexture | null = null;
  private rtt: RenderTargetTexture | null = null;
  private disposables: { dispose(): void }[] = [];
  private screenLive = false;

  private scene: Scene;
  private root: TransformNode;
  private stage: StageDef;
  private glow: GlowLayer;
  private fighters: () => Mesh[];
  private camera: Camera;

  constructor(scene: Scene, root: TransformNode, stage: StageDef, glow: GlowLayer, quality: Quality, fighters: () => Mesh[], camera: Camera) {
    this.scene = scene;
    this.root = root;
    this.stage = stage;
    this.glow = glow;
    this.fighters = fighters;
    this.camera = camera;
    this.build(quality);
  }

  private mat(t: DynamicTexture | null, color: string, alpha: number, add = false): StandardMaterial {
    const m = new StandardMaterial('alive', this.scene);
    m.disableLighting = true;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    m.emissiveColor = Color3.FromHexString(color);
    if (t) {
      m.diffuseTexture = t;
      m.opacityTexture = t;
      m.emissiveTexture = t;
      m.emissiveColor = add ? Color3.FromHexString(color) : Color3.White();
    }
    m.alpha = alpha;
    if (add) m.alphaMode = Constants.ALPHA_ADD;
    this.disposables.push(m);
    return m;
  }

  private plane(name: string, m: StandardMaterial, w: number, h: number, parent: TransformNode, y = 0): Mesh {
    const p = CreatePlane(name, { width: w, height: h }, this.scene);
    p.material = m;
    p.parent = parent;
    p.position.y = y;
    p.isPickable = false;
    this.glow.addExcludedMesh(p);
    return p;
  }

  /** A node placed from authored world coordinates at a depth slot. */
  private anchor(name: string, x: number, y: number, z: number): { node: TransformNode; k: number } {
    const at = layerPlacement({ x, y, width: 1, z });
    const node = new TransformNode(`alive-${name}`, this.scene);
    node.parent = this.root;
    node.position.set(at.x, at.y, z);
    return { node, k: at.width };
  }

  private build(quality: Quality): void {
    const low = quality === 'low';
    const theme = this.stage.theme.glow;
    const hues = [theme, '#ffd15a', '#ff4fd8', '#3fa7ff'];
    const b = this.stage.blast;
    const span = b.right - b.left;

    // Rig lights: tapered beams hung from the top that sweep, and blink.
    const beam = tex(this.scene, 64, 256, (c) => {
      const g = c.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(26, 0);
      c.lineTo(38, 0);
      c.lineTo(64, 256);
      c.lineTo(0, 256);
      c.closePath();
      c.fill();
    });
    this.disposables.push(beam);
    const nBeams = low ? 2 : 4;
    for (let i = 0; i < nBeams; i++) {
      const x = b.left + (span * (i + 0.5)) / nBeams;
      const { node, k } = this.anchor(`beam${i}`, x, b.top - 100, Z.beams + i * 0.05);
      const m = this.mat(beam, hues[i % hues.length], 0.5, true);
      this.plane(`alive-beam${i}`, m, 2.4 * k, 9 * k, node, -4.5 * k);
      const phase = i * 1.7;
      const speed = 0.6 + i * 0.13;
      this.blink.push({ mat: m, base: 0.5, period: 2.2 + i * 0.7, phase });
      this.movers.push({ name: `beam${i}`, node, x: node.position.x, y: node.position.y, rot: 0, move: (t) => (node.rotation.z = Math.sin(t * speed + phase) * 0.55) });
    }

    // Crowd silhouette: a row of heads and raised arms that bobs, one row on Low, two on High.
    const crowd = tex(this.scene, 512, 64, (c) => {
      c.fillStyle = '#0b0710';
      for (let i = 0; i < 24; i++) {
        const x = 10 + i * 21;
        c.beginPath();
        c.arc(x, 40 + ((i * 7) % 9), 9, 0, Math.PI * 2);
        c.fill();
        c.fillRect(x - 8, 48, 16, 16);
        if (i % 3 === 0) c.fillRect(x + 7, 14 + ((i * 5) % 8), 4, 30);
      }
    });
    this.disposables.push(crowd);
    for (let r = 0; r < (low ? 1 : 2); r++) {
      const { node, k } = this.anchor(`crowd${r}`, 0, b.bottom + 330 - r * 40, r ? Z.crowdFront : Z.crowd);
      const m = this.mat(crowd, '#ffffff', r ? 1 : 0.85);
      this.plane(`alive-crowd${r}`, m, (span * W * k) / 1.0, ((span * W * k) / 8) * 1.0, node);
      const base = node.position.y;
      this.movers.push({ name: `crowd${r}`, node, x: 0, y: base, rot: 0, move: (t) => {
        node.position.y = base + 0.12 * k * Math.abs(Math.sin(t * (2.1 + r * 0.6) + r));
        node.position.x = Math.sin(t * 1.3 + r) * 0.15 * k;
      } });
    }

    // Camera crane: an arm swinging over the stage from the left edge, with its lamp.
    const crane = tex(this.scene, 256, 32, (c) => {
      c.fillStyle = '#120d18';
      c.fillRect(0, 12, 230, 8);
      c.fillRect(200, 6, 50, 20);
      c.fillStyle = '#ffe9a8';
      c.fillRect(238, 14, 10, 6);
    });
    this.disposables.push(crane);
    {
      const { node, k } = this.anchor('crane', b.left + 150, b.top - 350, Z.crane);
      const m = this.mat(crane, '#ffffff', 1);
      this.plane('alive-crane', m, 6 * k, 0.75 * k, node, 0).position.x = 3 * k;
      this.movers.push({ name: 'crane', node, x: node.position.x, y: node.position.y, rot: 0, move: (t) => (node.rotation.z = -0.12 + Math.sin(t * 0.35) * 0.1) });
    }

    // A crew silhouette crossing behind the stage and back.
    if (!low) {
      const crew = tex(this.scene, 32, 64, (c) => {
        c.fillStyle = '#0d0912';
        c.beginPath();
        c.arc(16, 10, 8, 0, Math.PI * 2);
        c.fill();
        c.fillRect(8, 18, 16, 28);
        c.fillRect(8, 46, 6, 18);
        c.fillRect(18, 46, 6, 18);
      });
      this.disposables.push(crew);
      const { node, k } = this.anchor('crew', 0, b.bottom + 520, Z.crew);
      this.plane('alive-crew', this.mat(crew, '#ffffff', 1), 0.7 * k, 1.4 * k, node);
      const sx = node.position.x;
      this.movers.push({ name: 'crew', node, x: sx, y: node.position.y, rot: 0, move: (t) => {
        const u = (t / 14) % 2;
        node.position.x = sx + (u < 1 ? u - 0.5 : 1.5 - u) * span * W * k * 0.8;
        node.scaling.x = u < 1 ? 1 : -1;
      } });
    }

    // Stage screen: the live match on High, a looping graphic on Low.
    {
      const { node, k } = this.anchor('screen', 0, b.top - 330, Z.screen);
      const sw = 3.6 * k;
      const sh = 2.025 * k;
      this.plane('alive-screen-frame', this.mat(null, '#050308', 1), sw + 0.25 * k, sh + 0.25 * k, node).position.z = Z.screenFrame - Z.screen;
      const m = new StandardMaterial('alive-screen', this.scene);
      m.disableLighting = true;
      m.backFaceCulling = false;
      this.disposables.push(m);
      if (!low) {
        const rtt = new RenderTargetTexture('alive-screen', { width: 192, height: 108 }, this.scene, false);
        rtt.activeCamera = this.camera;
        rtt.renderList = this.fighters();
        rtt.clearColor = new Color3(0.04, 0.03, 0.08).toColor4(1);
        rtt.refreshRate = 3;
        this.scene.customRenderTargets.push(rtt);
        this.rtt = rtt;
        m.emissiveTexture = rtt;
        this.screenLive = true;
      } else {
        const g = tex(this.scene, 128, 72, (c) => {
          for (let i = 0; i < 8; i++) {
            c.fillStyle = hues[i % hues.length];
            c.fillRect(i * 16, 0, 16, 72);
          }
          c.fillStyle = 'rgba(0,0,0,0.45)';
          for (let y = 0; y < 72; y += 4) c.fillRect(0, y, 128, 2);
        });
        g.wrapU = DynamicTexture.WRAP_ADDRESSMODE;
        this.screenTex = g;
        m.emissiveTexture = g;
      }
      m.emissiveColor = Color3.White();
      this.screenMat = m;
      const p = this.plane('alive-screen', m, sw, sh, node);
      p.alphaIndex = 1;
      if (this.rtt) {
        // Looking down the camera at the screen, the render appears mirrored as a plain texture, so flip it back.
        (m.emissiveTexture as RenderTargetTexture).vScale = -1;
        (m.emissiveTexture as RenderTargetTexture).vOffset = 1;
      }
      this.movers.push({ name: 'screen', node, x: node.position.x, y: node.position.y, rot: 0, move: (t) => {
        if (this.screenTex) this.screenTex.uOffset = (t * 0.25) % 1;
        node.position.y = this.movers.find((v) => v.name === 'screen')!.y + Math.sin(t * 0.8) * 0.03 * k;
      } });
    }
  }

  /** Called every rendered frame, with the wall clock in seconds. */
  update(t: number): void {
    for (const m of this.movers) m.move(t);
    for (const b of this.blink) b.mat.alpha = b.base * (0.25 + 0.75 * (Math.sin((t / b.period) * Math.PI * 2 + b.phase) > -0.3 ? 1 : 0.1));
  }

  /** Enables the render list for the screen's live view (fighters are rebuilt per match). */
  setFighters(meshes: Mesh[]): void {
    if (this.rtt) this.rtt.renderList = meshes;
  }

  /** What is moving and what the screen shows, for the playtest. */
  stats() {
    return {
      pieces: this.movers.map((m) => m.name),
      positions: this.movers.map((m) => [m.name, Number(m.node.position.x.toFixed(3)), Number(m.node.position.y.toFixed(3)), Number(m.node.rotation.z.toFixed(3))] as const),
      screen: (this.screenLive ? 'live' : 'loop') as 'live' | 'loop',
      screenRefresh: this.rtt?.refreshRate ?? 0,
      depths: this.movers.map((m) => m.node.position.z),
    };
  }

  dispose(): void {
    if (this.rtt) {
      const i = this.scene.customRenderTargets.indexOf(this.rtt);
      if (i >= 0) this.scene.customRenderTargets.splice(i, 1);
      this.rtt.dispose();
    }
    for (const d of this.disposables) d.dispose();
    this.screenMat = null;
  }
}
