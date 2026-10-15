// Animations: every clip slot for one fighter. Import a video into a slot
// (button or drag and drop) and only that clip rebuilds. The editor trims and
// tunes a clip and previews it at game speed, with hitboxes on top, so the
// swing can be lined up with where the move actually hits.

import { MOVE_KEYS, fighter, type CharacterDef, type Move } from '../../game/sim/fighterDefs.ts';
import type { Clip } from '../../game/render/anims.ts';
import { h, kids } from '../../game/ui/dom.ts';
import { api, dropTarget, log, pickFile, runTask, store, type ClipOptions, type FighterState } from '../api.ts';
import { animate, drawFrame, frameAt } from '../sprites.ts';
import { attempt, checkbox, field, fighterList, numberInput, select, toast } from '../ui.ts';
import { CREATURES, defaultMethod, gpu, gpuSnapshot, refreshGpu, watchGpu, type ClipPlan, type JobSpec } from '../gpu.ts';
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

/** Per clip card: which take is being previewed (-1, or absent: the clip as built). */
const browsing = new Map<string, number>();
let using = '';

/** A clip's takes, newest first, and which one (if any) is the clip now (same size as its video). */
function takesOf(st: FighterState, name: string) {
  const list = (st.takes ?? []).filter((t) => t.clip === name).sort((a, b) => b.mtime - a.mtime);
  const src = st.clipSources[name];
  const inUse = src ? list.findIndex((t) => t.size === src.size) : -1;
  return { list, inUse };
}

