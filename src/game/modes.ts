// Which stages each game mode offers, authored in content/modes.json (the
// devtools Modes tab edits it). An entry can rename a stage for its mode and
// change its rules; a special version of a map is its own stage with
// variantOf. The campaign picks its stages per chapter instead.

import modesJson from '../../content/modes.json' with { type: 'json' };
import { STAGES } from './sim/stage.ts';
import type { Rules } from './sim/state.ts';

export type StageMode = 'versus' | 'training';

/** One stage as a mode offers it. */
export interface ModeStage {
  /** A stage id in content/stages.json. */
  stage: string;
  /** Shown instead of the stage's own name and blurb. */
  name?: string;
  blurb?: string;
  /** Rule changes for this mode, e.g. { hazards: 0 } for a calm version. */
  rules?: Partial<Rules>;
}

export interface ModeDef {
  name: string;
  stages: ModeStage[];
}

export interface ModesFile {
  _about?: string;
  modes: Partial<Record<StageMode, ModeDef>>;
}

export const MODE_IDS: StageMode[] = ['versus', 'training'];

/** A mode's stages, resolved to STAGES indices (unknown ids are skipped). */
export function stagesFor(mode: StageMode, file: ModesFile = modesJson as ModesFile): { index: number; entry: ModeStage }[] {
  const list = file.modes[mode]?.stages;
  // No list for the mode: every stage, as before modes existed.
  if (!list) return STAGES.map((s, index) => ({ index, entry: { stage: s.id } }));
  return list.map((entry) => ({ index: STAGES.findIndex((s) => s.id === entry.stage), entry })).filter((x) => x.index >= 0);
}
