// Fighters: each fighter's art and stats. Replace a cutout (from a file or one
// of the source images in their art folder), rebuild their images, tune their
// physics and power, and playtest the result.

import { fighter, type CharacterDef, type FighterEntry } from '../../game/sim/fighterDefs.ts';
import { h } from '../../game/ui/dom.ts';
import { api, dropTarget, log, pickFile, runTask, store } from '../api.ts';
import { attempt, field, fighterList, numberInput, textInput, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

let root: HTMLElement;
let list: ReturnType<typeof fighterList>;
let main: HTMLElement;
let draft: FighterEntry[] = [];
let dirty = false;
// Bumped after images are rebuilt, so <img> tags fetch the new files.
let bust = Date.now();

const STAT_FIELDS: { key: keyof FighterEntry; label: string; step: number; sub: string }[] = [
  { key: 'w', label: 'Width', step: 1, sub: 'Hurtbox width, world units' },
  { key: 'h', label: 'Height', step: 1, sub: 'Hurtbox height; 110 is average' },
  { key: 'weight', label: 'Weight', step: 1, sub: 'Higher is harder to launch; 100 is average' },
  { key: 'walk', label: 'Walk speed', step: 0.1, sub: 'Units per frame' },
  { key: 'air', label: 'Air speed', step: 0.1, sub: 'Top drift speed' },
  { key: 'gravity', label: 'Gravity', step: 0.01, sub: 'Lower is floatier' },
  { key: 'fall', label: 'Fall speed', step: 0.1, sub: 'Max; fast fall is 1.45x' },
  { key: 'hop', label: 'Jump height', step: 1, sub: 'Full hop, world units' },
  { key: 'jumps', label: 'Air jumps', step: 1, sub: 'Extra jumps in the air' },
  { key: 'frames', label: 'Attack timing', step: 0.01, sub: 'Multiplies every frame; above 1 is slower' },
  { key: 'dmg', label: 'Damage', step: 0.01, sub: 'Multiplier' },
  { key: 'kb', label: 'Knockback', step: 0.01, sub: 'Multiplier' },
  { key: 'reach', label: 'Reach', step: 0.01, sub: 'Hitbox reach multiplier' },
];

const DEFAULTS: Partial<Record<keyof FighterEntry, number>> = { frames: 1, dmg: 1, kb: 1, reach: 1 };

const CUT_MODES = {
  birefnet: 'BiRefNet: clean edges, solid dark clothing. The default.',
  union: 'Both models combined: keeps smoke, tendrils and other wisps that fade into the backdrop.',
  isnet: 'ISNet alone: softer; can let some backdrop through.',
} as const;

function defs(): CharacterDef[] {
  return draft.map((f) => fighter(f.id, f.name, f.role, f.blurb, f));
}

// The same comparisons the game's select screen draws.
const STATS: { label: string; of: (c: CharacterDef) => number }[] = [
  { label: 'Speed', of: (c) => c.walkSpeed },
  { label: 'Power', of: (c) => c.tuning.damage * c.tuning.knockback },
  { label: 'Weight', of: (c) => c.weight },
  { label: 'Air', of: (c) => c.airSpeed / 1000 + c.airJumps * 0.8 },
  { label: 'Reach', of: (c) => c.tuning.reach * (0.8 + c.height / 550) },
];

function statBars(id: string): HTMLElement {
  const all = defs();
  const me = all.find((c) => c.id === id);
  if (!me) return h('div');
  return h(
    'div',
    { class: 'bars' },
    ...STATS.map((s) => {
      const vals = all.map(s.of);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const k = hi > lo ? (s.of(me) - lo) / (hi - lo) : 0.5;
      const rank = [...vals].sort((a, b) => b - a).indexOf(s.of(me)) + 1;
      return h('div', {}, h('span', {}, s.label), h('i', {}, h('b', { style: `width:${Math.round(8 + k * 92)}%` })), h('span', {}, `#${rank}`));
    }),
  );
}

function syncDraft(force = false): void {
  if (force || !dirty) {
    draft = structuredClone(store.fighters);
    dirty = false;
  }
}

function markDirty(): void {
  dirty = true;
  const save = root.querySelector<HTMLButtonElement>('[data-save]');
  if (save) save.disabled = false;
  const bars = root.querySelector('[data-bars]');
  if (bars) bars.replaceChildren(statBars(store.selected));
  const derived = root.querySelector('[data-derived]');
  const f = draft.find((x) => x.id === store.selected);
  if (derived && f) derived.textContent = describe(f);
}

/** Plain-language numbers for a spec: how long a jump lasts, how high it goes. */
function describe(f: FighterEntry): string {
  const v = Math.sqrt(2 * f.gravity * f.hop);
  const airtime = Math.round((2 * v) / f.gravity);
  const short = Math.round(f.hop * 0.42);
  return `Full hop ${Math.round(f.hop)} units, about ${airtime} frames in the air. Short hop ${short} units. ${f.jumps} air jump${f.jumps === 1 ? '' : 's'}.`;
}

async function save(): Promise<void> {
  await attempt(async () => {
    await api.save('fighters', draft);
    dirty = false;
    await store.refresh();
  }, 'Fighters saved. Open game tabs reload.');
}

async function replaceArt(id: string, file: Blob, name: string, key: boolean): Promise<void> {
  log(`Replacing ${id}'s cutout with ${name}${key ? ' (keying out black backdrop)' : ''}`);
  const ok = await attempt(() => api.upload(`/art/upload?fighter=${id}&name=${encodeURIComponent(name)}&key=${key ? 'black' : 'none'}`, file));
  if (!ok) return;
  await runTask('fighter-images', { fighter: id }, `rebuild ${id} images`);
  bust = Date.now();
  render();
}

function artCard(id: string): HTMLElement {
  const st = store.fighterState(id);
  const drop = h('div', { class: 'dropzone' }, 'Drop a PNG, JPG or WebP here to replace the cutout');
  dropTarget(drop, (file) => replaceArt(id, file, file.name, false));
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Art', h('span', { class: 'spacer' }), st?.art.large ? null : h('span', { class: 'badge warn' }, 'images not built')),
    h(
      'div',
      { class: 'art-row' },
      h('div', { class: 'art-big checker' }, h('img', { src: `/characters/large/${id}.webp?v=${bust}`, alt: 'Large image' })),
      h(
        'div',
        { class: 'art-side' },
        h('div', { class: 'art-small checker' }, h('img', { src: `/characters/img/${id}.png?v=${st?.art.img ?? 0}`, alt: 'Cutout' })),
        h('span', { class: 'art-caption' }, 'Cutout: characters/img/', h('code', {}, `${id}.png`)),
        h('div', { class: 'art-small checker' }, h('img', { src: `/characters/thumb/${id}.webp?v=${bust}`, alt: 'Thumbnail' })),
        h('span', { class: 'art-caption' }, 'Thumbnail and large image are made from the cutout.'),
      ),
    ),
    drop,
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: 'btn', onclick: async () => {
          const file = await pickFile('image/png,image/jpeg,image/webp');
          if (file) await replaceArt(id, file, file.name, false);
        },
      }, 'Replace cutout…'),
      h('button', {
        type: 'button', class: 'btn', onclick: async () => {
          await runTask('fighter-images', { fighter: id }, `rebuild ${id} images`);
          bust = Date.now();
          render();
        },
      }, 'Rebuild images'),
      h('button', { type: 'button', class: 'btn', onclick: () => runTask('lineup', {}, 'rebuild home lineup and all images') }, 'Rebuild home lineup'),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'label' }, 'Recut with AI'),
      ...(['birefnet', 'union', 'isnet'] as const).map((mode) =>
        h('button', {
          type: 'button', class: 'btn small', title: CUT_MODES[mode],
          onclick: async () => {
            if ((await runTask('cutout', { fighter: id, mode }, `AI cutout ${id} (${mode})`)) !== 0) return;
            await runTask('fighter-images', { fighter: id }, `rebuild ${id} images`);
            bust = Date.now();
            render();
          },
        }, mode === 'birefnet' ? 'BiRefNet' : mode === 'union' ? 'Both combined' : 'ISNet'),
      ),
    ),
    h('p', { class: 'hint' }, 'Recut cuts the fighter out of the source image named in content/art-sources.json with a segmentation model, so dark clothing on a dark backdrop survives. BiRefNet is cleanest; Both combined keeps wisps (smoke, tendrils) that fade into the backdrop.'),
    h('p', { class: 'hint' }, 'The old cutout is backed up to _backup/art/ before it is replaced. A new fighter also needs a spot in ROWS in _build_lineup.py before the home lineup rebuilds.'),
  );
}

