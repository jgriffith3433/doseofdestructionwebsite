// Animations: every clip slot for one fighter. Import a video into a slot
// (button or drag and drop) and only that clip rebuilds. The editor trims and
// tunes a clip and previews it at game speed, with hitboxes on top, so the
// swing can be lined up with where the move actually hits.

import { MOVE_KEYS, fighter, type CharacterDef, type Move } from '../../game/sim/fighterDefs.ts';
import type { Clip } from '../../game/render/anims.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api, dropTarget, log, pickFile, runTask, store, type ClipOptions, type FighterState } from '../api.ts';
import { animate, drawFrame, frameAt } from '../sprites.ts';
import { attempt, checkbox, field, fighterList, numberInput, select } from '../ui.ts';
import type { Tab } from '../main.ts';

const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/x-matroska,image/gif,.mp4,.mov,.webm,.mkv,.gif,.avi';

let root: HTMLElement;
let list: ReturnType<typeof fighterList>;
let main: HTMLElement;
let selectedClip: string | null = null;
let draftOptions: ClipOptions = {};
let stops: (() => void)[] = [];
const preview = { playing: true, speed: 1, frame: 0, hurtbox: true, hitboxes: true, feet: true };

function charDef(): CharacterDef | undefined {
  const f = store.entry();
  return f ? fighter(f.id, f.name, f.role, f.blurb, f) : undefined;
}

function moveFor(name: string, ch?: CharacterDef): Move | undefined {
  const i = (MOVE_KEYS as readonly string[]).indexOf(name);
  return i >= 0 && ch ? ch.moves[i] : undefined;
}

function sheetUrl(st: FighterState, name: string): string {
  const clip = st.manifest!.clips[name];
  return `/characters/anim/${st.id}/${clip.file}?v=${st.manifest!.version ?? 0}`;
}

function label(name: string): string {
  return store.clips?.labels[name] ?? name;
}

async function importClip(name: string, file: File): Promise<void> {
  const id = store.selected;
  log(`Importing ${file.name} as ${id} / ${name}`);
  const ok = await attempt(() => api.upload(`/anim/upload?fighter=${id}&clip=${name}&name=${encodeURIComponent(file.name)}`, file));
  if (!ok) return;
  selectedClip = name;
  draftOptions = {};
  await runTask('anims', { fighter: id, clip: name }, `build ${id} ${name}`);
}

async function buildClip(name: string): Promise<void> {
  await runTask('anims', { fighter: store.selected, clip: name }, `build ${store.selected} ${name}`);
}

async function saveOptions(name: string, rebuild: boolean): Promise<void> {
  const ok = await attempt(() => api.post('/anim/options', { fighter: store.selected, clip: name, options: draftOptions }), rebuild ? undefined : 'Options saved.');
  if (ok && rebuild) await buildClip(name);
}

async function deleteClip(name: string): Promise<void> {
  if (!confirm(`Delete ${label(name)} for ${store.entry()?.name}? This removes the source video from the art folder.`)) return;
  const ok = await attempt(() => api.post('/anim/delete', { fighter: store.selected, clip: name }));
  if (ok) {
    selectedClip = null;
    await buildClip(name);
  }
}

// ------------------------------------------------------------ clip board

function clipCard(st: FighterState, name: string, ch?: CharacterDef): HTMLElement {
  const built = st.manifest?.clips[name];
  const src = st.clipSources[name];
  const canvas = built ? h('canvas', { class: 'checker' }) : null;
  const badge = built
    ? h('span', { class: 'badge ok' }, `${built.frames} frames`)
    : src
      ? h('span', { class: 'badge warn' }, 'not built')
      : h('span', { class: 'badge' }, 'empty');
  const card = h(
    'div',
    { class: `clip${built ? ' built' : src ? ' source' : ''}${selectedClip === name ? ' selected' : ''}` },
    h('div', { class: 'clip-head' }, h('strong', {}, label(name)), h('code', {}, name), h('span', { class: 'spacer' }), badge),
    canvas ?? h('div', { class: 'dropzone', style: 'height:130px;display:grid;place-items:center' }, src ? 'Source ready. Build it.' : 'Drop a video here'),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: 'btn small', onclick: async () => {
          const file = await pickFile(VIDEO_ACCEPT);
          if (file) await importClip(name, file);
        },
      }, 'Import'),
      src && h('button', { type: 'button', class: 'btn small', onclick: () => buildClip(name) }, 'Build'),
      (src || built) && h('button', { type: 'button', class: 'btn small', onclick: () => openEditor(name) }, 'Edit'),
    ),
  );
  dropTarget(card, (file) => importClip(name, file));
  if (canvas && built && st.manifest) {
    const url = sheetUrl(st, name);
    const move = moveFor(name, ch);
    const refHeight = st.manifest.refHeight;
    stops.push(
      animate((now) => {
        // Moves play over their frame data with a short pause; loops run at their fps.
        const total = move ? move.total + 20 : 0;
        const f = Math.floor((now / 1000) * 60);
        const index = move ? frameAt(built, Math.min(move.total - 1, f % total), move.total) : frameAt(built, f);
        drawFrame({ canvas, url, clip: built, refHeight, index });
      }),
    );
  }
  return card;
}

