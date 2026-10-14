// Stage geometry in world units. y is up; the main stage's top surface is y = 0.

export interface Platform {
  x1: number;
  x2: number;
  y: number;
  /** Solid platforms have sides and a bottom; pass-through ones only a top. */
  solid: boolean;
}

export interface StageDef {
  name: string;
  platforms: Platform[];
  /** Depth of the main (solid) block below its top surface. */
  depth: number;
  blast: { left: number; right: number; top: number; bottom: number };
  spawns: { x: number; y: number }[];
  respawn: { x: number; y: number };
}

export const STAGE: StageDef = {
  name: 'Foundry',
  platforms: [
    { x1: -560, x2: 560, y: 0, solid: true },
    { x1: -390, x2: -160, y: 130, solid: false },
    { x1: 160, x2: 390, y: 130, solid: false },
    { x1: -115, x2: 115, y: 260, solid: false },
  ],
  depth: 90,
  blast: { left: -1400, right: 1400, top: 1150, bottom: -750 },
  spawns: [
    { x: -300, y: 0 },
    { x: 300, y: 0 },
    { x: -110, y: 0 },
    { x: 110, y: 0 },
  ],
  respawn: { x: 0, y: 420 },
};