function sourcesCard(id: string): HTMLElement {
  const st = store.fighterState(id);
  const sources = st?.sources ?? [];
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Source art', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, st?.folder ? `${store.state?.artRoot}\\${st.folder}` : 'no folder')),
    sources.length
      ? h(
          'div',
          { class: 'sources' },
          ...sources.map((s) =>
            h(
              'div',
              { class: 'source' },
              h('a', { href: api.sourceUrl(id, s.file, s.mtime), target: '_blank', rel: 'noopener' }, h('img', { src: api.sourceUrl(id, s.file, s.mtime), alt: s.file, loading: 'lazy' })),
              h('span', { title: s.file }, s.file.length > 22 ? `${s.file.slice(0, 20)}…` : s.file),
              h('button', {
                type: 'button', class: 'btn small', title: 'Cut the fighter out of this image with AI and make it the cutout',
                onclick: async () => {
                  if ((await runTask('cutout', { fighter: id, file: s.file }, `AI cutout ${id} from ${s.file}`)) !== 0) return;
                  await runTask('fighter-images', { fighter: id }, `rebuild ${id} images`);
                  bust = Date.now();
                  render();
                },
              }, 'Use as cutout'),
            ),
          ),
        )
      : h('p', { class: 'hint' }, 'No images in this fighter’s art folder yet.'),
  );
}