/** ◀ take 2 of 4 ▶ on a clip card: preview takes in place, Use one. */
function takeSwitcher(st: FighterState, name: string): HTMLElement | null {
  const { list, inUse } = takesOf(st, name);
  if (!list.length) return null;
  const key = `${st.id}:${name}`;
  const at = browsing.get(key) ?? -1;
  const go = (by: number) => {
    // -1 is the clip as it is now; 0..n-1 the takes.
    let next = at + by;
    if (next < -1) next = list.length - 1;
    if (next >= list.length) next = -1;
    browsing.set(key, next);
    render();
  };
  const take = at >= 0 ? list[at] : null;
  const busy = using === key;
  return h('div', { class: 'take-switch' },
    h('button', { type: 'button', class: 'btn small', title: 'Previous take', onclick: () => go(-1) }, '◀'),
    h('span', { class: 'take-switch-label', title: take?.recipe?.prompt ?? '' },
      take ? `Take ${at + 1} of ${list.length}${at === inUse ? ' · in use' : ''}` : `In use${inUse >= 0 ? ` (take ${inUse + 1})` : ''} · ${list.length} take${list.length > 1 ? 's' : ''}`),
    h('button', { type: 'button', class: 'btn small', title: 'Next take', onclick: () => go(1) }, '▶'),
    take && at !== inUse ? h('button', { type: 'button', class: 'btn small primary', disabled: busy, title: 'Make this take the clip (the old video moves to anims/_old/) and build it', onclick: async () => {
      using = key;
      render();
      const ok = await attempt(() => gpu.useTake(st.id, name, take.file.replace(/^anims\/_takes\//, '')), `Take ${at + 1} is now ${label(name)}.`);
      using = '';
      if (ok) {
        browsing.delete(key);
        await store.refresh();
      } else render();
    } }, busy ? 'Using…' : 'Use') : null);
}

/**
 * The clip card being trimmed, and its unsaved trim (seconds into the video).
 * take: trimming a take (from the take switcher) rather than the clip in use;
 * saving then makes that take the clip, with this trim.
 */
let trimming: { fighter: string; clip: string; start: number; end: number | null; take?: { file: string; mtime: number; n: number } } | null = null;

/** A clip card's quick trim: the video loops between two slider handles; Save rebuilds it. */
function trimPanel(st: FighterState, name: string): HTMLElement {
  const src = t0(st, name);
  const t = trimming!;
  const video = h('video', { src: api.sourceUrl(st.id, src.file, src.mtime), muted: true, playsinline: true, preload: 'auto', class: 'checker trim-video' });
  const lo = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: t.start, class: 'trim-lo', 'aria-label': 'Trim start' });
  const hi = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: t.end ?? 1, class: 'trim-hi', 'aria-label': 'Trim end' });
  const fill = h('div', { class: 'trim-fill' });
  const readout = h('span', { class: 'muted mono' }, '…');
  let dur = 0;
  let scrubbing = false;
  const end = () => t.end ?? dur;
  const show = () => {
    if (!dur) return;
    const a = t.start / dur;
    const b = end() / dur;
    fill.style.left = `${a * 100}%`;
    fill.style.width = `${Math.max(0, b - a) * 100}%`;
    readout.textContent = `${t.start.toFixed(2)}s → ${end().toFixed(2)}s · ${(end() - t.start).toFixed(2)}s of ${dur.toFixed(2)}s`;
  };
  video.addEventListener('loadedmetadata', () => {
    dur = Math.round(video.duration * 100) / 100;
    for (const r of [lo, hi]) r.max = String(dur);
    if (t.end === null || t.end > dur) t.end = null;
    hi.value = String(end());
    video.currentTime = t.start;
    show();
    void video.play().catch(() => undefined);
  });
  // Play only the kept part, over and over: checked every frame, so the loop stops right on the end handle.
  const wrap = () => {
    if (!scrubbing && dur && !video.paused && (video.currentTime >= end() - 0.01 || video.currentTime < t.start - 0.05)) video.currentTime = t.start;
  };
  const loop = () => {
    if (!video.isConnected) return;
    wrap();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Animation frames pause while the page is in the background; the video's own ticks still keep it in range.
  video.addEventListener('timeupdate', wrap);
  video.addEventListener('ended', () => { video.currentTime = t.start; void video.play().catch(() => undefined); });
  const scrub = (which: 'lo' | 'hi') => {
    scrubbing = true;
    video.pause();
    if (which === 'lo') {
      t.start = Math.min(Number(lo.value), end() - 0.05);
      lo.value = String(t.start);
      video.currentTime = t.start;
    } else {
      const v = Math.max(Number(hi.value), t.start + 0.05);
      t.end = v >= dur - 0.01 ? null : v;
      hi.value = String(end());
      video.currentTime = Math.max(t.start, end() - 0.04);
    }
    show();
  };
  const release = () => {
    scrubbing = false;
    video.currentTime = t.start;
    void video.play().catch(() => undefined);
  };
  lo.addEventListener('input', () => scrub('lo'));
  hi.addEventListener('input', () => scrub('hi'));
  lo.addEventListener('change', release);
  hi.addEventListener('change', release);
  const save = async () => {
    const options: ClipOptions = { ...(st.clipOptions[name] ?? {}) };
    options.start = t.start > 0.005 ? t.start : undefined;
    options.end = t.end ?? undefined;
    if (!(await attempt(() => api.post('/anim/options', { fighter: st.id, clip: name, options })))) return;
    const take = t.take;
    trimming = null;
    render();
    if (take) {
      // Making the take the clip builds it, with the trim just saved.
      if (await attempt(() => gpu.useTake(st.id, name, take.file.replace(/^anims\/_takes\//, '')), `Take ${take.n} is now ${label(name)}, trimmed.`)) {
        browsing.delete(`${st.id}:${name}`);
        await store.refresh();
      }
      return;
    }
    await runTask('anims', { fighter: st.id, clip: name }, `trim and build ${st.id} ${name}`);
  };
  return h('div', { class: 'trim' },
    t.take ? h('div', { class: 'take-switch-label' }, `Trimming take ${t.take.n}`) : null,
    video,
    h('div', { class: 'trim-slider' }, h('div', { class: 'trim-track' }), fill, lo, hi),
    h('div', { class: 'row' }, readout),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small primary', title: t.take ? 'Make this take the clip, trimmed like this, and build it' : 'Save the trim and rebuild the clip', onclick: save }, t.take ? 'Use with this trim' : 'Save & rebuild'),
      h('button', { type: 'button', class: 'btn small', title: 'Use the whole video', onclick: () => { t.start = 0; t.end = null; lo.value = '0'; hi.value = String(dur); video.currentTime = 0; show(); } }, 'Reset'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => { trimming = null; render(); } }, 'Cancel')),
  );
}

/** The clip card being resized, and the size being tried (a multiplier, or 'auto'). */
let sizing: { fighter: string; clip: string; value: number | 'auto' } | null = null;

type BuiltClip = Clip & { size?: number; autoSize?: number | null; autoSizeFrom?: string | null };

/** The size a clip was built at (clips built before sizes existed are 1). */
function builtSize(st: FighterState, name: string): number {
  return (st.manifest?.clips[name] as BuiltClip | undefined)?.size ?? 1;
}

/** Sizes every clip with a video to match the Standing pose, then rebuilds them. Hand-set sizes stay. */
async function autoSizeAll(st: FighterState): Promise<void> {
  const names = Object.keys(st.clipSources).filter((n) => typeof st.clipOptions[n]?.size !== 'number');
  const kept = Object.keys(st.clipSources).length - names.length;
  if (!names.length) return toast('Every clip has a size set by hand.');
  if (!confirm(`Auto-size ${names.length} clips so the fighter matches their Standing pose, then rebuild them?${kept ? ` ${kept} sized by hand stay as they are.` : ''}`)) return;
  for (const n of names) {
    const options: ClipOptions = { ...(st.clipOptions[n] ?? {}), size: 'auto' };
    if (!(await attempt(() => api.post('/anim/options', { fighter: st.id, clip: n, options })))) return;
  }
  await store.refresh();
  for (const n of names) if ((await runTask('anims', { fighter: st.id, clip: n }, `auto-size ${st.id} ${n}`)) !== 0) break;
}

/**
 * A clip card's size control: the clip at the shared scale with the Standing
 * height marked, a slider that previews the new size live, and Auto, which
 * measures the clip against the Standing pose when it's built.
 */
function sizePanel(st: FighterState, name: string): HTMLElement {
  const built = st.manifest!.clips[name] as BuiltClip;
  const s = sizing!;
  const was = builtSize(st, name);
  const canvas = h('canvas', { class: 'checker' });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const current = () => (s.value === 'auto' ? built.autoSize ?? was : s.value);
  const slider = h('input', { type: 'range', min: 0.5, max: 1.5, step: 0.01, value: current(), 'aria-label': 'Size' });
  const readout = h('span', { class: 'muted mono' });
  const show = () => {
    readout.textContent = s.value === 'auto'
      ? built.autoSize != null ? `Auto: ${pct(built.autoSize)} (measured from ${built.autoSizeFrom === 'stand' ? 'Standing' : `${built.autoSizeFrom} → Standing`})` : 'Auto: measured against Standing when it builds'
      : `${pct(s.value)}${was !== s.value ? ` (built at ${pct(was)})` : ''}`;
  };
  slider.addEventListener('input', () => {
    s.value = Number(slider.value);
    show();
  });
  show();
  const url = sheetUrl(st, name);
  const move = moveFor(name, charDef());
  stops.push(animate((now) => {
    const f = Math.floor((now / 1000) * 60);
    const index = move ? frameAt(built, Math.min(move.total - 1, f % (move.total + 20)), move.total) : frameAt(built, f);
    drawFrame({ canvas, url, clip: built, refHeight: st.manifest!.refHeight, index, uniform: true, zoom: current() / was });
  }));
  const save = async () => {
    const options: ClipOptions = { ...(st.clipOptions[name] ?? {}) };
    options.size = s.value === 'auto' ? 'auto' : Math.abs(s.value - 1) < 0.005 ? undefined : Math.round(s.value * 100) / 100;
    if (!(await attempt(() => api.post('/anim/options', { fighter: st.id, clip: name, options })))) return;
    sizing = null;
    render();
    await runTask('anims', { fighter: st.id, clip: name }, `resize and build ${st.id} ${name}`);
  };
  return h('div', { class: 'trim' },
    canvas,
    h('div', { class: 'size-slider' }, slider, readout),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small primary', onclick: save }, 'Save & rebuild'),
      h('button', {
        type: 'button', class: `btn small${s.value === 'auto' ? ' primary' : ''}`, title: 'Size the fighter to match their Standing pose (measured when the clip builds)',
        onclick: () => { s.value = 'auto'; slider.value = String(current()); show(); },
      }, 'Auto'),
      h('button', { type: 'button', class: 'btn small', title: 'As the video is (100%)', onclick: () => { s.value = 1; slider.value = '1'; show(); } }, '100%'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => { sizing = null; render(); } }, 'Cancel')),
  );
}

