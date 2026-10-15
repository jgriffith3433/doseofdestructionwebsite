// The moving parts of a stage's art: layers that loop on their own (a crowd
// bobbing, a sign swaying), show or hide with stage events, ride hazards or
// moving platforms, and react to KOs, hits and events (a chess king tipping
// over, solar panels tilting away). Also the default look of zones and
// hazards that have no art of their own. Render only: it reads the sim state
// and never writes it.

import type { Scene } from '@babylonjs/core/scene.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { FX } from '../sim/fixed.ts';
import {
  EV_WARN,
  eventIndex,
  eventOn,
  hazardAt,
  platformOffset,
  platformOn,
  zoneOn,
  type LayerReact,
  type StageClock,
  type StageDef,
  type StageLayer,
} from '../sim/stageMath.ts';
import { layerPlacement } from './stageArt.ts';

const W = 1 / 100;

/** A built picture layer and where it rests. */
export interface Placed {
  layer: StageLayer;
  mesh: Mesh;
  mat: StandardMaterial;
  /** Rest position, scene units. */
  x: number;
  y: number;
  /** Depth scale: how much bigger one world unit is at this layer's depth. */
  k: number;
  /** Size once the image has loaded, scene units. */
  size: { w: number; h: number };
}

interface Playing {
  react: LayerReact;
  start: number;
  /** ms; Infinity while held by an event that's still running. */
  end: number;
  /** The event that holds it, released at its end. */
  until?: string;
}

/** Default tints for zones without art of their own. */
const ZONE_TINT: Record<string, { color: string; alpha: number; z: number } | undefined> = {
  damage: { color: '#a23cff', alpha: 0.16, z: 0.1 },
  water: { color: '#2f8cff', alpha: 0.3, z: -0.3 },
};

export class StageLive {
  private playing = new Map<Placed, Playing[]>();
  private zones: { mesh: Mesh; index: number }[] = [];
  private hazards: { mesh: Mesh; ring: Mesh; index: number }[] = [];
  private toggles: { node: TransformNode; index: number }[] = [];
  private stage: StageDef;
  private placed: Placed[];

  constructor(scene: Scene, root: TransformNode, stage: StageDef, placed: Placed[], glow: GlowLayer) {
    this.stage = stage;
    this.placed = placed;
    for (const p of placed) {
      if (p.layer.anim?.kind === 'scroll') {
        const tex = p.mat.diffuseTexture as Texture | null;
        if (tex) tex.wrapU = Texture.WRAP_ADDRESSMODE;
      }
    }
    const mat = (name: string, color: string, alpha: number) => {
      const m = new StandardMaterial(name, scene);
      m.disableLighting = true;
      m.backFaceCulling = false;
      m.emissiveColor = Color3.FromHexString(color);
      m.alpha = alpha;
      m.disableDepthWrite = true;
      root.onDisposeObservable.add(() => m.dispose());
      return m;
    };
    (stage.zones ?? []).forEach((z, index) => {
      const tint = ZONE_TINT[z.kind];
      if (!tint) return;
      const plane = CreatePlane(`zone-${index}`, { width: (z.x2 - z.x1) * W, height: (z.y2 - z.y1) * W }, scene);
      plane.position.set(((z.x1 + z.x2) / 2) * W, ((z.y1 + z.y2) / 2) * W, tint.z);
      plane.material = mat(`zone-${index}`, tint.color, tint.alpha);
      plane.material.alphaMode = Constants.ALPHA_COMBINE;
      plane.parent = root;
      plane.isPickable = false;
      glow.addExcludedMesh(plane);
      this.zones.push({ mesh: plane, index });
    });
    // Hazards nothing rides get a glowing disc, and a ring where they'll come from while they warn.
    const ridden = new Set(placed.map((p) => p.layer.follows).filter(Boolean));
    (stage.hazards ?? []).forEach((hz, index) => {
      if (ridden.has(hz.id)) return;
      const disc = CreateDisc(`hazard-${index}`, { radius: hz.r * W, tessellation: 28 }, scene);
      disc.material = mat(`hazard-${index}`, '#ff4a3a', 0.9);
      disc.parent = root;
      disc.position.z = -0.2;
      const ring = CreateDisc(`hazard-warn-${index}`, { radius: hz.r * W * 1.4, tessellation: 28 }, scene);
      ring.material = mat(`hazard-warn-${index}`, '#ffd15a', 0.35);
      ring.parent = root;
      ring.position.z = -0.2;
      this.hazards.push({ mesh: disc, ring, index });
    });
  }

  /** A platform block that comes and goes with an event. */
  addToggle(node: TransformNode, index: number): void {
    this.toggles.push({ node, index });
  }

  /** A match moment or stage event ('ko', 'hit', 'start', 'end', 'event:<id>', 'warn:<id>', 'eventEnd:<id>'). */
  trigger(on: string): void {
    const now = performance.now();
    if (on.startsWith('eventEnd:')) {
      // Held reactions let go when their event ends.
      const id = on.slice(9);
      for (const list of this.playing.values()) for (const p of list) if (p.until === id) p.end = now;
    }
    for (const pl of this.placed) {
      for (const r of pl.layer.reacts ?? []) {
        if (r.on !== on) continue;
        const held = r.kind === 'tilt' || r.kind === 'tip';
        const holdsEvent = held && on.startsWith('event:') && r.seconds === undefined;
        const secs = r.seconds ?? (held ? 3 : r.kind === 'flash' ? 0.4 : 0.6);
        const list = this.playing.get(pl) ?? [];
        // One of each kind at a time: a new KO restarts the hop rather than stacking.
        const kept = list.filter((p) => p.react.kind !== r.kind);
        kept.push({ react: r, start: now, end: holdsEvent ? Infinity : now + secs * 1000, until: holdsEvent ? on.slice(6) : undefined });
        this.playing.set(pl, kept);
      }
    }
  }

