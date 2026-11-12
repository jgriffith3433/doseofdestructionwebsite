// The fighter lighting pass: a Babylon material plugin on the fighter's sprite material, after the palette shader
// (lookPlugin.ts, priority 250: it recolours first, this lights what it made). High: a normal is derived from the
// sprite's alpha edge (Sobel on the alpha channel, two widths), the key light shades the fighter from the key side, a
// rim colour is added on the far side, and the whole is multiplied by the stage's ambient colour. Low: the ambient tint
// only (no texture reads beyond the sprite's own). The stage's numbers are `light` in content/stages.json.

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { hexRgb, type StageLight } from './fighterLight.ts';

const FRAGMENT_DEFS = `
float lightAlpha(vec2 uv){ return texture2D(diffuseSampler, uv).a; }
vec3 lightApply(vec3 rgb, vec2 uv){
  vec3 lit = rgb * fxAmb.rgb;
  if(fxAmb.w < 0.5) return lit;
  vec2 s1 = fxStep;
  vec2 s2 = fxStep * 2.6;
  // Sobel on alpha, narrow and wide, so the edge bevels into the body a little.
  vec2 g = vec2(0.0);
  for(int k=0;k<2;k++){
    vec2 s = k==0 ? s1 : s2;
    float w = k==0 ? 1.0 : 0.6;
    float tl=lightAlpha(uv+vec2(-s.x, s.y)); float t=lightAlpha(uv+vec2(0.0, s.y)); float tr=lightAlpha(uv+vec2(s.x, s.y));
    float l=lightAlpha(uv+vec2(-s.x,0.0)); float r=lightAlpha(uv+vec2(s.x,0.0));
    float bl=lightAlpha(uv+vec2(-s.x,-s.y)); float b=lightAlpha(uv+vec2(0.0,-s.y)); float br=lightAlpha(uv+vec2(s.x,-s.y));
    g += w * vec2((tr+2.0*r+br)-(tl+2.0*l+bl), (tl+2.0*t+tr)-(bl+2.0*b+br));
  }
  // Alpha rises into the body, so the outward normal is minus the gradient.
  vec2 e = -g * 0.45;
  float edge = clamp(length(e), 0.0, 1.0);
  vec3 n = normalize(vec3(e, 1.0 - 0.75 * edge));
  vec3 L = normalize(vec3(fxKey.xy, 0.55));
  float keyAmt = max(dot(n, L), 0.0);
  // The key lights the fighter on its side; the side turned away takes a little less than a flat face.
  vec3 keyed = rgb * fxKeyCol.rgb * fxKey.z * (keyAmt - 0.3);
  // The rim: edges facing away from the key.
  float far = max(dot(normalize(e + vec2(0.0001)), -normalize(fxKey.xy)), 0.0);
  float rim = far * smoothstep(0.08, 0.7, edge);
  return lit + keyed * fxAmb.rgb + fxRim.rgb * fxRim.w * rim;
}
`;

/** Lights a fighter's sprite material with the stage's key, rim and ambient. Create it for every fighter. */
export class LightPlugin extends MaterialPluginBase {
  private key: [number, number, number, number] = [0.4, 0.8, 0.3, 0];
  private keyCol: [number, number, number, number] = [1, 1, 1, 0];
  private rim: [number, number, number, number] = [1, 1, 1, 0.3];
  private amb: [number, number, number, number] = [1, 1, 1, 1];
  private full = true;
  private mat: StandardMaterial;

  constructor(material: StandardMaterial, light: StageLight, full: boolean) {
    super(material, 'DodLight', 300, undefined, true, true);
    this.mat = material;
    this.set(light, full);
  }

  /** The stage's light, and whether the key and rim run (High) or only the ambient tint (Low). */
  set(light: StageLight, full: boolean): void {
    this.full = full;
    const [kx, ky] = light.key.dir;
    const len = Math.hypot(kx, ky) || 1;
    const kc = hexRgb(light.key.color);
    const rc = hexRgb(light.rim.color);
    const ac = hexRgb(light.ambient);
    this.key = [kx / len, ky / len, light.key.strength, 0];
    this.keyCol = [kc[0], kc[1], kc[2], 0];
    this.rim = [rc[0], rc[1], rc[2], light.rim.strength];
    this.amb = [ac[0], ac[1], ac[2], full ? 1 : 0];
  }

  /** What the shader is given (playtest). */
  state() {
    return { full: this.full, key: this.key.slice(0, 3), keyColor: this.keyCol.slice(0, 3), rim: this.rim.slice(), ambient: this.amb.slice(0, 3) };
  }

  override getClassName(): string {
    return 'LightPlugin';
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'fxKey', size: 4, type: 'vec4' },
        { name: 'fxKeyCol', size: 4, type: 'vec4' },
        { name: 'fxRim', size: 4, type: 'vec4' },
        { name: 'fxAmb', size: 4, type: 'vec4' },
        { name: 'fxStep', size: 2, type: 'vec2' },
      ],
      fragment: 'uniform vec4 fxKey;\nuniform vec4 fxKeyCol;\nuniform vec4 fxRim;\nuniform vec4 fxAmb;\nuniform vec2 fxStep;',
    };
  }

  override bindForSubMesh(ubo: { updateFloat4(n: string, x: number, y: number, z: number, w: number): void; updateFloat2(n: string, x: number, y: number): void }): void {
    ubo.updateFloat4('fxKey', this.key[0], this.key[1], this.key[2], this.key[3]);
    ubo.updateFloat4('fxKeyCol', this.keyCol[0], this.keyCol[1], this.keyCol[2], this.keyCol[3]);
    ubo.updateFloat4('fxRim', this.rim[0], this.rim[1], this.rim[2], this.rim[3]);
    ubo.updateFloat4('fxAmb', this.amb[0], this.amb[1], this.amb[2], this.amb[3]);
    // The Sobel step is a share of one frame, so a clip sheet's size and Low's half-size sheets give the same edge.
    const t = this.mat.diffuseTexture as { uScale?: number; vScale?: number } | null;
    ubo.updateFloat2('fxStep', 0.012 * (t?.uScale ?? 1), 0.012 * (t?.vScale ?? 1));
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFS,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: 'color.rgb = lightApply(color.rgb, vDiffuseUV + uvOffset);',
    };
  }
}
