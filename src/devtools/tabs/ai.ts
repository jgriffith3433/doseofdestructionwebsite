// AI Settings: every prompt and setting the GPU workflows use, in
// content/generation.json (anything left out uses the defaults in
// tools/gpu/settings.mjs), plus each clip's action and length in
// content/anim-clips.json. Fighter overrides win over the defaults, and a
// job's own settings (clip editor) win over both. The preview shows exactly
// what a job would send, including edits not saved yet.

import { h } from '../../game/ui/dom.ts';
import { api, store } from '../api.ts';
import { gpu, type Resolved } from '../gpu.ts';
import { attempt, checkbox, field, numberInput, select, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

type Type = 'side' | 'pose' | 'i2v' | 'animate';
type Section = Record<string, number | string | boolean>;
interface FighterGen {
  description?: string;
  method?: 'animate' | 'i2v';
  negative?: string;
  clips?: Record<string, string>;
  /** Their own wording for poses (the Poses tab edits these). */
  poses?: Record<string, string>;
  side?: Section;
  pose?: Section;
  i2v?: Section;
  animate?: Section;
}
interface Gen {
  _about?: string;
  /** Painting stage pieces (tools/maps/paint.mjs). */
  paint?: Section;
  size?: number;
  fps?: number;
  takes?: number;
  background?: string;
  negative?: string;
  side?: Section;
  pose?: Section;
  i2v?: Section;
  animate?: Section;
  fighters: Record<string, FighterGen>;
}
interface ClipFile {
  loops: string[];
  once: string[];
  moves: string[];
  labels: Record<string, string>;
  actions?: Record<string, string>;
  seconds?: Record<string, number>;
  speed?: Record<string, number>;
  poses?: Record<string, { label: string; action: string }>;
  frames?: Record<string, [string, string | null]>;
  [k: string]: unknown;
}
type Defaults = Required<Omit<Gen, '_about' | 'fighters'>>;

interface Field {
  k: string;
  label: string;
  kind?: 'num' | 'bool' | 'sampler' | 'scheduler';
  step?: number;
  hint?: string;
}

const SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'dpmpp_3m_sde', 'uni_pc', 'uni_pc_bh2', 'lcm', 'res_multistep', 'ddim'];
const SCHEDULERS = ['simple', 'normal', 'karras', 'exponential', 'sgm_uniform', 'beta', 'linear_quadratic', 'kl_optimal', 'ddim_uniform'];

