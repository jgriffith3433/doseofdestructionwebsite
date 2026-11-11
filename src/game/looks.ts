// Colour looks: each fighter has at least four (content/fighters.json `looks`), drawn by a palette shader on the
// existing sprite sheets (render/lookPlugin.ts). Look 0 is always today's art. The later ones unlock by wins with that
// fighter in any mode (localStorage `dod-wins`, next to `dod-unlocks`). The pick is cosmetic: it never reaches the
// sim, so it can't desync a match; online it rides in the match setup so both sides draw the same colours.
//
// `recolor` is the shader's maths in TypeScript: the VS card and results paint pictures with it, and the test checks it.

import { CHARACTERS } from './sim/characters.ts';
import { CLASSIC, type Look } from './sim/fighterDefs.ts';

export { CLASSIC, type Look } from './sim/fighterDefs.ts';
export const MIN_LOOKS = 4;

export const looksOf = (char: number): Look[] => CHARACTERS[char]?.looks ?? [CLASSIC];
export const lookOf = (char: number, i: number): Look => looksOf(char)[i] ?? looksOf(char)[0];
export const lookCount = (char: number): number => looksOf(char).length;
/** What the select screen says on a locked swatch. */
export const winsToUnlock = (look: Look): string => `${look.wins} wins to unlock`;

// ------------------------------------------------------------------ wins and picks (localStorage)
const WINS_KEY = 'dod-wins';
const PICK_KEY = 'dod-looks';

function readMap(key: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
    const out: Record<string, number> = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v) && (v as number) >= 0) out[k] = v as number;
    return out;
  } catch {
    return {};
  }
}
function writeMap(key: string, map: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Storage blocked: the visit keeps its own session only.
  }
}

export const winsWith = (id: string): number => readMap(WINS_KEY)[id] ?? 0;

export function lookOpen(char: number, i: number): boolean {
  const l = looksOf(char)[i];
  return !!l && winsWith(CHARACTERS[char].id) >= l.wins;
}

/** A win with this fighter (any mode). Returns the names of the looks it just unlocked. */
export function addWin(id: string): string[] {
  const char = CHARACTERS.findIndex((c) => c.id === id);
  if (char < 0) return [];
  const map = readMap(WINS_KEY);
  const before = map[id] ?? 0;
  map[id] = before + 1;
  writeMap(WINS_KEY, map);
  return looksOf(char).filter((l) => l.wins > before && l.wins <= before + 1).map((l) => l.name);
}

/** The colour you last picked for a fighter (kept so it comes back, and so online uses it). Falls back to Classic if locked. */
export function preferredLook(char: number): number {
  const i = readMap(PICK_KEY)[CHARACTERS[char]?.id] ?? 0;
  return i < lookCount(char) && lookOpen(char, i) ? i : 0;
}
export function rememberLook(char: number, i: number): void {
  const map = readMap(PICK_KEY);
  map[CHARACTERS[char].id] = i;
  writeMap(PICK_KEY, map);
}

/** A look index valid for the fighter and open to the player; else Classic. */
export function openLook(char: number, i: number | undefined): number {
  return i !== undefined && Number.isInteger(i) && i >= 0 && i < lookCount(char) && lookOpen(char, i) ? i : 0;
}

/**
 * Two fighters of the same kind may not share a colour: the later slot moves to the next colour (Street Fighter II's rule).
 * `open(slot, i)` says which colours that slot may use; a slot with none free keeps its pick. Returns the slots it moved.
 */
export function separateLooks(slots: { char: number; look?: number }[], open: (slot: number, i: number) => boolean = () => true): number[] {
  const moved: number[] = [];
  slots.forEach((s, i) => {
    const n = lookCount(s.char);
    s.look = Math.min(s.look ?? 0, n - 1);
    const taken = () => slots.slice(0, i).some((o) => o.char === s.char && (o.look ?? 0) === s.look);
    if (!taken()) return;
    const start = s.look ?? 0;
    for (let k = 1; k < n; k++) {
      s.look = (start + k) % n;
      if (open(i, s.look) && !taken()) {
        moved.push(i);
        return;
      }
    }
    s.look = start;
  });
  return moved;
}

