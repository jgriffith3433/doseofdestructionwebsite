// Modes: where every stage is used. Each game mode (Versus, Training) offers
// a list of stages, in menu order, saved in content/modes.json; the campaign
// picks a stage per chapter (the Story tab). Tick a stage into a mode, order
// it, give it a mode-only name or rules (a calm version with hazards off), or
// make a special version of the map (a variant: its own stage, edited in Maps).

import type { StageDef } from '../../game/sim/stageMath.ts';
import type { ChapterEntry } from '../../game/campaign/story.ts';
import { MODE_IDS, type ModeStage, type ModesFile, type StageMode } from '../../game/modes.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api } from '../api.ts';
import { attempt, checkbox, field, numberInput, textInput } from '../ui.ts';
import type { Tab } from '../main.ts';

let root: HTMLElement;
let stages: StageDef[] = [];
let campaign: ChapterEntry[] = [];
let modes: ModesFile = { modes: {} };
let dirty = false;
let open: { mode: StageMode; index: number } | null = null;

const MODE_HELP: Record<StageMode, string> = {
  versus: 'Local matches against friends and CPUs.',
  training: 'Practice against a dummy or a CPU.',
};

function mode(id: StageMode) {
  return (modes.modes[id] ??= { name: id[0].toUpperCase() + id.slice(1), stages: [] });
}

function changed(): void {
  dirty = true;
  render();
}

/** A change that doesn't need the page redrawn (typing). */
function touched(): void {
  dirty = true;
  const b = root.querySelector<HTMLButtonElement>('[data-save]');
  if (b) b.disabled = false;
}

async function load(): Promise<void> {
  const [s, c, m] = await Promise.all([
    api.content<StageDef[]>('stages'),
    api.content<ChapterEntry[]>('campaign'),
    api.content<ModesFile>('modes').catch(() => null),
  ]);
  stages = s;
  campaign = c;
  // Never saved yet: every mode offers every stage, as the game did before modes.
  modes = m ?? { modes: Object.fromEntries(MODE_IDS.map((id) => [id, { name: id[0].toUpperCase() + id.slice(1), stages: s.map((x) => ({ stage: x.id })) }])) };
  dirty = false;
}

async function save(): Promise<void> {
  // Drop entries for stages that no longer exist, and empty overrides.
  for (const id of MODE_IDS) {
    const m = mode(id);
    m.stages = m.stages.filter((e) => stages.some((s) => s.id === e.stage)).map((e) => {
      const q: ModeStage = { stage: e.stage };
      if (e.name?.trim()) q.name = e.name.trim();
      if (e.blurb?.trim()) q.blurb = e.blurb.trim();
      const rules = Object.fromEntries(Object.entries(e.rules ?? {}).filter(([, v]) => v !== undefined && v !== null));
      if (Object.keys(rules).length) q.rules = rules;
      return q;
    });
  }
  if (await attempt(() => api.save('modes', modes), 'Modes saved. Open game tabs reload.')) {
    dirty = false;
    render();
  }
}

/** Chapters that fight on a stage. */
function chaptersOn(id: string): { n: number; title: string }[] {
  return campaign.map((c, i) => ({ n: i + 1, title: c.title, stage: c.fight.stage })).filter((c) => c.stage === id);
}

/** Opens a stage in the Maps tab (variant: makes a special version of it there first). */
function toMaps(id: string, variant = false): void {
  try {
    sessionStorage.setItem('dod-maps-open', JSON.stringify({ stage: id, variant }));
  } catch {
    // Without storage the Maps tab just opens.
  }
  location.hash = '#maps';
}

function toggle(id: StageMode, stage: string, on: boolean): void {
  const m = mode(id);
  if (on && !m.stages.some((e) => e.stage === stage)) m.stages.push({ stage });
  if (!on) m.stages = m.stages.filter((e) => e.stage !== stage);
  changed();
}

function matrix(): HTMLElement {
  // Base stages, each followed by its variants.
  const bases = stages.filter((s) => !s.variantOf || !stages.some((b) => b.id === s.variantOf));
  const rows = bases.flatMap((b) => [b, ...stages.filter((v) => v.variantOf === b.id)]);
  return h('section', { class: 'card' },
    h('h3', {}, 'Where each stage is used'),
    h('p', { class: 'hint' }, 'Tick a stage into a mode to offer it on that mode’s stage select. The story picks its stages per chapter (Story tab). A variant is a special version of a map: its own stage, edited in Maps.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table modes-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), ...MODE_IDS.map((id) => h('th', {}, mode(id).name)), h('th', {}, 'Story'), h('th', {}, ''))),
      h('tbody', {}, ...rows.map((s) => {
        const ch = chaptersOn(s.id);
        const used = ch.length || MODE_IDS.some((id) => mode(id).stages.some((e) => e.stage === s.id));
        return h('tr', {},
          h('td', {}, h('div', { class: s.variantOf ? 'variant' : '' },
            h('strong', {}, s.variantOf ? `↳ ${s.name}` : s.name), ' ', h('span', { class: 'muted mono' }, s.id),
            s.variantOf ? h('span', { class: 'badge' }, `variant of ${s.variantOf}`) : null,
            !used ? h('span', { class: 'badge warn', title: 'Players can’t reach this stage yet' }, 'not used') : null,
            (s.events?.length || s.hazards?.length) ? h('span', { class: 'badge', title: 'Has stage events or hazards' }, 'dynamic') : null)),
          ...MODE_IDS.map((id) => h('td', {}, checkbox('', mode(id).stages.some((e) => e.stage === s.id), (v) => toggle(id, s.id, v)))),
          h('td', {}, ch.length ? ch.map((c) => `Ch ${c.n} ${c.title}`).join(', ') : h('span', { class: 'muted' }, '—')),
          h('td', {}, h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn small', onclick: () => toMaps(s.id) }, 'Edit map'),
            h('button', { type: 'button', class: 'btn small', title: 'A special version of this map (its own stage, a copy to change), made in the Maps tab', onclick: () => toMaps(s.id, true) }, 'Make variant'))));
      })))),
  );
}

