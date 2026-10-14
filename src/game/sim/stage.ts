// The stages. They are authored in content/stages.json (the Maps tab in
// devtools.html edits it). Every number there must be an integer: the sim
// reads them as is.

import stagesJson from '../../../content/stages.json' with { type: 'json' };
import type { StageDef } from './stageMath.ts';

export * from './stageMath.ts';

export const STAGES: StageDef[] = stagesJson as StageDef[];

export function stageIndex(id: string): number {
  const i = STAGES.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}
