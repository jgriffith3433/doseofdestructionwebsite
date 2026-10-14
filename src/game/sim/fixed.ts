// Integer-only math for the simulation. Every value the sim stores is an integer,
// so two browsers given the same inputs always reach the same state.
// Positions and velocities are in world units * FX.

export const FX = 1000;

// sin(d) * 4096 for d = 0..90, baked so no engine's Math.sin is ever consulted.
const SIN_Q = [
  0, 71, 143, 214, 286, 357, 428, 499, 570, 641, 711, 782, 852, 921, 991, 1060, 1129, 1198, 1266, 1334,
  1401, 1468, 1534, 1600, 1666, 1731, 1796, 1860, 1923, 1986, 2048, 2110, 2171, 2231, 2290, 2349, 2408,
  2465, 2522, 2578, 2633, 2687, 2741, 2793, 2845, 2896, 2946, 2996, 3044, 3091, 3138, 3183, 3228, 3271,
  3314, 3355, 3396, 3435, 3474, 3511, 3547, 3582, 3617, 3650, 3681, 3712, 3742, 3770, 3798, 3824, 3849,
  3873, 3896, 3917, 3937, 3956, 3974, 3991, 4006, 4021, 4034, 4046, 4056, 4065, 4074, 4080, 4086, 4090,
  4094, 4095, 4096,
];
export const TRIG_ONE = 4096;

export function normDeg(d: number): number {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

/** sin of an integer degree angle, scaled by TRIG_ONE. */
export function isin(deg: number): number {
  const d = normDeg(deg);
  if (d <= 90) return SIN_Q[d];
  if (d <= 180) return SIN_Q[180 - d];
  if (d <= 270) return -SIN_Q[d - 180];
  return -SIN_Q[360 - d];
}

export function icos(deg: number): number {
  return isin(deg + 90);
}

/** Integer division that truncates toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Move v toward target by at most step. */
export function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}

/** Integer square root (floor). */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  // Correct any rounding in either direction so the result never depends on the engine.
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** Integer angle in degrees (0..359) of the vector (x, y), y up. */
export function iatan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  // Binary search on the baked table keeps this engine independent.
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  // Find d in 0..90 where tan(d) is closest to ay/ax: compare ay*cos(d) with ax*sin(d).
  let lo = 0;
  let hi = 90;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ay * SIN_Q[90 - mid] > ax * SIN_Q[mid]) lo = mid + 1;
    else hi = mid;
  }
  const d = lo;
  if (x >= 0 && y >= 0) return d;
  if (x < 0 && y >= 0) return 180 - d;
  if (x < 0) return 180 + d;
  return normDeg(360 - d);
}

/** Small deterministic PRNG (mulberry32), kept as a single integer of state. */
export function rngNext(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [t, (r ^ (r >>> 14)) >>> 0];
}