/** The video being trimmed: the take picked in the switcher, else the clip in use. */
function t0(st: FighterState, name: string): { file: string; mtime: number } {
  return trimming?.take ?? st.clipSources[name];
}

function clipCard(st: FighterState, name: string, ch?: CharacterDef): HTMLElement {
  const built = st.manifest?.clips[name];
  const src = st.clipSources[name];
  const takeCount = (st.takes ?? []).filter((t) => t.clip === name).length;
  const isTrimming = trimming?.fighter === st.id && trimming.clip === name && (!!src || !!trimming.take);
  // A take being previewed plays in place of the built clip.
  const browsed = (() => {
    const i = browsing.get(`${st.id}:${name}`) ?? -1;
    return i >= 0 ? takesOf(st, name).list[i] ?? null : null;
  })();
  const isSizing = !!built && sizing?.fighter === st.id && sizing.clip === name && !isTrimming && !browsed;
  const canvas = built && !isTrimming && !browsed && !isSizing ? h('canvas', { class: 'checker' }) : null;
  const sizeOpt = st.clipOptions[name]?.size;
  const badge = built
    ? h('span', { class: 'badge ok' }, `${built.frames} frames`)
    : src
      ? h('span', { class: 'badge warn' }, 'not built')
      : h('span', { class: 'badge' }, 'empty');
  const card = h(
    'div',
    { class: `clip${built ? ' built' : src ? ' source' : ''}${selectedClip === name ? ' selected' : ''}` },
    h('div', { class: 'clip-head' }, h('strong', {}, label(name)), h('code', {}, name), badge,
      h('span', { class: 'clip-tools' },
      (src || browsed) && h('button', {
        type: 'button', class: `btn small trim-btn${isTrimming ? ' primary' : ''}`, title: browsed ? 'Trim this take, then use it' : 'Trim the start and end of this clip',
        onclick: () => {
          if (isTrimming) trimming = null;
          else if (browsed) {
            // A take starts untrimmed: the clip's old trim was for a different video.
            const n = takesOf(st, name).list.indexOf(browsed) + 1;
            trimming = { fighter: st.id, clip: name, start: 0, end: null, take: { file: browsed.file, mtime: browsed.mtime, n } };
          } else {
            const o = st.clipOptions[name] ?? {};
            trimming = { fighter: st.id, clip: name, start: o.start ?? 0, end: o.end ?? null };
          }
          render();
        },
      }, '✂ Trim'),
      built && !browsed && h('button', {
        type: 'button', class: `btn small trim-btn${isSizing ? ' primary' : ''}`,
        title: `Size: ${sizeOpt === 'auto' ? 'auto (matches Standing)' : typeof sizeOpt === 'number' ? `${Math.round(sizeOpt * 100)}%, set by hand` : 'as the video is'}`,
        onclick: () => {
          trimming = null;
          sizing = isSizing ? null : { fighter: st.id, clip: name, value: sizeOpt ?? 1 };
          render();
        },
      }, sizeOpt === 'auto' ? '⤢ Auto' : typeof sizeOpt === 'number' ? `⤢ ${Math.round(sizeOpt * 100)}%` : '⤢ Size'))),
    isTrimming ? trimPanel(st, name)
      : isSizing ? sizePanel(st, name)
      : browsed ? h('video', { src: api.sourceUrl(st.id, browsed.file, browsed.mtime), muted: true, loop: true, autoplay: true, playsinline: true, class: 'checker trim-video', title: `seed ${browsed.seed}` })
      : canvas ?? h('div', { class: 'dropzone', style: 'height:130px;display:grid;place-items:center' }, src ? 'Source ready. Build it.' : 'Drop a video here'),
    isTrimming ? null : takeSwitcher(st, name),
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
      h('button', {
        type: 'button', class: 'btn small', title: 'Queue this clip on the GPU server with the AI Settings defaults. Open the editor (AI…) for prompt, seed and takes.',
        onclick: async () => {
          const type = defaultMethod(st.id, name, gpuSnapshot()?.motions ?? []);
          // A clip that already exists gets takes to pick from instead of being replaced.
          if (await attempt(() => gpu.queue([{ type, fighter: st.id, clip: name, use: src ? 'pick' : 'auto' }]), `Queued ${label(name)} (${type === 'animate' ? 'copying the motion library' : 'from a prompt'}).${src ? ' The takes wait for you to pick.' : ''}`)) await refreshGpu();
        },
      }, 'Generate'),
      h('button', { type: 'button', class: 'btn small', title: 'Prompt, seed, takes and settings for this clip', onclick: () => openEditor(name) }, 'AI…'),
      takeCount > 0 && h('span', { class: 'badge warn', title: 'Generated takes waiting to be picked (Edit)' }, `${takeCount} take${takeCount > 1 ? 's' : ''}`),
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
        drawFrame({ canvas, url, clip: built, refHeight, index, uniform: true });
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
      field('Speed', numberInput(o.speed ?? null, (v) => (o.speed = v ?? undefined), { step: 0.05, min: 0.25, max: 4, placeholder: String(store.clips?.speed?.[name] ?? 1) }), {
        sub: ownPace(name)
          ? `Plays at its own pace in the game: 2 is twice as fast as the video. Blank: this clip’s default (${store.clips?.speed?.[name] ?? 1}, AI Settings).`
          : `Stretched to the move’s timing in the game${move ? ` (${move.total} frames)` : ''}, so speed doesn’t change how long it takes; trim the wind-up (Start) if the hit lands late.`,
      }),
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
  source.append(generateBox(st, name));

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
  return h('div', { class: 'editor' }, source, game, takesCard(st, name));
}

/** What "Generate missing / out of date" would do for each fighter; re-read when their files change. */
const plans = new Map<string, ClipPlan[] | 'loading'>();
let planSig = '';

function planFor(id: string): ClipPlan[] | null {
  const p = plans.get(id);
  if (p === 'loading') return null;
  if (p) return p;
  plans.set(id, 'loading');
  void gpu.clipPlan(id).then((r) => { plans.set(id, r.clips); render(); }).catch(() => plans.delete(id));
  return null;
}

/** The work to bring a fighter's clips up to date: generate, regenerate, build. */
function updateWork(st: FighterState, plan: ClipPlan[]) {
  const missing = plan.filter((c) => c.status === 'missing');
  const needPoses = plan.filter((c) => c.status === 'needs-poses');
  const outdated = plan.filter((c) => c.status === 'outdated');
  const regen = new Set(outdated.map((c) => c.clip));
  const build = plan.filter((c) => !regen.has(c.clip) && st.clipSources[c.clip] && ['waiting', 'stale'].includes(clipStatus(st, c.clip))).map((c) => c.clip);
  return { missing, outdated, build, needPoses };
}

async function updateClips(st: FighterState): Promise<void> {
  const r = await attempt(() => gpu.clipPlan(st.id));
  if (!r) return;
  plans.set(st.id, r.clips);
  const { missing, outdated, build, needPoses } = updateWork(st, r.clips);
  if (!missing.length && !outdated.length && !build.length) {
    toast(needPoses.length
      ? `${needPoses.length} clip${needPoses.length > 1 ? 's' : ''} wait for poses (${[...new Set(needPoses.flatMap((c) => c.poses ?? []))].join(', ')}). Make them in the Poses tab.`
      : `${store.entry(st.id)?.name ?? st.id}’s animations are all up to date.`);
    render();
    return;
  }
  const names = (l: { clip: string }[] | string[]) => l.map((c) => label(typeof c === 'string' ? c : c.clip)).join(', ');
  const live = gpuSnapshot()?.servers.some((s) => s.state === 'running' && s.boot?.stage === 'ready');
  const lines = [
    missing.length && `Generate ${missing.length} missing: ${names(missing)}. Each is used as soon as it's made.`,
    outdated.length && `Regenerate ${outdated.length} out of date (made before AI Settings changed): ${names(outdated)}. Each new take replaces the clip; the old video moves to anims/_old/.`,
    build.length && `Build ${build.length} whose video changed: ${names(build)} (on this computer, no GPU).`,
    needPoses.length && `Skipping ${needPoses.length} that need poses this fighter doesn't have yet (${[...new Set(needPoses.flatMap((c) => c.poses ?? []))].join(', ')}): make them in the Poses tab.`,
  ].filter(Boolean);
  const wait = missing.length + outdated.length && !live ? '\n\nNo GPU server is ready: the GPU jobs wait in the queue until one is.' : '';
  if (!confirm(`${store.entry(st.id)?.name ?? st.id}:\n\n${lines.join('\n\n')}${wait}`)) return;
  const jobs: JobSpec[] = [
    ...missing.map((c): JobSpec => ({ type: defaultMethod(st.id, c.clip, gpuSnapshot()?.motions ?? []), fighter: st.id, clip: c.clip, use: 'auto' })),
    // The same way it was made (its own prompt, its driving video), with today's settings.
    ...outdated.map((c): JobSpec => ({ type: c.type ?? 'i2v', fighter: st.id, clip: c.clip, prompt: c.template, motion: c.type === 'animate' ? c.motion : undefined, use: 'replace' })),
  ];
  if (jobs.length && (await attempt(() => gpu.queue(jobs), `Queued ${jobs.length} clip${jobs.length > 1 ? 's' : ''} for ${store.entry(st.id)?.name ?? st.id}. Progress is in the GPU tab.`))) await refreshGpu();
  for (const n of build) if ((await runTask('anims', { fighter: st.id, clip: n }, `build ${st.id} ${n}`)) !== 0) break;
  plans.delete(st.id);
  render();
}

/** The poses a clip starts and ends on, as this fighter has them (Poses tab). */
function posesField(st: FighterState, clip: string, driving: boolean): HTMLElement | null {
  const c = store.clips;
  const [start, end] = c?.frames?.[clip] ?? [];
  if (!start) return null;
  const img = (p: string) => (p === 'stand' ? st.sides.find((s) => s.chosen) : st.poses?.[p]?.chosen) ?? null;
  const pose = (p: string) => {
    const file = img(p);
    return h('div', { class: 'clip-pose' },
      file ? h('img', { src: api.sourceUrl(st.id, file.file, file.mtime), alt: '' }) : h('span', { class: 'badge warn' }, 'missing'),
      h('span', {}, c?.poses?.[p]?.label ?? p));
  };
  const loop = c?.loops.includes(clip) && start === end;
  const lacking = [...new Set([start, end])].filter((p): p is string => !!p && !img(p));
  return h('div', { class: 'field' }, h('label', {}, 'Poses'),
    h('div', { class: 'row' }, pose(start), h('span', { class: 'muted' }, '→'), end ? pose(end) : h('span', { class: 'muted' }, 'the model decides'),
      loop ? h('span', { class: 'badge ok' }, 'loops') : null),
    h('span', { class: `sub${lacking.length && !driving ? ' warn' : ''}` }, driving
      ? 'With a driving video, the Standing pose is the reference and the video sets the motion.'
      : lacking.length ? `Make ${lacking.map((p) => c?.poses?.[p]?.label ?? p).join(' and ')} in the Poses tab first: the clip starts${end ? ' and ends' : ''} on ${lacking.length > 1 ? 'them' : 'it'}.`
      : loop ? 'Starts and ends on this pose, so it loops cleanly.' : `Starts on ${c?.poses?.[start]?.label}${end ? `, ends on ${c?.poses?.[end]?.label}` : ''}.`));
}

/** A fighter's own driving videos (anims/_motion/), fetched when the editor opens. */
const ownMotions = new Map<string, { clip: string; file: string; mtime: number }[]>();

async function loadOwnMotions(fighter: string): Promise<void> {
  try {
    ownMotions.set(fighter, (await gpu.ownMotions(fighter)).motions);
  } catch {
    ownMotions.set(fighter, []);
  }
}

interface GenDraft {
  /** The driving video: none (from the prompt), the motion library's, or the fighter's own. */
  drive: 'none' | 'library' | 'own';
  type: 'i2v' | 'animate';
  prompt: string;
  negative: string;
  seed: number | null;
  takes: number | null;
  use: 'auto' | 'replace' | 'pick';
  settings: Record<string, number>;
}
const drafts = new Map<string, GenDraft>();

/** Generate this clip on the GPU server, with this job's own prompt and settings. */
function generateBox(st: FighterState, name: string): HTMLElement {
  const g = gpuSnapshot();
  const hasMotion = !!g?.motions.some((m) => m.clip === name);
  const key = `${st.id}:${name}`;
  const startType = defaultMethod(st.id, name, g?.motions ?? []);
  const d = drafts.get(key) ?? { drive: startType === 'animate' ? 'library' : 'none', type: startType, prompt: '', negative: '', seed: null, takes: null, use: st.clipSources[name] ? 'pick' : 'auto', settings: {} };
  drafts.set(key, d);
  // Redraws just this box (the driving video choice changes what it shows).
  let el: HTMLElement | null = null;
  const rerender = () => { if (el?.isConnected) el.replaceWith(generateBox(st, name)); };
  if (!ownMotions.has(st.id)) void loadOwnMotions(st.id).then(() => rerender());
  const own = ownMotions.get(st.id)?.find((m) => m.clip === name);
  const spec = (): JobSpec => ({
    type: d.type, fighter: st.id, clip: name, motion: d.type === 'animate' ? d.drive : undefined,
    prompt: d.prompt.trim() || undefined, negative: d.negative.trim() || undefined,
    seed: d.seed ?? undefined, takes: d.takes ?? undefined, use: d.use,
    settings: Object.keys(d.settings).length ? d.settings : undefined,
  });

  // What this job will send, refreshed as the fields change.
  const sends = h('p', { class: 'hint text' }, '…');
  const knobs = h('dl', { class: 'form' });
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const r = await gpu.preview({ ...spec(), settings: undefined });
        const withMine = await gpu.preview(spec());
        sends.textContent = withMine.prompt;
        sends.title = `Negative: ${withMine.negative}`;
        prompt.placeholder = `Blank: ${r.prompt}`;
        // One box per number the workflow takes; blank uses AI Settings.
        if (!knobs.childElementCount) {
          for (const [k, v] of Object.entries(r.settings)) {
            if (typeof v !== 'number') continue;
            knobs.append(field(k, numberInput(d.settings[k] ?? null, (x) => {
              if (x == null) delete d.settings[k];
              else d.settings[k] = x;
              refresh();
            }, { step: Number.isInteger(v) ? 1 : 0.05, placeholder: String(v) })));
          }
        }
        frames.textContent = `${withMine.frames ?? '?'} frames at ${withMine.fps} fps, ${withMine.size}px`;
      } catch (e) {
        sends.textContent = (e as Error).message;
      }
    }, 250);
  };
  const frames = h('span', { class: 'muted' });
  const prompt = h('textarea', { style: 'min-height:64px' });
  prompt.value = d.prompt;
  prompt.addEventListener('input', () => { d.prompt = prompt.value; refresh(); });
  const negative = h('input', { type: 'text', value: d.negative, placeholder: 'Extra things to avoid for this job: "cape, second sword"' });
  negative.addEventListener('input', () => { d.negative = negative.value; refresh(); });
  if (d.drive === 'library' && !hasMotion) d.drive = 'none';
  if (d.drive === 'own' && !own) d.drive = 'none';
  d.type = d.drive === 'none' ? 'i2v' : 'animate';
  refresh();
  const driveUrl = d.drive === 'library' ? `/api/dev/gpu/motion?clip=${name}` : d.drive === 'own' && own ? gpu.ownMotionUrl(st.id, name, own.mtime) : null;

  return (el = h(
    'div',
    { class: 'card', style: 'background:var(--panel-2)' },
    h('h3', {}, 'Generate with AI', h('span', { class: 'spacer' }), h('a', { class: 'btn small', href: '#ai', title: 'Defaults, this fighter’s description and per-clip actions' }, 'AI Settings')),
    posesField(st, name, d.drive !== 'none'),
    h('div', { class: 'field' }, h('label', {}, 'Driving video (optional)'),
      h('div', { class: 'row' },
        select<GenDraft['drive']>([
          ['none', 'None: animate from the prompt'],
          ...(hasMotion ? [['library', `The motion library’s ${label(name)}`] as [GenDraft['drive'], string]] : []),
          ...(own ? [['own', `${store.entry(st.id)?.name ?? st.id}’s own (${own.file})`] as [GenDraft['drive'], string]] : []),
        ], d.drive, (v) => { d.drive = v; knobs.replaceChildren(); rerender(); }),
        h('button', { type: 'button', class: 'btn small', title: 'A video of the motion: you acting it on a phone is fine. Saved in this fighter’s anims/_motion/ and only used when you pick it.', onclick: async () => {
          const file = await pickFile('video/*');
          if (!file) return;
          if (await attempt(() => gpu.uploadMotion(st.id, name, file), `Saved as ${store.entry(st.id)?.name ?? st.id}’s driving video for ${label(name)}.`)) {
            await loadOwnMotions(st.id);
            d.drive = 'own';
            rerender();
          }
        } }, own ? 'Replace my driving video…' : 'Upload a driving video…')),
      h('span', { class: 'sub' }, d.drive === 'none'
        ? 'Wan makes the motion up from the prompt, so this fighter moves their own way. Attach a driving video to copy a motion exactly (Wan Animate).'
        : `Wan Animate: ${store.entry(st.id)?.name ?? st.id} performs this video’s motion, pose for pose.${CREATURES.has(st.id) ? ' It follows a human skeleton, so it may not suit this fighter.' : ''}`),
      driveUrl ? h('video', { src: driveUrl, muted: true, loop: true, autoplay: true, playsinline: true, style: 'max-width:220px;border-radius:6px' }) : null),
    field('Prompt', prompt, { wide: true, sub: 'Blank uses AI Settings. You can use {name}, {description}, {action} and {background} here too.' }),
    field('Avoid', negative, { wide: true }),
    h('div', { class: 'form' },
      field('Takes', numberInput(d.takes, (v) => (d.takes = v), { min: 1, max: 8, placeholder: 'AI Settings' }), { sub: 'Variations to pick from' }),
      field('Seed', numberInput(d.seed, (v) => (d.seed = v && v > 0 ? Math.round(v) : null), { min: 1, placeholder: 'random' }), { sub: 'Same seed + same settings = same clip' }),
      field('When done', select<GenDraft['use']>([['auto', 'Use it if there’s no clip yet'], ['replace', 'Use the first take now'], ['pick', 'Let me pick a take']], d.use, (v) => (d.use = v)))),
    h('details', {}, h('summary', { class: 'muted' }, 'Settings for this job'), h('p', { class: 'hint' }, 'Blank uses AI Settings (shown greyed). What each one does is explained there.'), knobs),
    h('div', { class: 'field' }, h('label', {}, 'Will send'), sends, frames),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (await attempt(() => gpu.queue([spec()]), 'Queued. Progress is in the GPU tab; takes show up below when done.')) await refreshGpu();
      } }, 'Queue'),
      h('span', { class: 'spacer' }),
      st.clipSources[name] && h('button', {
        type: 'button', class: 'btn', title: 'Every fighter copying this clip will move like this one',
        onclick: async () => {
          if (hasMotion && !confirm(`Replace the motion library's ${name} with ${store.entry(st.id)?.name}'s?`)) return;
          if (await attempt(() => gpu.promote(st.id, name), `${name} is now in the motion library.`)) await refreshGpu();
        },
      }, 'Add to motion library')),
  ));
}

