// The match's post chain: one full-screen pass over the 3D scene, never over the HUD, captions or touch controls
// (those are DOM above the canvas). High: the stage's 3D LUT grade, vignette, light film grain, and on heavy hits and
// KOs a 4-frame chromatic aberration plus exposure punch. Low: LUT + vignette only. Bloom is the glow layer (the
// Glow setting): it lights emissive things only, so faces and the HUD never bloom.

import type { Scene } from '@babylonjs/core/scene.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import { PostProcess } from '@babylonjs/core/PostProcesses/postProcess.js';
import { Effect } from '@babylonjs/core/Materials/effect.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import '@babylonjs/core/Shaders/postprocess.vertex.js';
import { LUT_SIZE, lutUrl, type StageGrade } from './grade.ts';
import type { Quality } from '../graphics.ts';

/** A heavy hit or KO punches the screen for this many rendered frames, the hit-stop's first frames. */
export const PUNCH_FRAMES = 4;

const NAME = 'dodGrade';
Effect.ShadersStore[`${NAME}FragmentShader`] = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D lutSampler;
uniform float lutOn;
uniform float vignette;
uniform float grain;
uniform float seed;
uniform float aberration;
uniform float punch;
uniform float glitch;
uniform float gtime;
const float N = ${LUT_SIZE}.0;

vec3 lut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (N - 1.0);
  float s0 = floor(b);
  float s1 = min(s0 + 1.0, N - 1.0);
  float f = b - s0;
  float y = (c.g * (N - 1.0) + 0.5) / N;
  float x0 = (s0 * N + c.r * (N - 1.0) + 0.5) / (N * N);
  float x1 = (s1 * N + c.r * (N - 1.0) + 0.5) / (N * N);
  return mix(texture2D(lutSampler, vec2(x0, y)).rgb, texture2D(lutSampler, vec2(x1, y)).rgb, f);
}

void main(void) {
  vec2 d = vUV - 0.5;
  vec2 off = d * aberration * (0.4 + dot(d, d) * 4.0);
  // The takeover glitch: bands of rows tear sideways and the red and blue channels split far apart.
  vec2 uv = vUV;
  float band = floor(vUV.y * 24.0 + gtime * 18.0);
  float tear = step(0.72, fract(sin(band * 91.7 + floor(gtime * 14.0) * 13.3) * 4375.5)) * (fract(sin(band * 12.9 + gtime) * 437.5) - 0.5);
  uv.x += tear * 0.12 * glitch;
  float split = glitch * (0.014 + 0.02 * fract(sin(floor(gtime * 20.0) * 7.7) * 1000.0));
  off += vec2(split, 0.0);
  vec3 c = vec3(texture2D(textureSampler, uv + off).r, texture2D(textureSampler, uv).g, texture2D(textureSampler, uv - off).b);
  c += glitch * 0.06 * step(0.5, fract(vUV.y * 90.0 + gtime * 6.0));
  c *= 1.0 + punch * 0.45;
  c = mix(c, c * c * (3.0 - 2.0 * min(c, vec3(1.0))), punch * 0.35);
  if (lutOn > 0.5) c = lut(c);
  float v = smoothstep(0.35, 0.95, length(d * vec2(1.0, 1.1)) * 1.45);
  c *= 1.0 - vignette * v;
  float n = fract(sin(dot(vUV * 1000.0 + seed, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * grain;
  gl_FragColor = vec4(c, 1.0);
}
`;

export interface PostStats {
  quality: Quality;
  lut: string | null;
  lutReady: boolean;
  vignette: number;
  grain: number;
  punchFrames: number;
  punches: number;
  /** Frames the aberration actually drew on the last punch. */
  lastPunchDrawn: number;
  /** Takeover glitches started, and rendered frames the last one drew. */
  glitches: number;
  glitchDrawn: number;
}

export class PostChain {
  private pp: PostProcess;
  private lutTex: Texture | null = null;
  private lutId: string | null = null;
  private ready = false;
  private quality: Quality = 'high';
  private frames = 0;
  private drawn = 0;
  private glitchUntil = 0;
  private glitchDrawn = 0;
  private glitches = 0;
  private stats = { punches: 0, lastPunchDrawn: 0 };

  private scene: Scene;

  constructor(scene: Scene, camera: Camera) {
    this.scene = scene;
    this.pp = new PostProcess(
      NAME,
      NAME,
      ['lutOn', 'vignette', 'grain', 'seed', 'aberration', 'punch', 'glitch', 'gtime'],
      ['lutSampler'],
      1.0,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      scene.getEngine(),
      false,
      null,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    this.pp.onApply = (effect) => {
      const high = this.quality === 'high';
      const punching = high && this.frames > 0;
      if (punching) this.drawn++;
      effect.setFloat('lutOn', this.ready ? 1 : 0);
      effect.setFloat('vignette', high ? 0.34 : 0.3);
      effect.setFloat('grain', high ? 0.035 : 0);
      effect.setFloat('seed', (performance.now() % 997) * 0.37);
      effect.setFloat('aberration', punching ? 0.012 : 0);
      effect.setFloat('punch', punching ? 1 : 0);
      // The takeover glitch runs on Low too (one extra texture read, no grain): it is the story beat, not polish.
      const now = performance.now();
      const gl = now < this.glitchUntil ? Math.min(1, (this.glitchUntil - now) / 250) : 0;
      if (gl > 0) this.glitchDrawn++;
      effect.setFloat('glitch', gl);
      effect.setFloat('gtime', (now % 100000) / 1000);
      if (this.lutTex) effect.setTexture('lutSampler', this.lutTex);
    };
  }

  /** Loads a stage's LUT (stages/<id>/lut.png). The grade shows once it is in; until then the picture is ungraded. */
  setStage(id: string, _grade?: StageGrade): void {
    if (this.lutId === id) return;
    this.lutId = id;
    this.ready = false;
    this.lutTex?.dispose();
    const tex = new Texture(`/${lutUrl(id)}`, this.scene, true, false, Texture.BILINEAR_SAMPLINGMODE, () => {
      if (this.lutTex === tex) this.ready = true;
    });
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.lutTex = tex;
  }

  setQuality(q: Quality): void {
    this.quality = q;
  }

  /** Starts the punch: the next PUNCH_FRAMES rendered frames. */
  punch(): void {
    if (this.frames === 0) {
      this.drawn = 0;
      this.stats.punches++;
    }
    this.frames = PUNCH_FRAMES;
  }

  /** The takeover glitch: an RGB split with torn rows for `ms` (it eases out over the last quarter second). */
  glitch(ms = 1000): void {
    this.glitchUntil = performance.now() + ms;
    this.glitchDrawn = 0;
    this.glitches++;
  }

  /** Call once per rendered frame, after scene.render(). */
  endFrame(): void {
    if (this.frames > 0) {
      this.frames--;
      if (this.frames === 0) this.stats.lastPunchDrawn = this.drawn;
    }
  }

  report(): PostStats {
    return {
      quality: this.quality,
      lut: this.lutId,
      lutReady: this.ready,
      vignette: this.quality === 'high' ? 0.34 : 0.3,
      grain: this.quality === 'high' ? 0.035 : 0,
      punchFrames: this.frames,
      punches: this.stats.punches,
      lastPunchDrawn: this.stats.lastPunchDrawn,
      glitches: this.glitches,
      glitchDrawn: this.glitchDrawn,
    };
  }
}
