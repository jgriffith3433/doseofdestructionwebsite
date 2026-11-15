// The art bible on the fighter's sprite material (docs/art-bible.md, artStyle.ts), two Babylon plugins around the stage light:
//   look (250, lookPlugin.ts) recolours -> RemapPlugin (275) lands the fighter's saturation and value inside the bible's
//   ranges with its own numbers (content/fighters.json `style.remap`) -> light (300, lightPlugin.ts) -> OutlinePlugin (350)
//   draws the outline from the sprite's alpha edge, in the fighter's darkened main hue, so no light or recolour touches it.
// The outline is 2 px at 1080p and never under 1 px (artStyle.ts `outlineWidthPx`); the renderer sets the width in
// texture units each frame from the fighter's size on screen.

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { IDENTITY, hexToRgb, type Remap } from '../artStyle.ts';

type Ubo = { updateFloat4(n: string, x: number, y: number, z: number, w: number): void; updateFloat2(n: string, x: number, y: number): void };

const REMAP_DEFS = `
vec3 styleRgb2Hsv(vec3 c){
  float mx=max(c.r,max(c.g,c.b)); float d=mx-min(c.r,min(c.g,c.b));
  float h=0.0;
  if(d>0.0){
    if(mx==c.r) h=mod((c.g-c.b)/d+6.0,6.0);
    else if(mx==c.g) h=(c.b-c.r)/d+2.0;
    else h=(c.r-c.g)/d+4.0;
  }
  return vec3(h/6.0, mx>0.0? d/mx:0.0, mx);
}
vec3 styleHsv2Rgb(vec3 c){
  vec3 k=mod(vec3(5.0,3.0,1.0)+c.x*6.0,6.0);
  return c.z-c.z*c.y*clamp(min(k,4.0-k),0.0,1.0);
}
vec3 styleRemap(vec3 rgb){
  vec3 hsv=styleRgb2Hsv(rgb);
  float s=clamp(hsv.y*fxRemap.x,0.0,1.0);
  float v=clamp(fxRemap.w+fxRemap.z*pow(max(hsv.z,0.0001),fxRemap.y),0.0,1.0);
  return styleHsv2Rgb(vec3(hsv.x,s,v));
}
`;

/** The per-fighter saturation / value remap (the bible's ranges). Priority 275: after the colour look, before the light. */
export class RemapPlugin extends MaterialPluginBase {
  private m: Remap = IDENTITY;

  constructor(material: StandardMaterial, remap: Remap) {
    super(material, 'DodRemap', 275, undefined, true, true);
    this.m = remap;
  }

  state(): Remap {
    return this.m;
  }

  override getClassName(): string {
    return 'RemapPlugin';
  }

  override getUniforms() {
    return { ubo: [{ name: 'fxRemap', size: 4, type: 'vec4' }], fragment: 'uniform vec4 fxRemap;' };
  }

  override bindForSubMesh(ubo: Ubo): void {
    ubo.updateFloat4('fxRemap', this.m.sGain, this.m.vGamma, this.m.vGain, this.m.vOff);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: REMAP_DEFS, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: 'color.rgb = styleRemap(color.rgb);' };
  }
}

const OUTLINE_DEFS = `
float outA(vec2 uv){
  // Taps outside this frame's cell on a clip sheet belong to the next frame: they count as empty.
  vec2 c = (uv - fxCell.xy) / fxCell.zw;
  if(c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return 0.0;
  return texture2D(diffuseSampler, uv).a;
}
vec4 outlineApply(vec4 col, vec2 uv){
  if(fxOutCol.w < 0.5 || col.a > 0.97) return col;
  vec2 r = fxOutStep * fxCell.zw;
  float m = 0.0;
  for(int i=0;i<8;i++){
    float a = 0.78539816 * float(i);
    vec2 d = vec2(cos(a), sin(a));
    m = max(m, outA(uv + d * r));
    if(fxOutCol.w > 1.5) m = max(m, outA(uv + d * r * 0.5));
  }
  float cov = smoothstep(0.05, 0.6, m) * (1.0 - col.a);
  return vec4(mix(col.rgb, fxOutCol.rgb, clamp(cov / max(cov + col.a, 0.0001), 0.0, 1.0)), max(col.a, cov));
}
`;

/** The outline from the alpha edge. Priority 350: last, so the light and the look never tint it. */
export class OutlinePlugin extends MaterialPluginBase {
  private col: [number, number, number] = [0.1, 0.1, 0.1];
  private on = 1;
  /** Outline width as a share of the frame, per px (set by the renderer from the fighter's size on screen). */
  private perPx: [number, number] = [0.01, 0.01];
  private px = 2;
  private mat: StandardMaterial;

  constructor(material: StandardMaterial, hex: string) {
    super(material, 'DodOutline', 350, undefined, true, true);
    this.mat = material;
    this.setColor(hex);
  }

  setColor(hex: string): void {
    this.col = hexToRgb(hex);
  }

  /** `high`: two rings of taps (a smooth 2 px line); Low: one ring. */
  setQuality(high: boolean): void {
    this.on = high ? 2 : 1;
  }

  /** Width in device px, and the frame's share one px is, across and up. */
  setWidth(px: number, perPxX: number, perPxY: number): void {
    this.px = px;
    this.perPx = [perPxX, perPxY];
  }

  /** What the shader is given (playtest). */
  state() {
    return { color: this.col.map((c) => Math.round(c * 255)), px: this.px, perPx: this.perPx.slice(), on: this.on };
  }

  override getClassName(): string {
    return 'OutlinePlugin';
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'fxOutCol', size: 4, type: 'vec4' },
        { name: 'fxCell', size: 4, type: 'vec4' },
        { name: 'fxOutStep', size: 2, type: 'vec2' },
      ],
      fragment: 'uniform vec4 fxOutCol;\nuniform vec4 fxCell;\nuniform vec2 fxOutStep;',
    };
  }

  override bindForSubMesh(ubo: Ubo): void {
    const t = this.mat.diffuseTexture as { uScale?: number; vScale?: number; uOffset?: number; vOffset?: number } | null;
    const us = t?.uScale ?? 1, vs = t?.vScale ?? 1;
    ubo.updateFloat4('fxOutCol', this.col[0], this.col[1], this.col[2], this.on);
    // The width is in frame shares per px times px; the shader multiplies by the cell size, so give it the share of the cell.
    ubo.updateFloat2('fxOutStep', this.perPx[0] * this.px, this.perPx[1] * this.px);
    ubo.updateFloat4('fxCell', t?.uOffset ?? 0, t?.vOffset ?? 0, us, vs);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: OUTLINE_DEFS, CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: 'color = outlineApply(color, vDiffuseUV + uvOffset);' };
  }
}