const STEPS_HINT = 'The speed LoRAs are tuned for this many steps. More steps help only with the LoRA turned down.';
const CFG_HINT = '1 with the speed LoRAs (they bake guidance in). Raise it, to 3 to 5, only with the LoRA at 0 and 20+ steps.';
const FIELDS: Record<Type, Field[]> = {
  side: [
    { k: 'count', label: 'Candidates per job', step: 1 },
    { k: 'steps', label: 'Steps', step: 1, hint: STEPS_HINT },
    { k: 'cfg', label: 'CFG', step: 0.1, hint: CFG_HINT },
    { k: 'shift', label: 'Shift', step: 0.1, hint: 'Higher keeps more of the original image’s structure.' },
    { k: 'lora', label: 'Lightning LoRA strength', step: 0.05 },
    { k: 'sampler', label: 'Sampler', kind: 'sampler' },
    { k: 'scheduler', label: 'Scheduler', kind: 'scheduler' },
    { k: 'resolution', label: 'Working size (px)', step: 64 },
    { k: 'fill', label: 'Figure height in frame', step: 0.01, hint: 'Share of the frame the fighter fills before editing (0.3 to 1).' },
  ],
  pose: [
    { k: 'count', label: 'Candidates per job', step: 1 },
    { k: 'steps', label: 'Steps', step: 1, hint: STEPS_HINT },
    { k: 'cfg', label: 'CFG', step: 0.1, hint: CFG_HINT },
    { k: 'shift', label: 'Shift', step: 0.1, hint: 'Higher keeps more of the side view’s structure (size, framing).' },
    { k: 'lora', label: 'Lightning LoRA strength', step: 0.05 },
    { k: 'sampler', label: 'Sampler', kind: 'sampler' },
    { k: 'scheduler', label: 'Scheduler', kind: 'scheduler' },
    { k: 'front', label: 'Also send the front art', kind: 'bool', hint: 'Off: Standing is the only reference, for the most consistent poses. On: the front art goes in as image 2, for details the side view hides (mention image 2 in the prompt).' },
  ],
  i2v: [
    { k: 'steps', label: 'Steps', step: 1, hint: STEPS_HINT },
    { k: 'split', label: 'Low-noise model from step', step: 1, hint: 'Wan 2.2 runs a high-noise model for the first steps (motion), then a low-noise one (detail).' },
    { k: 'loraVersion', label: 'Speed LoRA version', step: 1, hint: '1: the original Wan 2.2 Lightning v1 (known for slow, still motion). 2: lightx2v’s newer 4-step LoRAs (1022), which move more.' },
    { k: 'cfgHigh', label: 'CFG, high-noise stage', step: 0.1, hint: 'Guidance while the motion is decided. 1 with the speed LoRA at full strength; about 2 with it at 0.7. Higher makes the prompt count more, too high morphs and bleeds the background color.' },
    { k: 'motionAmplitude', label: 'Motion boost (PainterI2V)', step: 0.05, hint: 'Clips with no end pose only: 1 is off; 1.15 to 1.4 pushes more motion out of the 4-step LoRAs.' },
    { k: 'endFrame', label: 'Pin the end pose', step: 1, hint: '1: clips end on their end pose (loops loop). 0: only the start is pinned: freer motion, but the end can wander.' },
    { k: 'motionSteps', label: 'Motion steps without the speed LoRA', step: 1, hint: 'The first steps run on the plain high-noise model, where the motion is decided, so the prompt really steers it. 0: all steps use the speed LoRAs (fast, but motion comes out flat). About 2.' },

    { k: 'cfg', label: 'CFG', step: 0.1, hint: CFG_HINT },
    { k: 'shift', label: 'Shift', step: 0.1 },
    { k: 'loraHigh', label: 'Speed LoRA (high noise)', step: 0.05, hint: 'Lower it for bigger, freer motion (and raise steps).' },
    { k: 'loraLow', label: 'Speed LoRA (low noise)', step: 0.05 },
    { k: 'sampler', label: 'Sampler', kind: 'sampler' },
    { k: 'scheduler', label: 'Scheduler', kind: 'scheduler' },
    { k: 'fill', label: 'Figure height in frame', step: 0.01, hint: 'Leave headroom for jumps and big swings.' },
  ],
  animate: [
    { k: 'steps', label: 'Steps', step: 1, hint: STEPS_HINT },
    { k: 'cfg', label: 'CFG', step: 0.1, hint: CFG_HINT },
    { k: 'shift', label: 'Shift', step: 0.1 },
    { k: 'lora', label: 'Lightx2v LoRA strength', step: 0.05 },
    { k: 'sampler', label: 'Sampler', kind: 'sampler' },
    { k: 'scheduler', label: 'Scheduler', kind: 'scheduler' },
    { k: 'maxFrames', label: 'Most frames', step: 4, hint: 'The motion clip is cut to this (4n + 1 frames).' },
    { k: 'hands', label: 'Follow hands', kind: 'bool' },
    { k: 'face', label: 'Follow the face', kind: 'bool', hint: 'Off for masked or faceless fighters.' },
    { k: 'poseResolution', label: 'Pose detail (px)', step: 64 },
    { k: 'fill', label: 'Figure height in frame', step: 0.01 },
  ],
};
const TITLES: Record<Type, [string, string]> = {
  side: ['Side view (Standing pose)', 'Qwen-Image-Edit 2511: turns the front art into the Standing pose, the side view every other pose and clip is made from.'],
  pose: ['Poses', 'Qwen-Image-Edit 2511: the Standing pose (and the front art) -> the fighter crouching, in the air, guarding… {action} is the pose (or the fighter’s own note for it).'],
  i2v: ['From a prompt', 'Wan 2.2 image-to-video: animates from the clip’s start pose to its end pose (first-last frame), from the prompt. {frames} says which poses.'],
  animate: ['Copy the motion library', 'Wan 2.2 Animate: the fighter performs a motion library clip, matched by pose.'],
};

