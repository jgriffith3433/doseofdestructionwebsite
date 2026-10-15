// Sounds: the catalog in content/sounds.json. Each entry is one sound the
// game plays by id. Write a description, generate it with ElevenLabs (or
// upload your own file), set its level, and hear it in place.

import type { SoundEntry } from '../../game/audio.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api, dropTarget, log, pickFile, store } from '../api.ts';
import { batchRunning, runBatch } from '../batch.ts';
import { attempt, checkbox, field, numberInput, preview, select, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

const AUDIO_ACCEPT = 'audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a';
const GROUPS = ['combat', 'movement', 'ui', 'music', 'other'];

// Ids the game plays today (see main.ts, ui/screens.ts and ui/views.ts).
const USED = new Set([
  'hit-light', 'hit-medium', 'hit-heavy', 'hit-shield', 'shield-break', 'swing-light', 'swing-heavy', 'ko',
  'jump', 'land', 'ledge', 'dodge', 'respawn', 'ui-move', 'ui-select', 'ui-back', 'wipe', 'vs-slam',
  'music-menu', 'music-results',
]);
/** Each stage plays music-<its id>; filled in from content/stages.json when the tab mounts. */
const stageIds = new Set<string>();
const used = (id: string) => USED.has(id) || (id.startsWith('music-') && stageIds.has(id.slice(6)));

let root: HTMLElement;
let sounds: SoundEntry[] = [];
let selected = '';
let dirty = false;
let filter = '';
let status: 'all' | 'missing' | 'stale' = 'all';
let generating = false;
/** Saves run one after another so a batch never writes an older catalog over a newer one. */
let saving: Promise<unknown> = Promise.resolve();
const saveSoon = () => (saving = saving.then(() => save(true)));

function state(s: SoundEntry): 'missing' | 'stale' | 'ok' | 'manual' {
  if (!s.file) return 'missing';
  if (!s.take) return 'manual';
  const t = s.take;
  return t.text === s.text && t.loop === s.loop && (t.duration ?? null) === (s.duration ?? null) && t.influence === s.influence ? 'ok' : 'stale';
}

const STATE_LABEL = { missing: ['bad', 'no file'], stale: ['warn', 'out of date'], ok: ['ok', 'current'], manual: ['ok', 'uploaded'] } as const;

async function save(quiet = false): Promise<boolean> {
  const ok = await attempt(() => api.save('sounds', sounds), quiet ? undefined : 'Sounds saved.');
  if (ok) {
    dirty = false;
    renderBar();
  }
  return !!ok;
}

function markDirty(): void {
  dirty = true;
  renderBar();
}

/** Generates one sound and saves the catalog. Throws on failure. */
async function generateOne(s: SoundEntry): Promise<void> {
  log(`Generating sound ${s.id}: ${s.text}`);
  const out = await api.post<{ file: string; take: SoundEntry['take'] }>('/sfx/generate', { id: s.id, text: s.text, loop: s.loop, duration: s.duration, influence: s.influence });
  s.file = out.file;
  s.take = out.take;
  log(`  saved ${out.file}`, 'ok');
  await saveSoon();
}

async function generate(s: SoundEntry): Promise<boolean> {
  return (await attempt(() => generateOne(s).then(() => true))) ?? false;
}

async function upload(s: SoundEntry, file: File): Promise<void> {
  const out = await attempt(() => api.upload<{ file: string }>(`/audio/upload?kind=sfx&id=${s.id}&name=${encodeURIComponent(file.name)}`, file));
  if (!out) return;
  s.file = out.file;
  // An uploaded file was not generated from the description.
  s.take = null;
  await save(true);
  toast(`${file.name} is now ${s.id}.`);
  render();
}

/** Generates every sound in the given states, a few at a time, riding out throttling. */
async function generateBatch(which: ('missing' | 'stale')[]): Promise<void> {
  const want = sounds.filter((s) => (which as string[]).includes(state(s)));
  const todo = want.filter((s) => s.text.trim());
  const blank = want.length - todo.length;
  if (!todo.length) {
    toast(blank ? `${blank} sound${blank > 1 ? 's need' : ' needs'} a description first.` : 'Nothing to generate.', blank ? 'error' : 'ok');
    return;
  }
  const what = which.length === 2 ? 'missing and out-of-date' : which[0] === 'missing' ? 'missing' : 'out-of-date';
  if (!confirm(`Generate ${todo.length} ${what} sound${todo.length > 1 ? 's' : ''} with ElevenLabs? Each one uses credits.${blank ? `

Skipping ${blank} with no description.` : ''}`)) return;
  generating = true;
  render();
  await runBatch({ label: `Sounds (${what})`, items: todo, name: (s) => s.id, run: generateOne, progress: render });
  generating = false;
  render();
}

function renderBar(): void {
  const bar = root.querySelector('[data-bar]');
  if (!bar) return;
  const counts = { missing: 0, stale: 0 };
  for (const s of sounds) {
    const st = state(s);
    if (st === 'missing') counts.missing++;
    if (st === 'stale') counts.stale++;
  }
  const key = store.state?.elevenLabs;
  bar.replaceChildren(...kids(
    h('h2', {}, 'Sounds'),
    h('span', { class: 'muted' }, `${sounds.length} sounds · ${counts.missing} without a file · ${counts.stale} out of date`),
    h('span', { class: 'spacer' }),
    !key && h('span', { class: 'pill warn' }, 'Add ELEVENLABS_API_KEY to .env to generate'),
    h('button', { type: 'button', class: 'btn', disabled: !key || generating || batchRunning() || !counts.missing, onclick: () => generateBatch(['missing']) }, generating ? 'Generating…' : `Generate missing (${counts.missing})`),
    counts.stale > 0 && h('button', { type: 'button', class: 'btn', disabled: !key || generating || batchRunning(), onclick: () => generateBatch(['stale']) }, `Regenerate out of date (${counts.stale})`),
    h('button', { type: 'button', class: 'btn', onclick: addSound }, 'Add sound'),
    h('button', { type: 'button', class: 'btn primary', disabled: !dirty, onclick: () => save() }, dirty ? 'Save sounds' : 'Saved'),
  ));
}

function addSound(): void {
  const id = prompt('Id for the new sound (lowercase, dashes)?', 'my-sound')?.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  if (!id) return;
  if (sounds.some((s) => s.id === id)) {
    toast(`${id} already exists.`, 'error');
    return;
  }
  sounds.push({ id, group: 'other', text: '', loop: false, duration: null, influence: 0.55, volume: 0.8, file: null, take: null });
  selected = id;
  markDirty();
  render();
}

function editorFor(s: SoundEntry): HTMLElement {
  const key = store.state?.elevenLabs;
  const update = () => {
    markDirty();
    const row = root.querySelector(`[data-row="${s.id}"]`);
    if (row) row.replaceWith(rowFor(s));
  };
  const text = h('textarea', {}, s.text);
  text.addEventListener('input', () => {
    s.text = text.value;
    update();
  });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s.volume });
  const volOut = h('span', { class: 'muted' }, s.volume.toFixed(2));
  vol.addEventListener('input', () => {
    s.volume = Number(vol.value);
    volOut.textContent = s.volume.toFixed(2);
    update();
  });
  const infl = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.influence });
  const inflOut = h('span', { class: 'muted' }, s.influence.toFixed(2));
  infl.addEventListener('input', () => {
    s.influence = Number(infl.value);
    inflOut.textContent = s.influence.toFixed(2);
    update();
  });
  const card = h(
    'section',
    { class: 'card sticky' },
    h('h3', {}, s.id, h('span', { class: 'spacer' }), used(s.id) ? h('span', { class: 'badge ok' }, 'played by the game') : h('span', { class: 'badge' }, 'not used yet')),
    h(
      'div',
      { class: 'form' },
      field('Group', select(GROUPS, GROUPS.includes(s.group) ? s.group : 'other', (v) => { s.group = v; update(); })),
      field('Duration (s)', numberInput(s.duration, (v) => { s.duration = v; update(); }, { step: 0.1, min: 0.5, max: 30, placeholder: 'Auto' }), { sub: 'Blank lets the model choose' }),
      field('Description', text, { wide: true, sub: 'One sound: what it is, what it’s made of, and one-shot or seamless loop.' }),
      field('Prompt influence', h('div', { class: 'row' }, infl, inflOut), { sub: 'Higher follows the description more tightly' }),
      field('Volume', h('div', { class: 'row' }, vol, volOut), { sub: 'How loud the game plays it' }),
      h('div', { class: 'field' }, h('label', {}, 'Loop'), checkbox('Seamless loop (music, ambience)', s.loop, (v) => { s.loop = v; update(); })),
    ),
    h('p', { class: 'hint mono' }, s.file ?? 'No file yet.'),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn', disabled: !s.file, onclick: () => preview(s.file, s.volume) }, '▶ Play'),
      h('button', { type: 'button', class: 'btn primary', disabled: !key || generating, onclick: async () => {
        if (await generate(s)) {
          render();
          preview(s.file, s.volume);
        }
      } }, s.file ? 'Regenerate' : 'Generate'),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        const f = await pickFile(AUDIO_ACCEPT);
        if (f) await upload(s, f);
      } }, 'Upload file…'),
      h('span', { class: 'spacer' }),
      s.file && h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!confirm(`Delete the file for ${s.id}?`)) return;
        await attempt(() => api.post('/audio/delete', { file: s.file }));
        s.file = null;
        s.take = null;
        await save(true);
        render();
      } }, 'Delete file'),
      !used(s.id) && h('button', { type: 'button', class: 'btn danger', onclick: () => {
        sounds = sounds.filter((x) => x !== s);
        selected = '';
        markDirty();
        render();
      } }, 'Remove sound'),
    ),
    h('p', { class: 'hint' }, 'Drop an audio file on this panel to use it for this sound.'),
  );
  dropTarget(card, (f) => upload(s, f));
  return card;
}

