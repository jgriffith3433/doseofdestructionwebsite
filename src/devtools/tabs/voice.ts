// Voice: every spoken line in one place. Announcer calls, fighter names, KO
// yells and victory lines live in content/voice.json; campaign dialogue lives
// in content/campaign.json and is edited here too. Pick a voice per speaker,
// then generate takes with ElevenLabs or upload recordings.

import type { VoiceCatalog, VoiceLine } from '../../game/audio.ts';
import type { ChapterEntry, Line } from '../../game/campaign/story.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api, dropTarget, log, pickFile, store, thumb } from '../api.ts';
import { attempt, field, preview, select, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

const AUDIO_ACCEPT = 'audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a';
const MODELS = ['eleven_v4', 'eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'];

interface Item {
  key: string;
  group: string;
  who: string;
  /** Where the line sits in the campaign, for display. */
  where?: string;
  line: VoiceLine | Line;
  source: 'voice' | 'campaign';
}

interface ApiVoice {
  id: string;
  name: string;
  category: string;
  preview: string;
}

let root: HTMLElement;
let catalog: VoiceCatalog = { voices: {}, lines: [] };
let campaign: ChapterEntry[] = [];
let voices: ApiVoice[] = [];
let selected = '';
let dirtyVoice = false;
let dirtyCampaign = false;
let filter = '';
let group = 'all';
let status: 'all' | 'missing' | 'stale' = 'all';
let busy = false;
/** The model is part of the cast, saved in content/voice.json. */
const model = () => catalog.model ?? 'eleven_v4';

function items(): Item[] {
  const out: Item[] = catalog.lines.map((l) => ({ key: l.id, group: l.group, who: l.who, line: l, source: 'voice' }));
  campaign.forEach((c, ci) => {
    for (const part of ['intro', 'outro'] as const) {
      c[part].forEach((l, i) => {
        out.push({
          key: `campaign.${c.id}.${part}.${i}`,
          group: 'campaign',
          who: l.who,
          where: `Ch ${ci + 1} ${c.title}, ${part === 'intro' ? 'before' : 'after'} the fight, line ${i + 1}`,
          line: l,
          source: 'campaign',
        });
      });
    }
  });
  return out;
}

function speakerName(who: string): string {
  if (who === 'announcer') return 'Announcer';
  if (who === 'narrator') return 'Narrator';
  return store.fighters.find((f) => f.id === who)?.name ?? who;
}

function stateOf(it: Item): 'missing' | 'stale' | 'ok' | 'manual' {
  const l = it.line;
  if (!l.audio) return 'missing';
  if (!l.take) return 'manual';
  return l.take.text === l.text.trim() && l.take.voice === (catalog.voices[it.who] ?? '') ? 'ok' : 'stale';
}

const STATE_LABEL = { missing: ['bad', 'no take'], stale: ['warn', 'out of date'], ok: ['ok', 'current'], manual: ['ok', 'uploaded'] } as const;

function markDirty(which: 'voice' | 'campaign'): void {
  if (which === 'voice') dirtyVoice = true;
  else dirtyCampaign = true;
  renderBar();
}

async function save(quiet = false): Promise<boolean> {
  const ok = await attempt(async () => {
    if (dirtyVoice) await api.save('voice', catalog);
    if (dirtyCampaign) await api.save('campaign', campaign);
    return true;
  }, quiet ? undefined : 'Voice lines saved.');
  if (ok) {
    dirtyVoice = false;
    dirtyCampaign = false;
    renderBar();
  }
  return !!ok;
}

function fileId(it: Item): string {
  // Campaign lines move when dialogue is edited, so their takes get a fresh name each time.
  return it.source === 'voice' ? it.key : `${it.key.replace(/\.(\d+)$/, '')}-${Date.now().toString(36)}`;
}

async function generate(it: Item): Promise<boolean> {
  const voice = catalog.voices[it.who];
  if (!voice) {
    toast(`Pick a voice for ${speakerName(it.who)} first.`, 'error');
    return false;
  }
  log(`Voicing ${it.key} as ${speakerName(it.who)}: ${it.line.text}`);
  const old = it.line.audio;
  const out = await attempt(() => api.post<{ file: string; take: { text: string; voice: string } }>('/voice/generate', { id: fileId(it), text: it.line.text, voice, model: model() }));
  if (!out) return false;
  it.line.audio = out.file;
  it.line.take = out.take;
  if (old && old !== out.file) await api.post('/audio/delete', { file: old }).catch(() => undefined);
  markDirty(it.source);
  await save(true);
  log(`  saved ${out.file}`, 'ok');
  return true;
}

async function upload(it: Item, file: File): Promise<void> {
  const old = it.line.audio;
  const out = await attempt(() => api.upload<{ file: string }>(`/audio/upload?kind=voice&id=${encodeURIComponent(fileId(it))}&name=${encodeURIComponent(file.name)}`, file));
  if (!out) return;
  if (old && old !== out.file) await api.post('/audio/delete', { file: old }).catch(() => undefined);
  it.line.audio = out.file;
  it.line.take = null;
  markDirty(it.source);
  await save(true);
  render();
}

async function generateAll(list: Item[]): Promise<void> {
  const todo = list.filter((it) => {
    const st = stateOf(it);
    return (st === 'missing' || st === 'stale') && catalog.voices[it.who];
  });
  const noVoice = new Set(list.filter((it) => !catalog.voices[it.who]).map((it) => speakerName(it.who)));
  if (!todo.length) {
    toast(noVoice.size ? `Pick voices first: ${[...noVoice].slice(0, 4).join(', ')}${noVoice.size > 4 ? '…' : ''}` : 'Every shown line is current.', noVoice.size ? 'error' : 'ok');
    return;
  }
  if (!confirm(`Generate ${todo.length} line${todo.length > 1 ? 's' : ''} with ElevenLabs? Each uses credits.${noVoice.size ? `\n\nSkipping speakers with no voice: ${[...noVoice].join(', ')}` : ''}`)) return;
  busy = true;
  render();
  for (const it of todo) if (!(await generate(it))) break;
  busy = false;
  render();
}

async function loadVoices(): Promise<void> {
  const out = await attempt(() => api.get<{ voices: ApiVoice[] }>('/voice/voices'));
  if (out) {
    voices = out.voices;
    toast(`${voices.length} voices on your ElevenLabs account.`);
    render();
  }
}

// ------------------------------------------------------------------ render

function renderBar(): void {
  const bar = root.querySelector('[data-bar]');
  if (!bar) return;
  const all = items();
  const missing = all.filter((it) => stateOf(it) === 'missing').length;
  const stale = all.filter((it) => stateOf(it) === 'stale').length;
  const key = store.state?.elevenLabs;
  bar.replaceChildren(...kids(
    h('h2', {}, 'Voice'),
    h('span', { class: 'muted' }, `${all.length} lines · ${missing} without a take · ${stale} out of date`),
    h('span', { class: 'spacer' }),
    !key && h('span', { class: 'pill warn' }, 'Add ELEVENLABS_API_KEY to .env to generate'),
    select(MODELS.includes(model()) ? MODELS : [model(), ...MODELS], model(), (v) => {
      catalog.model = v;
      markDirty('voice');
    }),
    h('button', { type: 'button', class: 'btn primary', disabled: !(dirtyVoice || dirtyCampaign), onclick: () => save() }, dirtyVoice || dirtyCampaign ? 'Save' : 'Saved'),
  ));
}

function voicesCard(): HTMLElement {
  const speakers = [...new Set(['announcer', 'narrator', ...items().map((it) => it.who)])];
  const key = store.state?.elevenLabs;
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Voices', h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', disabled: !key, onclick: loadVoices }, voices.length ? 'Reload voices' : 'Load voices from ElevenLabs')),
    h('p', { class: 'hint' }, 'Each speaker speaks every one of their lines in this voice. Changing a voice marks that speaker’s takes out of date.'),
    h(
      'div',
      { class: 'voice-grid' },
      ...speakers.map((who) => {
        const current = catalog.voices[who] ?? '';
        let input: HTMLElement;
        if (voices.length) {
          const opts: [string, string][] = [['', '(none)'], ...voices.map((v): [string, string] => [v.id, `${v.name}${v.category ? ` · ${v.category}` : ''}`])];
          if (current && !voices.some((v) => v.id === current)) opts.push([current, current]);
          input = select(opts.map((o) => o) as [string, string][], current, (v) => {
            catalog.voices[who] = v;
            markDirty('voice');
            render();
          });
        } else {
          const t = h('input', { type: 'text', value: current, placeholder: 'voice id', class: 'input' });
          t.addEventListener('change', () => {
            catalog.voices[who] = t.value.trim();
            markDirty('voice');
            render();
          });
          input = t;
        }
        const sample = voices.find((v) => v.id === current)?.preview;
        const cast = catalog.cast?.[who];
        return h(
          'div',
          { class: 'voice-row' },
          who === 'announcer' || who === 'narrator' ? h('span', { class: 'badge' }, '🎙') : h('img', { src: thumb(who), alt: '' }),
          h(
            'div',
            { class: 'field' },
            h('label', {}, speakerName(who)),
            h('div', { class: 'row' }, input, sample ? h('button', { type: 'button', class: 'btn small icon', title: 'Voice sample', onclick: () => preview(sample) }, '▶') : null),
            cast && h('span', { class: 'sub', title: cast.why }, `${cast.voice} · ${cast.about}`),
          ),
        );
      }),
    ),
  );
}

