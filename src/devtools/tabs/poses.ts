// Poses: each fighter's still images, side view facing right, that their
// animations start and end on (content/anim-clips.json "poses" and
// "frames"). Standing is the side view made from the front art; every other
// pose is made from it, so they all share its size and framing. A fighter's
// own note for a pose ("crouches like a coiled cat") is their personality,
// saved in content/generation.json and used in place of the default wording.
//
// Make poses in two rounds: everyone's Standing first (pick one), then the
// rest, since those are made from the chosen Standing.

import { h, largeUrl } from '../../game/ui/dom.ts';
import { api, store, type ClipList, type FighterState } from '../api.ts';
import { gpu, gpuSnapshot, refreshGpu, watchGpu, type GpuJob, type JobSpec } from '../gpu.ts';
import { attempt, checkbox, toast } from '../ui.ts';
import { morphChildrenTo } from '../morph.ts';
import type { Tab } from '../main.ts';

interface Gen {
  fighters?: Record<string, { poses?: Record<string, string>; [k: string]: unknown }>;
  side?: { count?: number };
  pose?: { count?: number };
  [k: string]: unknown;
}

let root: HTMLElement;
let clips: ClipList | null = null;
let gen: Gen = {};
let open: { fighter: string; pose: string } | null = null;
let onlyIncomplete = false;
let sendsFor = '';
let sends = '';

const poseIds = () => Object.keys(clips?.poses ?? {});
const poseLabel = (p: string) => clips?.poses?.[p]?.label ?? p;
const name = (id: string) => store.fighters.find((f) => f.id === id)?.name ?? id;

interface Cell {
  /** The chosen image, if any. */
  chosen: { file: string; mtime: number } | null;
  /** Candidates waiting to be picked. */
  takes: { file: string; seed: number; mtime: number }[];
}

/** One pose of one fighter: Standing comes from the side views. */
function cell(st: FighterState, pose: string): Cell {
  if (pose === 'stand') {
    const chosen = st.sides.find((s) => s.chosen) ?? null;
    return { chosen, takes: st.sides.filter((s) => !s.chosen).map((s) => ({ file: s.file, seed: Number(/-(\d+)\.png$/.exec(s.file)?.[1] ?? 0), mtime: s.mtime })) };
  }
  const p = st.poses?.[pose];
  return { chosen: p?.chosen ?? null, takes: p?.takes ?? [] };
}

/** GPU jobs making this pose for this fighter now. */
function making(id: string, pose: string): GpuJob | undefined {
  return (gpuSnapshot()?.jobs ?? []).find((j) => (j.status === 'queued' || j.status === 'running') && j.fighter === id && (pose === 'stand' ? j.type === 'side' : j.type === 'pose' && j.pose === pose));
}

function spec(id: string, pose: string, n?: number): JobSpec {
  return pose === 'stand'
    ? { type: 'side', fighter: id, settings: n ? { count: n } : undefined }
    : { type: 'pose', fighter: id, pose, takes: n };
}

/** What making missing poses would queue: Standing where there's none, the rest where Standing is chosen. */
function missingWork(only?: FighterState): { stand: JobSpec[]; rest: JobSpec[]; blocked: number } {
  const stand: JobSpec[] = [];
  const rest: JobSpec[] = [];
  let blocked = 0;
  for (const st of only ? [only] : store.state?.fighters ?? []) {
    for (const pose of poseIds()) {
      const c = cell(st, pose);
      if (c.chosen || c.takes.length || making(st.id, pose)) continue;
      if (pose === 'stand') stand.push(spec(st.id, pose));
      else if (cell(st, 'stand').chosen) rest.push(spec(st.id, pose));
      else blocked++;
    }
  }
  return { stand, rest, blocked };
}

/** One fighter's missing poses: Standing first if they have none, otherwise every other pose missing. */
async function makeMissingFor(st: FighterState): Promise<void> {
  const { stand, rest, blocked } = missingWork(st);
  const who = name(st.id);
  if (!stand.length && !rest.length) {
    toast(blocked
      ? cell(st, 'stand').takes.length ? `Pick ${who}’s Standing pose first: the other poses are made from it.` : `${who}’s Standing pose is being made; the rest follow once you pick it.`
      : `${who} has every pose (or candidates to pick from).`);
    return;
  }
  const n = stand.length * (gen.side?.count ?? 4) + rest.length * (gen.pose?.count ?? 2);
  const what = stand.length ? `Standing (${gen.side?.count ?? 4} candidates). The other poses are made from it: pick one, then press this again.` : `${rest.map((j) => poseLabel(j.pose!)).join(', ')}: ${gen.pose?.count ?? 2} candidates each.`;
  if (!confirm(`${who}: make ${what}\n\n${n} images, roughly $${((n * 30) / 3600 * 1.86).toFixed(2)} of GPU time.`)) return;
  await queue([...stand, ...rest], `Queued ${stand.length + rest.length} pose job${stand.length + rest.length > 1 ? 's' : ''} for ${who}.`);
}