  update(c: StageClock): void {
    const now = performance.now();
    const t = c.frame / 60;
    for (const pl of this.placed) this.place(pl, c, t, now);
    for (const z of this.zones) z.mesh.setEnabled(zoneOn(this.stage, c, this.stage.zones![z.index]));
    for (const h of this.hazards) {
      const hz = this.stage.hazards![h.index];
      const at = hazardAt(this.stage, c, hz);
      h.mesh.setEnabled(!!at);
      if (at) h.mesh.position.set((at.x / FX) * W, (at.y / FX) * W, -0.2);
      const ev = eventIndex(this.stage, hz.during);
      const warning = ev >= 0 && c.evPhase[ev] === EV_WARN && hz.path.length > 0;
      h.ring.setEnabled(warning && Math.floor(now / 200) % 2 === 0);
      if (warning) {
        const b = this.stage.blast;
        const p = hz.path[0];
        h.ring.position.set(Math.max(b.left + 150, Math.min(b.right - 150, p.x)) * W, Math.max(b.bottom + 150, Math.min(b.top - 150, p.y)) * W, -0.2);
      }
    }
    for (const tg of this.toggles) tg.node.setEnabled(platformOn(this.stage, c, tg.index));
  }

  private place(pl: Placed, c: StageClock, t: number, now: number): void {
    const l = pl.layer;
    let visible = true;
    if (l.showDuring) visible = eventOn(this.stage, c, l.showDuring);
    if (l.hideDuring && eventOn(this.stage, c, l.hideDuring)) visible = false;
    let x = pl.x;
    let y = pl.y;
    let flip = 1;
    if (l.follows) {
      const hz = this.stage.hazards?.find((h) => h.id === l.follows);
      const at = hz ? hazardAt(this.stage, c, hz) : null;
      if (!at) visible = false;
      else {
        const p = layerPlacement({ x: at.x / FX, y: at.y / FX, z: l.z, width: l.width });
        x = p.x;
        y = p.y;
        // Art is painted facing right.
        flip = at.dir;
      }
    } else {
      const moving = (l.platforms ?? []).map((i) => this.stage.platforms[i]).find((p) => p?.motion);
      if (moving) {
        const [dx, dy] = platformOffset(moving, c.frame);
        x += (dx / FX) * W * pl.k;
        y += (dy / FX) * W * pl.k;
      }
    }
    pl.mesh.setEnabled(visible);
    if (!visible) return;

    let rot = 0;
    let centerPivot = false;
    let scale = 1;
    const a = l.anim;
    if (a) {
      const period = Math.max(0.1, a.speed ?? 2);
      const wave = Math.sin((t / period) * Math.PI * 2);
      const amt = a.amount ?? 0;
      if (a.kind === 'bob') y += (amt || 6) * W * pl.k * wave;
      else if (a.kind === 'wave') x += (amt || 10) * W * pl.k * wave;
      else if (a.kind === 'sway') rot += (amt || 4) * wave;
      else if (a.kind === 'pulse') scale *= 1 + ((amt || 4) / 100) * wave;
      else if (a.kind === 'spin') {
        rot += ((t / period) * 360 * Math.sign(amt || 1)) % 360;
        centerPivot = true;
      } else if (a.kind === 'scroll') {
        const tex = pl.mat.diffuseTexture as Texture | null;
        if (tex) tex.uOffset = (t / period) * Math.sign(amt || 1);
      }
    }

    let overlay = 0;
    const list = this.playing.get(pl);
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        const r = p.react;
        const len = Math.max(1, (r.seconds ?? 0.6) * 1000);
        const e = Math.min(1, (now - p.start) / (r.kind === 'tilt' || r.kind === 'tip' ? 400 : len));
        if (r.kind === 'hop') y += (r.amount ?? 30) * W * pl.k * Math.sin(Math.PI * e);
        else if (r.kind === 'shake') x += (r.amount ?? 8) * W * pl.k * (Math.random() - 0.5) * (1 - e);
        else if (r.kind === 'spin') rot += (r.amount ?? 360) * (1 - (1 - e) * (1 - e));
        else if (r.kind === 'flash') overlay = Math.max(overlay, 1 - e);
        else {
          // tilt and tip ease over, hold, and ease back once released.
          const back = now > p.end ? Math.min(1, (now - p.end) / 400) : 0;
          const k = (1 - (1 - e) * (1 - e)) * (1 - back);
          rot += (r.amount ?? (r.kind === 'tip' ? 80 : 25)) * k;
        }
        if (now > p.end + (r.kind === 'tilt' || r.kind === 'tip' ? 400 : 0)) list.splice(i, 1);
      }
    }

    // Positive angles lean right (clockwise), around the bottom edge unless it spins.
    const th = (-rot * Math.PI) / 180;
    const hh = (pl.size.h * scale) / 2;
    if (!centerPivot && th) {
      x += -hh * Math.sin(th);
      y += hh * Math.cos(th) - hh;
    }
    pl.mesh.position.x = x;
    pl.mesh.position.y = y;
    pl.mesh.rotation.z = th;
    if (pl.size.w) pl.mesh.scaling.set(pl.size.w * scale * flip, pl.size.h * scale, 1);
    pl.mesh.renderOverlay = overlay > 0;
    if (overlay > 0) {
      pl.mesh.overlayColor = Color3.White();
      pl.mesh.overlayAlpha = overlay * 0.7;
    }
  }
}
