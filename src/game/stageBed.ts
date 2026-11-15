// Per-stage layered sound beds: which theme, which reused ambience/intensity files, and which
// procedural place tone. Intensity fires on last stock or ≥100% (damage in tenths).

import bedsJson from '../../content/stage-beds.json' with { type: 'json' };
import type { BedKind } from './synth.ts';

export type MusicState = 'calm' | 'intense';

export interface StageBedRecipe {
  music: string;
  ambience: string | null;
  ambienceVolume: number;
  intense: string | null;
  intenseVolume: number;
  bed: BedKind;
}

interface StageBedsFile {
  stages: Record<string, {
    music: string;
    ambience?: string | null;
    ambienceVolume?: number;
    intense?: string | null;
    intenseVolume?: number;
    bed: BedKind;
  }>;
  gaps?: string[];
}

const STAGE_BEDS = bedsJson as StageBedsFile;

/** Damage is tenths of a percent in the sim: 100% = 1000. */
export const INTENSE_PERCENT = 1000;

/** Anyone still in on their last stock, or anyone over 100%. */
export function fightersNeedIntense(fighters: ReadonlyArray<{ stocks: number; percent: number }>): boolean {
  return fighters.some((f) => f.stocks > 0 && (f.stocks === 1 || f.percent >= INTENSE_PERCENT));
}

export function stageBedRecipe(stageId: string): StageBedRecipe {
  const raw = STAGE_BEDS.stages[stageId];
  if (!raw) {
    return {
      music: `music-${stageId}`,
      ambience: null,
      ambienceVolume: 0.12,
      intense: null,
      intenseVolume: 0.24,
      bed: 'arena',
    };
  }
  return {
    music: raw.music,
    ambience: raw.ambience ?? null,
    ambienceVolume: raw.ambienceVolume ?? 0.14,
    intense: raw.intense ?? null,
    intenseVolume: raw.intenseVolume ?? 0.24,
    bed: raw.bed,
  };
}

export const stageBedGaps = (): string[] => STAGE_BEDS.gaps ?? [];
