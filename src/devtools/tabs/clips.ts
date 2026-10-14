// Clips: every animation video in the fighter art folders, in one list, the
// way Sounds lists every effect. Drop MP4s into
// <art root>\<Fighter>\anims\<clip>.mp4, rescan, and process what is waiting.
// A clip shows "out of date" when its video or its options changed after it
// was built.

import { h, kids } from '../../game/ui/dom.ts';
import { api, isBusy, onBusy, runTask, store } from '../api.ts';
import { attempt, numberInput, select, toast } from '../ui.ts';
import { clipEditorPanel, clipStatus, type ClipStatus } from './animations.ts';
import { defaultMethod, gpu, gpuSnapshot, ready, refreshGpu, watchGpu, type GpuState, type JobSpec } from '../gpu.ts';
import type { Tab } from '../main.ts';

interface Row {
  fighter: string;
  name: string;
  clip: string;
  /** The video's file name, or null for a built clip whose video is gone. */
  file: string | null;
  status: ClipStatus | 'unknown';
  frames: number;
  mtime: number;
}

const STATUS_LABEL: Record<Row['status'], [string, string]> = {
  waiting: ['warn', 'waiting'],
  stale: ['warn', 'out of date'],
  ok: ['ok', 'current'],
  empty: ['', 'no video'],
  unknown: ['bad', 'unknown name'],
};

let root: HTMLElement;
let filterFighter = 'all';
let filterStatus: 'all' | 'todo' | 'ok' | 'unknown' = 'all';
let query = '';
let selected = '';
let stopEditor: (() => void) | null = null;
let batch = false;
let gen: { fighter: string; which: string; method: 'auto' | 'animate' | 'i2v'; takes: number | null; use: 'auto' | 'pick' | 'replace' } = { fighter: '', which: 'missing', method: 'auto', takes: null, use: 'auto' };
/** Each fighter's "Make clips by" choice from AI Settings. */
let methods: Record<string, string | undefined> = {};
async function loadMethods(): Promise<void> {
  const g = await api.content<{ fighters?: Record<string, { method?: string }> }>('generation').catch(() => ({ fighters: {} }));
  methods = Object.fromEntries(Object.entries(g.fighters ?? {}).map(([id, f]) => [id, (f as { method?: string }).method]));
}
let gpuState: GpuState | null = null;

function allClips(): Set<string> {
  const c = store.clips;
  return new Set(c ? [...c.loops, ...c.once, ...c.moves] : []);
}