let root: HTMLElement;
let defaults: Defaults | null = null;
let gen: Gen = { fighters: {} };
let clips: ClipFile | null = null;
let dirty = { gen: false, clips: false };
let fighter = '';
const look = { type: 'i2v' as Type, fighter: '', clip: 'jab' };
let previewEl: HTMLElement | null = null;
let previewTimer = 0;

const allClips = () => (clips ? [...clips.loops, ...clips.once, ...clips.moves] : []);
const label = (c: string) => clips?.labels[c] ?? c;

function changed(which: 'gen' | 'clips'): void {
  dirty[which] = true;
  saveBar();
  schedulePreview();
}

/** A setting's control. get() is the value set here (undefined: inherited), fallback what it inherits. */
function control(f: Field, get: () => unknown, set: (v: unknown) => void, fallback: unknown): HTMLElement {
  if (f.kind === 'bool') {
    const opts: ['inherit' | 'on' | 'off', string][] = [['inherit', `Default (${fallback ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']];
    const v = get();
    return select(opts, v === undefined ? 'inherit' : v ? 'on' : 'off', (x) => set(x === 'inherit' ? undefined : x === 'on'));
  }
  if (f.kind === 'sampler' || f.kind === 'scheduler') {
    const list = f.kind === 'sampler' ? SAMPLERS : SCHEDULERS;
    const v = get() as string | undefined;
    const opts: [string, string][] = [['', `Default (${fallback})`], ...list.map((x): [string, string] => [x, x])];
    if (v && !list.includes(v)) opts.push([v, v]);
    return select(opts, v ?? '', (x) => set(x || undefined));
  }
  return numberInput(get() as number | undefined, (v) => set(v ?? undefined), { step: f.step ?? 1, placeholder: String(fallback ?? '') });
}

/** Sets or clears one key of an object, dropping the object when it empties. */
function put(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === '' || value === null) delete obj[key];
  else obj[key] = value;
}

function typeCard(type: Type): HTMLElement {
  const d = defaults![type] as Section;
  const mine = (gen[type] ??= {}) as Section;
  const [title, about] = TITLES[type];
  const prompt = h('textarea', { style: 'min-height:96px' });
  prompt.value = (mine.prompt as string) ?? (d.prompt as string);
  prompt.addEventListener('input', () => {
    put(mine, 'prompt', prompt.value.trim() === String(d.prompt).trim() ? undefined : prompt.value);
    changed('gen');
  });
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, title, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', title: 'Back to the defaults for this section', onclick: () => { gen[type] = {}; changed('gen'); render(); } }, 'Reset')),
    h('p', { class: 'hint' }, about),
    field('Prompt', prompt, { wide: true, sub: 'Use {name}, {description}, {action} and {background}.' }),
    h('dl', { class: 'form' }, ...FIELDS[type].filter((f) => f.k !== 'prompt').map((f) =>
      field(f.label, control(f, () => mine[f.k], (v) => { put(mine, f.k, v === d[f.k] ? undefined : v); changed('gen'); }, d[f.k]), { sub: f.hint }))),
  );
}

/** Painting stages: what docs/comfyui.md found works, as settings. */
const PAINT_FIELDS: Field[] = [
  { k: 'pass', label: 'Shape pass strength', step: 0.01, hint: 'How much pass 1 repaints the blockout. It’s a cliff: at 0.80 takes land on the platforms (fit 0.86–0.97); at 0.82 they already tilt (fit about 0.5). Keep 0.80 or lower.' },
  { k: 'detail', label: 'Detail pass strength', step: 0.05, hint: 'Pass 2 adds texture and light over pass 1. More detail, more risk of tilting (then pass 1 is kept). 0 skips it.' },
  { k: 'stageTakes', label: 'Takes: the stage', step: 1, hint: 'The piece you stand on varies most between seeds, so it gets more takes to pick from.' },
  { k: 'takes', label: 'Takes: other pieces', step: 1 },
  { k: 'fitTarget', label: 'Fit target', step: 0.05, hint: 'A stage take that lands on the platforms worse than this is painted again with a new seed. 0 keeps every take.' },
  { k: 'retries', label: 'Retries per take', step: 1, hint: 'How many new seeds to try before keeping a take that misses the fit target.' },
  { k: 'mood', label: 'Mood board size (px)', step: 8, hint: 'The concept reaches the painter shrunk to this and blurred: smaller keeps only palette and light, larger starts copying its layout.' },
  { k: 'windows', label: 'Window grids on facades', kind: 'bool', hint: 'Seeds big building walls with lit windows so the painter has something to build on.' },
];

function paintCard(): HTMLElement {
  const d = (defaults as unknown as { paint: Section }).paint ?? {};
  const mine = (gen.paint ??= {}) as Section;
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Painting stages', h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => { gen.paint = {}; changed('gen'); render(); } }, 'Reset')),
    h('p', { class: 'hint' }, 'Qwen-Image-Edit paints each stage piece over its blockout (Maps → Paint). These are the defaults that worked on City Top; why each one matters is in docs/comfyui.md.'),
    h('dl', { class: 'form' }, ...PAINT_FIELDS.map((f) =>
      field(f.label, control(f, () => mine[f.k], (v) => { put(mine, f.k, v === d[f.k] ? undefined : v); changed('gen'); }, d[f.k]), { sub: f.hint }))),
  );
}

function globalCard(): HTMLElement {
  const d = defaults!;
  const text = (key: 'background' | 'negative', min = 60) => {
    const t = h('textarea', { style: `min-height:${min}px` });
    t.value = (gen[key] as string) ?? d[key];
    t.addEventListener('input', () => {
      put(gen as unknown as Record<string, unknown>, key, t.value.trim() === d[key].trim() ? undefined : t.value);
      changed('gen');
    });
    return t;
  };
  const num = (key: 'size' | 'fps' | 'takes', step: number) =>
    numberInput((gen[key] as number | undefined), (v) => { put(gen as unknown as Record<string, unknown>, key, v === d[key] ? undefined : v ?? undefined); changed('gen'); }, { step, placeholder: String(d[key]) });
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Every job'),
    h('dl', { class: 'form' },
      field('Clip size (px)', num('size', 16), { sub: 'Square. 640 is the sweet spot for Wan on this GPU; 720+ is slower and needs more memory.' }),
      field('Frames per second', num('fps', 1), { sub: 'Wan makes 16.' }),
      field('Takes per clip job', num('takes', 1), { sub: 'Variations to choose from (each costs GPU time).' })),
    field('Background ({background})', text('background'), { wide: true, sub: 'Flat green keys out cleanly; keep it unless keying struggles with a green fighter.' }),
    field('Negative prompt (video)', text('negative', 90), { wide: true, sub: 'What to steer away from. The Chinese part is Wan’s own recommended list.' }),
  );
}

function clipsCard(): HTMLElement {
  if (!clips) return h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Loading clips…'));
  const c = clips;
  return h(
    'section',
    { class: 'card wide-card' },
    h('h3', {}, 'Clips ({action})'),
    h('p', { class: 'hint' }, 'What each clip shows, and how long a prompt clip is. Saved to content/anim-clips.json.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Clip'), h('th', {}, 'Action'), h('th', {}, 'Starts on'), h('th', {}, 'Ends on'), h('th', { title: 'How long a prompt clip is made' }, 'Seconds'), h('th', { title: 'Playback speed when the video becomes frames: 2 is twice as fast. Matters for loops and jumps; moves are stretched to their timing.' }, 'Speed'))),
      h('tbody', {}, ...allClips().map((name) => {
        const action = h('input', { type: 'text', value: c.actions?.[name] ?? '', placeholder: name, style: 'width:100%' });
        action.addEventListener('input', () => { (c.actions ??= {})[name] = action.value; changed('clips'); });
        return h('tr', {},
          h('td', {}, h('strong', {}, label(name)), ' ', h('code', {}, name)),
          h('td', { style: 'width:50%' }, action),
          ...([0, 1] as const).map((i) => {
            const poses = Object.entries(c.poses ?? {}).map(([id, p]): [string, string] => [id, p.label]);
            const now = c.frames?.[name] ?? ['stand', null];
            const opts: [string, string][] = i === 0 ? poses : [['', i === 1 && c.loops.includes(name) ? 'free (won’t loop)' : 'free'], ...poses];
            return h('td', {}, select<string>(opts, now[i] ?? '', (v) => {
              const f = ((c.frames ??= {})[name] ??= [now[0], now[1]]);
              f[i] = (v || null) as string;
              changed('clips');
            }));
          }),
          h('td', {}, numberInput(c.seconds?.[name], (v) => { if (v == null) delete c.seconds?.[name]; else (c.seconds ??= {})[name] = v; changed('clips'); }, { step: 0.5, min: 0.5, max: 6, style: 'width:70px' })),
          h('td', {}, numberInput(c.speed?.[name] ?? null, (v) => { if (v == null || v === 1) delete c.speed?.[name]; else (c.speed ??= {})[name] = Math.max(0.25, Math.min(4, v)); changed('clips'); }, { step: 0.05, min: 0.25, max: 4, placeholder: '1', style: 'width:64px' })));
      })))),
  );
}

/** The pose library: what each pose is, used by every fighter (their own notes are in the Poses tab). */
function posesCard(): HTMLElement {
  if (!clips?.poses) return h('section', { class: 'card' }, h('p', { class: 'hint' }, 'Loading poses…'));
  const poses = clips.poses;
  return h('section', { class: 'card wide-card' },
    h('h3', {}, 'Poses ({action} for poses)'),
    h('p', { class: 'hint' }, 'The stills every fighter has, side view facing right: clips start and end on them (the Starts on and Ends on columns below). Standing is the side view. A fighter’s own note for a pose (Poses tab) replaces this wording for them. Saved to content/anim-clips.json.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Pose'), h('th', {}, 'Name'), h('th', {}, 'What it looks like'))),
      h('tbody', {}, ...Object.entries(poses).map(([id, p]) => {
        const lbl = h('input', { type: 'text', value: p.label, style: 'width:120px' });
        lbl.addEventListener('input', () => { p.label = lbl.value; changed('clips'); });
        const act = h('input', { type: 'text', value: p.action, style: 'width:100%' });
        act.addEventListener('input', () => { p.action = act.value; changed('clips'); });
        return h('tr', {}, h('td', {}, h('code', {}, id)), h('td', {}, lbl), h('td', { style: 'width:70%' }, act));
      })))),
  );
}

function fighterCard(): HTMLElement {
  if (!fighter) fighter = store.selected || store.fighters[0]?.id || '';
  const f = (gen.fighters[fighter] ??= {});
  const d = defaults!;
  const tidy = () => {
    for (const k of ['side', 'pose', 'i2v', 'animate', 'clips', 'poses'] as const) if (f[k] && !Object.keys(f[k]!).length) delete f[k];
    if (!Object.keys(f).length) delete gen.fighters[fighter];
  };
  const area = (key: 'description' | 'negative', placeholder: string) => {
    const t = h('textarea', { placeholder, style: 'min-height:60px' });
    t.value = f[key] ?? '';
    t.addEventListener('input', () => { put(f as Record<string, unknown>, key, t.value.trim() || undefined); tidy(); changed('gen'); });
    return t;
  };
  const sidePrompt = h('textarea', { placeholder: 'Blank: the default side view prompt', style: 'min-height:60px' });
  sidePrompt.value = (f.side?.prompt as string) ?? '';
  sidePrompt.addEventListener('input', () => { put((f.side ??= {}) as Record<string, unknown>, 'prompt', sidePrompt.value.trim() || undefined); tidy(); changed('gen'); });
  const overrides = (type: Type) => h('details', {},
    h('summary', {}, `${TITLES[type][0]} settings for this fighter${f[type] && Object.keys(f[type]!).filter((k) => k !== 'prompt').length ? ' (changed)' : ''}`),
    h('dl', { class: 'form' }, ...FIELDS[type].map((fl) => {
      const inherited = (gen[type] as Section | undefined)?.[fl.k] ?? (d[type] as Section)[fl.k];
      return field(fl.label, control(fl, () => f[type]?.[fl.k], (v) => { put((f[type] ??= {}) as Record<string, unknown>, fl.k, v); tidy(); changed('gen'); }, inherited));
    })));
  return h(
    'section',
    { class: 'card wide-card' },
    h('h3', {}, 'Per fighter', h('span', { class: 'spacer' }),
      select(store.fighters.map((x): [string, string] => [x.id, `${x.name}${gen.fighters[x.id] && Object.keys(gen.fighters[x.id]).length ? ' •' : ''}`]), fighter, (v) => { tidy(); fighter = v; look.fighter = v; render(); })),
    h('p', { class: 'hint' }, 'Anything set here wins over the defaults for this fighter only. A • in the list marks fighters with overrides.'),
    h('div', { class: 'cards' },
      h('div', {},
        field('Description ({description})', area('description', 'What they look like, in a few words: "a lanky punk in a ripped leather jacket and a green mohawk". Helps the model keep them on model.'), { wide: true }),
        field('Make clips by', select<string>([['', 'Default (prompts; attach a driving video per clip if you want)'], ['animate', 'Copying the motion library where it has the clip'], ['i2v', 'Prompts only']], f.method ?? '', (v) => { put(f as Record<string, unknown>, 'method', v || undefined); tidy(); changed('gen'); })),
        field('Extra negative prompt', area('negative', 'Added to the negative prompt for this fighter: "extra arms, cape"'), { wide: true }),
        field('Side view prompt', sidePrompt, { wide: true })),
      h('div', {},
        h('label', { class: 'label' }, 'Actions for this fighter'),
        h('p', { class: 'hint' }, 'Replace {action} for one clip: "a quick jab with the left fist, sparks fly".'),
        h('div', { style: 'max-height:320px;overflow:auto' }, ...allClips().map((name) => {
          const input = h('input', { type: 'text', value: f.clips?.[name] ?? '', placeholder: clips?.actions?.[name] ?? name, style: 'width:100%' });
          input.addEventListener('input', () => { put((f.clips ??= {}) as Record<string, unknown>, name, input.value.trim() || undefined); tidy(); changed('gen'); });
          return h('div', { class: 'field' }, h('label', {}, label(name)), input);
        })))),
    overrides('side'), overrides('i2v'), overrides('animate'),
  );
}

function previewCard(): HTMLElement {
  if (!look.fighter) look.fighter = fighter || store.selected || store.fighters[0]?.id || '';
  previewEl = h('div', {}, h('p', { class: 'hint' }, 'Working it out…'));
  const card = h(
    'section',
    { class: 'card wide-card' },
    h('h3', {}, 'Preview: what a job sends'),
    h('div', { class: 'row' },
      select<Type>([['i2v', 'From a prompt'], ['animate', 'Copy the motion library'], ['side', 'Side view']], look.type, (v) => { look.type = v; render(); }),
      select(store.fighters.map((x): [string, string] => [x.id, x.name]), look.fighter, (v) => { look.fighter = v; schedulePreview(0); }),
      look.type !== 'side' ? select(allClips().map((c): [string, string] => [c, label(c)]), look.clip, (v) => { look.clip = v; schedulePreview(0); }) : null),
    previewEl,
  );
  schedulePreview(0);
  return card;
}

function schedulePreview(delay = 300): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void showPreview(), delay);
}

async function showPreview(): Promise<void> {
  const el = previewEl;
  if (!el || !look.fighter) return;
  try {
    const r: Resolved = await gpu.preview(
      { type: look.type, fighter: look.fighter, clip: look.type === 'side' ? undefined : look.clip },
      { generation: gen, actions: clips?.actions, seconds: clips?.seconds },
    );
    el.replaceChildren(
      field('Prompt', h('p', { class: 'text', style: 'margin:0' }, r.prompt), { wide: true }),
      h('details', {}, h('summary', { class: 'muted' }, 'Negative prompt'), h('p', { class: 'text muted' }, r.negative)),
      h('p', { class: 'hint mono' }, Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(' · '),
        ` · ${r.size}px · ${r.fps} fps${r.frames ? ` · ${r.frames} frames (${(r.frames / r.fps).toFixed(1)}s)` : ''}`),
    );
  } catch (e) {
    el.replaceChildren(h('p', { class: 'hint warn' }, (e as Error).message));
  }
}

let bar: HTMLElement | null = null;
function saveBar(): void {
  if (!bar) return;
  const any = dirty.gen || dirty.clips;
  bar.replaceChildren(
    h('span', { class: any ? 'badge warn' : 'badge ok' }, any ? 'Unsaved changes' : 'Saved'),
    h('button', { type: 'button', class: 'btn primary', disabled: !any, onclick: save }, 'Save'),
    h('button', { type: 'button', class: 'btn', disabled: !any, onclick: () => { if (confirm('Throw away the changes since the last save?')) void load(); } }, 'Discard'),
  );
}

async function save(): Promise<void> {
  // Drop empty sections so the file only holds real choices.
  const out: Gen = JSON.parse(JSON.stringify(gen));
  for (const k of ['side', 'i2v', 'animate', 'paint'] as const) if (out[k] && !Object.keys(out[k]!).length) delete out[k];
  for (const [id, f] of Object.entries(out.fighters)) if (!Object.keys(f).length) delete out.fighters[id];
  const ok = await attempt(async () => {
    if (dirty.gen) await api.save('generation', out);
    if (dirty.clips && clips) {
      for (const [k, v] of Object.entries(clips.actions ?? {})) if (!v.trim()) delete clips.actions![k];
      await api.save('anim-clips', clips);
    }
    return true;
  });
  if (ok) {
    dirty = { gen: false, clips: false };
    toast('AI settings saved. New jobs use them.');
    saveBar();
    void store.refresh();
  }
}

async function load(): Promise<void> {
  const [d, g, c] = await Promise.all([
    api.get<{ defaults: Defaults }>('/gpu/defaults'),
    api.content<Gen>('generation').catch(() => ({ fighters: {} }) as Gen),
    api.content<ClipFile>('anim-clips'),
  ]);
  defaults = d.defaults;
  gen = { ...g, fighters: g.fighters ?? {} };
  clips = c;
  dirty = { gen: false, clips: false };
  render();
}

function render(): void {
  if (!defaults) {
    root.replaceChildren(h('div', { class: 'main' }, h('p', { class: 'muted' }, 'Loading AI settings…')));
    return;
  }
  bar = h('div', { class: 'row' });
  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h('header', {}, h('h2', {}, 'AI Settings'), h('span', { class: 'muted' }, 'Prompts and settings for side views and clips. Saved to content/generation.json.'), h('span', { class: 'spacer' }), bar),
      h('div', { class: 'cards' }, previewCard(), globalCard(), typeCard('side'), typeCard('pose'), typeCard('i2v'), typeCard('animate'), paintCard(), fighterCard(), posesCard(), clipsCard()),
    ),
  );
  saveBar();
}

export const aiTab: Tab = {
  mount(el) {
    root = el;
    el.style.display = 'block';
    render();
    void load().catch((e) => toast((e as Error).message, 'error'));
  },
  show() {
    if (!dirty.gen && !dirty.clips && defaults) void load();
  },
};