async function queue(jobs: JobSpec[], done: string): Promise<void> {
  if (!jobs.length) return;
  if (await attempt(() => gpu.queue(jobs), done)) await refreshGpu();
  render();
}

async function makeMissing(): Promise<void> {
  const { stand, rest, blocked } = missingWork();
  const sideN = gen.side?.count ?? 4;
  const poseN = gen.pose?.count ?? 2;
  const images = stand.length * sideN + rest.length * poseN;
  if (!images) {
    toast(blocked ? `Pick a Standing pose first for the ${blocked > 1 ? 'fighters' : 'fighter'} still missing one; the rest are made from it.` : 'Every fighter has every pose (or candidates to pick from).');
    return;
  }
  const lines = [
    stand.length && `${stand.length} fighter${stand.length > 1 ? 's' : ''} need a Standing pose: ${sideN} candidates each.`,
    rest.length && `${rest.length} other pose${rest.length > 1 ? 's' : ''} for fighters who have a Standing pose: ${poseN} candidates each.`,
    blocked && `${blocked} more wait until their fighter's Standing pose is picked (they're made from it). Run this again after picking.`,
  ].filter(Boolean);
  // Images take about half a minute each on one server.
  const servers = Math.max(1, (gpuSnapshot()?.servers ?? []).filter((s) => s.state === 'running' && s.boot?.stage === 'ready').length);
  const mins = Math.round((images * 30) / 60 / servers);
  if (!confirm(`${lines.join('\n\n')}\n\n${images} images in all: about ${mins} minutes on ${servers} ready server${servers > 1 ? 's' : ''}, roughly $${((images * 30) / 3600 * 1.86).toFixed(2)} of GPU time.`)) return;
  await queue([...stand, ...rest], `Queued ${stand.length + rest.length} pose jobs. Pick from the candidates as they come in.`);
}

async function saveNote(id: string, pose: string, text: string): Promise<void> {
  // Read the file fresh so AI Settings edits saved meanwhile aren't lost.
  const fresh = await api.content<Gen>('generation');
  const f = ((fresh.fighters ??= {})[id] ??= {});
  const poses = (f.poses ??= {});
  if (text.trim()) poses[pose] = text.trim();
  else delete poses[pose];
  if (!Object.keys(poses).length) delete f.poses;
  if (!Object.keys(f).length) delete fresh.fighters[id];
  if (await attempt(() => api.save('generation', fresh), 'Saved. New takes of this pose use it.')) {
    gen = fresh;
    sendsFor = '';
    render();
  }
}

/** Mirrors or turns a pose image (a picked pose or a candidate), then re-reads the folders so it shows. */
async function flip(st: FighterState, file: string, picked: boolean, op: 'flip' | 'cw' | 'ccw' = 'flip'): Promise<void> {
  const done = op === 'flip' ? 'Flipped' : 'Turned';
  if (await attempt(() => gpu.flipPose(st.id, file, op), picked ? `${done}. Clips made from this pose are now out of date.` : `${done}.`)) await store.refresh();
}

/** Flip and quarter-turn buttons for one pose image. */
function tools(st: FighterState, file: string, picked: boolean): HTMLElement[] {
  return [
    h('button', { type: 'button', class: 'btn small', title: 'Mirror it left to right (poses face right)', onclick: () => flip(st, file, picked) }, picked ? '⇋ Flip' : '⇋'),
    h('button', { type: 'button', class: 'btn small', title: 'Turn it 90° counter-clockwise', onclick: () => flip(st, file, picked, 'ccw') }, '⟲'),
    h('button', { type: 'button', class: 'btn small', title: 'Turn it 90° clockwise', onclick: () => flip(st, file, picked, 'cw') }, '⟳'),
  ];
}