function rowFor(s: SoundEntry): HTMLElement {
  const st = state(s);
  const [cls, label] = STATE_LABEL[st];
  return h(
    'tr',
    { 'data-row': s.id, class: s.id === selected ? 'selected' : '', onclick: () => { selected = s.id; render(); } },
    h('td', {}, h('button', { type: 'button', class: 'btn small icon', disabled: !s.file, title: 'Play', onclick: (e: Event) => { e.stopPropagation(); preview(s.file, s.volume); } }, '▶')),
    h('td', { class: 'mono' }, s.id),
    h('td', {}, h('span', { class: `badge ${cls}` }, label)),
    h('td', { class: 'text' }, s.text || '(no description)'),
    h('td', { class: 'muted' }, s.loop ? 'loop' : ''),
  );
}

function render(): void {
  const q = filter.toLowerCase();
  const shown = sounds.filter((s) => (!q || s.id.includes(q) || s.text.toLowerCase().includes(q)) && (status === 'all' || state(s) === status));
  const rows: HTMLElement[] = [];
  for (const g of GROUPS) {
    const inGroup = shown.filter((s) => (GROUPS.includes(s.group) ? s.group : 'other') === g);
    if (!inGroup.length) continue;
    rows.push(h('tr', { class: 'group-row' }, h('td', { colspan: 5 }, g)));
    rows.push(...inGroup.map(rowFor));
  }
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search id or description', value: filter });
  search.addEventListener('input', () => {
    filter = search.value;
    const pos = search.selectionStart;
    render();
    const again = root.querySelector<HTMLInputElement>('input.search');
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  const current = sounds.find((s) => s.id === selected);
  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h('header', { 'data-bar': '' }),
      h('p', { class: 'hint' }, 'Every sound the game plays by id. Generated sounds remember their description; when you change it, the sound shows as out of date until you regenerate it. Sounds without a file are silent in the game.'),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          {},
          h('div', { class: 'row', style: 'margin-bottom:8px' }, search, select<typeof status>([['all', 'All'], ['missing', 'No file'], ['stale', 'Out of date']], status, (v) => { status = v; render(); })),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Id'), h('th', {}, 'Status'), h('th', {}, 'Description'), h('th', {}, ''))), h('tbody', {}, ...rows))),
        ),
        current ? editorFor(current) : h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Pick a sound to edit it.')),
      ),
    ),
  );
  renderBar();
}

export const soundsTab: Tab = {
  async mount(el) {
    root = el;
    el.style.display = 'block';
    sounds = (await attempt(() => api.content<SoundEntry[]>('sounds'))) ?? [];
    for (const st of (await attempt(() => api.content<{ id: string }[]>('stages'))) ?? []) stageIds.add(st.id);
    selected = sounds[0]?.id ?? '';
    render();
    store.on(() => {
      if (!root.hidden) renderBar();
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirty) e.preventDefault();
    });
  },
};
