// The roster. Fighters are authored in content/fighters.json (the Fighters
// tab in devtools.html edits it); fighterDefs.ts turns each entry into the
// static data the sim reads by index. None of it is per-frame state.

import fightersJson from '../../../content/fighters.json' with { type: 'json' };
import archetypesJson from '../../../content/archetypes.json' with { type: 'json' };
import { fighter, ARCHETYPES, type Archetype, type CharacterDef, type FighterEntry } from './fighterDefs.ts';

export * from './fighterDefs.ts';

export const FIGHTERS: FighterEntry[] = fightersJson as FighterEntry[];
/** content/archetypes.json: the normals archetype of each fighter (a fighter's own `archetype` in fighters.json overrides it). */
export const ARCHETYPE_OF: Record<string, Archetype> = (archetypesJson as { fighters: Record<string, Archetype> }).fighters;
for (const [id, a] of Object.entries(ARCHETYPE_OF)) if (!ARCHETYPES.includes(a)) throw new Error(`content/archetypes.json: ${id} has unknown archetype "${a}"`);
export const CHARACTERS: CharacterDef[] = FIGHTERS.map((f) => fighter(f.id, f.name, f.role, f.blurb, { ...f, archetype: f.archetype ?? ARCHETYPE_OF[f.id] }));

export function characterIndex(id: string): number {
  const i = CHARACTERS.findIndex((c) => c.id === id);
  return i < 0 ? 0 : i;
}