/** Generated takes of this clip, to compare, use, discard or make more like. */
function takesCard(st: FighterState, name: string): HTMLElement | null {
  const takes = (st.takes ?? []).filter((t) => t.clip === name).sort((a, b) => b.mtime - a.mtime);
  if (!takes.length) return null;
  return h(
    'section',
    { class: 'card takes' },
    h('h3', {}, `Takes · ${label(name)}`, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${takes.length} waiting in anims/_takes/`)),
    h('div', { class: 'take-grid' }, ...takes.map((t) => {
      const r = t.recipe;
      return h(
        'div',
        { class: 'take' },
        h('video', { src: api.sourceUrl(st.id, t.file, t.mtime), muted: true, loop: true, autoplay: true, playsinline: true, controls: true, class: 'checker' }),
        h('div', { class: 'muted mono', title: r ? `${r.prompt}\n\n${Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(' · ')}` : '' },
          `seed ${t.seed}${r ? ` · ${r.type === 'animate' ? 'motion' : 'prompt'} · ${r.frames ?? '?'}f` : ''}`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small primary', onclick: async () => {
            if (st.clipSources[name] && !confirm(`Use this take as ${label(name)}? The current video moves to anims/_old/.`)) return;
            if (await attempt(() => gpu.useTake(st.id, name, t.file), `Seed ${t.seed} is now ${label(name)}.`)) await store.refresh();
          } }, 'Use'),
          r && h('button', { type: 'button', class: 'btn small', title: 'Queue more takes with this prompt and these settings (new seeds)', onclick: async () => {
            const job: JobSpec = { type: r.type === 'animate' ? 'animate' : 'i2v', fighter: st.id, clip: name, prompt: r.prompt, settings: r.settings as Record<string, unknown>, takes: 2, use: 'pick', motion: r.type === 'animate' ? (r as { motion?: string }).motion : undefined };
            if (await attempt(() => gpu.queue([job]), 'Queued 2 more like this.')) await refreshGpu();
          } }, 'More like this'),
          h('button', { type: 'button', class: 'btn small', title: 'Move it to anims/_old/', onclick: async () => {
            if (await attempt(() => gpu.discardTake(st.id, t.file))) await store.refresh();
          } }, 'Discard')),
      );
    })),
  );
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
  // A clip's default speed (AI Settings) can change too; clips built before speed was recorded played at 1.
  const sameSpeed = ((built as { speed?: number }).speed ?? 1) === speedOf(st, name);
  return sameFile && sameOptions && sameSpeed ? 'ok' : 'stale';
}

/** The speed a clip is built at: this fighter's own, else the clip's default, else 1. */
export function speedOf(st: FighterState, name: string): number {
  return Math.max(0.25, Math.min(4, st.clipOptions[name]?.speed ?? store.clips?.speed?.[name] ?? 1));
}

/** Clips the game plays at their own pace; the rest are stretched to their timing in the game. */
const OWN_PACE = new Set(['jump', 'jumpsquat']);
function ownPace(name: string): boolean {
  return !!store.clips?.loops.includes(name) || OWN_PACE.has(name);
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
      (() => {
        const plan = planFor(st.id);
        const work = plan ? updateWork(st, plan) : null;
        const n = work ? work.missing.length + work.outdated.length + work.build.length : 0;
        const waits = work?.needPoses.length ? ` · ${work.needPoses.length} need poses` : '';
        const label = !work ? 'Generate missing / out of date…' : n
          ? `Generate missing / out of date (${[work.missing.length && `${work.missing.length} missing`, work.outdated.length && `${work.outdated.length} out of date`, work.build.length && `${work.build.length} to build`].filter(Boolean).join(', ')})${waits}`
          : work.needPoses.length ? `${work.needPoses.length} clips need poses first` : 'All animations up to date';
        return h('button', {
          type: 'button', class: `btn${n ? ' primary' : ''}`,
          title: 'Generates clips that have no animation, regenerates AI-made clips whose prompt AI Settings no longer sends (a changed description or action), and builds videos that changed. Your own imported videos are never replaced.',
          onclick: () => updateClips(st),
        }, label);
      })(),
      waiting.length > 0 && h('button', { type: 'button', class: 'btn', onclick: async () => {
        for (const n of waiting) if ((await runTask('anims', { fighter: st.id, clip: n }, `build ${st.id} ${n}`)) !== 0) break;
      } }, `Build ${waiting.length} waiting`),
      h('button', { type: 'button', class: 'btn', disabled: !Object.keys(st.clipSources).length, onclick: () => runTask('anims', { fighter: st.id }, `rebuild every ${st.id} clip`) }, 'Rebuild all clips'),
      h('button', {
        type: 'button', class: 'btn', disabled: !Object.keys(st.clipSources).length,
        title: 'Size every clip so the fighter matches their Standing pose (the dashed line on each card), then rebuild. Clips you sized by hand keep their size.',
        onclick: () => autoSizeAll(st),
      }, 'Auto-size all'),
      h('a', { class: 'btn', href: `/_anim_preview/${st.id}.png?v=${Date.now()}`, target: '_blank', rel: 'noopener' }, 'Contact sheet'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => window.open(`/Game/?play&fighter=${st.id}&vs=dummy`, 'dod-playtest') }, 'Playtest'),
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
      // Files or settings changed: work the plans out again.
      const sig = JSON.stringify(store.state?.fighters.map((f) => [f.id, f.clipSources, Object.keys(f.manifest?.clips ?? {})]));
      if (sig !== planSig) {
        planSig = sig;
        plans.clear();
      }
      if (!root.hidden) render();
    });
    // A clip job finishing leaves new videos and takes in the art folder: read them in.
    let finished = new Set<string>();
    let seeded = false;
    watchGpu((s) => {
      const now = new Set(s.jobs.filter((j) => (j.type === 'i2v' || j.type === 'animate') && j.status === 'done').map((j) => j.id));
      const fresh = seeded && [...now].some((id) => !finished.has(id));
      seeded = true;
      finished = now;
      if (fresh) void store.refresh();
    });
  },
  show() {
    // AI Settings may have changed while away, and new clips may be in the art folders.
    plans.clear();
    render();
    void store.refresh();
  },
};