function openEditor(name: string): void {
  selectedClip = name;
  draftOptions = { ...(store.fighterState()?.clipOptions[name] ?? {}) };
  preview.frame = 0;
  render();
  main.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- editor

function editor(st: FighterState, name: string, ch: CharacterDef | undefined, onClose: () => void): HTMLElement {
  const src = st.clipSources[name];
  const built = st.manifest?.clips[name];
  const move = moveFor(name, ch);
  const loops = store.clips?.loops.includes(name);
  const o = draftOptions;

  // ---- source side
  let video: HTMLVideoElement | null = null;
  const timeLabel = h('span', { class: 'muted mono' }, '0.00s');
  if (src) {
    video = h('video', { src: api.sourceUrl(st.id, src.file, src.mtime), controls: true, loop: true, muted: true, playsinline: true });
    video.addEventListener('timeupdate', () => (timeLabel.textContent = `${video!.currentTime.toFixed(2)}s / ${(video!.duration || 0).toFixed(2)}s`));
  }
  const startIn = numberInput(o.start ?? null, (v) => (o.start = v ?? undefined), { step: 0.01, min: 0, placeholder: 'from start' });
  const endIn = numberInput(o.end ?? null, (v) => (o.end = v ?? undefined), { step: 0.01, min: 0, placeholder: 'to end' });
  const setFromVideo = (which: 'start' | 'end') => {
    if (!video) return;
    const t = Math.round(video.currentTime * 100) / 100;
    o[which] = t;
    (which === 'start' ? startIn : endIn).value = String(t);
  };
  const tol = h('input', { type: 'range', min: 5, max: 120, step: 1, value: o.tolerance ?? 40 });
  const tolOut = h('span', { class: 'muted' }, String(o.tolerance ?? 40));
  tol.addEventListener('input', () => {
    o.tolerance = Number(tol.value);
    tolOut.textContent = tol.value;
  });

  const source = h(
    'section',
    { class: 'card' },
    h('h3', {}, `Source · ${label(name)}`, h('span', { class: 'spacer' }), src ? h('span', { class: 'muted mono' }, src.file) : null),
    video ?? h('div', { class: 'dropzone' }, 'No source video for this clip yet. Import one.'),
    video && h('div', { class: 'row' }, timeLabel, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => setFromVideo('start') }, 'Start here'),
      h('button', { type: 'button', class: 'btn small', onclick: () => setFromVideo('end') }, 'End here'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { if (video) { video.currentTime = o.start ?? 0; void video.play(); } } }, 'Play trim')),
    h(
      'div',
      { class: 'form' },
      field('Start (s)', startIn),
      field('End (s)', endIn),
      field('Frames per second', numberInput(o.fps ?? null, (v) => (o.fps = v ?? undefined), { step: 1, min: 4, max: 60, placeholder: loops ? '15' : '20' })),
      field('Size from', select<'auto' | 'on' | 'off'>([['auto', 'Automatic'], ['on', 'This clip'], ['off', 'Idle clip']], o.normalize === undefined ? 'auto' : o.normalize ? 'on' : 'off', (v) => {
        o.normalize = v === 'auto' ? undefined : v === 'on';
      }), { sub: 'Clips that don’t start standing should use idle' }),
      field('Background tolerance', h('div', { class: 'row' }, tol, tolOut), { sub: 'Lower if the fighter gets eaten; higher if background stays' }),
      h('div', { class: 'field' }, h('label', {}, 'Facing'), checkbox('Clip faces left (flip it)', o.flip === true, (v) => (o.flip = v || undefined))),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', disabled: !src, onclick: () => saveOptions(name, true) }, 'Save & rebuild'),
      h('button', { type: 'button', class: 'btn', onclick: () => saveOptions(name, false) }, 'Save options'),
      h('button', {
        type: 'button', class: 'btn', onclick: async () => {
          const file = await pickFile(VIDEO_ACCEPT);
          if (file) await importClip(name, file);
        },
      }, src ? 'Replace video…' : 'Import video…'),
      h('span', { class: 'spacer' }),
      (src || built) && h('button', { type: 'button', class: 'btn danger', onclick: () => deleteClip(name) }, 'Delete clip'),
      h('button', { type: 'button', class: 'btn', onclick: onClose }, 'Close'),
    ),
  );
  dropTarget(source, (file) => importClip(name, file));

  // ---- in-game side
  let game: HTMLElement;
  if (built && st.manifest && ch) {
    const canvas = h('canvas', { class: 'preview checker' });
    const total = move ? move.total : Math.max(1, Math.round((built.frames / built.fps) * 60));
    const scrub = h('input', { type: 'range', min: 0, max: total - 1, step: 1, value: 0, style: 'width:100%' });
    const frameLabel = h('span', { class: 'muted mono' });
    const playhead = h('i', { class: 'playhead' });
    const timeline = move ? h('div', { class: 'timeline' }, ...timelineParts(move), playhead) : null;
    const url = sheetUrl(st, name);
    const refHeight = st.manifest.refHeight;
    let last = performance.now();
    stops.push(
      animate((now) => {
        const dt = now - last;
        last = now;
        if (preview.playing) preview.frame = (preview.frame + (dt / 1000) * 60 * preview.speed) % total;
        const f = Math.floor(preview.frame);
        scrub.value = String(f);
        const index = move ? frameAt(built, f, move.total) : frameAt(built, f);
        frameLabel.textContent = `game frame ${f + 1}/${total} · clip frame ${index + 1}/${built.frames}`;
        if (timeline) playhead.style.left = `${(f / total) * 100}%`;
        drawFrame({
          canvas, url, clip: built, refHeight, index, ch, move, moveFrame: f,
          overlay: { hurtbox: preview.hurtbox, hitboxes: preview.hitboxes, feet: preview.feet },
        });
      }),
    );
    scrub.addEventListener('input', () => {
      preview.playing = false;
      preview.frame = Number(scrub.value);
      playBtn.textContent = 'Play';
    });
    const playBtn = h('button', { type: 'button', class: 'btn small', onclick: () => { preview.playing = !preview.playing; playBtn.textContent = preview.playing ? 'Pause' : 'Play'; } }, preview.playing ? 'Pause' : 'Play');
    const step = (d: number) => {
      preview.playing = false;
      playBtn.textContent = 'Play';
      preview.frame = (Math.floor(preview.frame) + d + total) % total;
    };
    game = h(
      'section',
      { class: 'card' },
      h('h3', {}, 'In game', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${built.frames} frames · ${built.fw}×${built.fh}px · ${built.loop ? 'loops' : move ? `stretched over ${move.total} game frames` : 'plays once'}`)),
      canvas,
      timeline,
      scrub,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => step(-1) }, '◀'),
        playBtn,
        h('button', { type: 'button', class: 'btn small', onclick: () => step(1) }, '▶'),
        select<string>([['0.25', '¼ speed'], ['0.5', '½ speed'], ['1', 'Full speed']], String(preview.speed), (v) => (preview.speed = Number(v))),
        frameLabel,
      ),
      h(
        'div',
        { class: 'row' },
        checkbox('Hurtbox', preview.hurtbox, (v) => (preview.hurtbox = v)),
        move && checkbox('Hitboxes', preview.hitboxes, (v) => (preview.hitboxes = v)),
        checkbox('Feet', preview.feet, (v) => (preview.feet = v)),
      ),
      move
        ? h('p', { class: 'hint' }, `The swing should connect during the red part of the timeline, where the hitboxes show. If the art lands early or late, trim the clip so the hit sits there.`)
        : h('p', { class: 'hint' }, 'The yellow box is where this fighter can be hit. The art should fill it.'),
    );
  } else {
    game = h('section', { class: 'card' }, h('h3', {}, 'In game'), h('p', { class: 'hint' }, src ? 'Build the clip to preview it here.' : 'Import a video to start.'));
  }
  return h('div', { class: 'editor' }, source, game);
}

function timelineParts(move: Move): HTMLElement[] {
  const first = Math.min(...move.hits.map((w) => w.start));
  const last = Math.max(...move.hits.map((w) => w.end));
  const pct = (n: number) => `${(n / move.total) * 100}%`;
  return [
    h('span', { class: 'startup', style: `width:${pct(first)}` }, first > 4 ? `startup ${first}` : ''),
    h('span', { class: 'active', style: `width:${pct(last - first + 1)}` }, 'hit'),
    h('span', { class: 'recovery', style: `width:${pct(move.total - last - 1)}` }, 'recovery'),
  ];
}

/**
 * Where a clip stands: no video yet, a video waiting to be built, built from an
 * older video or older options, or current.
 */
export type ClipStatus = 'empty' | 'waiting' | 'stale' | 'ok';

export function clipStatus(st: FighterState, name: string): ClipStatus {
  const src = st.clipSources[name];
  const built = st.manifest?.clips[name] as (Clip & { sourceMtime?: number; options?: ClipOptions; source?: string }) | undefined;
  if (!src) return built ? 'ok' : 'empty';
  if (!built) return 'waiting';
  // Clips built before this was tracked have no record; trust them.
  if (built.sourceMtime === undefined) return 'ok';
  const sameFile = built.source === src.file.replace(/^anims\//, '') && Math.abs(built.sourceMtime - src.mtime) < 2000;
  const sameOptions = JSON.stringify(sortKeys(built.options ?? {})) === JSON.stringify(sortKeys(st.clipOptions[name] ?? {}));
  return sameFile && sameOptions ? 'ok' : 'stale';
}

function sortKeys(o: object): object {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).sort(([a], [b]) => a.localeCompare(b)));
}

/** The clip editor on its own, for other tabs. stop() ends its previews. */
export function clipEditorPanel(fighterId: string, clip: string, onClose: () => void): { el: HTMLElement; stop: () => void } {
  // The editor works on the selected fighter; select quietly so other tabs don't re-render.
  store.selected = fighterId;
  selectedClip = clip;
  draftOptions = { ...(store.fighterState(fighterId)?.clipOptions[clip] ?? {}) };
  preview.frame = 0;
  const outer = stops;
  stops = [];
  const st = store.fighterState(fighterId)!;
  const el = editor(st, clip, charDef(), onClose);
  const mine = stops;
  stops = outer;
  return { el, stop: () => mine.forEach((s) => s()) };
}

// ---------------------------------------------------------------- render

function render(): void {
  stops.forEach((s) => s());
  stops = [];
  list.render();
  const st = store.fighterState();
  const entry = store.entry();
  const clips = store.clips;
  if (!st || !entry || !clips) {
    main.replaceChildren(h('p', { class: 'muted' }, 'Pick a fighter.'));
    return;
  }
  const ch = charDef();
  const builtCount = Object.keys(st.manifest?.clips ?? {}).length;
  const waiting = Object.keys(st.clipSources).filter((n) => !st.manifest?.clips[n]);
  main.replaceChildren(...kids(
    h(
      'header',
      {},
      h('h2', {}, entry.name),
      h('span', { class: 'muted' }, `${builtCount} built${waiting.length ? ` · ${waiting.length} waiting to build` : ''}`),
      h('span', { class: 'spacer' }),
      waiting.length > 0 && h('button', { type: 'button', class: 'btn', onclick: async () => {
        for (const n of waiting) if ((await runTask('anims', { fighter: st.id, clip: n }, `build ${st.id} ${n}`)) !== 0) break;
      } }, `Build ${waiting.length} waiting`),
      h('button', { type: 'button', class: 'btn', disabled: !Object.keys(st.clipSources).length, onclick: () => runTask('anims', { fighter: st.id }, `rebuild every ${st.id} clip`) }, 'Rebuild all clips'),
      h('a', { class: 'btn', href: `/_anim_preview/${st.id}.png?v=${Date.now()}`, target: '_blank', rel: 'noopener' }, 'Contact sheet'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => window.open(`/Game/?play&fighter=${st.id}&vs=dummy&stage=foundry`, 'dod-playtest') }, 'Playtest'),
    ),
    st.folder
      ? h('p', { class: 'hint' }, 'Videos live in ', h('code', {}, `${store.state?.artRoot}\\${st.folder}\\anims\\`), '. Side view, facing right, in place, on a flat background. See docs/animation.md.')
      : h('p', { class: 'hint warn' }, `${entry.name} has no folder in the art root yet. Importing a clip creates one.`),
    selectedClip ? editor(st, selectedClip, ch, () => { selectedClip = null; render(); }) : null,
    ...([['Loops', clips.loops], ['One-shots', clips.once], ['Moves', clips.moves]] as const).map(([title, names]) =>
      h('div', { class: 'clip-group' }, h('h3', {}, title), h('div', { class: 'clip-grid' }, ...names.map((n) => clipCard(st, n, ch)))),
    ),
  ));
}

export const animationsTab: Tab = {
  mount(el) {
    root = el;
    el.classList.add('with-list');
    list = fighterList((id) => {
      const st = store.fighterState(id);
      const built = Object.keys(st?.manifest?.clips ?? {}).length;
      const waiting = Object.keys(st?.clipSources ?? {}).filter((n) => !st?.manifest?.clips[n]).length;
      if (waiting) return h('span', { class: 'badge warn' }, `${waiting} to build`);
      return built ? h('span', { class: 'badge ok' }, `${built}`) : null;
    });
    main = h('div', { class: 'main' });
    el.append(list.el, main);
    let lastFighter = store.selected;
    store.on(() => {
      if (store.selected !== lastFighter) {
        lastFighter = store.selected;
        selectedClip = null;
      }
      if (!root.hidden) render();
    });
  },
  show() {
    render();
  },
};
