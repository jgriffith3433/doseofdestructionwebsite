/**
 * Colour vision (Settings → Colour vision): Standard keeps the orange, blue, yellow, green player colours;
 * Colourblind-safe swaps them for an Okabe-Ito based set that deuteranopes and protanopes can separate. In both
 * modes each player also has a shape (circle, triangle, square, diamond) on their ring, name tag and HUD card, so
 * colour is never the only cue. Saved in localStorage "dod.colourvision" ("standard" | "safe").
 *
 * PLAYER_COLORS and TEAM_COLORS are the live arrays every screen reads: setColourVision rewrites them in place.
 */

export type ColourVision = 'standard' | 'safe';
export type PlayerShape = 'circle' | 'triangle' | 'square' | 'diamond';

export const PALETTES: Record<ColourVision, { players: string[]; teams: string[] }> = {
  standard: { players: ['#ff5a1f', '#3fa7ff', '#ffd15a', '#5ce08a'], teams: ['#ff5a1f', '#3fa7ff'] },
  // Okabe-Ito: vermilion, sky blue, yellow, reddish purple.
  safe: { players: ['#d55e00', '#56b4e9', '#f0e442', '#cc79a7'], teams: ['#d55e00', '#56b4e9'] },
};

export const SHAPES: PlayerShape[] = ['circle', 'triangle', 'square', 'diamond'];
export const SHAPE_GLYPH: Record<PlayerShape, string> = { circle: '●', triangle: '▲', square: '■', diamond: '◆' };

export const shapeOf = (slot: number): PlayerShape => SHAPES[((slot % 4) + 4) % 4];

export const PLAYER_COLORS: string[] = [...PALETTES.standard.players];
export const TEAM_COLORS: string[] = [...PALETTES.standard.teams];

const KEY = 'dod.colourvision';

const read = (): ColourVision => {
  try {
    return localStorage.getItem(KEY) === 'safe' ? 'safe' : 'standard';
  } catch {
    return 'standard';
  }
};

let current: ColourVision = read();
const apply = () => {
  PLAYER_COLORS.splice(0, 4, ...PALETTES[current].players);
  TEAM_COLORS.splice(0, 2, ...PALETTES[current].teams);
};
apply();

const listeners = new Set<(mode: ColourVision) => void>();

export const colourVision = (): ColourVision => current;

export const setColourVision = (mode: ColourVision): void => {
  current = mode;
  apply();
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const l of listeners) l(mode);
};

export const onColourVision = (l: (mode: ColourVision) => void): (() => boolean) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
