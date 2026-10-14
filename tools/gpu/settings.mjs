// Generation settings: content/generation.json, edited in devtools (AI
// Settings). resolve() turns the defaults, a fighter's overrides and a job's
// own settings into exactly what a job sends to ComfyUI, so the preview in
// devtools and the job itself never disagree.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

const FILE = path.join(ROOT, 'content', 'generation.json');

/** What every setting is unless content/generation.json says otherwise. They follow the official templates. */
export const DEFAULTS = {
  "size": 640,
  "fps": 16,
  "takes": 1,
  "background": "Plain flat pure green background, no floor, no shadow, even studio lighting.",
  "negative": "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走, camera movement, zoom, pan, cut, background change, floor, shadow, extra limbs",
  "side": {
    "prompt": "Show this exact character in full-body side profile view, turned to face right, standing in a relaxed fighting stance. Keep exactly the same character design: the same face, hair, outfit, colors, proportions and art style. {description} The whole body is visible from head to feet. {background}",
    "count": 4,
    "steps": 4,
    "cfg": 1,
    "shift": 3.1,
    "lora": 1,
    "sampler": "euler",
    "scheduler": "simple",
    "resolution": 1024,
    "fill": 0.86
  },
  "i2v": {
    "prompt": "{name}, {description}, {action}. Side view, facing right, full body, staying in place in the center of the frame. Locked camera, no camera movement. {background} Clear, readable motion for a fighting game.",
    "steps": 4,
    "split": 2,
    "cfg": 1,
    "shift": 5,
    "loraHigh": 1,
    "loraLow": 1,
    "sampler": "euler",
    "scheduler": "simple",
    "fill": 0.78
  },
  "animate": {
    "prompt": "{name}, {description}, {action}. Side view, facing right. {background}",
    "steps": 6,
    "cfg": 1,
    "shift": 8,
    "lora": 1,
    "sampler": "euler",
    "scheduler": "simple",
    "maxFrames": 77,
    "hands": true,
    "face": true,
    "poseResolution": 512,
    "fill": 0.78
  },
  "paint": {
    "pass": 0.8,
    "detail": 0.6,
    "takes": 2,
    "stageTakes": 4,
    "fitTarget": 0.75,
    "retries": 2,
    "mood": 40,
    "windows": true
  }
};

/** The numeric and switch settings each job type takes, with their limits. */
export const LIMITS = {
  side: { count: [1, 8], steps: [1, 60], cfg: [0, 20], shift: [0, 20], lora: [0, 2], resolution: [512, 1536], fill: [0.3, 1] },
  i2v: { steps: [1, 60], split: [1, 59], cfg: [0, 20], shift: [0, 20], loraHigh: [0, 2], loraLow: [0, 2], fill: [0.3, 1] },
  animate: { steps: [1, 60], cfg: [0, 20], shift: [0, 20], lora: [0, 2], maxFrames: [5, 161], poseResolution: [256, 1024], fill: [0.3, 1] },
  paint: { pass: [0.5, 1], detail: [0, 0.9], takes: [1, 8], stageTakes: [1, 8], fitTarget: [0, 1], retries: [0, 6], mood: [8, 400] },
};
const SWITCHES = { animate: ['hands', 'face'], paint: ['windows'] };
const TEXT = ['sampler', 'scheduler'];

/** content/generation.json over DEFAULTS (one level deep, so a section can set just one value). */
export function withDefaults(raw = {}) {
  const out = { ...DEFAULTS, ...raw, fighters: raw.fighters ?? {} };
  for (const type of Object.keys(LIMITS)) out[type] = { ...DEFAULTS[type], ...(raw[type] ?? {}) };
  return out;
}

/** Settings for painting stage pieces (tools/maps/paint.mjs, Jobs.paint), clamped. */
export function paintSettings(gen = loadGeneration()) {
  return { ...DEFAULTS.paint, ...clean('paint', withDefaults(gen).paint) };
}

export function loadGeneration() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // No file yet, or a bad edit: the defaults still work.
  }
  return withDefaults(raw);
}

/** Fills {name}, {description}, {action} and {background}, then tidies the gaps empty ones leave. */
export function render(template, vars) {
  return String(template)
    .replace(/\{(name|description|action|background)\}/g, (_, k) => vars[k] ?? '')
    .replace(/\s*,\s*(?=[,.])/g, '')
    .replace(/\.\s*\./g, '.')
    .replace(/^[\s,.]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Keeps known settings only, clamped to their limits. */
function clean(type, raw = {}) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS[type])) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  }
  for (const k of SWITCHES[type] ?? []) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  for (const k of TEXT) if (typeof raw[k] === 'string' && /^[a-z0-9_]+$/i.test(raw[k])) out[k] = raw[k];
  return out;
}

/**
 * Everything a job needs: { prompt, negative, settings, size, fps, seconds }.
 * job: { type, fighter, clip?, prompt?, negative?, settings?, seconds? }
 * info: { name, action, seconds } for this fighter and clip.
 */
export function resolve(job, info, gen = loadGeneration()) {
  gen = withDefaults(gen);
  const type = job.type;
  if (!LIMITS[type]) throw new Error(`Unknown job type: ${type}`);
  const fighter = gen.fighters?.[job.fighter] ?? {};
  const settings = { ...clean(type, gen[type]), ...clean(type, fighter[type]), ...clean(type, job.settings) };
  const vars = {
    name: info.name,
    description: fighter.description?.trim() ?? '',
    action: (job.clip && fighter.clips?.[job.clip]?.trim()) || info.action || job.clip || '',
    background: gen.background ?? '',
  };
  const template = job.prompt?.trim() || fighter[type]?.prompt?.trim() || gen[type]?.prompt || '';
  const extra = [fighter.negative, job.negative].map((s) => s?.trim()).filter(Boolean);
  return {
    prompt: render(template, vars),
    negative: [gen.negative, ...extra].filter(Boolean).join(', '),
    settings,
    size: Math.round(Number(gen.size) / 16) * 16 || 640,
    fps: Number(gen.fps) || 16,
    seconds: Number(job.seconds ?? info.seconds) || 2,
  };
}

/** The method a fighter uses for a clip unless a job says otherwise. */
export function methodFor(gen, fighter) {
  const m = gen.fighters?.[fighter]?.method;
  return m === 'i2v' || m === 'animate' ? m : null;
}
