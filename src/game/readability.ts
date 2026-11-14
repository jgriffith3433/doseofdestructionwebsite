// Readability: can a player find their fighter and the edge of every platform at a glance? Pure maths on rendered frames
// (RGBA pixels, as from getImageData); the renderer captures the frames (`Renderer.readabilityProbe`) and the `readability`
// playtest scenario reads them. WCAG relative luminance and contrast ratio; the bar is 3:1 (the large-graphics bar).

/** The contrast every outline and platform edge must reach, and the share of a fighter foreground art may cover. */
export const MIN_CONTRAST = 3;
export const MAX_COVER = 0.3;
/** Of the covered part, the share that must still show a fighter (the silhouette, or the fighter through a faded element). */
export const MIN_SHOWN = 0.6;

export interface Frame {
  w: number;
  h: number;
  /** RGBA, row by row. */
  d: ArrayLike<number>;
}

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Relative luminance (0..1) of the pixel at index i (pixel number, not byte). */
export function lumAt(f: Frame, i: number): number {
  return 0.2126 * lin(f.d[i * 4] / 255) + 0.7152 * lin(f.d[i * 4 + 1] / 255) + 0.0722 * lin(f.d[i * 4 + 2] / 255);
}

/** WCAG contrast ratio of two relative luminances (1..21). */
export function contrast(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const diff = (a: Frame, b: Frame, i: number): number =>
  Math.abs(a.d[i * 4] - b.d[i * 4]) + Math.abs(a.d[i * 4 + 1] - b.d[i * 4 + 1]) + Math.abs(a.d[i * 4 + 2] - b.d[i * 4 + 2]);

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const clampBox = (b: Box, w: number, h: number): Box => ({
  x1: Math.max(0, Math.floor(b.x1)),
  y1: Math.max(0, Math.floor(b.y1)),
  x2: Math.min(w, Math.ceil(b.x2)),
  y2: Math.min(h, Math.ceil(b.y2)),
});

/**
 * The pixels a fighter changes: where the frame with them differs from the same frame without them (inside the box).
 * Isolated specks (the stage's own motion between two renders) are dropped.
 */
export function fighterMask(withF: Frame, without: Frame, box: Box, threshold = 36): Uint8Array {
  const { w, h } = withF;
  const b = clampBox(box, w, h);
  const m = new Uint8Array(w * h);
  for (let y = b.y1; y < b.y2; y++) for (let x = b.x1; x < b.x2; x++) if (diff(withF, without, y * w + x) > threshold) m[y * w + x] = 1;
  const out = new Uint8Array(w * h);
  for (let y = b.y1; y < b.y2; y++) {
    for (let x = b.x1; x < b.x2; x++) {
      if (!m[y * w + x]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) n += m[(y + dy) * w + x + dx];
      if (n >= 3) out[y * w + x] = 1;
    }
  }
  return out;
}

export const maskSize = (m: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
};

/** How far in each mask pixel is from the outside (1 = on the edge, 2 = one pixel in...), up to `max`; 0 = not in the mask or deeper. */
function depthIn(m: Uint8Array, w: number, h: number, box: Box, max: number): Uint8Array {
  const dep = new Uint8Array(w * h);
  for (let d = 1; d <= max; d++) {
    const layer: number[] = [];
    for (let y = box.y1; y < box.y2; y++) {
      for (let x = box.x1; x < box.x2; x++) {
        const i = y * w + x;
        if (!m[i] || dep[i]) continue;
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !m[ny * w + nx] || (d > 1 && dep[ny * w + nx] === d - 1)) { edge = true; break; }
          }
        }
        if (edge) layer.push(i);
      }
    }
    for (const i of layer) dep[i] = d;
  }
  return dep;
}

export interface RingRead {
  /** Pixels in the fighter's silhouette (0: nothing measurable). */
  px: number;
  /** Contrast of the outer band of the silhouette (the player-colour rim) with the background just outside it. */
  rim: number;
  /** Contrast of the band inside that (the dark outline) with the same background. */
  outline: number;
  /** The better of the two: a fighter reads when either tone of its two-tone ring parts from what is behind. */
  best: number;
  /** Ring width in pixels. */
  ringPx: number;
}

/** The ring width for a render height: about 0.5% of it, never under 2 px. */
export const ringWidth = (h: number): number => Math.max(2, Math.round(h * 0.005));

/**
 * (a) A fighter's ring against the background around it. `withF` is the frame with the fighter, `without` the same frame
 * without; the ring is the outer band of the silhouette (width ringPx), the outline the band inside it, the background the
 * band just outside (read from `without`, so it is the real picture behind).
 */