// ------------------------------------------------------------------ the palette maths (mirrors render/lookPlugin.ts)
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The weight (0..1) of a pixel in the look's mask, with its hue/saturation/value; null when the look changes nothing. */
function mask(look: Look, h: number, s: number, v: number): number {
  if (look.from === undefined) return 0;
  if (look.from < 0) return (1 - sstep(0.14, 0.24, s)) * sstep(0.2, 0.32, v) * (1 - sstep(0.86, 0.96, v));
  const range = look.range ?? 40;
  let d = Math.abs(h - look.from);
  d = Math.min(d, 360 - d);
  return (1 - sstep(range * 0.6, range, d)) * sstep(0.18, 0.32, s) * sstep(0.12, 0.25, v);
}

function toHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, mx ? d / mx : 0, mx];
}
function fromHsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** One pixel (0..1 channels) through a look. */
export function recolor(r: number, g: number, b: number, look: Look): [number, number, number] {
  if (look.from === undefined) return [r, g, b];
  const [h, s, v] = toHsv(r, g, b);
  const w = mask(look, h, s, v);
  if (w <= 0) return [r, g, b];
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  let nh: number, ns: number;
  if (look.from < 0) {
    nh = look.hue ?? 0;
    ns = s + ((look.sat ?? 0.5) - s) * w;
  } else {
    nh = (h + (look.hue ?? 0) + 720) % 360;
    ns = clamp(s * (look.sat ?? 1));
  }
  const [nr, ng, nb] = fromHsv(nh, ns, clamp(v * (look.val ?? 1)));
  return [r + (nr - r) * w, g + (ng - g) * w, b + (nb - b) * w];
}

/** The uniforms the shader reads: [from, range, hueTurn, mode] and [sat, val]. mode: 0 off, 1 outfit, 2 neutral. */
export function lookUniforms(look: Look): { a: [number, number, number, number]; b: [number, number] } {
  if (look.from === undefined) return { a: [0, 1, 0, 0], b: [1, 1] };
  if (look.from < 0) return { a: [0, 1, (look.hue ?? 0) / 360, 2], b: [look.sat ?? 0.5, look.val ?? 1] };
  return { a: [look.from / 360, (look.range ?? 40) / 360, (look.hue ?? 0) / 360, 1], b: [look.sat ?? 1, look.val ?? 1] };
}

/** A representative swatch colour (CSS) for the look: the fighter's main hue after the look, or a tint for dark ones. */
export function swatchColor(char: number, i: number): string {
  const l = lookOf(char, i);
  if (l.from === undefined) {
    // Classic: the main colour the other looks turn, or a plain grey for the dark fighters.
    const main = looksOf(char).find((o) => o.from !== undefined && o.from >= 0)?.from;
    return main === undefined ? 'hsl(0 0% 46%)' : `hsl(${main} 60% 50%)`;
  }
  if (l.from < 0) return `hsl(${l.hue ?? 0} ${Math.round((l.sat ?? 0.5) * 100)}% ${Math.round(40 * (l.val ?? 1))}%)`;
  return `hsl(${Math.round((l.from + (l.hue ?? 0) + 720) % 360)} ${Math.round(Math.min(1, 0.7 * (l.sat ?? 1)) * 100)}% ${Math.round(50 * (l.val ?? 1))}%)`;
}

/** Repaints an image through a look (VS card, results, select preview): a blob URL, or the same URL for Classic. */
export async function recolorUrl(url: string, look: Look): Promise<string> {
  if (look.from === undefined) return url;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return url;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [r, g, b] = recolor(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, look);
    px[i] = Math.round(r * 255);
    px[i + 1] = Math.round(g * 255);
    px[i + 2] = Math.round(b * 255);
  }
  ctx.putImageData(data, 0, 0);
  return new Promise((done) => canvas.toBlob((b) => done(b ? URL.createObjectURL(b) : url), 'image/png'));
}
