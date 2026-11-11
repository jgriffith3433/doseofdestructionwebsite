// The palette shader: a Babylon material plugin that recolours the fighter's sprite (still or clip sheet) in the
// fragment shader, just before the colour is written. Only the colour mask of the look is turned (hue, saturation,
// value), so skin, eyes and outlines stay. The same maths as looks.ts `recolor` (which the test checks).
// Classic fighters get no plugin at all, so today's look costs nothing.

import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { lookUniforms, type Look } from '../looks.ts';

const FRAGMENT_DEFS = `
vec3 lookRgb2Hsv(vec3 c){
  float mx=max(c.r,max(c.g,c.b)); float d=mx-min(c.r,min(c.g,c.b));
  float h=0.0;
  if(d>0.0){
    if(mx==c.r) h=mod((c.g-c.b)/d+6.0,6.0);
    else if(mx==c.g) h=(c.b-c.r)/d+2.0;
    else h=(c.r-c.g)/d+4.0;
  }
  return vec3(h/6.0, mx>0.0? d/mx:0.0, mx);
}
vec3 lookHsv2Rgb(vec3 c){
  vec3 k=mod(vec3(5.0,3.0,1.0)+c.x*6.0,6.0);
  return c.z-c.z*c.y*clamp(min(k,4.0-k),0.0,1.0);
}
vec3 lookApply(vec3 rgb){
  vec3 hsv=lookRgb2Hsv(rgb);
  float w=0.0; float nh=hsv.x; float ns=hsv.y;
  if(lookA.w>1.5){
    w=(1.0-smoothstep(0.14,0.24,hsv.y))*smoothstep(0.2,0.32,hsv.z)*(1.0-smoothstep(0.86,0.96,hsv.z));
    nh=lookA.z; ns=mix(hsv.y,lookB.x,w);
  } else {
    float d=abs(hsv.x-lookA.x); d=min(d,1.0-d);
    w=(1.0-smoothstep(lookA.y*0.6,lookA.y,d))*smoothstep(0.18,0.32,hsv.y)*smoothstep(0.12,0.25,hsv.z);
    nh=fract(hsv.x+lookA.z+2.0); ns=clamp(hsv.y*lookB.x,0.0,1.0);
  }
  vec3 outc=lookHsv2Rgb(vec3(nh,ns,clamp(hsv.z*lookB.y,0.0,1.0)));
  return mix(rgb,outc,w);
}
`;

/** Recolours a StandardMaterial by one look. Create it only for a look other than Classic. */
export class LookPlugin extends MaterialPluginBase {
  private a: [number, number, number, number] = [0, 1, 0, 0];
  private b: [number, number] = [1, 1];

  constructor(material: StandardMaterial, look: Look) {
    super(material, 'DodLook', 250, undefined, true, true);
    this.set(look);
  }

  set(look: Look): void {
    const u = lookUniforms(look);
    this.a = u.a;
    this.b = u.b;
  }

  override getClassName(): string {
    return 'LookPlugin';
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'lookA', size: 4, type: 'vec4' },
        { name: 'lookB', size: 2, type: 'vec2' },
      ],
      // Without uniform buffers the same two are plain uniforms.
      fragment: 'uniform vec4 lookA;\nuniform vec2 lookB;',
    };
  }

  override bindForSubMesh(ubo: { updateFloat4(n: string, x: number, y: number, z: number, w: number): void; updateFloat2(n: string, x: number, y: number): void }): void {
    ubo.updateFloat4('lookA', this.a[0], this.a[1], this.a[2], this.a[3]);
    ubo.updateFloat2('lookB', this.b[0], this.b[1]);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFS,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: 'color.rgb = lookApply(color.rgb);',
    };
  }
}