export function ringContrast(withF: Frame, without: Frame, box: Box, mask?: Uint8Array): RingRead {
  const { w, h } = withF;
  const m = mask ?? fighterMask(withF, without, box);
  const px = maskSize(m);
  const rp = ringWidth(h);
  const empty: RingRead = { px, rim: 0, outline: 0, best: 0, ringPx: rp };
  if (px < 60) return empty;
  // Work in a box grown by the ring, so the outside band is inside it.
  const bb = clampBox({ x1: box.x1 - rp * 3, y1: box.y1 - rp * 3, x2: box.x2 + rp * 3, y2: box.y2 + rp * 3 }, w, h);
  const dep = depthIn(m, w, h, bb, rp * 2);
  // Outside band: grow the mask by up to 1 + rp pixels.
  let grown = m;
  const outside = new Uint8Array(w * h);
  for (let step = 1; step <= rp + 1; step++) {
    const next = new Uint8Array(grown);
    for (let y = bb.y1; y < bb.y2; y++) {
      for (let x = bb.x1; x < bb.x2; x++) {
        if (grown[y * w + x]) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h && grown[(y + dy) * w + x + dx]) { near = true; break; }
        if (near) {
          next[y * w + x] = 1;
          if (step >= 2) outside[y * w + x] = 1;
        }
      }
    }
    grown = next;
  }
  const mean = (frame: Frame, pick: (i: number) => boolean): number => {
    let s = 0;
    let n = 0;
    for (let y = bb.y1; y < bb.y2; y++) for (let x = bb.x1; x < bb.x2; x++) if (pick(y * w + x)) { s += lumAt(frame, y * w + x); n++; }
    return n ? s / n : -1;
  };
  const bg = mean(without, (i) => outside[i] === 1 && !m[i]);
  const outer = mean(withF, (i) => dep[i] >= 1 && dep[i] <= rp);
  const inner = mean(withF, (i) => dep[i] > rp && dep[i] <= rp * 2);
  if (bg < 0 || outer < 0) return empty;
  const rimC = contrast(outer, bg);
  const outC = inner < 0 ? 0 : contrast(inner, bg);
  return { px, rim: rimC, outline: outC, best: Math.max(rimC, outC), ringPx: rp };
}

export interface CoverRead {
  /** Pixels the fighter would show with no foreground art. */
  px: number;
  /** Share of those that foreground art paints over. */
  covered: number;
  /** Of the covered pixels, the share where the fighter still changes the picture (a silhouette, or seen through a faded element). */
  shown: number;
}

/**
 * (c) The share of a fighter covered by foreground art, and whether the silhouette shows. Four frames: the fighter with the
 * foreground off (`fighterOnly`) and the stage without either (`bareStage`) give the silhouette; the stage with the foreground
 * on and no fighter (`fgStage`) says where the art paints over it; the foreground on with the fighter (`fgFighter`) says
 * whether the fighter still shows there.
 */
export function coverRead(fighterOnly: Frame, bareStage: Frame, fgStage: Frame, fgFighter: Frame, box: Box): CoverRead {
  const { w, h } = fighterOnly;
  const m = fighterMask(fighterOnly, bareStage, box);
  const px = maskSize(m);
  if (px < 60) return { px, covered: 0, shown: 1 };
  const b = clampBox(box, w, h);
  let covered = 0;
  let shown = 0;
  for (let y = b.y1; y < b.y2; y++) {
    for (let x = b.x1; x < b.x2; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      if (diff(fgStage, bareStage, i) > 36) {
        covered++;
        if (diff(fgFighter, fgStage, i) > 24) shown++;
      }
    }
  }
  return { px, covered: covered / px, shown: covered ? shown / covered : 1 };
}

export interface EdgeRead {
  /** Contrast of the platform's lip with the band just above it (the better of the lip's rows). */
  contrast: number;
  /** Columns measured. */
  cols: number;
}

/**
 * (b) A platform's top edge against the area just above it. `y` is the top edge in pixels, `x1`..`x2` its span (clipped to the
 * frame, the ends trimmed); `lipPx` how far below the top edge the lip reaches. The edge rows are the lip (the top edge and
 * `lipPx` below it); the area above is a band a few pixels higher, clear of the lip. A two-tone lip (a bright core with a dark
 * line either side) counts for the row of it that stands out most.
 */
export function edgeContrast(f: Frame, x1: number, x2: number, y: number, lipPx: number): EdgeRead | null {
  const { w, h } = f;
  const trim = Math.max(2, Math.round((x2 - x1) * 0.12));
  const a = Math.max(0, Math.ceil(x1 + trim));
  const b = Math.min(w, Math.floor(x2 - trim));
  const top = Math.round(y);
  const gap = Math.max(3, Math.round(h * 0.01));
  const band = Math.max(3, Math.round(h * 0.012));
  if (b - a < 12 || top - gap - band < 0 || top + Math.ceil(lipPx) + 2 >= h) return null;
  const rowLum = (yy: number): number => {
    let s = 0;
    for (let x = a; x < b; x++) s += lumAt(f, yy * w + x);
    return s / (b - a);
  };
  let above = 0;
  for (let r = 0; r < band; r++) above += rowLum(top - gap - r);
  above /= band;
  let best = 0;
  for (let yy = top - 1; yy <= top + Math.ceil(lipPx) + 1; yy++) best = Math.max(best, contrast(rowLum(yy), above));
  return { contrast: best, cols: b - a };
}