function editorFor(it: Item): HTMLElement {
  const key = store.state?.elevenLabs;
  const text = h('textarea', {}, it.line.text);
  text.addEventListener('input', () => {
    it.line.text = text.value;
    markDirty(it.source);
    const row = root.querySelector(`[data-row="${CSS.escape(it.key)}"]`);
    if (row) row.replaceWith(rowFor(it));
  });
  const card = h(
    'section',
    { class: 'card sticky' },
    h('h3', {}, speakerName(it.who), h('span', { class: 'spacer' }), h('span', { class: 'muted mono' }, it.key)),
    it.where && h('p', { class: 'hint' }, it.where),
    field('Line', text, { wide: true, sub: it.source === 'campaign' ? 'Edits the campaign dialogue itself.' : 'What the game plays for this id.' }),
    h('p', { class: 'hint mono' }, it.line.audio ?? 'No take yet.'),
    !catalog.voices[it.who] && h('p', { class: 'hint warn' }, `${speakerName(it.who)} has no voice yet. Pick one above.`),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn', disabled: !it.line.audio, onclick: () => preview(it.line.audio) }, '▶ Play'),
      h('button', { type: 'button', class: 'btn primary', disabled: !key || busy || !catalog.voices[it.who], onclick: async () => {
        if (await generate(it)) {
          render();
          preview(it.line.audio);
        }
      } }, it.line.audio ? 'Regenerate' : 'Generate'),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        const f = await pickFile(AUDIO_ACCEPT);
        if (f) await upload(it, f);
      } }, 'Upload recording…'),
      h('span', { class: 'spacer' }),
      it.line.audio && h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!confirm('Delete this take?')) return;
        await attempt(() => api.post('/audio/delete', { file: it.line.audio }));
        it.line.audio = null as never;
        it.line.take = null as never;
        markDirty(it.source);
        await save(true);
        render();
      } }, 'Delete take'),
    ),
    h('p', { class: 'hint' }, 'Drop a recording on this panel to use it for this line.'),
  );
  dropTarget(card, (f) => upload(it, f));
  return card;
}

