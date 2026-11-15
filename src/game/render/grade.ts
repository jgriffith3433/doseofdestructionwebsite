// A stage's colour grade: the numbers in content/stages.json (`grade`) and the one function that turns them into
// a colour. Pure and dependency-free: tools/make-luts.mjs bakes it into each stage's 3D LUT, and the test checks it.

export interface StageGrade {
  /** Lifts the shadows (0 to 0.1): added where the picture is dark. */
  lift: number;
  /** Mid-tone curve: above 1 brightens the mids, below 1 darkens them. */
  gamma: number;
  /** Multiplies the highlights. */
  gain: number;
  /** 1 = as painted, 0 = grey. */
  saturation: number;
  /** The colour the picture leans toward, `#rrggbb`. */
  tint: string;
  /** How far it leans (0 to 0.5), brightness kept. */
  tintAmount: number;
}

/** The LUT is a strip of LUT_SIZE slices (blue) side by side, each LUT_SIZE x LUT_SIZE (red across, green down). */
export const LUT_SIZE = 16;

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Grades one colour (each channel 0 to 1). */
export function gradeColor(g: StageGrade, r: number, gr: number, b: number): [number, number, number] {
  const tint = hexRgb(g.tint);
  const tl = Math.max(0.05, luma(tint[0], tint[1], tint[2]));
  const out: number[] = [r, gr, b];
  for (let i = 0; i < 3; i++) {
    let c = out[i] * g.gain + g.lift * (1 - out[i]);
    c = Math.pow(clamp01(c), 1 / Math.max(0.1, g.gamma));
    out[i] = c;
  }
  const l = luma(out[0], out[1], out[2]);
  for (let i = 0; i < 3; i++) {
    let c = l + (out[i] - l) * g.saturation;
    c = c + (c * (tint[i] / tl) - c) * g.tintAmount;
    out[i] = clamp01(c);
  }
  return [out[0], out[1], out[2]];
}

/** The strip's pixels (RGBA, LUT_SIZE*LUT_SIZE wide, LUT_SIZE tall), row 0 = green 0. */
export function lutPixels(g: StageGrade): Uint8Array {
  const n = LUT_SIZE;
  const w = n * n;
  const px = new Uint8Array(w * n * 4);
  for (let y = 0; y < n; y++)
    for (let s = 0; s < n; s++)
      for (let x = 0; x < n; x++) {
        const [r, gg, b] = gradeColor(g, x / (n - 1), y / (n - 1), s / (n - 1));
        const o = (y * w + s * n + x) * 4;
        px[o] = Math.round(r * 255);
        px[o + 1] = Math.round(gg * 255);
        px[o + 2] = Math.round(b * 255);
        px[o + 3] = 255;
      }
  return px;
}

export const lutUrl = (stageId: string): string => `stages/${stageId}/lut.png`;
