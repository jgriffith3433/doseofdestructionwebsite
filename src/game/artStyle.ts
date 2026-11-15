// The art bible's numbers (docs/art-bible.md) and the pure maths behind them. The fighter style pass (render/stylePlugin.ts)
// draws with them, tools/derive-style.mjs computes each fighter's remap from its idle sheet with them, and
// test/style.test.ts lists any fighter outside the ranges. Change a number here and in the bible together.

export type Range = readonly [number, number];

export const ART = {
  /** Outline from the sprite's alpha edge: 2 px at 1080p, never under 1 px (a phone at 844x390 draws 1 px). */
  outline: { px1080: 2, minPx: 1, /** value of the darkened main hue */ value: 0.2, /** saturation floor and cap of the outline colour */ sat: [0.35, 0.7] as Range },
  /** What a fighter's idle sheet measures AFTER the remap (opaque pixels, HSV, 0..1). */
  ranges: {
    /** Mean saturation of the coloured pixels (s > 0.12, v > 0.15 in the original art, then remapped). */
    sMean: [0.32, 0.82] as Range,
    /** The darkest 5% of the body: never black, never washed out. */
    vP5: [0.08, 0.30] as Range,
    /** The brightest 5%: every fighter has a highlight, none burns out. */
    vP95: [0.66, 0.94] as Range,
    /** Mean value of the body. */
    vMean: [0.25, 0.65] as Range,
  },
  /** Where the remap aims (inside the ranges with a margin); a fighter already inside moves as little as it can. */
  target: { sMean: [0.4, 0.76] as Range, vP5: [0.12, 0.28] as Range, vP95: [0.72, 0.88] as Range },
  /** The remap may not turn a fighter into another one. */
  limits: { sGain: [0.8, 2.6] as Range, vGamma: [0.55, 1] as Range, vGain: [0.7, 2.6] as Range },
} as const;

export interface Remap {
  /** Saturation multiplier. */
  sGain: number;
  /** Value is v' = vOff + vGain * v^vGamma. */
  vGamma: number;
  vGain: number;
  vOff: number;
}
export interface StyleStats {
  sMean: number;
  vP5: number;
  vP95: number;
  vMean: number;
}
export interface FighterStyle {
  /** Outline colour: the fighter's main hue, darkened (never black). */
  outline: string;
  /** Main hue in degrees the outline was made from. */
  hue: number;
  remap: Remap;
  /** What the idle sheet measured before and after the remap (tools/derive-style.mjs). */
  before: StyleStats;
  after: StyleStats;
}

export const IDENTITY: Remap = { sGain: 1, vGamma: 1, vGain: 1, vOff: 0 };
const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

export function toHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, mx ? d / mx : 0, mx];
}
export function fromHsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** Value and saturation through a remap (hue kept). The shader (render/stylePlugin.ts) does the same. */
export function remapSV(s: number, v: number, m: Remap): [number, number] {
  return [clamp(s * m.sGain), clamp(m.vOff + m.vGain * Math.pow(v, m.vGamma))];
}
export function remapPx(r: number, g: number, b: number, m: Remap): [number, number, number] {
  const [h, s, v] = toHsv(r, g, b);
  const [ns, nv] = remapSV(s, v, m);
  return fromHsv(h, ns, nv);
}

/** The outline colour: the main hue, darkened to the bible's value, its saturation following the fighter's own (within the bible's band). */
export function outlineColor(hue: number, sMean: number): string {
  const s = clamp(sMean, ART.outline.sat[0], ART.outline.sat[1]);
  const [r, g, b] = fromHsv(((hue % 360) + 360) % 360, s, ART.outline.value);
  return '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}
export const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Outline width in device pixels for a render height: 2 px at 1080, scaled down with the screen, never under 1. */
export const outlineWidthPx = (renderHeight: number): number => Math.max(ART.outline.minPx, (ART.outline.px1080 * renderHeight) / 1080);

/** The remap that brings measured stats into the target bands, moving as little as it can. */
export function solveRemap(b: StyleStats): Remap {
  const lim = ART.limits;
  const tgt = ART.target;
  const sGain = clamp(clamp(b.sMean, tgt.sMean[0], tgt.sMean[1]) / Math.max(b.sMean, 0.01), lim.sGain[0], lim.sGain[1]);
  // Dark fighters get a gamma lift first (it keeps their shadows apart), then the affine fit of the two ends.
  const gamma = b.vP95 >= tgt.vP95[0] ? 1 : clamp(Math.log(tgt.vP95[0]) / Math.log(Math.max(b.vP95, 0.05)), lim.vGamma[0], 1);
  const lo = Math.pow(b.vP5, gamma), hi = Math.pow(b.vP95, gamma);
  const wantLo = clamp(lo, tgt.vP5[0], tgt.vP5[1]);
  const wantHi = clamp(hi, tgt.vP95[0], tgt.vP95[1]);
  const vGain = clamp((wantHi - wantLo) / Math.max(hi - lo, 0.02), lim.vGain[0], lim.vGain[1]);
  return { sGain, vGamma: gamma, vGain, vOff: wantLo - vGain * lo };
}

/** Names of the bible's ranges this fighter's measured-after stats are outside of (empty: inside). */
export function outsideRanges(s: StyleStats): string[] {
  const out: string[] = [];
  for (const k of ['sMean', 'vP5', 'vP95', 'vMean'] as const) {
    const [lo, hi] = ART.ranges[k];
    if (!(s[k] >= lo && s[k] <= hi)) out.push(`${k} ${s[k].toFixed(2)} not in ${lo}-${hi}`);
  }
  return out;
}

