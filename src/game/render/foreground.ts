// Foreground elements (crowd heads, cables, kelp, a bush at the lip of the stage): pictures in front of the fighters at the
// play area's edges. When a fighter stands behind one of its solid pixels the element fades to 30% so the fighter stays
// readable, and it comes back when they walk out. The test is a ray from the camera through the fighter's body onto the
// layer's plane, read against the picture's own alpha, so it follows the real parallax (the camera moves the element
// across the fighter, not only the fighter across the stage). Pure maths; the renderer feeds it. Render only.

/** What a foreground element turns to while a fighter is behind it. */
export const FADE_TO = 0.3;
/** Fade speed, per second (about 0.2 s end to end). */
export const FADE_RATE = 7;

/** A picture's alpha, shrunk to a small grid (0..255 per cell). */
export interface AlphaMask {
  w: number;
  h: number;
  a: Uint8Array;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A layer plane in the scene: centre, size, and the depth it sits at (all scene units). */
export interface Plane {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/** Builds a mask from RGBA pixels (as from getImageData), sampling a grid no wider than maxW. */
export function maskFromRGBA(rgba: ArrayLike<number>, width: number, height: number, maxW = 96): AlphaMask {
  const step = Math.max(1, Math.ceil(width / maxW));
  const w = Math.max(1, Math.floor(width / step));
  const h = Math.max(1, Math.floor(height / step));
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The strongest alpha in the cell, so a thin leaf or cable still counts.
      let m = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const v = rgba[(((y * step + dy) * width) + (x * step + dx)) * 4 + 3];
          if (v > m) m = v;
        }
      }
      a[y * w + x] = m;
    }
  }
  return { w, h, a };
}

/** Where the ray from the camera through a point meets the plane z = planeZ, or null when it never does. */
export function rayToPlane(cam: Vec3, p: Vec3, planeZ: number): { x: number; y: number } | null {
  const dz = p.z - cam.z;
  if (Math.abs(dz) < 1e-6) return null;
  const t = (planeZ - cam.z) / dz;
  if (t <= 0) return null;
  return { x: cam.x + (p.x - cam.x) * t, y: cam.y + (p.y - cam.y) * t };
}

/** Is the picture solid (alpha over the threshold) at the plane point (x, y)? The plane is untilted. */
export function solidAt(mask: AlphaMask, plane: Plane, x: number, y: number, threshold = 90): boolean {
  if (plane.w <= 0 || plane.h <= 0) return false;
  const u = (x - plane.x) / plane.w + 0.5;
  const v = 0.5 - (y - plane.y) / plane.h;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  return mask.a[Math.floor(v * mask.h) * mask.w + Math.floor(u * mask.w)] >= threshold;
}

/** Is any of the points (a fighter's body, in scene units) seen through a solid pixel of this foreground element? */
export function behindForeground(mask: AlphaMask, plane: Plane, cam: Vec3, points: Vec3[]): boolean {
  for (const p of points) {
    // A point nearer the camera than the element is in front of it, not behind.
    if (p.z <= plane.z) continue;
    const hit = rayToPlane(cam, p, plane.z);
    if (hit && solidAt(mask, plane, hit.x, hit.y)) return true;
  }
  return false;
}

/** Eases the element's opacity toward 1 (clear) or FADE_TO (a fighter behind), whatever the frame rate. */
export function fadeToward(current: number, behind: boolean, dt: number): number {
  const target = behind ? FADE_TO : 1;
  const k = 1 - Math.exp(-FADE_RATE * Math.max(0, dt));
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 0.005 ? target : next;
}

/** The points on a fighter that count as "behind" (scene units): head, chest, hips and both sides of the chest. */
export function bodyPoints(x: number, footY: number, height: number, halfWidth: number, z = 0): Vec3[] {
  return [
    { x, y: footY + height * 0.9, z },
    { x, y: footY + height * 0.6, z },
    { x, y: footY + height * 0.25, z },
    { x: x - halfWidth, y: footY + height * 0.55, z },
    { x: x + halfWidth, y: footY + height * 0.55, z },
  ];
}
