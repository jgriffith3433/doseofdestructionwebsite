// Draws a GameState with Babylon. Nothing here feeds back into the sim: the
// renderer only reads state and the events step() returns.

import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { LookPlugin } from './lookPlugin.ts';
import { LightPlugin } from './lightPlugin.ts';
import { RemapPlugin, OutlinePlugin } from './stylePlugin.ts';
import { IDENTITY, outlineWidthPx } from '../artStyle.ts';
import { REFLECTION_ALPHA, floorBelow, lightOf, shadowAt } from './fighterLight.ts';
import { COUNTER_TINT, Flipbooks, FLIPBOOK_KINDS, fighterTint, type FlipStats } from './flipbook.ts';
import { lookOf, recolorHex } from '../looks.ts';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import '@babylonjs/core/Layers/effectLayerSceneComponent.js';

import { FX } from '../sim/fixed.ts';
import { entranceBeats, entrancePose, flyCamera, flyProgress, type BeatFx, type IntroPlan, type Pose } from '../campaign/intro.ts';
import { CHARACTERS, MOVE } from '../sim/characters.ts';
import { STAGES, ledges, platformAt, type Platform, type StageDef } from '../sim/stage.ts';
import { ACT, SHIELD_MAX, type Fighter, type GameState } from '../sim/state.ts';
import { GRAB_FIRST, activeHitboxes, rigPos, type SimEvent } from '../sim/step.ts';
import { KILL_CUE, TUMBLE_SPEED, reactionFor, hitTier, impactFor, killPunch, killTimeScale, screenShake, trailFor, type HitTier, type TrailKind } from '../hitFeel.ts';
import { graphics, onGraphics, particleShare, scalingLevel, type Graphics } from '../graphics.ts';
import { cameraFighters, followCamera, frameGoal, punchGoal, type CamBounds, type CamState } from './cameraRig.ts';
import { clipFrame, clipSheetFile, feetLift, loadAnimSet, pickClip, type AnimSet } from './anims.ts';
import { StageFx, buildLayers, drawnPlatforms, layersFor } from './stageArt.ts';
import { behindForeground, bodyPoints, fadeToward } from './foreground.ts';
import { StageLive } from './stageLive.ts';
import { StageAlive } from './stageAlive.ts';
import { PostChain } from './post.ts';
import { Constants } from '@babylonjs/core/Engines/constants.js';

/** Sim units to scene units: 100 world units per scene unit. */
/**
 * Gives the page one chance to paint (the wipe, the VS card, the fps meter) between warm-up steps,
 * instead of holding the main thread for the whole warm-up. The timer covers a hidden page.
 */
const breathe = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => r());
    setTimeout(r, 24);
  });

const S = 1 / (100 * FX);
const W = 1 / 100;
/** How far a hanging fighter's hands come up over the ledge's top edge, in scene units. */
const GRIP = 0.04;
/** How long a fighter's drop-in takes in a story scene. */
const ARRIVE_MS = 520;
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
  /** The fighter's silhouette, shown only where stage art in front covers them. */
  ghost: Mesh | null;
  ghostMat: StandardMaterial | null;
  /** A thin player-colour silhouette just behind the body, so a fighter separates from a busy stage. */
  rim: Mesh;
  rimMat: StandardMaterial;
  /** Roster index and colour look this view was built for (playtest). */
  charIdx: number;
  lookIdx: number;
  tumble?: number;
  /** The stage's key, rim and ambient on the sprite (lightPlugin.ts). */
  light: LightPlugin;
  /** The art bible's remap and outline on the sprite (stylePlugin.ts). */
  outline: OutlinePlugin;
  /** The soft contact shadow under the feet, and its material (alpha follows the height). */
  shadow: Mesh;
  shadowMat: StandardMaterial;
  /** The faint mirror image on a glossy floor (High only): a pivot flipped under the floor, its plane and material. */
  reflRoot: TransformNode;
  reflPose: TransformNode;
  refl: Mesh;
  reflMat: StandardMaterial;
  /** What the last frame drew, for the playtest. */
  lit: { height: number; scale: number; alpha: number; shadow: boolean; reflection: boolean };
}

/** One launch's smoke trail, kept for the playtest: what it was and how many puffs it threw. */
export interface TrailRecord { seq: number; victim: number; tier: HitTier; kb: number; kind: TrailKind; ko: boolean; puffs: number }

interface Spark {
  mesh: Mesh;
  /** Impact sprites (stars, rings) grow as they fade; plain sparks don't. */
  grow?: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  /** A streak (dash trail): stretched along x. */
  stretch?: number;
}

/** Looks of a special's projectile or trap, by ShotDef.style: 0 thrown board, 1 placed trap, 2 orb. */
const SHOT_LOOKS = ['board', 'trap', 'orb'] as const;

/** Depth of every hit, dust and streak effect: behind the fighters (they sit at z 0 to -0.05), in front of the stage, so no effect covers a body or its outline. */
const FX_Z = 0.06;