function rowFor(it: Item): HTMLElement {
  const [cls, label] = STATE_LABEL[stateOf(it)];
  return h(
    'tr',
    { 'data-row': it.key, class: it.key === selected ? 'selected' : '', onclick: () => { selected = it.key; render(); } },
    h('td', {}, h('button', { type: 'button', class: 'btn small icon', disabled: !it.line.audio, onclick: (e: Event) => { e.stopPropagation(); preview(it.line.audio); } }, '▶')),
    h('td', {}, speakerName(it.who)),
    h('td', {}, h('span', { class: `badge ${cls}` }, label)),
    h('td', { class: 'text' }, it.line.text),
  );
}

function render(): void {
  const all = items();
  const q = filter.toLowerCase();
  const shown = all.filter(
    (it) =>
      (group === 'all' || it.group === group) &&
      (status === 'all' || stateOf(it) === status) &&
      (!q || it.line.text.toLowerCase().includes(q) || it.key.includes(q) || speakerName(it.who).toLowerCase().includes(q)),
  );
  const groups = ['all', ...new Set(all.map((it) => it.group))];
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search lines or speakers', value: filter });
  search.addEventListener('input', () => {
    filter = search.value;
    const pos = search.selectionStart;
    render();
    const again = root.querySelector<HTMLInputElement>('input.search');
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  const current = all.find((it) => it.key === selected);
  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h('header', { 'data-bar': '' }),
      voicesCard(),
      h('div', { style: 'height:14px' }),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'row', style: 'margin-bottom:8px' },
            search,
            select(groups.map((g): [string, string] => [g, g === 'all' ? 'All groups' : g]), group, (v) => { group = v; render(); }),
            select<typeof status>([['all', 'Any status'], ['missing', 'No take'], ['stale', 'Out of date']], status, (v) => { status = v; render(); }),
            h('button', { type: 'button', class: 'btn', disabled: !store.state?.elevenLabs || busy, onclick: () => generateAll(shown) }, busy ? 'Generating…' : `Generate shown (${shown.length})`),
          ),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Speaker'), h('th', {}, 'Status'), h('th', {}, 'Line'))),
            h('tbody', {}, ...shown.slice(0, 400).map(rowFor)))),
        ),
        current ? editorFor(current) : h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Pick a line to edit or voice it.')),
      ),
    ),
  );
  renderBar();
}

export const voiceTab: Tab = {
  async mount(el) {
    root = el;
    el.style.display = 'block';
    const [v, c] = await Promise.all([attempt(() => api.content<VoiceCatalog>('voice')), attempt(() => api.content<ChapterEntry[]>('campaign'))]);
    catalog = v ?? catalog;
    campaign = c ?? [];
    selected = items()[0]?.key ?? '';
    render();
    store.on(() => {
      if (!root.hidden) renderBar();
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirtyVoice || dirtyCampaign) e.preventDefault();
    });
  },
};