function rows(): Row[] {
  const known = allClips();
  const out: Row[] = [];
  for (const st of store.state?.fighters ?? []) {
    const name = store.fighters.find((f) => f.id === st.id)?.name ?? st.id;
    const seen = new Set<string>();
    for (const [clip, src] of Object.entries(st.clipSources)) {
      seen.add(clip);
      out.push({
        fighter: st.id, name, clip, file: src.file.replace(/^anims\//, ''),
        status: known.has(clip) ? clipStatus(st, clip) : 'unknown',
        frames: st.manifest?.clips[clip]?.frames ?? 0, mtime: src.mtime,
      });
    }
    for (const [clip, built] of Object.entries(st.manifest?.clips ?? {})) {
      if (!seen.has(clip)) out.push({ fighter: st.id, name, clip, file: null, status: 'ok', frames: built.frames, mtime: 0 });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.clip.localeCompare(b.clip));
}

const todo = (r: Row) => r.status === 'waiting' || r.status === 'stale';
const key = (r: Row) => `${r.fighter}/${r.clip}`;

async function processRows(list: Row[]): Promise<void> {
  if (!list.length) {
    toast('Nothing waiting to process.');
    return;
  }
  batch = true;
  render();
  let done = 0;
  for (const r of list) {
    const code = await runTask('anims', { fighter: r.fighter, clip: r.clip }, `process ${r.fighter} ${r.clip} (${++done}/${list.length})`);
    if (code !== 0) {
      toast(`Stopped: ${r.fighter} ${r.clip} failed. See the console.`, 'error');
      break;
    }
  }
  batch = false;
  await store.refresh();
}

async function rename(r: Row, to: string): Promise<void> {
  if (!r.file) return;
  const ok = await attempt(() => api.post('/anim/rename', { fighter: r.fighter, from: r.file, to }), `Renamed to ${to}.`);
  if (ok) {
    selected = `${r.fighter}/${to}`;
    await store.refresh();
  }
}

/** The jobs a Generate request turns into. */
function plan(): JobSpec[] {
  const c = store.clips;
  const st = store.fighterState(gen.fighter);
  if (!c || !st) return [];
  const all = [...c.loops, ...c.once, ...c.moves];
  const names = gen.which === 'missing' ? all.filter((n) => !st.clipSources[n] && !st.manifest?.clips[n]) : gen.which === 'all' ? all : [gen.which];
  const motions = gpuState?.motions ?? [];
  return names.map((clip) => {
    const type = gen.method === 'auto' ? defaultMethod(gen.fighter, clip, motions, methods[gen.fighter]) : gen.method;
    return { type, fighter: gen.fighter, clip, takes: gen.takes ?? undefined, use: gen.use };
  });
}

function generatePanel(): HTMLElement {
  if (!gen.fighter) gen.fighter = store.selected || store.fighters[0]?.id || '';
  const c = store.clips;
  const jobs = plan();
  const server = gpuState?.server;
  const live = ready(server);
  const motions = new Set((gpuState?.motions ?? []).map((m) => m.clip));
  const withoutMotion = jobs.filter((j) => j.type === 'animate' && !motions.has(j.clip!)).length;
  const fromMotion = jobs.filter((j) => j.type === 'animate').length;
  const side = store.fighterState(gen.fighter)?.sides?.some((s) => s.chosen);
  const queued = gpuState?.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length ?? 0;
  return h(
    'section',
    { class: 'card', style: 'margin-bottom:14px' },
    h('h3', {}, 'Generate with AI', h('span', { class: 'spacer' }),
      h('span', { class: `badge ${live ? 'ok' : 'warn'}` }, live ? 'GPU ready' : server?.exists ? `GPU ${server.state}${server.boot?.stage && server.state === 'running' ? `: ${server.boot.stage}` : ''}` : 'no GPU server'),
      queued ? h('span', { class: 'badge warn' }, `${queued} in the queue`) : null),
    h('div', { class: 'row' },
      select(store.fighters.map((f): [string, string] => [f.id, f.name]), gen.fighter, (v) => { gen.fighter = v; render(); }),
      select([['missing', 'Every missing clip'], ['all', 'Every clip (replaces)'], ...(c ? [...c.loops, ...c.once, ...c.moves].map((n): [string, string] => [n, c.labels[n] ?? n]) : [])] as [string, string][], gen.which, (v) => { gen.which = v; render(); }),
      select<typeof gen.method>([['auto', methods[gen.fighter] ? `This fighter’s choice (${methods[gen.fighter] === 'i2v' ? 'prompt' : 'motion library'})` : 'Auto: motion library for people, prompt for creatures'], ['animate', 'Copy the motion library'], ['i2v', 'From a prompt']], gen.method, (v) => { gen.method = v; render(); }),
      numberInput(gen.takes, (v) => (gen.takes = v), { min: 1, max: 8, placeholder: 'takes', title: 'Takes per clip (blank: AI Settings)', style: 'width:64px' }),
      select<typeof gen.use>([['auto', 'Use each if the clip is empty'], ['pick', 'Let me pick takes'], ['replace', 'Replace existing clips']], gen.use, (v) => { gen.use = v; }),
      h('button', {
        type: 'button', class: 'btn primary', disabled: !jobs.length || withoutMotion > 0,
        onclick: async () => {
          const out = await attempt(() => gpu.queue(jobs));
          if (out) {
            toast(`Queued ${jobs.length} job${jobs.length > 1 ? 's' : ''}.${live ? '' : ' They run once the GPU server is ready.'}`);
            await refreshGpu();
          }
        },
      }, `Queue ${jobs.length} clip${jobs.length === 1 ? '' : 's'}`),
    ),
    h('p', { class: 'hint' + (withoutMotion ? ' warn' : '') },
      withoutMotion
        ? `${withoutMotion} of these would copy the motion library, which has no video for them yet. Pick "From a prompt", or add those clips to the library first.`
        : `${jobs.length - fromMotion} from a prompt, ${fromMotion} copying the motion library. ${side ? 'Uses the chosen side view.' : 'No side view chosen for this fighter yet: the front art is used, which animates side-on less well. Generate side views in the Fighters tab.'}`),
    !live && h('p', { class: 'hint' }, 'Jobs wait in the queue until the GPU server is running and set up (GPU tab).'),
  );
}

function rowEl(r: Row): HTMLElement {
  const [cls, label] = STATUS_LABEL[r.status];
  const tr = h(
    'tr',
    { class: key(r) === selected ? 'selected' : '', onclick: () => { selected = key(r); render(); } },
    h('td', {}, h('img', { src: `/characters/thumb/${r.fighter}.webp`, alt: '', style: 'width:26px;height:26px;object-fit:contain' })),
    h('td', {}, r.name),
    h('td', { class: 'mono' }, r.clip),
    h('td', {}, h('span', { class: `badge ${cls}` }, label)),
    h('td', { class: 'text mono' }, r.file ?? '(video removed)'),
    h('td', { class: 'muted' }, r.frames ? `${r.frames}f` : ''),
    h('td', {}, todo(r)
      ? h('button', { type: 'button', class: 'btn small', disabled: isBusy(), onclick: (e: Event) => { e.stopPropagation(); void processRows([r]); } }, 'Process')
      : null),
  );
  return tr;
}

function detail(r: Row | undefined): HTMLElement {
  stopEditor?.();
  stopEditor = null;
  if (!r) return h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Pick a clip to preview, trim and process it.'));
  if (r.status === 'unknown') {
    const known = [...allClips()].sort();
    let to = known[0];
    return h(
      'section',
      { class: 'card' },
      h('h3', {}, `${r.name} · ${r.file}`),
      h('p', { class: 'hint' }, `The game only plays clips with known names, so this video is skipped. Rename it to the clip it shows.`),
      h('video', { src: api.sourceUrl(r.fighter, `anims/${r.file}`, r.mtime), controls: true, loop: true, muted: true, style: 'width:100%;max-height:320px;background:#000;border-radius:8px' }),
      h('div', { class: 'row' }, select(known.map((k): [string, string] => [k, `${store.clips?.labels[k] ?? k} (${k})`]), to, (v) => (to = v)),
        h('button', { type: 'button', class: 'btn primary', onclick: () => rename(r, to) }, 'Rename')),
    );
  }
  const panel = clipEditorPanel(r.fighter, r.clip, () => {
    selected = '';
    render();
  });
  stopEditor = panel.stop;
  return panel.el;
}

function render(): void {
  const all = rows();
  const q = query.toLowerCase();
  const shown = all.filter(
    (r) =>
      (filterFighter === 'all' || r.fighter === filterFighter) &&
      (filterStatus === 'all' || (filterStatus === 'todo' ? todo(r) : r.status === filterStatus)) &&
      (!q || r.name.toLowerCase().includes(q) || r.clip.includes(q) || (r.file ?? '').toLowerCase().includes(q)),
  );
  const waiting = all.filter(todo);
  const unknown = all.filter((r) => r.status === 'unknown').length;
  const busy = isBusy() || batch;
  const fighters = [...new Map(all.map((r) => [r.fighter, r.name])).entries()];
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search fighter, clip or file', value: query });
  search.addEventListener('input', () => {
    query = search.value;
    const pos = search.selectionStart;
    render();
    const again = root.querySelector<HTMLInputElement>('input.search');
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  const current = all.find((r) => key(r) === selected);
  const folders = store.state?.fighters.filter((f) => f.folder).length ?? 0;

  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h(
        'header',
        {},
        ...kids(
          h('h2', {}, 'Clips'),
          h('span', { class: 'muted' }, `${all.length} clips across ${new Set(all.map((r) => r.fighter)).size} fighters · ${waiting.length} to process${unknown ? ` · ${unknown} with unknown names` : ''}`),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => store.refresh().then(() => toast('Folders rescanned.')) }, 'Rescan folders'),
          h('button', { type: 'button', class: 'btn primary', disabled: busy || !waiting.length, onclick: () => processRows(waiting) }, batch ? 'Processing…' : `Process all waiting (${waiting.length})`),
        ),
      ),
      generatePanel(),
      h('p', { class: 'hint' }, 'Put each animation in ', h('code', {}, `${store.state?.artRoot}\\<Fighter>\\anims\\<clip>.mp4`),
        ` (${folders} fighter folders found). Each anims folder has a reference image and a CLIPS.txt checklist. Processing keys out the background, lines the frames up on the feet and builds the sheet the game plays. Edit a clip to trim it or tune the keying, then Save & rebuild.`),
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
            select([['all', 'All fighters'], ...fighters] as [string, string][], filterFighter, (v) => { filterFighter = v; render(); }),
            select<typeof filterStatus>([['all', 'Any status'], ['todo', 'To process'], ['ok', 'Current'], ['unknown', 'Unknown name']], filterStatus, (v) => { filterStatus = v; render(); }),
            filterFighter !== 'all' && h('button', {
              type: 'button', class: 'btn', disabled: busy || !shown.some(todo), onclick: () => processRows(shown.filter(todo)),
            }, `Process shown (${shown.filter(todo).length})`),
          ),
          shown.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Fighter'), h('th', {}, 'Clip'), h('th', {}, 'Status'), h('th', {}, 'Video'), h('th', {}, 'Frames'), h('th', {}, ''))),
                h('tbody', {}, ...shown.map(rowEl))))
            : h('section', { class: 'card' }, h('p', { class: 'hint' }, all.length ? 'Nothing matches the filters.' : 'No animation videos yet. Drop MP4s into the anims folders, then Rescan.')),
        ),
        detail(current),
      ),
    ),
  );
}

export const clipsTab: Tab = {
  mount(el) {
    root = el;
    el.style.display = 'block';
    gpuState = gpuSnapshot();
    watchGpu((s) => {
      const changed = JSON.stringify([s.server.state, s.server.boot?.stage, s.motions.length, s.jobs.length]) !== JSON.stringify([gpuState?.server.state, gpuState?.server.boot?.stage, gpuState?.motions.length, gpuState?.jobs.length]);
      gpuState = s;
      // Don't redraw (and reset an open clip editor) for every poll.
      if (changed && !root.hidden && !selected) render();
    });
    onBusy(() => {
      if (!root.hidden && !batch) render();
    });
    store.on(() => {
      if (!root.hidden) render();
    });
  },
  show() {
    // store.refresh() redraws once the methods are in.
    void loadMethods().then(() => store.refresh());
  },
};