export class Renderer {
  readonly engine: Engine;
  readonly scene: Scene;
  private camera: FreeCamera;
  private sky!: HemisphericLight;
  private rig: Mesh | null = null;
  private views: FighterView[] = [];
  private sparks: Spark[] = [];
  /** Finished spark meshes, reused so a KO burst doesn't build geometry mid-fight. */
  private sparkPool: Mesh[] = [];
  private sparkMat: StandardMaterial;
  /** Visual-only reactions per fighter (squash, push, bounce); render reads sim state and never writes it. */
  private react = new Map<number, { age: number; frames: number; squash: number; push: number; dir: number; hop: number }>();
  private prevGround = new Map<number, number>();
  private reactStats = { squashes: 0, maxSquash: 0, squashFrames: 0, tumbleFrames: 0, bounces: 0, dustBursts: 0, smears: 0, smearFrames: 0, smashSmears: 0, charges: 0 };
  /** Launch-trail looks: grey smoke (medium), white smoke (heavy), a coloured streak (a hit that will KO). */
  private smokeMats!: { grey: StandardMaterial; white: StandardMaterial; streak: StandardMaterial };
  /** The last hit on each victim (knockback and tier), read when its launch begins. */
  private lastHits = new Map<number, { kb: number; tier: HitTier }>();
  /** Launches in hit-stun that throw a trail until they recover (victim id -> trail). */
  private trails = new Map<number, TrailRecord>();
  private trailLog: TrailRecord[] = [];
  private trailSeq = 0;
  /** Projectile and trap sprites, one plane per shot in play (index = position in state.shots), and their looks. */
  private shotMeshes: Mesh[] = [];
  private shotMats: StandardMaterial[] | null = null;
  private lastTrail = -1;
  /** Painted special-effect flipbooks (render/flipbook.ts): a pre-warmed pool, tinted per fighter. */
  private flip: Flipbooks;
  private flipTints = new Map<number, Color3>();
  /** Sim frame the special effects last ran for (a pause or a paused render draws none twice). */
  private flipFrame = -1;
  private flipLast = new Map<number, { move: number; frame: number }>();
  private lastState: GameState | null = null;
  private debugMeshes: Mesh[] = [];
  private debugMat: StandardMaterial;
  private hurtMat: StandardMaterial;
  private glow: GlowLayer;
  private post: PostChain;
  private stageRoot: TransformNode | null = null;
  private movers: { platform: Platform; node: TransformNode }[] = [];
  private stage: StageDef = STAGES[0];
  /**
   * Clip sheets, kept between matches (a rematch starts instantly). Keyed by
   * fighter slot and URL: two of the same fighter each need their own texture,
   * since each shows its own frame.
   */
  private clipCache = new Map<string, Texture>();
  private fx: StageFx | null = null;
  private live: StageLive | null = null;
  private alive: StageAlive | null = null;
  /** A plane over the whole view that stage effects flash. */
  private flashPlane: Mesh;
  private flashMat: StandardMaterial;
  /** Whether this stage has art in front of the fighters that hides them. */
  private occluders = false;
  /** Plays a sound effect for stage effects (main wires it to the audio system). */
  onSound: ((id: string) => void) | null = null;
  /** Procedural effects (synth.ts) the renderer asks for, like an arrival's thud. */
  onSynth: ((kind: 'thud' | 'whoosh' | 'whistle') => void) | null = null;
  private shake = 0;
  /** A story scene's camera (scene.ts): a close-up on one fighter, or a wide shot; null is the gameplay camera. */
  private shot: { focus: number | null; since: number } | null = null;
  /** Fighters held off stage until their arrival, and arrivals in progress (fighter id -> start time). */
  private offstage = new Set<number>();
  private arriving = new Map<number, number>();
  /** The match intro in progress (campaign/intro.ts): its clock, each fighter's entrance pose and the beats already fired. */
  private intro: { t0: number; plan: IntroPlan; fired: Map<number, number>; poses: Map<number, Pose>; beats: number; flyMax: number; lastD: number } | null = null;
  private introMats = new Map<string, StandardMaterial>();
  private introProps = new Map<number, Mesh>();
  /** Called at each entrance beat (main.ts plays the taunt on 'taunt'). */
  onIntroBeat: ((slot: number, who: string, fx: BeatFx) => void) | null = null;
  /** Speakers in a story scene: a small bounce while their line starts (fighter id -> start time). */
  private talking = new Map<number, number>();
  /** The last hit's effect and the camera shake actually applied, for the playtest to read. */
  private hitStats = { hits: 0, last: null as null | { tier: HitTier; lag: number; sparks: number; stars: number; ring: boolean; shake: number; flash: number }, tiers: { light: 0, medium: 0, heavy: 0 }, shakeApplied: 0, shakeMax: 0 };
  /** Camera follow state: smoothed distance and the critically damped velocities (pan x, pan y, zoom), and the last frame's time. */
  private camDist = 14;
  private camRig: CamState = { x: 0, y: 1.6, d: 14, vx: 0, vy: 0, vd: 0 };
  private camSide = 0;
  private camTilt = 0;
  private camMs = 0;
  /** The next gameplay frame sets the camera outright (a new stage, a rematch, a menu shot): an intended cut, never a jump. */
  private camCut = true;
  /** The kill cue in progress: when the finishing hit landed (ms) and where. */
  private kill: { at: number; x: number; y: number } | null = null;
  /** What the camera and kill cues did, for the playtest (cameraJumps must stay 0). */
  private camStats = { cameraJumps: 0, framingMisses: 0, killCues: 0, slowFpsMin: 0, lastCue: null as null | { zoom: boolean; slow: boolean; whistle: boolean; shake: number; punch: number } };
  private camPos = new Vector3(0, 1.6, -14);
  private camTarget = new Vector3(0, 1.6, 0);
  debug = false;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, false);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.063, 0.055, 0.047, 1) // brand dark (#100e0c), the fallback if the canvas ever shows;

    this.camera = new FreeCamera('cam', this.camPos.clone(), this.scene);
    this.camera.fov = 0.55;
    this.camera.setTarget(this.camTarget);
    this.camera.inputs.clear();

    const light = (this.sky = new HemisphericLight('sky', new Vector3(0.2, 1, -0.6), this.scene));
    light.intensity = 0.95;
    light.groundColor = new Color3(0.18, 0.1, 0.08);

    this.post = new PostChain(this.scene, this.camera);
    this.glow = new GlowLayer('glow', this.scene, { mainTextureSamples: 2 });
    this.glow.intensity = 0.6;
    // Silhouettes draw in group 1 against the depth group 0 left behind.
    this.scene.setRenderingAutoClearDepthStencil(1, false, false, false);

    this.sparkMat = this.flatMaterial('spark', '#ffd15a');
    // Soft radial alpha so impact stars/rings read as a glow, not a hard square (GlowLayer
    // used to bloom the whole opaque plane into a blown-out white rectangle over the fighter).
    const soft = this.softSparkTex();
    this.sparkMat.diffuseTexture = soft;
    this.sparkMat.opacityTexture = soft;
    this.sparkMat.emissiveTexture = soft;
    this.sparkMat.alphaMode = Constants.ALPHA_ADD;
    this.sparkMat.disableDepthWrite = true;
    // The spark/KO pool exists from the start, so the warm-up (which can finish under the match wipe) never counts an empty one.
    // Smoke for the launch trail: alpha-blended (grey and white) and additive (the KO streak), sharing the soft disc.
    const smoke = (name: string, hex: string, add: boolean): StandardMaterial => {
      const m = this.flatMaterial(name, hex);
      m.diffuseTexture = soft;
      m.opacityTexture = soft;
      m.emissiveTexture = soft;
      m.disableDepthWrite = true;
      if (add) m.alphaMode = Constants.ALPHA_ADD;
      else m.alpha = 0.3; // faint: smoke must never compete with the fighters
      return m;
    };
    this.smokeMats = { grey: smoke('smoke-grey', '#9a9a9e', false), white: smoke('smoke-white', '#ffffff', false), streak: smoke('smoke-streak', '#ff4a1f', true) };
    for (let i = 0; i < 96; i++) {
      const m = this.makeSpark();
      m.setEnabled(false);
      this.sparkPool.push(m);
    }
    this.flip = new Flipbooks(this.scene, (m) => this.glow.addExcludedMesh(m));
    this.flip.setQuality(this.gfx.quality);
    this.debugMat = this.flatMaterial('dbg-hit', '#ff2a2a', 0.45);
    this.hurtMat = this.flatMaterial('dbg-hurt', '#ffd15a', 0.22);

    this.flashMat = this.flatMaterial('flash', '#ffffff', 0);
    this.flashMat.disableDepthWrite = true;
    this.flashPlane = CreatePlane('flash', { size: 40 }, this.scene);
    this.flashPlane.material = this.flashMat;
    this.flashPlane.parent = this.camera;
    this.flashPlane.position.set(0, 0, 2);
    this.flashPlane.isPickable = false;
    this.flashPlane.renderingGroupId = 1;
    this.flashPlane.setEnabled(false);
    this.glow.addExcludedMesh(this.flashPlane);

    this.setStage(0);
    this.applyGraphics(graphics());
    onGraphics((g) => this.applyGraphics(g));
    this.buildFpsMeter();
    // A new pixel ratio (zoom, another screen) arrives with a resize.
    window.addEventListener('resize', () => {
      this.applyGraphics(graphics());
      this.engine.resize();
    });
  }

  private gfx: Graphics = graphics();
  private fpsEl: HTMLElement | null = null;

  /** Quality, Glow and Show FPS, applied live: render scale, the glow layer, particle counts, the readout. */
  private applyGraphics(g: Graphics): void {
    const qualityChanged = g.quality !== this.gfx.quality;
    this.gfx = g;
    this.engine.setHardwareScalingLevel(scalingLevel(g.quality, window.devicePixelRatio));
    if (qualityChanged && this.alive) this.showStage(this.stage);
    if (qualityChanged) this.engine.resize();
    // Low loads half-resolution clip sheets when present; drop cached textures so the next preload picks the right file.
    if (qualityChanged) {
      for (const tex of this.clipCache.values()) tex.dispose();
      this.clipCache.clear();
      for (const v of this.views) v.clipTex.clear();
      void this.preloadClips(0);
    }
    if (qualityChanged) this.flip.setQuality(g.quality);
    this.glow.isEnabled = g.glow;
    this.post.setQuality(g.quality);
    this.applyLight();
    if (this.fpsEl) this.fpsEl.hidden = !g.fps;
  }

  /** The Orchestrator seizes the feed: a 1 s RGB-split glitch over the whole picture (the HUD and screens are DOM, so they get a CSS glitch of their own). */
  glitch(ms = 1000): void {
    this.post.glitch(ms);
    this.shake = Math.max(this.shake, 0.25);
  }

  /** The post chain's state (grade, vignette, grain, hit punches), for the playtest. */
  postStats() {
    return this.post.report();
  }

  /** Stage life pieces and the screen mode, for the playtest. */
  aliveStats() {
    return this.alive?.stats() ?? null;
  }

  /** The render scale and glow actually in use, for the playtest. */
  gfxStats() {
    return {
      quality: this.gfx.quality,
      glow: this.gfx.glow,
      showFps: this.gfx.fps,
      dpr: window.devicePixelRatio || 1,
      scale: Number((1 / this.engine.getHardwareScalingLevel()).toFixed(3)),
      glowOn: this.glow.isEnabled,
      fpsShown: !!this.fpsEl && !this.fpsEl.hidden,
      fpsNow: this.engine.getFps(),
    };
  }

  /** A small corner readout, redrawn twice a second from the render loop's own frame end (no timers). */
  private buildFpsMeter(): void {
    const el = document.createElement('div');
    el.id = 'fps-meter';
    el.setAttribute('aria-hidden', 'true');
    el.hidden = !this.gfx.fps;
    el.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:60;padding:2px 6px;font:700 11px/1.3 monospace;color:#ffd15a;background:rgba(16,14,12,.7);border-radius:3px;pointer-events:none';
    document.body.appendChild(el);
    this.fpsEl = el;
    let last = 0;
    this.engine.onEndFrameObservable.add(() => {
      if (el.hidden) return;
      const now = performance.now();
      if (now - last < 500) return;
      last = now;
      el.textContent = `${Math.round(this.engine.getFps())} FPS`;
    });
  }

  private flatMaterial(name: string, hex: string, alpha = 1): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.emissiveColor = Color3.FromHexString(hex);
    m.alpha = alpha;
    m.backFaceCulling = false;
    return m;
  }

  /** Soft white disc for hit sparks / impact flashes (alpha falls off to the edge). */
  private softSparkTex(): DynamicTexture {
    const t = new DynamicTexture('spark-soft', { width: 64, height: 64 }, this.scene, false);
    const c = t.getContext() as CanvasRenderingContext2D;
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.clearRect(0, 0, 64, 64);
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    t.hasAlpha = true;
    t.update();
    return t;
  }

  /** One spark plane from the pool (or a new one), soft-glowed and kept out of the glow layer. */
  private takeSpark(mat: StandardMaterial = this.sparkMat): Mesh {
    const reused = this.sparkPool.pop();
    if (reused) {
      reused.material = mat;
      reused.setEnabled(true);
      return reused;
    }
    const mesh = this.makeSpark();
    mesh.material = mat;
    mesh.setEnabled(true);
    return mesh;
  }

  private makeSpark(): Mesh {
    const mesh = CreatePlane('spark', { size: 1 }, this.scene);
    mesh.material = this.sparkMat;
    mesh.isPickable = false;
    // Soft material already looks like a glow; exclude so GlowLayer doesn't square-bloom the plane.
    this.glow.addExcludedMesh(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------ stage

  setStage(index: number): void {
    const next = STAGES[index] ?? STAGES[0];
    // Same stage already built (Stage Select prep, or a rematch): skip the rebuild so the VS wipe stays free.
    if (this.stage === next && this.stageRoot) return;
    this.showStage(next);
  }

  /** Builds any stage, saved or not (devtools previews unsaved ones). */
  showStage(stage: StageDef): void {
    this.stageRoot?.dispose(false, true);
    this.fx?.dispose();
    this.alive?.dispose();
    this.movers = [];
    this.stage = stage;
    this.post.setStage(stage.id);
    this.applyLight();
    this.camCut = true;
    this.kill = null;
    const root = new TransformNode('stage', this.scene);
    this.stageRoot = root;
    const t = this.stage.theme;
    this.sparkMat.emissiveColor = Color3.FromHexString(t.thinEdge);

    this.buildBackdrop(root);
    const built = buildLayers(this.scene, root, this.stage, this.glow, this.gfx.quality === 'high');
    this.fgMs = 0;
    this.occluders = built.occluders;
    this.live = new StageLive(this.scene, root, this.stage, built.placed, this.glow);
    this.alive = new StageAlive(this.scene, root, this.stage, this.glow, this.gfx.quality, () => this.views.map((v) => v.body), this.camera);
    // Collision-only platforms whose art isn't painted yet still get a block, so the stage is playable.
    const drawn = drawnPlatforms(this.stage);
    this.fx = new StageFx(this.scene, this.stage, {
      sound: (id) => this.onSound?.(id),
      shake: (a) => (this.shake = Math.max(this.shake, a)),
      flash: (color) => {
        this.flashMat.emissiveColor = Color3.FromHexString(color);
        this.flashMat.alpha = 0.75;
        this.flashPlane.setEnabled(true);
      },
    }, this.glow);

    const body = new StandardMaterial('stage-body', this.scene);
    body.diffuseColor = Color3.FromHexString(t.body);
    body.specularColor = new Color3(0.05, 0.04, 0.03);
    const under = new StandardMaterial('stage-under', this.scene);
    under.diffuseColor = Color3.FromHexString(t.under);
    under.specularColor = Color3.Black();
    const edge = this.flatMaterial('edge', t.edge);
    const thinEdge = this.flatMaterial('edge-thin', t.thinEdge);
    for (const m of [body, under, edge, thinEdge]) this.track(root, m);

    for (const [index, p] of this.stage.platforms.entries()) {
      const artDraws = p.hidden && drawn.has(index);
      // Collision-only platforms: the stage art draws them. Moving ones still need a node.
      if (artDraws && !p.motion) continue;
      const width = (p.x2 - p.x1) * W;
      const cx = ((p.x1 + p.x2) / 2) * W;
      const node = new TransformNode('platform', this.scene);
      node.parent = root;
      node.position.set(cx, p.y * W, 0);
      // Blocks that events switch off come and go with them.
      if (p.offDuring || p.onlyDuring) this.live.addToggle(node, index);
      if (artDraws) {
        this.movers.push({ platform: p, node });
      } else if (p.solid) {
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
    // Painted props only when the stage has no art of its own.
    if (!this.stage.layers?.some((l) => l.image && !l.hidden)) paintProps(ctx, t.props, t.glow, t.thinEdge);
    tex.update();
    const mat = new StandardMaterial('sky', this.scene);
    mat.disableLighting = true;
    mat.emissiveTexture = tex;
    this.track(root, mat);
    // Always behind the farthest art layer, scaled so it still fills the view.
    const z = Math.max(18, ...(this.stage.layers ?? []).filter((l) => !l.hidden).map((l) => l.z + 6));
    const k = (16 + z) / (16 + 18);
    const plane = CreatePlane('sky', { width: 64 * k, height: 32 * k }, this.scene);
    plane.material = mat;
    plane.position.set(0, 2 * k, z);
    plane.parent = root;
    this.glow.addExcludedMesh(plane);
  }

  // --------------------------------------------------------------- fighters

  /** Told (sheets ready, sheets total) while a match's clip sheets load; the VS card shows it. */
  onLoadProgress: ((done: number, total: number) => void) | null = null;

  /** Fingerprint of the fighters currently in `views` (char+scale), so Stage Select pre-builds can be reused at VS. */
  private fighterKey = '';
  private looks: number[] = [];
  /** Ghost planes depend on stage occluders: reuse only when that matches too. */
  private fightersHadOccluders = false;
  /** One setFighters at a time (Stage Select prep must not interleave with startMatch). */
  private fightersLock: Promise<void> = Promise.resolve();

  /** Stable id for a match's fighter lineup (meshes only care about character and scale). */
  static fightersKey(state: GameState, looks: number[] = []): string {
    return state.fighters.map((f) => `${f.char}:${f.scale}:${looks[f.id] ?? 0}`).join('|');
  }

  /** What each built fighter wears (playtest): the look index and whether the palette shader is on its material. */
  lookStats(): { slot: number; char: number; look: number; shader: boolean }[] {
    return this.views.map((v, slot) => ({ slot, char: v.charIdx, look: v.lookIdx, shader: v.mat.pluginManager?.getPlugin('DodLook') !== undefined }));
  }

  /** The colour look of each fighter slot for the next setFighters (looks.ts; 0 is the original art). Cosmetic only, never in the sim. */
  setLooks(looks: number[]): void {
    this.looks = looks.slice();
  }

  /**
   * Builds a sprite for each fighter. Still art is cropped to its visible pixels first.
   * `clipWaitMs` caps how long we wait for every clip sheet (VS uses 0 so the card can hand off; the rest finish via warmTick).
   * Same lineup already built (Stage Select pre-build): skip the mesh work and only refresh clip waits.
   */
  async setFighters(state: GameState, keepStage = false, clipWaitMs = 30000): Promise<void> {
    const next = this.fightersLock.then(() => this.setFightersBody(state, keepStage, clipWaitMs));
    this.fightersLock = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Resolves when any in-flight setFighters (Stage Select prep) has finished. */
  whenFightersIdle(): Promise<void> {
    return this.fightersLock;
  }

  private async setFightersBody(state: GameState, keepStage = false, clipWaitMs = 30000): Promise<void> {
    const key = Renderer.fightersKey(state, this.looks);
    // keepStage: devtools shows an unsaved stage that isn't in STAGES.
    if (!keepStage && this.stage !== STAGES[state.stage]) this.setStage(state.stage);
    if (key === this.fighterKey && this.views.length === state.fighters.length && this.fightersHadOccluders === this.occluders) {
      await this.preloadClips(clipWaitMs);
      return;
    }
    for (const v of this.views) {
      // Clip sheets stay cached; only the fighter's own meshes, materials and still go.
      v.mat.diffuseTexture = v.mat.emissiveTexture = null;
      if (v.ghostMat) v.ghostMat.diffuseTexture = null;
      v.root.dispose(false, true);
      v.still.dispose();
    }
    this.views = [];
    this.fighterKey = '';
    // Load every fighter's still + anim set together (was sequential: two fighters nearly doubled VS wait).
    const loaded = await Promise.all(state.fighters.map(async (f) => {
      const ch = CHARACTERS[f.char];
      const [art, anims] = await Promise.all([loadArt(`/characters/large/${ch.id}.webp`), loadAnimSet(ch.id)]);
      return { f, ch, art, anims };
    }));
    for (const { f, ch, art, anims } of loaded) {
      // Yield between fighters so menus / the VS card can paint (software GL otherwise freezes for seconds).
      await breathe();
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
      // A colour look other than Classic recolours the sprite in the shader; Classic keeps the plain material.
      const look = lookOf(f.char, this.looks[f.id] ?? 0);
      if (look.from !== undefined) new LookPlugin(mat, look);
      // The stage's light comes after the look: the palette is recoloured first, then lit.
      const style = ch.style;
      // The art bible: the remap sits between the look and the light (priority 275), the outline after the light (350).
      new RemapPlugin(mat, style?.remap ?? IDENTITY);
      const lightPlugin = new LightPlugin(mat, lightOf(this.stage), this.gfx.quality === 'high');
      // The outline is the fighter's darkened main hue, turned with the colour look so a recoloured fighter keeps a matching line.
      const outlinePlugin = new OutlinePlugin(mat, style ? recolorHex(style.outline, look) : '#1a1a1a');
      outlinePlugin.setQuality(this.gfx.quality === 'high');

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

      // Behind an occluder, a flat silhouette in the player's color shows where they are.
      let ghost: Mesh | null = null;
      let ghostMat: StandardMaterial | null = null;
      if (this.occluders) {
        ghostMat = new StandardMaterial(`ghost-${f.id}`, this.scene);
        ghostMat.disableLighting = true;
        ghostMat.backFaceCulling = false;
        ghostMat.diffuseColor = Color3.Black();
        ghostMat.emissiveColor = Color3.FromHexString(color);
        ghostMat.useAlphaFromDiffuseTexture = true;
        ghostMat.alpha = 0.6;
        ghostMat.depthFunction = Constants.GREATER;
        ghostMat.disableDepthWrite = true;
        ghost = CreatePlane(`ghost-${f.id}`, { size: 1 }, this.scene);
        ghost.material = ghostMat;
        ghost.parent = pose;
        ghost.renderingGroupId = 1;
        ghost.position.z = body.position.z;
        this.glow.addExcludedMesh(ghost);
        root.onDisposeObservable.add(() => ghostMat!.dispose());
      }

      // The rim: the same sprite in the player's colour, a little larger, one step behind the body.
      const rimMat = new StandardMaterial(`rim-${f.id}`, this.scene);
      rimMat.disableLighting = true;
      rimMat.backFaceCulling = false;
      rimMat.diffuseColor = Color3.Black();
      rimMat.emissiveColor = Color3.FromHexString(color);
      rimMat.useAlphaFromDiffuseTexture = true;
      rimMat.alpha = 0.9;
      const rim = CreatePlane(`rim-${f.id}`, { size: 1 }, this.scene);
      rim.material = rimMat;
      rim.parent = pose;
      rim.position.z = body.position.z + 0.012;
      rim.isPickable = false;
      this.glow.addExcludedMesh(rim);
      root.onDisposeObservable.add(() => rimMat.dispose());

      // The contact shadow: a soft ellipse on the platform below, parented to the root so it hides and goes with it.
      const shadowMat = new StandardMaterial(`shadow-${f.id}`, this.scene);
      shadowMat.disableLighting = true;
      shadowMat.backFaceCulling = false;
      shadowMat.diffuseColor = Color3.Black();
      shadowMat.emissiveColor = Color3.Black();
      shadowMat.diffuseTexture = this.shadowTexture();
      shadowMat.useAlphaFromDiffuseTexture = true;
      const shadow = CreatePlane(`shadow-${f.id}`, { size: 1 }, this.scene);
      shadow.material = shadowMat;
      shadow.parent = root;
      shadow.position.z = 0.02;
      shadow.isPickable = false;
      this.glow.addExcludedMesh(shadow);
      root.onDisposeObservable.add(() => shadowMat.dispose());

      // The mirror image for glossy floors: rotated half a turn about x (no negative scale), under the floor line.
      const reflRoot = new TransformNode(`refl-root-${f.id}`, this.scene);
      reflRoot.parent = root;
      reflRoot.rotation.x = Math.PI;
      const reflPose = new TransformNode(`refl-pose-${f.id}`, this.scene);
      reflPose.parent = reflRoot;
      const reflMat = new StandardMaterial(`refl-${f.id}`, this.scene);
      reflMat.disableLighting = true;
      reflMat.backFaceCulling = false;
      reflMat.emissiveColor = Color3.White();
      reflMat.useAlphaFromDiffuseTexture = true;
      reflMat.alpha = REFLECTION_ALPHA;
      const refl = CreatePlane(`refl-${f.id}`, { size: 1 }, this.scene);
      refl.material = reflMat;
      refl.parent = reflPose;
      refl.isPickable = false;
      refl.setEnabled(false);
      this.glow.addExcludedMesh(refl);
      root.onDisposeObservable.add(() => reflMat.dispose());

      this.views.push({
        light: lightPlugin, outline: outlinePlugin, shadow, shadowMat, reflRoot, reflPose, refl, reflMat, lit: { height: -1, scale: 0, alpha: 0, shadow: false, reflection: false },
        root, pose, body, mat, still, stillAspect: art.width / art.height, anims, clipTex: new Map(), ring, shield, flash: 0, ghost, ghostMat, rim, rimMat, charIdx: f.char, lookIdx: this.looks[f.id] ?? 0,
      });
    }
    this.fighterKey = key;
    this.fightersHadOccluders = this.occluders;
    await this.preloadClips(clipWaitMs);
  }

  /**
   * Loads every clip sheet of the fighters in the match before it starts, so
   * no clip waits on the network the first time it plays. Sheets for fighters
   * no longer in the match are freed.
   */
  private async preloadClips(timeoutMs = 30000): Promise<void> {
    const keep = new Set<string>();
    const waits: Promise<void>[] = [];
    let total = 0;
    let loaded = 0;
    const quality = this.gfx.quality;
    this.views.forEach((v, slot) => {
      if (!v.anims) return;
      for (const key of Object.keys(v.anims.clips)) {
        const file = clipSheetFile(v.anims.clips[key], quality);
        const url = `${v.anims.base}${file}?v=${v.anims.version}`;
        const id = `${slot}|${url}`;
        keep.add(id);
        let tex = this.clipCache.get(id);
        if (!tex) {
          // A sheet that fails (404) counts as settled, so it can't hold the match up; the fighter falls back to its still.
          const made: Texture = new Texture(url, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, () => made.onLoadObservable.notifyObservers(made));
          made.hasAlpha = true;
          this.clipCache.set(id, made);
          tex = made;
        }
        v.clipTex.set(key, tex);
        total++;
        if (tex.isReady()) loaded++;
        else waits.push(new Promise((done) => tex!.onLoadObservable.addOnce(() => { loaded++; this.onLoadProgress?.(loaded, total); done(); })));
      }
    });
    for (const [id, tex] of this.clipCache) {
      if (!keep.has(id)) {
        tex.dispose();
        this.clipCache.delete(id);
      }
    }
    this.onLoadProgress?.(loaded, total);
    // Wait for sheets up to timeoutMs; a short VS cap lets the match start while the rest finish in the background (warmTick / first use).
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Resolves once the stage's painted layers are drawn at size (or after timeoutMs), so a match never opens on an empty arena. */
  async stageArtReady(timeoutMs = 2500): Promise<void> {
    if (!this.live) return;
    await Promise.race([this.live.artLoaded(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** True while some stage picture is still loading (the arena would show only the clear colour). */
  stageArtPending(): boolean {
    const l = this.live?.readyLayers();
    return !!l && l.ready < l.total;
  }

  /** Resolves once every texture in the scene (stage art, clips) is loaded, or after a while. */
  async ready(timeoutMs = 15000): Promise<void> {
    await Promise.race([this.scene.whenReadyAsync(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /**
   * Draws a match's first frames behind the menus, so shaders compile and textures reach the GPU
   * while a loading screen is up. Without it the first frame on the match screen can stall for
   * seconds (a frozen, blank wipe on slower machines).
   */
  async warmUp(state: GameState, timeoutMs = 4000): Promise<void> {
    this.engine.resize();
    this.render(state);
    await breathe();
    // Enable every stage layer, hazard, shield, hit-flash overlay, spark burst, KO burst material
    // and KO flash once, so their shaders (and the glow layer's variants) compile now instead of on
    // the first hit, event or KO, and the particle pools are filled.
    this.burst(this.camTarget.x, this.camTarget.y, 64, 0);
    // The burst took the pool's meshes: refill it now, so a match that starts while the warm-up is still
    // running (the VS card hands over early) never finds the pool empty.
    while (this.sparkPool.length < 96) {
      const m = this.makeSpark();
      m.setEnabled(false);
      this.sparkPool.push(m);
    }
    // Every special's flipbook texture is uploaded and shown once, tiny, so the first special never compiles or uploads mid-fight.
    this.flip.prepare();
    for (const k of FLIPBOOK_KINDS) this.flip.play(k, this.camTarget.x, this.camTarget.y, -0.4, 0.01, COUNTER_TINT, { hold: 1 });
    // The launch trail's three looks are shown once with the other spark materials, so the first trail never compiles a shader mid-fight.
    for (const mat of Object.values(this.smokeMats)) {
      const m = this.takeSpark(mat);
      m.position.set(this.camTarget.x, this.camTarget.y, -0.4);
      m.scaling.set(0.2, 0.2, 1);
      this.sparks.push({ mesh: m, vx: 0, vy: 0, life: 2, max: 2, size: 0.2 });
    }
    await breathe();
    // One heavy step per animation frame (each compiles shaders synchronously, seconds on a software renderer),
    // so the match wipe and Ready countdown that run alongside keep painting.
    await breathe();
    this.fx?.warmUp();
    await breathe();
    this.live?.warmUp();
    await breathe();
    // Each projectile and trap look is shown once, so their shaders compile now and not on the first throw
    // (the first drawShots with nothing in play hides them again).
    this.shotMaterials().forEach((mat, i) => {
      const mesh = this.shotMeshes[i] ?? CreatePlane(`shot-${i}`, { width: 1, height: 0.5 }, this.scene);
      mesh.isPickable = false;
      this.glow.addExcludedMesh(mesh);
      mesh.material = mat;
      mesh.position.set(this.camTarget.x, this.camTarget.y, -0.3);
      mesh.setEnabled(true);
      this.shotMeshes[i] = mesh;
    });
    this.alive?.setFighters(this.views.map((v) => v.body));
    for (const v of this.views) {
      v.shield.setEnabled(true);
      if (v.ghost) v.ghost.setEnabled(true);
      v.body.renderOverlay = true;
      v.body.overlayColor = Color3.White();
      v.body.overlayAlpha = 0.01;
    }
    this.flashMat.alpha = 0.5;
    this.flashPlane.setEnabled(true);
    await this.ready(timeoutMs);
    await breathe();
    this.scene.render();
    await breathe();
    // Clip sheets are uploaded a few ms per frame by warmTick (called from the render loop), not here.
    this.queueClipWarm();
    this.fx?.endWarmUp();
    for (const s of this.sparks) {
      s.mesh.setEnabled(false);
      if (this.sparkPool.length < 128) this.sparkPool.push(s.mesh);
      else s.mesh.dispose();
    }
    this.sparks = [];
    this.flip.clear();
    this.flashMat.alpha = 0;
    this.flashPlane.setEnabled(false);
    // Two more presented frames in normal state; the timeout covers a hidden page, where rAF never fires.
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => {
        requestAnimationFrame(r);
        setTimeout(r, 100);
      });
      this.render(state);
    }
  }

  private clipWarm: { slot: number; tex: Texture }[] = [];

  /** Queues every clip sheet of the fighters in lockstep, so the first attack/jump/hurt doesn't upload a sheet mid-fight. */
  queueClipWarm(): void {
    const lists = this.views.map((v) => [...v.clipTex.values()]);
    const max = Math.max(0, ...lists.map((l) => l.length));
    this.clipWarm = [];
    for (let i = 0; i < max; i++) lists.forEach((l, slot) => { if (l[i]) this.clipWarm.push({ slot, tex: l[i] }); });
  }

  /** Whether clip sheets still wait to be uploaded. */
  get warming(): boolean {
    return this.clipWarm.length > 0;
  }

  /** Uploads queued clip sheets within a small time budget; call once per animation frame, before the frame's own render. */
  warmTick(budgetMs = 4): void {
    const end = performance.now() + budgetMs;
    while (this.clipWarm.length && performance.now() < end) {
      const w = this.clipWarm.shift()!;
      const v = this.views[w.slot];
      if (!v || !w.tex.isReady()) continue;
      setTexture(v.mat, w.tex);
      if (v.ghostMat) v.ghostMat.diffuseTexture = w.tex;
      this.scene.render();
    }
  }

  /** Current particle and warm-up diagnostics for playtest verification. */
  fxStats(): { active: number; dustBehind: number; dustInFront: number; maxCap: number; sparkPool: number; readyLayers: number; totalLayers: number; readyClips: number; totalClips: number } {
    const fx = this.fx?.stats() ?? { active: 0, dustBehind: 0, dustInFront: 0, maxCap: 120 };
    const layers = this.live?.readyLayers() ?? { ready: 0, total: 0 };
    let readyClips = 0;
    let totalClips = 0;
    for (const v of this.views) {
      for (const tex of v.clipTex.values()) {
        totalClips++;
        if (tex.isReady()) readyClips++;
      }
    }
    return {
      ...fx,
      sparkPool: this.sparkPool.length,
      readyLayers: layers.ready,
      totalLayers: layers.total,
      readyClips,
      totalClips,
    };
  }

  private clipTexture(v: FighterView, key: string): Texture | null {
    if (!v.anims) return null;
    // Normally preloaded (preloadClips); made here only if a clip appears mid-match.
    let tex = v.clipTex.get(key);
    if (!tex) {
      const file = clipSheetFile(v.anims.clips[key], this.gfx.quality);
      const url = `${v.anims.base}${file}?v=${v.anims.version}`;
      tex = new Texture(url, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.hasAlpha = true;
      v.clipTex.set(key, tex);
    }
    return tex;
  }

  /** Reacts to sim events with sparks and camera shake. */
  onEvents(events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'hit' || e.type === 'hurt') {
        const shield = e.type === 'hit' && e.shield;
        if (shield) {
          this.burst(e.x * S, e.y * S, 6, 0.06);
        } else if (e.type === 'hit') {
          this.lastHits.set(e.victim, { kb: e.kb, tier: hitTier(e.dmg) });
          this.impact(e);
          if (hitTier(e.dmg) === 'heavy') this.post.punch();
        } else {
          this.burst(e.x * S, e.y * S, 8 + Math.min(16, e.kb >> 3), 0.09 + e.kb * 0.0006);
          this.shake = Math.max(this.shake, Math.min(0.5, e.kb * 0.003));
        }
        if (!shield && e.type === 'hit') {
          const r = reactionFor(hitTier(e.dmg), e.kb);
          this.react.set(e.victim, { age: 0, frames: r.frames, squash: r.squash, push: r.push, dir: 0, hop: 0 });
          this.reactStats.squashes++;
          this.reactStats.maxSquash = Math.max(this.reactStats.maxSquash, r.squash);
        }
        if (!shield && this.views[e.victim]) this.views[e.victim].flash = 10;
        if (!shield) {
          this.fx?.trigger('hit', { x: e.x * S, y: e.y * S });
          this.live?.trigger('hit');
        }
      } else if (e.type === 'stage') {
        const id = this.stage.events?.[e.event]?.id;
        if (!id) continue;
        const on = e.phase === 'warn' ? `warn:${id}` : e.phase === 'start' ? `event:${id}` : `eventEnd:${id}`;
        this.fx?.trigger(on);
        this.live?.trigger(on);
      } else if (e.type === 'launch') {
        // The launch that will carry the victim out of the blast zone: the kill cue.
        if (e.ko) this.post.punch();
        if (e.ko && !this.shot) this.killCue(e.x * S, e.y * S + 0.5);
        this.startTrail(e.victim, e.ko);
      } else if (e.type === 'ko') {
        const b = this.stage.blast;
        const x = Math.max(b.left + 40, Math.min(b.right - 40, e.x / FX)) * W;
        const y = Math.max(b.bottom + 40, Math.min(b.top - 40, e.y / FX)) * W;
        this.burst(x, y, 28, 0.25);
        this.shake = 0.9;
        this.fx?.trigger('ko', { x, y });
        this.live?.trigger('ko');
      } else if (e.type === 'shieldbreak') {
        this.burst(e.x * S, e.y * S + 0.6, 16, 0.16);
        this.shake = 0.5;
      } else if (e.type === 'land' || e.type === 'jump') {
        this.burst(e.x * S, e.y * S + 0.02, 3, 0.03);
      } else if (e.type === 'counter') {
        // The counter flash: a bright ring and star where the hit was caught, and the fighter lights up.
        const x = e.x * S;
        const y = e.y * S;
        this.sprite(x, y, 0, 0.5, 18, 6);
        this.sprite(x, y, 0.4, 0.7, 12, 2.4);
        this.burst(x, y, 14, 0.1);
        if (this.views[e.id]) this.views[e.id].flash = 14;
        this.shake = Math.max(this.shake, 0.3);
        // The painted parry: a white-blue flash and ring, with the sim's 6-frame freeze (step.ts COUNTER_FREEZE).
        this.flip.play('counter', x, y, -0.5, 2.1, COUNTER_TINT);
        this.flashMat.emissiveColor = new Color3(0.7, 0.88, 1);
        this.flashMat.alpha = Math.max(this.flashMat.alpha, 0.45);
        this.flashPlane.setEnabled(true);
        this.post.punch();
      } else if (e.type === 'grab') {
        // The grab flash: a bright ring and star where the hands close, and both fighters light up.
        const x = e.x * S;
        const y = e.y * S;
        this.sprite(x, y, 0, 0.45, 14, 5);
        this.sprite(x, y, 0.3, 0.6, 10, 2);
        this.burst(x, y, 10, 0.08);
        if (this.views[e.attacker]) this.views[e.attacker].flash = 6;
        if (this.views[e.victim]) this.views[e.victim].flash = 10;
        this.shake = Math.max(this.shake, e.shield ? 0.22 : 0.12);
      } else if (e.type === 'throw') {
        this.burst(e.x * S, e.y * S, 12, 0.1);
        // The slam: a painted shockwave ring where the victim lands.
        this.flip.play('grab', e.x * S, e.y * S, -0.4, 2.3, this.tintOf(e.attacker));
        this.shake = Math.max(this.shake, 0.25);
      } else if (e.type === 'shot') {
        this.onSynth?.(e.kind === 1 ? 'thud' : 'whoosh');
        this.burst(e.x * S, e.y * S, 4, 0.04);
        // Muzzle flash on a projectile's release, a glyph on a placed trap.
        const dir = this.lastState?.fighters[e.id]?.facing ?? 1;
        if (e.kind === 1) this.flip.play('trap', e.x * S, e.y * S + 0.12, -0.28, 1.9, this.tintOf(e.id));
        else this.flip.play('projectile', e.x * S, e.y * S, -0.4, 1.5, this.tintOf(e.id), { flip: dir });
      }
    }
  }

  private shotMaterials(): StandardMaterial[] {
    if (this.shotMats) return this.shotMats;
    const make = (name: string, draw: (c: CanvasRenderingContext2D) => void): StandardMaterial => {
      const t = new DynamicTexture(`shot-${name}`, { width: 128, height: 64 }, this.scene, true);
      const c = t.getContext() as CanvasRenderingContext2D;
      c.clearRect(0, 0, 128, 64);
      draw(c);
      t.hasAlpha = true;
      t.update();
      const m = new StandardMaterial(`shot-${name}`, this.scene);
      m.disableLighting = true;
      m.emissiveTexture = t;
      m.diffuseTexture = t;
      m.opacityTexture = t;
      m.backFaceCulling = false;
      m.disableDepthWrite = true;
      return m;
    };
    const deck = (c: CanvasRenderingContext2D, y: number) => {
      c.fillStyle = '#1a1a1a';
      c.beginPath();
      c.roundRect(10, y, 108, 14, 7);
      c.fill();
      c.fillStyle = '#ff7a2a';
      c.beginPath();
      c.roundRect(14, y + 2, 100, 8, 4);
      c.fill();
      c.fillStyle = '#ffe3b0';
      c.fillRect(30, y + 4, 68, 2);
      c.fillStyle = '#d8d8d8';
      for (const wx of [30, 98]) {
        c.beginPath();
        c.arc(wx, y + 18, 6, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#1a1a1a';
        c.lineWidth = 2;
        c.stroke();
      }
    };
    this.shotMats = [
      // The thrown board: deck and wheels, spinning as it flies.
      make('board', (c) => deck(c, 22)),
      // The trap: a board lying on the floor inside a warning ring.
      make('trap', (c) => {
        c.strokeStyle = 'rgba(255,209,90,0.95)';
        c.lineWidth = 4;
        c.setLineDash([10, 6]);
        c.beginPath();
        c.ellipse(64, 40, 58, 16, 0, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        c.scale(0.8, 0.8);
        c.translate(16, 14);
        deck(c, 22);
      }),
      make('orb', (c) => {
        const g = c.createRadialGradient(64, 32, 0, 64, 32, 30);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, 'rgba(255,170,60,0.95)');
        g.addColorStop(1, 'rgba(255,90,20,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, 128, 64);
      }),
    ];
    return this.shotMats;
  }

  /** Draws the projectiles and traps in play, and a dash's trail behind a fighter that is driving. */
  private drawShots(state: GameState): void {
    const mats = this.shotMaterials();
    for (let i = 0; i < state.shots.length; i++) {
      const o = state.shots[i];
      let mesh = this.shotMeshes[i];
      if (!mesh) {
        mesh = CreatePlane(`shot-${i}`, { width: 1, height: 0.5 }, this.scene);
        mesh.isPickable = false;
        this.glow.addExcludedMesh(mesh);
        this.shotMeshes[i] = mesh;
      }
      const look = SHOT_LOOKS[o.style] ?? 'board';
      mesh.material = mats[o.style] ?? mats[0];
      mesh.setEnabled(true);
      const size = Math.max(0.5, o.r * S * 2.6);
      if (look === 'trap') {
        // Lies on the floor; dim while it arms, then pulses.
        const pulse = o.arm > 0 ? 0.6 : 1 + Math.sin(o.age * 0.3) * 0.08;
        mesh.position.set(o.x * S, o.y * S + size * 0.22, -0.25);
        mesh.scaling.set(size * pulse, size * pulse, 1);
        mesh.rotation.z = 0;
        mesh.visibility = o.arm > 0 ? 0.55 : 1;
      } else {
        mesh.position.set(o.x * S, o.y * S, -0.3);
        mesh.scaling.set(o.facing * size, size, 1);
        mesh.rotation.z = look === 'board' ? -o.facing * o.age * 0.55 : 0;
        mesh.visibility = 1;
      }
    }
    for (let i = state.shots.length; i < this.shotMeshes.length; i++) this.shotMeshes[i].setEnabled(false);

    // A dash leaves a streak behind each frame it drives (once per sim frame, so a pause leaves none).
    if (state.frame === this.lastTrail) return;
    this.lastTrail = state.frame;
    this.specialFx(state);
    for (const f of state.fighters) {
      if (f.action !== ACT.ATTACK) continue;
      const m = CHARACTERS[f.char].moves[f.move];
      if (m.kind !== 'dash' && !(m.kind === 'recovery' && m.drive?.some((d) => f.frame >= d.from && f.frame <= d.to))) continue;
      if (m.kind === 'dash' && !m.drive?.some((d) => f.frame >= d.from && f.frame <= d.to)) continue;
      const mesh = this.takeSpark();
      mesh.position.set((f.x - f.facing * 24 * FX * (f.scale / 100)) * S, (f.y + 40 * FX) * S, FX_Z);
      mesh.rotation.z = m.kind === 'dash' ? 0 : Math.atan2(f.vy, f.vx * f.facing) * f.facing;
      this.sparks.push({ mesh, vx: 0, vy: 0, life: 6, max: 6, size: 0.26, stretch: m.kind === 'dash' ? 3.2 : 2, grow: 0 });
    }
  }

  /** A fighter's own colour for its special effects (content/fighters.json: the hue of its main outfit colour). */
  private tintOf(id: number): Color3 {
    const f = this.lastState?.fighters[id];
    const char = f ? f.char : id;
    let t = this.flipTints.get(char);
    if (!t) {
      const c = CHARACTERS[char];
      t = fighterTint(c?.looks, c?.id ?? String(char));
      this.flipTints.set(char, t);
    }
    return t;
  }

  /**
   * The painted flipbooks that follow the state (the events do the rest: muzzle flash and trap glyph on 'shot', slam on
   * 'throw', the parry flash on 'counter'): a dash lunges, a recovery climbs, each flurry hit slashes, and a shot
   * leaves a trail. Runs once per sim frame; each effect is keyed to the frame it starts on.
   */
  private specialFx(state: GameState): void {
    for (const f of state.fighters) {
      const prev = this.flipLast.get(f.id);
      this.flipLast.set(f.id, { move: f.move, frame: f.action === ACT.ATTACK ? f.frame : -1 });
      if (f.action !== ACT.ATTACK || f.hitlag > 0) continue;
      const fresh = !prev || prev.move !== f.move || prev.frame !== f.frame;
      if (!fresh) continue;
      const ch = CHARACTERS[f.char];
      const m = ch.moves[f.move];
      if (!m.kind) continue;
      const k = f.scale / 100;
      const cy = ch.height * W * k * 0.5;
      const x = f.x * S;
      const y = f.y * S;
      const tint = this.tintOf(f.id);
      const from = m.drive?.[0]?.from ?? m.hits[0]?.start ?? 1;
      if (m.kind === 'dash' && f.frame === from) {
        this.flip.play('dash', x + f.facing * 0.25, y + cy, -0.36, 2.2 * k, tint, { flip: f.facing });
      } else if (m.kind === 'recovery' && f.frame === from) {
        this.flip.play('recovery', x, y + cy * 0.9, -0.36, 2.4 * k, tint);
      } else if (m.kind === 'flurry') {
        const i = m.hits.findIndex((h) => h.start === f.frame || (h.rehit !== undefined && h.rehit > 0 && f.frame === h.start));
        if (i >= 0) this.flip.play('flurry', x + f.facing * 0.45 * k, y + cy, -0.38, 1.5 * k, tint, { flip: f.facing, rot: ((i % 3) - 1) * 0.4 });
      }
    }
    // A shot in flight leaves a short trail behind it every few frames.
    for (const o of state.shots) {
      if (o.style === 1 || o.age % 4 !== 2) continue;
      const dir = o.vx >= 0 ? 1 : -1;
      this.flip.play('dash', o.x * S - dir * 0.2, o.y * S, -0.34, 0.95, this.tintOf(o.owner), { flip: dir, hold: 1 });
    }
  }

  /** A launch begins: if the hit was medium or heavy (or will KO) the victim throws a smoke trail for the length of its hit-stun. */
  private startTrail(victim: number, ko: boolean): void {
    const hit = this.lastHits.get(victim);
    if (!hit) return;
    const look = trailFor(hit.tier, hit.kb, ko);
    const rec: TrailRecord = { seq: ++this.trailSeq, victim, tier: hit.tier, kb: hit.kb, kind: look.kind, ko, puffs: 0 };
    this.trailLog.push(rec);
    if (this.trailLog.length > 60) this.trailLog.shift();
    if (look.kind === 'none') this.trails.delete(victim);
    else this.trails.set(victim, rec);
  }

  /** Every frame: a fighter still in hit-stop-free hit-stun from a launch leaves puffs behind it (more and bigger with knockback). */
  private emitTrails(state: GameState): void {
    for (const [id, rec] of this.trails) {
      const f = state.fighters[id];
      if (!f || f.action !== ACT.HITSTUN) {
        if (!f || f.hitlag <= 0) this.trails.delete(id);
        continue;
      }
      if (f.hitlag > 0) continue;
      const look = trailFor(rec.tier, rec.kb, rec.ko);
      if (look.every === 0 || f.frame % look.every !== 0) continue;
      const n = Math.max(1, Math.ceil(look.puffs * particleShare(this.gfx.quality)));
      const ang = Math.atan2(f.kby, f.kbx);
      const h = CHARACTERS[f.char].height * W * (f.scale / 100) * 0.5;
      const cx = f.x * S;
      const cy = f.y * S + h;
      for (let i = 0; i < n; i++) {
        const j = (Math.random() - 0.5) * h * 0.5;
        if (look.kind === 'streak') {
          const mesh = this.takeSpark(this.smokeMats.streak);
          mesh.position.set(cx, cy + j * 0.4, FX_Z);
          mesh.rotation.z = ang;
          this.sparks.push({ mesh, vx: 0, vy: 0, life: 10, max: 10, size: look.size * 1.1, stretch: 3.4, grow: 0 });
        } else {
          const mesh = this.takeSpark(look.kind === 'white' ? this.smokeMats.white : this.smokeMats.grey);
          // Behind the fighters (they sit at z 0 to -0.05), so smoke never covers a body or its outline.
          mesh.position.set(cx + j * Math.cos(ang + 1.57), cy + j * Math.sin(ang + 1.57), 0.08);
          mesh.rotation.z = Math.random() * 6.28;
          const life = 10 + Math.floor(Math.random() * 6);
          // The puff stays where it was dropped (the fighter moves on, so it lines up behind it) and billows as it thins.
          this.sparks.push({ mesh, vx: 0, vy: 0.003, life, max: life, size: look.size * (0.8 + Math.random() * 0.4), grow: 0.8 });
        }
        rec.puffs++;
      }
    }
  }

  /** The launch trails so far (and which are still burning), for the playtest. */
  trailStats(reset = false) {
    const out = { log: this.trailLog.map((r) => ({ ...r })), active: this.trails.size, puffs: this.trailLog.reduce((n, r) => n + r.puffs, 0) };
    if (reset) this.trailLog = [];
    return out;
  }

  /** A landed hit: sparks, impact sprites and shake that grow with the damage (hitFeel.ts). Heavy hits add a ring and a flash. */
  private impact(e: Extract<SimEvent, { type: 'hit' }>): void {
    const tier = hitTier(e.dmg);
    const fx = impactFor(tier, e.kb);
    const x = e.x * S;
    const y = e.y * S;
    this.burst(x, y, fx.sparks, (tier === 'light' ? 0.06 : 0.09) + e.kb * 0.0006);
    for (let i = 0; i < fx.stars; i++) this.sprite(x, y, i * (Math.PI / 4) + Math.random(), tier === 'heavy' ? 0.4 : 0.26, 8 + i * 2, 1);
    if (fx.ring) this.sprite(x, y, 0, 0.3, 12, 3.2);
    this.shake = Math.max(this.shake, fx.shake);
    if (fx.flash > 0 && this.flashMat.alpha < fx.flash) {
      this.flashMat.emissiveColor = Color3.White();
      this.flashMat.alpha = fx.flash;
      this.flashPlane.setEnabled(true);
    }
    const st = this.hitStats;
    st.hits++;
    st.tiers[tier]++;
    st.last = { tier, lag: e.lag, sparks: fx.sparks, stars: fx.stars, ring: fx.ring, shake: fx.shake, flash: fx.flash };
  }

  /**
   * The hit that ends a stock announces itself (hitFeel.ts predicts it as the hit-stop ends and the launch begins): a red-tinted
   * flash, a sharper impact ring, a punch-in on the impact, a beat of slow motion (`timeScale`) and a rising whistle.
   * Screen shake off still removes the shake; the zoom stays.
   */
  private killCue(x: number, y: number): void {
    this.kill = { at: performance.now(), x, y };
    this.flashMat.emissiveColor = new Color3(1, 0.12, 0.08);
    this.flashMat.alpha = KILL_CUE.redFlash;
    this.flashPlane.setEnabled(true);
    this.sprite(x, y, 0, 0.45, 12, 6);
    this.sprite(x, y, 0.5, 0.7, 16, 4);
    this.shake = Math.max(this.shake, 0.8);
    this.onSynth?.('whistle');
    const c = this.camStats;
    c.killCues++;
    c.lastCue = { zoom: true, slow: true, whistle: !!this.onSynth, shake: screenShake() ? this.shake : 0, punch: 0 };
  }

  /** How fast the match clock should run right now: slow motion for the kill cue's beat, else 1. */
  timeScale(): number {
    if (!this.kill) return 1;
    const t = (performance.now() - this.kill.at) / 1000;
    if (t > KILL_CUE.slowSeconds + KILL_CUE.easeBack + 0.1) this.kill = null;
    return killTimeScale(t);
  }

  /** Camera and kill-cue counters for the playtest. */
  camFxStats(reset = false) {
    const out = { ...this.camStats, killActive: !!this.kill };
    if (reset) {
      this.camStats.cameraJumps = 0;
      this.camStats.framingMisses = 0;
    }
    return out;
  }

  /** One impact flash: a soft disc that blows up as it fades (two make a heavy burst, a big fast one reads as a shockwave). */
  private sprite(x: number, y: number, rot: number, size: number, life: number, grow: number): void {
    const mesh = this.takeSpark();
    mesh.position.set(x, y, FX_Z);
    mesh.rotation.z = rot;
    this.sparks.push({ mesh, vx: 0, vy: 0, life, max: life, size, grow });
  }

  /** The special-effect flipbooks' counters, for the playtest. */
  flipStats(reset = false): FlipStats {
    return this.flip.stats(reset);
  }

  /** What the last hits did, for the playtest. */
  hitFxStats(reset = false) {
    const out = { ...this.hitStats, tiers: { ...this.hitStats.tiers }, shakeOn: screenShake() };
    if (reset) {
      this.hitStats.hits = 0;
      this.hitStats.shakeMax = 0;
    }
    return out;
  }

  private burst(x: number, y: number, count: number, speed: number, mat?: StandardMaterial): void {
    const n = Math.ceil(count * particleShare(this.gfx.quality));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const mesh = this.takeSpark(mat);
      mesh.position.set(x, y, FX_Z);
      mesh.rotation.z = a;
      const life = 10 + Math.floor(Math.random() * 10);
      this.sparks.push({ mesh, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, size: 0.06 + Math.random() * 0.08 });
    }
  }

  /** Draws one frame. */
  render(state: GameState): void {
    this.lastState = state;
    for (const m of this.movers) {
      const p = platformAt(m.platform, state.frame);
      m.node.position.set(((p.x1 + p.x2) / 2) * S, p.y * S, 0);
    }
    this.live?.update(state);
    this.alive?.update(performance.now() / 1000);
    if (this.intro) this.introTick(state);
    // Broadcast events: the studio lights flicker, the rig light hangs and falls.
    this.sky.intensity = state.flicker > 0 ? (state.frame % 8 < 3 ? 0.15 : 1) : 1;
    if (state.rigFrame >= 0) {
      if (!this.rig) {
        this.rig = CreateBox('rig', { width: 0.9, height: 0.5, depth: 0.9 }, this.scene);
        const m = new StandardMaterial('rigm', this.scene);
        m.emissiveColor = new Color3(1, 0.9, 0.5);
        this.rig.material = m;
      }
      const p = rigPos(state);
      this.rig.setEnabled(true);
      this.rig.position.set(p.x * S, p.y * S, 0);
    } else this.rig?.setEnabled(false);
    for (const f of state.fighters) this.drawFighter(f, this.views[f.id], state);
    this.drawShots(state);
    this.emitTrails(state);
    this.updateSparks();
    this.fx?.setClock(state);
    this.fx?.update();
    if (this.flashMat.alpha > 0) {
      this.flashMat.alpha = Math.max(0, this.flashMat.alpha - 0.04);
      if (this.flashMat.alpha === 0) this.flashPlane.setEnabled(false);
    }
    this.drawDebug(state);
    this.updateCamera(state);
    this.updateForeground(state);
    this.scene.render();
    this.post.endFrame();
    this.checkFraming(state);
    if (this.kill && (performance.now() - this.kill.at) / 1000 > 0.15 && (performance.now() - this.kill.at) / 1000 < KILL_CUE.slowSeconds) {
      const fps = this.engine.getFps();
      this.camStats.slowFpsMin = this.camStats.slowFpsMin === 0 ? fps : Math.min(this.camStats.slowFpsMin, fps);
    }
  }

  private fgMs = 0;

  /**
   * Foreground elements at the play area's edge fade to 30% while a fighter is behind one of their solid pixels (seen from
   * the camera, so the parallax counts) and come back when they walk out. Runs after the camera has moved.
   */
  private updateForeground(state: GameState): void {
    const fgs = this.live?.foregrounds();
    if (!fgs?.length) return;
    const now = performance.now();
    const dt = this.fgMs ? Math.min(0.1, (now - this.fgMs) / 1000) : 0.1;
    this.fgMs = now;
    const cam = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
    const bodies = [];
    for (const f of state.fighters) {
      const v = this.views[f.id];
      if (!v || f.action === ACT.DEAD || this.offstage.has(f.id)) continue;
      const ch = CHARACTERS[f.char];
      const k = f.scale / 100;
      bodies.push(bodyPoints(v.root.position.x, v.root.position.y, ch.height * W * ART_SCALE * k, ch.width * W * ART_SCALE * k * 0.35, v.body.position.z));
    }
    for (const pl of fgs) {
      let behind = false;
      if (pl.mask && pl.size.w && pl.mesh.isEnabled()) {
        const plane = { x: pl.mesh.position.x, y: pl.mesh.position.y, z: pl.mesh.position.z, w: pl.size.w, h: pl.size.h };
        behind = bodies.some((pts) => behindForeground(pl.mask!, plane, cam, pts));
      }
      pl.fade = fadeToward(pl.fade ?? 1, behind, dt);
      pl.mat.alpha = (pl.layer.opacity ?? 1) * pl.fade;
    }
  }

  /** Every layer's depth and where its picture sits on the page (CSS px, from the last render), for the playtest's parallax check. */
  depthStats(): { quality: string; camX: number; camDist: number; layers: { id: string; z: number; kind: 'far' | 'foreground' | 'haze' | 'stage'; screenX: number; alpha: number; fade: number | null; behind: boolean }[] } {
    const canvas = this.engine.getRenderingCanvas();
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const m = this.scene.getTransformMatrix();
    const k = canvas ? canvas.clientWidth / w : 1;
    const layers = (this.live?.allPlaced() ?? []).map((pl) => {
      const p = Vector3.Project(new Vector3(pl.mesh.position.x, pl.mesh.position.y, pl.mesh.position.z), Matrix.IdentityReadOnly, m, vp);
      const kind: 'far' | 'foreground' | 'haze' | 'stage' = pl.haze ? 'haze' : pl.layer.foreground ? 'foreground' : pl.layer.z > 0.5 ? 'far' : 'stage';
      return { id: pl.layer.id, z: pl.layer.z, kind, screenX: p.x * k, alpha: pl.mat.alpha, fade: pl.fade ?? null, behind: pl.fade !== undefined && pl.fade < 0.99 };
    });
    return { quality: this.gfx.quality, camX: this.camera.position.x, camDist: this.camDist, layers };
  }

  private shadowTex: DynamicTexture | null = null;

  /** One soft radial blob shared by every contact shadow (black, opaque in the middle, clear at the rim). */
  private shadowTexture(): DynamicTexture {
    if (this.shadowTex) return this.shadowTex;
    const tex = new DynamicTexture('shadow-blob', { width: 128, height: 128 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.7)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    tex.hasAlpha = true;
    tex.update();
    this.shadowTex = tex;
    return tex;
  }

  /** Every fighter's light and shadow as last drawn, for the playtest. */
  lightStats() {
    const st = this.stage;
    return {
      stage: st.id,
      quality: this.gfx.quality,
      glossy: !!st.light?.glossy,
      fighters: this.views.map((v, slot) => ({ slot, plugin: v.light.state(), ...v.lit })),
    };
  }

  /** The stage's light goes onto every fighter's material (a new stage, or a quality change). */
  private applyLight(): void {
    const light = lightOf(this.stage);
    for (const v of this.views) {
      v.light.set(light, this.gfx.quality === 'high');
      v.outline.setQuality(this.gfx.quality === 'high');
    }
  }

  /** The outline's width in the sprite's own units: 2 px at 1080p, never under 1 px, from how big the fighter is on screen. */
  private sizeOutline(v: FighterView): void {
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const m = this.scene.getTransformMatrix();
    const p = v.root.getAbsolutePosition();
    const a = Vector3.Project(p, Matrix.IdentityReadOnly, m, vp);
    const b = Vector3.Project(new Vector3(p.x + 1, p.y, p.z), Matrix.IdentityReadOnly, m, vp);
    const pxPerWorld = Math.max(1, Math.abs(b.x - a.x));
    v.outline.setWidth(outlineWidthPx(h), 1 / (Math.max(0.01, v.body.scaling.x) * pxPerWorld), 1 / (Math.max(0.01, v.body.scaling.y) * pxPerWorld));
  }

  /** Every fighter's outline as drawn (playtest): colour, width in device px, and the render height it was sized for. */
  styleStats() {
    return {
      quality: this.gfx.quality,
      renderHeight: this.engine.getRenderHeight(),
      fighters: this.views.map((v, slot) => ({ slot, char: v.charIdx, look: v.lookIdx, outline: v.outline.state(), remap: v.mat.pluginManager?.getPlugin('DodRemap') !== undefined, outlinePass: v.mat.pluginManager?.getPlugin('DodOutline') !== undefined })),
    };
  }

  private drawFighter(f: Fighter, v: FighterView | undefined, state: GameState): void {
    if (!v) return;
    const ch = CHARACTERS[f.char];
    const dead = f.action === ACT.DEAD;
    const ip = this.intro?.poses.get(f.id);
    const away = this.offstage.has(f.id) || !!ip?.hidden;
    v.root.setEnabled(!dead && !away);
    if (dead || away) return;

    const k = f.scale / 100;
    const height = ch.height * W * ART_SCALE * k;
    let x = f.x * S;
    if (f.hitlag > 0 && f.action === ACT.HITSTUN) x += (f.hitlag & 1 ? 1 : -1) * 0.04;
    let drop = 0;
    const came = this.arriving.get(f.id);
    if (came !== undefined) {
      // Falls in over ARRIVE_MS (eased like gravity), then lands with dust, a thud and a little shake.
      const k = Math.min(1, (performance.now() - came) / ARRIVE_MS);
      drop = (1 - k * k) * 7;
      if (k >= 1) {
        this.arriving.delete(f.id);
        this.burst(x, f.y * S + 0.02, 10, 0.07);
        this.shake = Math.max(this.shake, 0.35);
        this.onSound?.('land');
        this.onSynth?.('thud');
      }
    }
    if (ip) {
      // An entrance (match intro): its offset in fighter heights, on top of where the sim stands them.
      x += ip.dx * height;
      drop += ip.dy * height;
    }
    v.root.position.set(x, f.y * S + drop, 0);

    // A clip if there is one, else the still with procedural motion. An entrance borrows the walk, jump, fall or land clip.
    const fa = ip && ip.anim !== 'idle' ? { ...f, x: x / S, action: ip.anim === 'walk' ? ACT.WALK : ip.anim === 'land' ? ACT.LAND : ACT.AIR, vy: ip.anim === 'jump' ? 1 : -1, frame: Math.floor(((performance.now() - this.intro!.t0) / 1000) * 60) } : f;
    const pick = pickClip(fa, v.anims);
    const tex = pick ? this.clipTexture(v, pick.key) : null;
    if (pick && tex && v.anims) {
      const c = pick.clip;
      const i = clipFrame(fa, pick);
      tex.uScale = 1 / c.cols;
      tex.vScale = 1 / c.rows;
      tex.uOffset = (i % c.cols) / c.cols;
      tex.vOffset = 1 - (Math.floor(i / c.cols) + 1) / c.rows;
      setTexture(v.mat, tex);
      const px = height / v.anims.refHeight;
      v.body.scaling.set(c.fw * px, c.fh * px, 1);
      v.body.position.x = (c.fw / 2 - c.ax) * px;
      v.body.position.y = (c.ay - c.fh / 2 + feetLift(fa, pick, i)) * px;
      // Clips line up on the feet, but a hang is about the hands: put the top of the
      // sprite (the gripping hands) on the ledge's top edge instead.
      if (pick.key === 'ledge' && pick.exact && f.ledge > 0) {
        const l = ledges(this.stage)[f.ledge - 1];
        if (l) v.body.position.y += l.y * W + GRIP - f.y * S - c.ay * px;
      }
    } else {
      setTexture(v.mat, v.still);
      v.body.scaling.set(height * v.stillAspect, height, 1);
      v.body.position.x = 0;
      v.body.position.y = height / 2;
    }

    let [sx, sy, rot, lift] = pick?.exact ? [1, 1, 0, 0] : proceduralPose(f, this.stage);
    const spoke = this.talking.get(f.id);
    if (spoke !== undefined) {
      const k = (performance.now() - spoke) / 420;
      if (k >= 1) this.talking.delete(f.id);
      else {
        const b = Math.sin(k * Math.PI) * 0.07;
        sx *= 1 - b * 0.5;
        sy *= 1 + b;
      }
    }
    const rx = this.reaction(f, v, state);
    sx *= rx.sx;
    sy *= rx.sy;
    if (rx.rot !== null) rot = rx.rot;
    if (ip) {
      sx *= ip.sx;
      sy *= ip.sy;
      rot += ip.rot;
    }
    x += rx.dx;
    v.root.position.x = x;
    v.pose.scaling.set(f.facing * sx, sy, 1);
    v.pose.rotation.z = rot;
    v.pose.position.y = lift + rx.lift;

    if (v.ghost && v.ghostMat) {
      v.ghost.position.x = v.body.position.x;
      v.ghost.position.y = v.body.position.y;
      v.ghost.scaling.copyFrom(v.body.scaling);
      if (v.ghostMat.diffuseTexture !== v.mat.diffuseTexture) v.ghostMat.diffuseTexture = v.mat.diffuseTexture;
    }

    // The rim follows the body, a touch larger. On Low it is thinner and only drawn in one-on-ones (two fighters), which is cheaper.
    const rimOn = this.gfx.quality === 'high' || state.fighters.length <= 2;
    v.rim.setEnabled(rimOn);
    if (rimOn) {
      const grow = this.gfx.quality === 'high' ? 1.07 : 1.045;
      v.rim.position.x = v.body.position.x;
      v.rim.position.y = v.body.position.y;
      v.rim.scaling.set(v.body.scaling.x * grow, v.body.scaling.y * grow, 1);
      if (v.rimMat.diffuseTexture !== v.mat.diffuseTexture) v.rimMat.diffuseTexture = v.mat.diffuseTexture;
    }

    this.sizeOutline(v);

    const flicker = f.intangible > 0 && f.action !== ACT.LEDGE ? (f.frame & 4 ? 0.45 : 0.8) : 1;
    v.mat.alpha = flicker * (ip ? ip.alpha : 1);
    if (v.flash > 0) {
      v.flash--;
      v.mat.emissiveColor.set(1, 0.55 + (10 - v.flash) * 0.045, 0.45 + (10 - v.flash) * 0.055);
    } else if (f.action === ACT.ATTACK && CHARACTERS[f.char].moves[f.move].counter && f.frame >= CHARACTERS[f.char].moves[f.move].counter!.from && f.frame <= CHARACTERS[f.char].moves[f.move].counter!.to) {
      // Counter stance: a cold pulse on the fighter while the window is open.
      const pulse = f.frame & 4 ? 0.55 : 0.8;
      v.mat.emissiveColor.set(pulse, 0.95, 1);
    } else {
      v.mat.emissiveColor.set(1, 1, 1);
    }

    // The contact shadow on the platform below: smaller and fainter with height, gone above 300 units.
    const floor = floorBelow(this.stage, state.frame, f.x, f.y);
    const sh = shadowAt(floor === null ? null : f.y / FX - floor);
    const floorLocal = floor === null ? 0 : floor / 100 - v.root.position.y;
    const wide = ch.width * W * k * 1.7 * sh.scale;
    v.shadow.setEnabled(sh.on);
    if (sh.on) {
      v.shadow.scaling.set(wide, wide * 0.24, 1);
      v.shadow.position.y = floorLocal - 0.005;
      v.shadowMat.alpha = sh.alpha;
    }
    // On a glossy floor (High only) a faint mirror of the fighter shows under the platform, fading with the same height.
    const mirror = sh.on && this.gfx.quality === 'high' && !!this.stage.light?.glossy;
    v.refl.setEnabled(mirror);
    if (mirror) {
      v.reflRoot.position.y = 2 * floorLocal;
      v.reflPose.position.y = v.pose.position.y;
      v.reflPose.scaling.copyFrom(v.pose.scaling);
      v.reflPose.rotation.z = v.pose.rotation.z;
      v.refl.position.copyFrom(v.body.position);
      v.refl.scaling.copyFrom(v.body.scaling);
      v.reflMat.alpha = REFLECTION_ALPHA * (1 - Math.max(0, sh.height) / 300);
      if (v.reflMat.diffuseTexture !== v.mat.diffuseTexture) {
        v.reflMat.diffuseTexture = v.mat.diffuseTexture;
        v.reflMat.emissiveTexture = v.mat.diffuseTexture;
      }
    }
    v.lit = { height: Number(sh.height.toFixed(1)), scale: Number(sh.scale.toFixed(3)), alpha: Number(sh.alpha.toFixed(3)), shadow: sh.on, reflection: mirror };

    v.ring.setEnabled((f.grounded === 1 || f.action === ACT.RESPAWN) && !(ip && ip.dy > 0.05));
    const shielding = f.action === ACT.SHIELD || f.action === ACT.SHIELD_STUN;
    v.shield.setEnabled(shielding);
    if (shielding) {
      const s = 0.45 + 0.55 * (f.shield / SHIELD_MAX);
      v.shield.scaling.set(s, s, 1);
    }
  }

  /** Procedural reaction on top of the clips: hit squash and push, tumble in hit-stun, ground bounce with dust, smash charge glow, smears. */
  private reaction(f: Fighter, v: FighterView, state: GameState): { sx: number; sy: number; rot: number | null; dx: number; lift: number } {
    const out = { sx: 1, sy: 1, rot: null as number | null, dx: 0, lift: 0 };
    const st = this.reactStats;
    const r = this.react.get(f.id);
    const hurt = f.action === ACT.HITSTUN;
    if (r) {
      if (f.hitlag <= 0 || r.age > 0) r.age++;
      const k = r.age <= r.frames ? 1 : 0;
      if (k) {
        out.sx = 1 + r.squash;
        out.sy = 1 - r.squash;
        st.squashFrames++;
      }
      if (r.push > 0 && r.age < 8) out.dx = -f.facing * r.push * (1 - r.age / 8);
      if (r.hop > 0) {
        r.hop--;
        out.lift = Math.sin((r.hop / 14) * Math.PI) * 0.18;
      }
      if (r.age > 40 && r.hop <= 0 && !hurt) this.react.delete(f.id);
    }
    const speed = Math.hypot(f.kbx, f.kby) / FX;
    if (hurt && speed > TUMBLE_SPEED) {
      v.tumble = (v.tumble ?? 0) + 1;
      out.rot = f.facing * v.tumble * 0.35;
      st.tumbleFrames++;
    } else v.tumble = 0;
    const was = this.prevGround.get(f.id) ?? 1;
    this.prevGround.set(f.id, f.grounded);
    if (hurt && !was && f.grounded && f.kby <= 0 && r) {
      r.hop = 14;
      st.bounces++;
      st.dustBursts++;
      this.burst(f.x * S, f.y * S + 0.02, 7, 0.07);
      this.onSynth?.('thud');
    }
    if (f.action === ACT.ATTACK) {
      const ch = CHARACTERS[f.char];
      const m = ch.moves[f.move];
      const w = m.hits[0];
      const big = f.move === MOVE.FSMASH || f.move === MOVE.USMASH || f.move === MOVE.DSMASH;
      if (w && (big || f.move >= MOVE.UPB)) {
        if (big && f.frame < w.start) {
          const g = f.frame / w.start;
          const e = 1 + g * 0.5;
          v.mat.emissiveColor.set(e, e, 1 + g);
          out.dx += (f.frame & 1 ? 1 : -1) * 0.012 * g;
          if (f.frame === 1) st.charges++;
        }
        if (this.gfx.quality === 'high' && f.frame >= w.start && f.frame < w.start + 3) {
          this.smear(f, w.boxes[0], f.frame - w.start, big);
          if (f.frame === w.start) st.smears++;
          st.smearFrames++;
          if (big) st.smashSmears++;
        }
      }
    }
    return out;
  }

  /** One of three streak frames along the swing, from the body to the active hitbox. */
  private smear(f: Fighter, b: { x: number; y: number }, i: number, big: boolean): void {
    const ch = CHARACTERS[f.char];
    const k = f.scale / 100;
    const hw = ch.height * W * k;
    const bx = f.facing * b.x * W * k;
    const by = b.y * W * k;
    const cy = hw * 0.5;
    const t = (i + 1) / 3;
    const mesh = this.takeSpark(this.smokeMats.streak);
    mesh.position.set(f.x * S + bx * t * 0.9, f.y * S + cy + (by - cy) * t, FX_Z);
    mesh.rotation.z = Math.atan2(by - cy, bx || f.facing);
    this.sparks.push({ mesh, vx: 0, vy: 0, life: 3, max: 3, size: (big ? 0.55 : 0.4) * (0.6 + t * 0.6), stretch: 3, grow: 0 });
  }

  /** What the reaction layer has done, for the playtest. */
  reactFxStats(reset = false) {
    const out = { ...this.reactStats, quality: this.gfx.quality };
    if (reset) for (const k of Object.keys(this.reactStats) as (keyof typeof this.reactStats)[]) this.reactStats[k] = 0;
    return out;
  }

  private updateSparks(): void {
    this.flip.update();
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.mesh.position.x += s.vx;
      s.mesh.position.y += s.vy;
      s.vx *= 0.9;
      s.vy *= 0.9;
      s.vy -= 0.002;
      const k = --s.life / s.max;
      const sz = s.grow ? s.size * (1 + (1 - k) * s.grow) * Math.min(1, k * 2) : k * s.size;
      s.mesh.scaling.set(sz * (s.stretch ?? 1), sz, 1);
      if (s.life <= 0) {
        s.mesh.setEnabled(false);
        this.sparkPool.push(s.mesh);
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

  /**
   * The match camera: frames the box around every living fighter (plus padding and a little of the stage), with
   * critically damped pan and zoom (smoothDamp: it never snaps, whatever a KO or a respawn does to the box), clamped
   * to the stage's blast zone and to zoom limits that keep fighters readable. A kill cue punches in on the impact and
   * eases back out. An intended cut (new stage, rematch) sets it outright and is not counted as a jump.
   */
  private updateCamera(state: GameState): void {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - (this.camMs || now - 16.7)) / 1000));
    this.camMs = now;
    const b = this.stage.blast;
    const { live, soon } = cameraFighters(state, this.stage.respawn);
    const aspect = this.engine.getAspectRatio(this.camera);
    const tan = Math.tan(this.camera.fov / 2);
    const world: CamBounds = { left: b.left * W, right: b.right * W, bottom: b.bottom * W, top: b.top * W };
    let { x: cx, y: cy, d: cd } = frameGoal([...live, ...soon], world, aspect, tan);

    let smooth = 0.18;
    let smoothZoom = 0.25;
    if (this.shot) {
      // Story scene: ease slower, like a camera operator, onto the speaker or out to the whole stage.
      smooth = 0.6;
      smoothZoom = 0.8;
      const secs = (now - this.shot.since) / 1000;
      const f = this.shot.focus === null ? undefined : state.fighters[this.shot.focus];
      if (f && f.action !== ACT.DEAD && !this.offstage.has(f.id)) {
        const h = CHARACTERS[f.char].height * W * (f.scale / 100);
        cx = f.x * S + f.facing * h * 0.35;
        cy = f.y * S + h * 0.62;
        cd = Math.max(4.5, h * 3.1) - Math.min(0.8, secs * 0.12);
      } else {
        cx = 0;
        cy = 1.5;
        cd = Math.max(12, Math.min(30, ((b.right - b.left) * W) / (2 * tan * aspect) * 0.62)) - Math.min(2.5, secs * 0.35);
      }
    } else if (this.kill) {
      // The kill cue's punch-in: toward the impact, closer, quickly; then back out as the punch fades.
      const t = (now - this.kill.at) / 1000;
      const p = killPunch(t);
      ({ x: cx, y: cy, d: cd } = punchGoal({ x: cx, y: cy, d: cd }, this.kill, p, KILL_CUE.punchIn));
      smooth = 0.12 + 0.16 * (1 - p);
      smoothZoom = 0.1 + 0.3 * (1 - p);
      if (this.camStats.lastCue && t < 0.3) this.camStats.lastCue.punch = Math.max(this.camStats.lastCue.punch, p);
    }

    // Commercial-break angles ease too, so the camera never jumps to the new one.
    const sideGoal = [0, 1, -1][state.angle] ?? 0;
    const tiltGoal = state.angle === 2 ? 0.1 : 0;
    const k = 1 - Math.exp(-dt * 3);
    this.camSide += (sideGoal - this.camSide) * k;
    this.camTilt += (tiltGoal - this.camTilt) * k;

    if (this.intro) {
      // The match intro's fly-in: from a wide shot of the stage's far layers to the fight framing, eased both ends,
      // set outright each frame (it is a scripted move, not a follow), so it lands exactly where the gameplay camera starts.
      const ms = now - this.intro.t0;
      const wideD = Math.max(cd + 3, Math.min(30, ((b.right - b.left) * W) / (2 * tan * aspect) * 0.62));
      const c = flyCamera({ x: cx - 4, y: cy + 1.6, d: wideD }, { x: cx, y: cy, d: cd }, flyProgress(ms, this.intro.plan.flyMs));
      this.intro.flyMax = Math.max(this.intro.flyMax, (Math.hypot(c.x - this.camRig.x, c.y - this.camRig.y) + Math.abs(c.d - this.camRig.d)) / dt);
      this.camRig = { x: c.x, y: c.y, d: c.d, vx: 0, vy: 0, vd: 0 };
      this.intro.lastD = c.d;
      this.camCut = false;
    } else if (this.camCut) {
      this.camRig = { x: cx, y: cy, d: cd, vx: 0, vy: 0, vd: 0 };
      this.camSide = sideGoal;
      this.camTilt = tiltGoal;
      this.camCut = false;
    } else if (followCamera(this.camRig, { x: cx, y: cy, d: cd }, { smooth, smoothZoom, dt, tan, side: this.camSide, tilt: this.camTilt, keep: this.shot ? null : { fighters: live, tan, aspect } }) && !this.shot) {
      // A frame that moved or zoomed past the threshold (scaled for a slow frame) is a jump, scenes aside.
      this.camStats.cameraJumps++;
    }
    this.camTarget.x = this.camRig.x;
    this.camTarget.y = this.camRig.y;
    this.camDist = this.camRig.d;
    const d = this.camDist;
    this.camPos.x = this.camTarget.x + this.camSide * d * 0.12;
    this.camPos.y = this.camTarget.y + d * (0.06 + this.camTilt);
    this.camPos.z = -d;

    // Screen shake off (Settings): the camera stays put, whatever the stage or a hit asked for.
    if (!screenShake()) this.shake = 0;
    this.shake *= 0.86;
    this.hitStats.shakeApplied = this.shake;
    this.hitStats.shakeMax = Math.max(this.hitStats.shakeMax, this.shake);
    const jx = (Math.random() - 0.5) * this.shake * 0.4;
    const jy = (Math.random() - 0.5) * this.shake * 0.4;
    this.camera.position.set(this.camPos.x + jx, this.camPos.y + jy, this.camPos.z);
    this.camera.setTarget(new Vector3(this.camTarget.x + jx, this.camTarget.y + jy, 0));
  }

  /** Where a fighter's head is on the page in CSS pixels (for on-stage prompts), or null when the fighter is off the stage. */
  fighterScreen(f: Fighter): { x: number; y: number; scale: number } | null {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas || this.offstage.has(f.id) || f.action === ACT.DEAD) return null;
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const m = this.scene.getTransformMatrix();
    const head = (f.y + ((CHARACTERS[f.char]?.height ?? 110) * f.scale * FX) / 100) * S;
    const foot = f.y * S;
    const top = Vector3.Project(new Vector3(f.x * S, head, 0), Matrix.IdentityReadOnly, m, vp);
    const bottom = Vector3.Project(new Vector3(f.x * S, foot, 0), Matrix.IdentityReadOnly, m, vp);
    const k = canvas.clientWidth / w;
    return { x: top.x * k, y: top.y * k, scale: Math.abs(bottom.y - top.y) * k };
  }

  /**
   * Where a sim x is across the view: 0 at the left edge, 1 at the right, beyond that off screen (the stereo pan of a
   * sound made there, see roomAudio.panFromScreen). 0.5 when there is no view to ask.
   */
  screenX01(simX: number): number {
    const w = this.engine.getRenderWidth();
    if (!w) return 0.5;
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const p = Vector3.Project(new Vector3(simX * S, 0, 0), Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), vp);
    return Number.isFinite(p.x) ? p.x / w : 0.5;
  }

  /**
   * Where a living fighter's middle is on the page (CSS px), whether it is out of the view (or cut off by its edge), and how far
   * it is from the nearest blast line (world units). Null while it is away, dead or in a story scene.
   */
  fighterEdge(f: Fighter): { x: number; y: number; off: boolean; gap: number } | null {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas || this.shot || this.camCut || this.offstage.has(f.id) || f.action === ACT.DEAD) return null;
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const m = this.scene.getTransformMatrix();
    const mid = f.y * S + (CHARACTERS[f.char].height * W * (f.scale / 100)) / 2;
    const p = Vector3.Project(new Vector3(f.x * S, mid, 0), Matrix.IdentityReadOnly, m, vp);
    const k = canvas.clientWidth / w;
    const cw = w * k;
    const ch = h * k;
    const x = p.x * k;
    const y = p.y * k;
    const edge = 20;
    const b = this.stage.blast;
    const gap = Math.min(f.x / FX - b.left, b.right - f.x / FX, b.top - f.y / FX, f.y / FX - b.bottom);
    return { x, y, off: x < edge || x > cw - edge || y < edge || y > ch - edge, gap: Math.max(0, gap) };
  }

  /** After a render: counts a living fighter whose body is outside the view (the playtest wants none). */
  private checkFraming(state: GameState): void {
    if (this.shot || this.camCut || this.intro) return;
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.camera.viewport.toGlobal(w, h);
    const m = this.scene.getTransformMatrix();
    for (const f of state.fighters) {
      if (f.action === ACT.DEAD || this.offstage.has(f.id)) continue;
      const wx = f.x * S;
      const wy = f.y * S;
      if (f.x / FX <= this.stage.blast.left || f.x / FX >= this.stage.blast.right || f.y / FX >= this.stage.blast.top || f.y / FX <= this.stage.blast.bottom) continue;
      const p = Vector3.Project(new Vector3(wx, wy, 0), Matrix.IdentityReadOnly, m, vp);
      if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) this.camStats.framingMisses++;
    }
  }

  /**
   * Story-scene camera: `focus` a fighter id for a close-up, null for a wide shot of the stage that slowly
   * pushes in; `direct(null)` hands the camera back to the fight. The camera always eases, never cuts.
   */
  direct(shot: { focus: number | null } | null): void {
    this.shot = shot ? { focus: shot.focus, since: performance.now() } : null;
  }

  /** Keeps a fighter off stage (before their arrival in a story scene), or brings them back without one. */
  holdOffstage(id: number, held: boolean): void {
    if (held) this.offstage.add(id);
    else this.offstage.delete(id);
  }

  /** A fighter's entrance: drops in from above and lands with dust, a thud and a small shake. */
  arrive(id: number): void {
    this.offstage.delete(id);
    this.arriving.set(id, performance.now());
  }

  /** The speaker of a story line gives a little bounce as they start talking. */
  cue(id: number): void {
    this.talking.set(id, performance.now());
  }

  /** Kicks the camera (slams: ROUND START, GAME!). 0.3 is a medium hit. */
  kick(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  // ---------------------------------------------------------------- the match intro (campaign/intro.ts)

  /** Starts the intro: the fly-in camera and each fighter's entrance run from this moment (until `introEnd`). */
  introBegin(plan: IntroPlan): void {
    this.intro = { t0: performance.now(), plan, fired: new Map(), poses: new Map(), beats: 0, flyMax: 0, lastD: 0 };
    for (const e of plan.entries) this.intro.poses.set(e.slot, entrancePose(e.kind, -1, e.from));
    this.camMs = 0;
  }

  /** Ends the intro (it ran out or was skipped): everyone stands where the sim has them and the gameplay camera follows on. */
  introEnd(): void {
    this.intro = null;
    for (const m of this.introProps.values()) m.setEnabled(false);
    this.camMs = 0;
  }

  introActive(): boolean {
    return this.intro !== null;
  }

  /** Where the intro is, for the playtest: the clock, the camera's distance, the fastest camera move (units per second) and the beats fired. */
  introStats(): { active: boolean; ms: number; camDist: number; camX: number; maxSpeed: number; beats: number; kinds: string[] } {
    const i = this.intro;
    return { active: !!i, ms: i ? Math.round(performance.now() - i.t0) : 0, camDist: this.camRig.d, camX: this.camRig.x, maxSpeed: i?.flyMax ?? 0, beats: i?.beats ?? 0, kinds: i ? i.plan.entries.map((e) => `${e.who}:${e.kind}`) : [] };
  }

  /** A flat additive material in a colour, for the intro's coloured sparks, rings and spotlights. */
  private introMat(hex: string, tex?: DynamicTexture): StandardMaterial {
    const key = `${hex}|${tex?.name ?? ''}`;
    let m = this.introMats.get(key);
    if (!m) {
      m = this.sparkMat.clone(`intro-${key}`);
      m.emissiveColor = Color3.FromHexString(hex);
      if (tex) {
        m.diffuseTexture = tex;
        m.opacityTexture = tex;
        m.emissiveTexture = tex;
      }
      this.introMats.set(key, m);
    }
    return m;
  }

  /** A small painted prop texture: the skateboard, the cable and the spotlight's cone. */
  private introTex(kind: 'board' | 'cable' | 'spot'): DynamicTexture {
    const name = `intro-${kind}`;
    const found = this.scene.getTextureByName(name);
    if (found) return found as DynamicTexture;
    const [w, h] = kind === 'board' ? [128, 32] : kind === 'cable' ? [8, 64] : [64, 128];
    const t = new DynamicTexture(name, { width: w, height: h }, this.scene, false);
    const c = t.getContext() as CanvasRenderingContext2D;
    c.clearRect(0, 0, w, h);
    if (kind === 'board') {
      c.fillStyle = '#e8e0d0';
      for (const x of [28, 100]) {
        c.beginPath();
        c.arc(x, 24, 6, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#7d7468';
      c.fillRect(24, 16, 8, 4);
      c.fillRect(96, 16, 8, 4);
      c.fillStyle = '#2b2118';
      c.beginPath();
      c.roundRect(6, 6, 116, 11, 5);
      c.fill();
      c.fillStyle = '#ff5a1f';
      c.fillRect(14, 9, 100, 3);
    } else if (kind === 'cable') {
      c.fillStyle = '#3a3a40';
      c.fillRect(2, 0, 4, h);
      c.fillStyle = '#9a9aa6';
      c.fillRect(3, 0, 1, h);
    } else {
      // A cone of light, narrow at the top, wide at the floor, soft at the edges.
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0.95)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(w * 0.42, 0);
      c.lineTo(w * 0.58, 0);
      c.lineTo(w * 0.98, h);
      c.lineTo(w * 0.02, h);
      c.closePath();
      c.fill();
    }
    t.hasAlpha = true;
    t.update();
    return t;
  }

  /** The prop mesh of one fighter's entrance (made on first use, then reused). */
  private introProp(slot: number, kind: 'board' | 'cable' | 'spot', color: string): Mesh {
    let m = this.introProps.get(slot);
    const tag = `${kind}|${color}`;
    if (!m || m.metadata !== tag) {
      m?.dispose();
      m = CreatePlane(`intro-prop-${slot}`, { size: 1 }, this.scene);
      m.isPickable = false;
      m.metadata = tag;
      const tex = this.introTex(kind);
      if (kind === 'spot') m.material = this.introMat(color, tex);
      else {
        const mat = this.flatMaterial(`intro-${kind}-${slot}`, '#ffffff');
        mat.diffuseTexture = tex;
        mat.emissiveTexture = tex;
        mat.opacityTexture = tex;
        mat.disableDepthWrite = true;
        m.material = mat;
      }
      this.glow.addExcludedMesh(m);
      this.introProps.set(slot, m);
    }
    return m;
  }

  /** One frame of the intro: each entrance's pose, the beats it has passed and its prop. */
  private introTick(state: GameState): void {
    const intro = this.intro!;
    const ms = performance.now() - intro.t0;
    for (const e of intro.plan.entries) {
      const f = state.fighters[e.slot];
      const v = this.views[e.slot];
      if (!f || !v) continue;
      const k = (ms - e.startMs) / e.durMs;
      const pose = entrancePose(e.kind, k, e.from);
      intro.poses.set(e.slot, pose);
      const h = CHARACTERS[f.char].height * W * ART_SCALE * (f.scale / 100);
      const fx = f.x * S + pose.dx * h;
      const fy = f.y * S + pose.dy * h;
      const beats = entranceBeats(e.kind);
      let i = intro.fired.get(e.slot) ?? 0;
      while (i < beats.length && k >= beats[i].at) {
        this.introBeat(e.slot, e.who, beats[i], fx, f.y * S, fy, h, e.from, e.color);
        intro.beats++;
        i++;
      }
      intro.fired.set(e.slot, i);
      const mesh = pose.prop && k < 1.2 ? this.introProp(e.slot, pose.prop.kind, e.color) : this.introProps.get(e.slot);
      if (!mesh) continue;
      if (!pose.prop || pose.hidden) {
        mesh.setEnabled(false);
        continue;
      }
      const p = pose.prop;
      mesh.setEnabled(p.alpha > 0.01);
      const px = f.x * S + p.dx * h;
      if (p.kind === 'board') {
        mesh.position.set(px, f.y * S + p.dy * h + h * 0.07, 0.03);
        mesh.scaling.set(h * 0.75, h * 0.19, 1);
        (mesh.material as StandardMaterial).alpha = p.alpha;
      } else if (p.kind === 'cable') {
        const len = (p.len ?? 4) * h;
        mesh.position.set(px, f.y * S + p.dy * h + len / 2, 0.02);
        mesh.scaling.set(0.07, len, 1);
        (mesh.material as StandardMaterial).alpha = p.alpha;
      } else {
        const len = (p.len ?? 4) * h;
        mesh.position.set(px, f.y * S + len / 2, 0.04);
        mesh.scaling.set(h * 1.9, len, 1);
        (mesh.material as StandardMaterial).alpha = p.alpha;
      }
      mesh.rotation.z = p.rot;
    }
  }

  /** One beat of an entrance: sparks, a shake, the thud of a landing. `fx`/`fy` is where the feet are, `floor` where the ground is. */
  private introBeat(slot: number, who: string, b: { fx: BeatFx; kick?: number; n?: number }, fx: number, floor: number, fy: number, h: number, from: number, color: string): void {
    const n = b.n ?? 8;
    const tint = this.introMat(color);
    switch (b.fx) {
      case 'dust':
        this.burst(fx, floor + 0.02, n, 0.06);
        break;
      case 'thud':
        this.burst(fx, floor + 0.02, n, 0.08);
        this.onSound?.('land');
        this.onSynth?.('thud');
        break;
      case 'clank':
        this.burst(fx, fy + h * 0.5, n, 0.05, this.introMat('#ffd9a0'));
        this.onSound?.('land');
        break;
      case 'ring': {
        const mesh = this.takeSpark(tint);
        mesh.position.set(fx, floor + 0.05, -0.38);
        mesh.rotation.z = 0;
        this.sparks.push({ mesh, vx: 0, vy: 0, life: 20, max: 20, size: 0.7, grow: 5, stretch: 2.2 });
        break;
      }
      case 'spark':
        this.burst(fx, fy + h * 0.5, n, 0.07, tint);
        break;
      case 'streak':
        for (let i = 0; i < Math.ceil(n * particleShare(this.gfx.quality)); i++) {
          const mesh = this.takeSpark(tint);
          mesh.position.set(fx - from * (0.1 + Math.random() * 0.5), fy + h * (0.15 + Math.random() * 0.7), -0.4);
          mesh.rotation.z = 0;
          this.sparks.push({ mesh, vx: -from * 0.01, vy: 0, life: 9 + Math.floor(Math.random() * 6), max: 14, size: 0.28 + Math.random() * 0.22, stretch: 4 });
        }
        break;
      case 'flash':
        // A lightning strike or a flashbulb: the screen whitens for a few frames and sparks fly off the fighter.
        this.flashMat.alpha = Math.max(this.flashMat.alpha, b.kick ? 0.5 : 0.28);
        this.flashPlane.setEnabled(true);
        this.burst(fx + (Math.random() - 0.5) * h * 0.8, fy + h * (0.4 + Math.random() * 0.6), n, 0.05, this.introMat('#ffffff'));
        break;
      case 'snap':
        this.burst(fx, fy + h * 1.05, n, 0.06, this.introMat('#fff0a0'));
        this.onSynth?.('whoosh');
        break;
      case 'taunt':
        break;
    }
    if (b.kick) this.kick(b.kick);
    this.onIntroBeat?.(slot, who, b.fx);
  }

  /** A match moment the stage's effects can react to: 'start' when play begins, 'end' at Game! */
  stageEvent(on: 'start' | 'end'): void {
    this.fx?.trigger(on);
    this.live?.trigger(on);
  }

  /** Frees the engine (devtools previews come and go). */
  dispose(): void {
    this.alive?.dispose();
    this.fx?.dispose();
    this.engine.dispose();
  }

  /** Points the camera at the stage, for menus that show it behind them. */
  frameStage(): void {
    this.camCut = true;
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
      // The bob follows the ground covered (as fast as the old clock at full walking speed), so a slow walk doesn't skate.
      return [1, 1, -f.facing * 0.06, Math.abs(Math.sin((f.x * f.facing * 0.35) / ch.walkSpeed)) * 0.04];
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
      // Throws, traps and counters have no hit window: they lean in around the moment they take effect.
      const w = m.hits[0] ?? { start: m.shot?.frame ?? m.counter?.from ?? 4, end: (m.shot?.frame ?? m.counter?.from ?? 4) + 3, boxes: [{ x: 40, y: ch.height * 0.5 }] };
      const b = w.boxes[0];
      const ang = Math.atan2(b.y - ch.height * 0.5, b.x);
      if (m.kind === 'recovery' && m.helpless && t > w.start) return [1, 1, f.facing * t * 0.5, 0];
      if (m.kind === 'counter') return t >= w.start ? [1.06, 0.94, 0, 0] : [0.98, 1.03, 0, 0];
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
    case ACT.GRAB:
      return t < GRAB_FIRST ? [1, 1, 0, 0] : [1.1, 1, -f.facing * 0.2, 0];
    case ACT.GRAB_HOLD:
      return [1.04, 0.97, -f.facing * 0.12, 0];
    case ACT.THROW:
      return [1.08, 1, f.facing * (f.throwKind === 2 ? -0.2 : 0.2), 0];
    case ACT.GRABBED:
      return [0.96, 1.02, f.facing * Math.sin(t * 0.8) * 0.12, 0];
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

const prefetched = new Map<string, Promise<void>>();

/**
 * Starts fetching fighters' art and every clip sheet into the browser cache, with no match or scene
 * needed: called the moment fighters are picked, so setFighters and the VS card find them ready.
 * Never throws; a failed fetch is simply retried by the real load.
 */
export function prefetchFighters(chars: number[]): Promise<void> {
  const all = [...new Set(chars)].map((c) => {
    const id = CHARACTERS[c].id;
    let p = prefetched.get(id);
    if (!p) {
      p = (async () => {
        const [, anims] = await Promise.all([loadArt(`/characters/large/${id}.webp`).catch(() => null), loadAnimSet(id)]);
        if (!anims) return;
        const quality = graphics().quality;
        await Promise.all(Object.values(anims.clips).map((clip) => new Promise<void>((done) => {
          const img = new Image();
          img.onload = img.onerror = () => done();
          img.src = `${anims.base}${clipSheetFile(clip, quality)}?v=${anims.version}`;
        })));
      })();
      prefetched.set(id, p);
    }
    return p;
  });
  return Promise.all(all).then(() => undefined, () => undefined);
}

const prefetchedStages = new Set<number>();

/** Starts fetching a stage's painted layers into the browser cache (on hover/focus in Stage Select, or when a chapter starts), so warmUp doesn't wait on them. */
export function prefetchStage(stage: number): void {
  if (prefetchedStages.has(stage)) return;
  prefetchedStages.add(stage);
  const st = STAGES[stage];
  for (const l of st ? layersFor(st, graphics().quality === 'high') : []) {
    if (l.hidden || !l.image) continue;
    const img = new Image();
    img.src = `/${l.image}`;
  }
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