function modeCard(id: StageMode): HTMLElement {
  const m = mode(id);
  const entry = (e: ModeStage, i: number) => {
    const st = stages.find((s) => s.id === e.stage);
    const isOpen = open?.mode === id && open.index === i;
    const rules = (e.rules ??= {});
    const move = (by: number) => {
      const j = i + by;
      if (j < 0 || j >= m.stages.length) return;
      [m.stages[i], m.stages[j]] = [m.stages[j], m.stages[i]];
      if (isOpen) open = { mode: id, index: j };
      changed();
    };
    const tweaks = [rules.hazards === 0 && 'hazards off', rules.gravity !== undefined && `gravity ${rules.gravity}%`, rules.damage !== undefined && `damage ${rules.damage}%`, e.name && `as “${e.name}”`].filter(Boolean);
    return h('div', { class: 'effect-row' },
      h('div', { class: 'row' },
        h('span', { class: 'muted mono' }, String(i + 1)),
        h('button', { type: 'button', class: 'link', onclick: () => { open = isOpen ? null : { mode: id, index: i }; render(); } }, e.name || st?.name || e.stage),
        !st ? h('span', { class: 'badge bad' }, 'missing stage') : null,
        ...tweaks.map((t) => h('span', { class: 'badge' }, t as string)),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn small', onclick: () => move(-1) }, '▲'),
        h('button', { type: 'button', class: 'btn small', onclick: () => move(1) }, '▼'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { m.stages.splice(i, 1); open = null; changed(); } }, '×')),
      isOpen ? h('div', { class: 'form' },
        field('Name here', textInput(e.name ?? '', (v) => { e.name = v || undefined; touched(); }, { placeholder: st?.name ?? '' })),
        field('Blurb here', textInput(e.blurb ?? '', (v) => { e.blurb = v || undefined; touched(); }, { placeholder: st?.blurb ?? '' }), { wide: true }),
        field('Stage events', checkbox('On', rules.hazards !== 0, (v) => { rules.hazards = v ? undefined : 0; changed(); }), { sub: 'Off: no events, damage zones or hazards' }),
        field('Gravity (%)', numberInput(rules.gravity ?? null, (v) => { rules.gravity = v ?? undefined; touched(); }, { min: 10, max: 300, placeholder: 100 })),
        field('Damage (%)', numberInput(rules.damage ?? null, (v) => { rules.damage = v ?? undefined; touched(); }, { min: 10, max: 300, placeholder: 100 })),
      ) : null);
  };
  const missing = stages.filter((s) => !m.stages.some((e) => e.stage === s.id));
  const add = h('select', {}, h('option', { value: '' }, 'Add a stage…'), ...missing.map((s) => h('option', { value: s.id }, s.name)));
  add.addEventListener('change', () => { if (add.value) toggle(id, add.value, true); });
  return h('section', { class: 'card' },
    h('h3', {}, `${m.name}`, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${m.stages.length} stage${m.stages.length === 1 ? '' : 's'}`)),
    h('p', { class: 'hint' }, `${MODE_HELP[id]} The stage select shows these in this order, plus Random. Click one to rename it or change its rules for this mode only.`),
    m.stages.length ? h('div', {}, ...m.stages.map(entry)) : h('p', { class: 'hint warn' }, 'No stages: this mode’s stage select would be empty.'),
    h('div', { class: 'row' }, add),
  );
}

function render(): void {
  root.replaceChildren(...kids(
    h('div', { class: 'modes-page' },
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0' }, 'Modes and maps'),
        h('span', { class: 'spacer' }),
        dirty ? h('span', { class: 'pill warn' }, 'Unsaved changes') : null,
        h('button', { type: 'button', class: 'btn', onclick: async () => { if (dirty && !confirm('Throw away unsaved changes?')) return; await attempt(load); render(); } }, 'Revert'),
        h('button', { type: 'button', class: 'btn primary', 'data-save': '', disabled: !dirty, onclick: save }, 'Save modes')),
      matrix(),
      h('div', { class: 'modes-grid' }, ...MODE_IDS.map(modeCard)),
    ),
  ));
}

export const modesTab: Tab = {
  async mount(el) {
    root = el;
    el.style.display = 'block';
    el.style.overflow = 'auto';
    await attempt(load);
    render();
    window.addEventListener('beforeunload', (e) => {
      if (dirty) e.preventDefault();
    });
  },
  async show() {
    // Stages and chapters may have changed in the other tabs.
    if (!root || dirty) return;
    await attempt(load);
    render();
  },
};