function statsCard(f: FighterEntry): HTMLElement {
  const set = <K extends keyof FighterEntry>(k: K, v: FighterEntry[K]) => {
    f[k] = v;
    markDirty();
  };
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Identity'),
    h(
      'div',
      { class: 'form' },
      field('Name', textInput(f.name, (v) => set('name', v))),
      field('Role', textInput(f.role, (v) => set('role', v)), { sub: 'One or two words on the select screen' }),
      field('Blurb', textInput(f.blurb, (v) => set('blurb', v)), { wide: true }),
    ),
    h('h3', {}, 'Stats'),
    h(
      'div',
      { class: 'form' },
      ...STAT_FIELDS.map((s) =>
        field(
          s.label,
          numberInput((f[s.key] as number | undefined) ?? DEFAULTS[s.key] ?? null, (v) => {
            if (v === null || Number.isNaN(v)) return;
            (f as unknown as Record<string, number>)[s.key] = v;
            markDirty();
          }, { step: s.step, min: 0 }),
          { sub: s.sub },
        ),
      ),
    ),
    h('p', { class: 'hint', 'data-derived': '' }, describe(f)),
    h('h3', {}, 'Against the roster'),
    h('div', { 'data-bars': '' }, statBars(f.id)),
  );
}

function newFighter(): void {
  const name = prompt('Name of the new fighter?');
  if (!name) return;
  const id = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id || draft.some((f) => f.id === id)) {
    toast(`A fighter with id ${id || '(empty)'} already exists.`, 'error');
    return;
  }
  draft.push({ id, name, role: 'All-rounder', blurb: '', w: 46, h: 110, weight: 95, walk: 6.5, air: 5.5, gravity: 0.62, fall: 11, hop: 150, jumps: 1 });
  draft.sort((a, b) => a.id.localeCompare(b.id));
  markDirty();
  store.select(id);
  toast(`Added ${name}. Save, then give them a cutout.`);
}

function playtest(id: string, vs: string): void {
  window.open(`/Game/?play&fighter=${id}&vs=${vs}&stage=foundry&level=5`, 'dod-playtest');
}

function render(): void {
  list.render();
  const f = draft.find((x) => x.id === store.selected);
  if (!f) {
    main.replaceChildren(h('p', { class: 'muted' }, 'Pick a fighter.'));
    return;
  }
  const saveBtn = h('button', { type: 'button', class: 'btn primary', 'data-save': '', disabled: !dirty, onclick: save }, 'Save fighters');
  main.replaceChildren(
    h(
      'header',
      {},
      h('h2', {}, f.name),
      h('span', { class: 'muted' }, f.id),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => playtest(f.id, 'dummy') }, 'Playtest vs dummy'),
      h('button', { type: 'button', class: 'btn', onclick: () => playtest(f.id, 'break') }, 'Playtest vs CPU'),
      h('button', { type: 'button', class: 'btn', onclick: newFighter }, 'New fighter'),
      h('button', { type: 'button', class: 'btn', onclick: () => { syncDraft(true); render(); } }, 'Revert'),
      saveBtn,
    ),
    h('div', { class: 'cards' }, artCard(f.id), statsCard(f), sourcesCard(f.id)),
  );
}

export const fightersTab: Tab = {
  mount(el) {
    root = el;
    el.classList.add('with-list');
    list = fighterList((id) => {
      const n = Object.keys(store.fighterState(id)?.manifest?.clips ?? {}).length;
      return n ? h('span', { class: 'badge ok' }, `${n} clips`) : null;
    });
    main = h('div', { class: 'main' });
    el.append(list.el, main);
    syncDraft(true);
    store.on(() => {
      syncDraft();
      if (!el.hidden) render();
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirty) e.preventDefault();
    });
  },
  show() {
    syncDraft();
    render();
  },
};