function detail(st: FighterState, pose: string): HTMLElement {
  const c = cell(st, pose);
  const job = making(st.id, pose);
  const def = clips?.poses?.[pose];
  const note = h('textarea', { placeholder: def?.action ?? '', style: 'min-height:56px;width:100%' });
  note.value = gen.fighters?.[st.id]?.poses?.[pose] ?? '';
  const key = `${st.id}:${pose}:${note.value}`;
  if (pose !== 'stand' && sendsFor !== key) {
    sendsFor = key;
    void gpu.preview({ type: 'pose', fighter: st.id, pose }).then((r) => { sends = r.prompt; render(); }).catch(() => undefined);
  }
  const usedBy = Object.entries(clips?.frames ?? {}).filter(([, f]) => f.includes(pose)).map(([clip]) => clips?.labels[clip] ?? clip);
  return h('section', { class: 'card pose-detail', 'data-key': `detail-${st.id}-${pose}` },
    h('h3', {}, `${name(st.id)} · ${poseLabel(pose)}`, h('span', { class: 'spacer' }),
      job ? h('span', { class: 'badge warn' }, job.status === 'running' ? 'making…' : 'queued') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => { open = null; render(); } }, 'Close')),
    h('div', { class: 'pose-detail-body' },
      h('div', { class: 'pose-big-wrap' },
        h('div', { class: 'pose-big checker' }, c.chosen ? h('img', { src: api.sourceUrl(st.id, c.chosen.file, c.chosen.mtime), alt: '' }) : h('span', { class: 'muted' }, 'Not picked yet')),
        c.chosen ? h('div', { class: 'row', title: 'Clips made from this pose become out of date' }, ...tools(st, c.chosen.file, true)) : null),
      h('div', { class: 'pose-side' },
        h('p', { class: 'hint' }, pose === 'stand'
          ? 'The side view every other pose and clip is made from. Made from the front art.'
          : `Made from the chosen Standing pose. Used by: ${usedBy.join(', ') || 'no clip yet'}.`),
        pose !== 'stand' ? h('div', { class: 'field' }, h('label', {}, `How ${name(st.id)} does it (their personality)`), note,
          h('span', { class: 'sub' }, 'Blank: the default wording (shown greyed). Say it their way: “crouches like a coiled spring, fists up”.'),
          // The page updates in place, so read the live box, not the one built here.
          h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: () => saveNote(st.id, pose, root.querySelector<HTMLTextAreaElement>('.pose-detail textarea')?.value ?? '') }, 'Save note'))) : null,
        pose !== 'stand' && sends ? h('div', { class: 'field' }, h('label', {}, 'Will send'), h('p', { class: 'hint text' }, sends)) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', disabled: !!job || (pose !== 'stand' && !cell(st, 'stand').chosen), onclick: () => queue([spec(st.id, pose)], `Queued ${poseLabel(pose)} for ${name(st.id)}.`) },
            c.chosen || c.takes.length ? 'Make more candidates' : 'Make candidates'),
          pose !== 'stand' && !cell(st, 'stand').chosen ? h('span', { class: 'hint warn' }, 'Pick a Standing pose first.') : null))),
    c.takes.length ? h('div', { class: 'pose-takes' }, ...[...c.takes].sort((a, b) => b.mtime - a.mtime).map((t) => h('div', { class: 'pose-take', 'data-key': t.file },
      h('div', { class: 'checker' }, h('img', { src: api.sourceUrl(st.id, t.file, t.mtime), alt: '', loading: 'lazy' })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small primary', onclick: async () => {
          const ok = await attempt(() => (pose === 'stand' ? gpu.chooseSide(st.id, t.file.replace(/^anims\//, '')) : gpu.choosePose(st.id, pose, t.file.replace(/^poses\/_takes\//, ''))), `${poseLabel(pose)} picked for ${name(st.id)}.`);
          if (ok) await store.refresh();
        } }, 'Use'),
        ...tools(st, t.file, false),
        pose !== 'stand' ? h('button', { type: 'button', class: 'btn small', title: 'Move it to poses/_old/', onclick: async () => {
          if (await attempt(() => gpu.discardPose(st.id, t.file.replace(/^poses\/_takes\//, '')))) await store.refresh();
        } }, '×') : null)))) : h('p', { class: 'hint' }, job ? 'Candidates show up here as they are made.' : 'No candidates waiting.'),
  );
}

function matrix(): HTMLElement {
  const poses = poseIds();
  const rows = (store.state?.fighters ?? []).filter((st) => !onlyIncomplete || poses.some((p) => !cell(st, p).chosen));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table pose-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Fighter'), h('th', {}, 'Front'), ...poses.map((p) => h('th', { title: clips?.poses?.[p]?.action ?? '' }, poseLabel(p))))),
    h('tbody', {}, ...rows.map((st) => h('tr', { 'data-key': st.id },
      h('td', {}, h('div', { class: 'pose-who' },
        h('strong', {}, name(st.id)),
        (() => {
          const w = missingWork(st);
          const n = w.stand.length + w.rest.length;
          const waiting = poseIds().some((p) => making(st.id, p));
          return h('button', {
            type: 'button', class: `btn small${n ? ' primary' : ''}`, disabled: !n,
            title: w.stand.length ? 'Makes Standing candidates; the other poses are made from the one you pick.' : 'Makes candidates for every pose this fighter is missing, from their Standing pose.',
            onclick: () => makeMissingFor(st),
          }, n ? `Generate all missing (${n})` : waiting ? 'Making…' : w.blocked ? 'Pick Standing' : 'All made');
        })())),
      h('td', {}, h('img', { class: 'pose-thumb', src: largeUrl(st.id), alt: '', loading: 'lazy' })),
      ...poses.map((p) => {
        const c = cell(st, p);
        const job = making(st.id, p);
        const isOpen = open?.fighter === st.id && open.pose === p;
        const blocked = p !== 'stand' && !cell(st, 'stand').chosen;
        return h('td', { 'data-key': `${st.id}-${p}` }, h('button', {
          type: 'button', class: `pose-cell${isOpen ? ' active' : ''}${c.chosen ? '' : ' empty'}`,
          title: blocked ? 'Pick a Standing pose first' : `${poseLabel(p)}: ${c.chosen ? 'picked' : c.takes.length ? `${c.takes.length} to pick from` : 'not made yet'}`,
          onclick: () => { open = isOpen ? null : { fighter: st.id, pose: p }; render(); },
        },
        c.chosen ? h('img', { class: 'pose-thumb', src: api.sourceUrl(st.id, c.chosen.file, c.chosen.mtime), alt: '', loading: 'lazy' }) : h('span', { class: 'muted' }, blocked ? '·' : '—'),
        job ? h('span', { class: 'badge warn' }, job.status === 'running' ? 'making' : 'queued') : c.takes.length ? h('span', { class: 'badge ok' }, `${c.takes.length} to pick`) : null));
      }))))));
}

function render(): void {
  if (!root || root.hidden) return;
  const fighters = store.state?.fighters ?? [];
  const poses = poseIds();
  const complete = fighters.filter((st) => poses.every((p) => cell(st, p).chosen)).length;
  const toPick = fighters.reduce((n, st) => n + poses.filter((p) => !cell(st, p).chosen && cell(st, p).takes.length).length, 0);
  const work = missingWork();
  const st = open ? store.fighterState(open.fighter) : null;
  morphChildrenTo(root, [
    h('div', { class: 'main' },
      h('header', {}, h('h2', {}, 'Poses'), h('span', { class: 'muted' }, `${complete} of ${fighters.length} fighters have every pose${toPick ? ` · ${toPick} waiting to be picked` : ''}`), h('span', { class: 'spacer' }),
        checkbox('Only fighters missing poses', onlyIncomplete, (v) => { onlyIncomplete = v; render(); }),
        h('button', { type: 'button', class: 'btn primary', onclick: makeMissing },
          `Make missing poses${work.stand.length + work.rest.length ? ` (${work.stand.length + work.rest.length})` : ''}`)),
      h('p', { class: 'hint' }, 'Every animation starts on one of these stills and usually ends on one: loops start and end on the same pose, so they loop; moves come back to their stance. Standing is made from the front art, and the rest from the picked Standing, so pick everyone’s Standing first, then make the rest. Click a cell to pick candidates and to say how this fighter does that pose.'),
      st && open ? detail(st, open.pose) : null,
      matrix()),
  ]);
}

export const posesTab: Tab = {
  async mount(el) {
    root = el;
    el.style.display = 'block';
    el.style.overflow = 'auto';
    [clips, gen] = await Promise.all([api.content<ClipList>('anim-clips'), api.content<Gen>('generation')]);
    store.on(() => render());
    // When a pose job finishes, its candidates are on disk: read them in.
    let finished = new Set<string>();
    watchGpu((s) => {
      const now = new Set(s.jobs.filter((j) => (j.type === 'pose' || j.type === 'side') && j.status === 'done').map((j) => j.id));
      const fresh = [...now].some((id) => !finished.has(id));
      finished = now;
      if (fresh) void store.refresh();
      render();
    });
    render();
  },
  async show() {
    if (!root) return;
    [clips, gen] = await Promise.all([api.content<ClipList>('anim-clips'), api.content<Gen>('generation')]);
    sendsFor = '';
    render();
    // New candidates land in the art folders: re-read them while this tab is open.
    void store.refresh();
  },
};
