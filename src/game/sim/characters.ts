// The roster. Fighters are authored in content/fighters.json (the Fighters
// tab in devtools.html edits it); fighterDefs.ts turns each entry into the
// static data the sim reads by index. None of it is per-frame state.

import fightersJson from '../../../content/fighters.json' with { type: 'json' };
import { fighter, type CharacterDef, type FighterEntry } from './fighterDefs.ts';

export * from './fighterDefs.ts';

export const FIGHTERS: FighterEntry[] = fightersJson as FighterEntry[];
export const CHARACTERS: CharacterDef[] = FIGHTERS.map((f) => fighter(f.id, f.name, f.role, f.blurb, f));

export function characterIndex(id: string): number {
  const i = CHARACTERS.findIndex((c) => c.id === id);
  return i < 0 ? 0 : i;
}
