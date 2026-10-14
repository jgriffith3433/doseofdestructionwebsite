// The generation queue. Jobs run one at a time on the GPU server:
//
//   side     front art -> side-view candidates     anims/_side-<seed>.png
//   i2v      side view + prompt -> clip takes      anims/_takes/<clip>-<seed>.mp4
//   animate  side view + motion library clip -> the same motion by this fighter
//   paint    a stage piece's blockout + concept -> painted art takes
//            stages/<id>/_takes/<piece>-<seed>.webp (tools/maps/paint.mjs)
//
// Prompts and settings come from content/generation.json (settings.mjs), with
// a job's own overrides on top. Every output keeps a .json beside it with the
// exact prompt, seed and settings, so a take can be made again. A clip take is
// used straight away when the fighter has no video for that clip yet (or the
// job says to); otherwise it waits in _takes/ for the artist to pick.
// The queue is saved to .cache/gpu/jobs.json, each job's graphs to
// .cache/gpu/graphs/ (they load into ComfyUI as they are).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './env.mjs';
import { Comfy } from './comfy.mjs';
import { comfyEndpoint, currentPrice } from './aws.mjs';
import { animate, imageToVideo, paintOver, sideView } from './workflows.mjs';
import { loadGeneration, paintSettings, resolve } from './settings.mjs';
import { dropTake, finishTake, preparePiece } from '../maps/paint.mjs';

const FILE = path.join(ROOT, '.cache', 'gpu', 'jobs.json');
const TMP = path.join(ROOT, '.cache', 'gpu', 'tmp');
export const GRAPHS = path.join(ROOT, '.cache', 'gpu', 'graphs');
const python = process.platform === 'win32' ? 'python' : 'python3';
const VIDEO = ['.mp4', '.mov', '.webm', '.mkv', '.gif', '.avi'];
const MAX_TAKES = 8;
/** Which models each job type loads: Qwen-Image-Edit, or one of the two Wan setups. */
const FAMILY = { side: 'qwen', paint: 'qwen', i2v: 'wan-i2v', animate: 'wan-animate' };

export class Jobs {
  /**
   * folderFor(id, create) gives a fighter's art folder, info(fighter, clip)
   * their { name, action, seconds }, and clipNames() the clips the game knows.
   */
  constructor({ folderFor, info, clipNames }) {
    this.folderFor = folderFor;
    this.info = info;
    this.clipNames = clipNames;
    this.jobs = this.load();
    this.running = null;
    this.abort = null;
    void this.pump();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      // A job mid-flight when the dev server stopped goes back in the line; it keeps
      // the outputs it finished and makes only the rest.
      for (const j of list) {
        if (j.status !== 'running') continue;
        Object.assign(j, { status: 'queued', detail: `picked up again after a dev server restart (${j.outputs?.length ?? 0} done)`, resumed: (j.resumed ?? 0) + 1 });
        j.log.push(j.detail);
      }
      return list;
    } catch {
      return [];
    }
  }

  /** Stops this queue for good (the dev server is restarting and a new one takes over). */
  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    this.abort?.abort();
  }

  save() {
    if (this.disposed) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.jobs.slice(-300), null, 1));
  }

  list() {
    return this.jobs;
  }

  /**
   * What a job would send, without queueing it: prompt, negative, settings, frames.
   * gen and actions/seconds let devtools preview edits it hasn't saved.
   */
  preview(spec, { gen, actions, seconds } = {}) {
    this.validate(spec);
    const info = this.info(spec.fighter, spec.clip);
    if (spec.clip && actions?.[spec.clip] !== undefined) info.action = actions[spec.clip];
    if (spec.clip && seconds?.[spec.clip] !== undefined) info.seconds = seconds[spec.clip];
    const r = resolve(spec, info, gen ?? undefined);
    return { ...r, frames: spec.type === 'i2v' ? i2vFrames(r) : spec.type === 'animate' ? r.settings.maxFrames ?? 77 : null };
  }

  validate(spec) {
    if (!['side', 'i2v', 'animate', 'paint'].includes(spec.type)) throw new Error(`Unknown job type: ${spec.type}`);
    if (spec.type === 'paint') {
      if (!/^[a-z0-9-]+$/.test(spec.stage ?? '') || !/^[a-z0-9-]+$/.test(spec.piece ?? '')) throw new Error('A paint job needs a stage and a piece');
    } else if (spec.type !== 'side' && !this.clipNames().has(spec.clip)) throw new Error(`Unknown clip: ${spec.clip}`);
    if (spec.seed != null && !(Number.isInteger(spec.seed) && spec.seed > 0 && spec.seed < 2 ** 48)) throw new Error('A seed is a whole number above 0');
    if (spec.use && !['auto', 'replace', 'pick'].includes(spec.use)) throw new Error(`Unknown use: ${spec.use}`);
  }

  /** Adds jobs to the queue; returns them. */
  add(specs) {
    const list = Array.isArray(specs) ? specs : [specs];
    for (const spec of list) this.validate(spec);
    const defaultTakes = Number(loadGeneration().takes) || 1;
    const paint = paintSettings();
    const added = list.map((spec) => ({
      id: crypto.randomBytes(6).toString('hex'),
      type: spec.type,
      fighter: spec.type === 'paint' ? undefined : spec.fighter,
      stage: spec.type === 'paint' ? spec.stage : undefined,
      piece: spec.type === 'paint' ? spec.piece : undefined,
      clip: spec.type === 'side' || spec.type === 'paint' ? undefined : spec.clip,
      prompt: spec.prompt?.trim() || undefined,
      negative: spec.negative?.trim() || undefined,
      settings: spec.settings && typeof spec.settings === 'object' ? spec.settings : undefined,
      seed: spec.seed ?? undefined,
      // The stage piece varies most between seeds (and is scored on fit), so it gets more takes.
      takes: spec.type === 'side' ? undefined : Math.max(1, Math.min(MAX_TAKES, Number(spec.takes) || (spec.type === 'paint' ? (spec.piece === 'stage' ? paint.stageTakes : paint.takes) : defaultTakes))),
      use: spec.type === 'side' || spec.type === 'paint' ? undefined : spec.use ?? 'auto',
      seconds: spec.seconds ?? undefined,
      motion: spec.motion ?? undefined,
      status: 'queued',
      detail: '',
      log: [],
      created: Date.now(),
    }));
    this.jobs.push(...added);
    this.save();
    void this.pump();
    return added;
  }

  /** Queues a job again: the same settings, a new seed unless sameSeed. */
  rerun(id, { sameSeed = false } = {}) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error('No such job');
    const seed = sameSeed ? j.seeds?.[0] ?? j.seed : undefined;
    return this.add([{ ...pick(j, ['type', 'fighter', 'stage', 'piece', 'clip', 'prompt', 'negative', 'settings', 'takes', 'use', 'seconds', 'motion']), seed }])[0];
  }

  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.status === 'queued') Object.assign(j, { status: 'cancelled', detail: 'cancelled before it started' });
    if (j.status === 'running') this.abort?.abort();
    this.save();
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    this.save();
  }

  async pump() {
    if (this.running || this.checking || this.disposed) return;
    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return;
    // Jobs wait in the queue until the server is up and set up; check again shortly.
    let endpoint;
    this.checking = true;
    try {
      endpoint = await comfyEndpoint();
    } catch (e) {
      for (const j of this.jobs) if (j.status === 'queued') j.detail = `waiting: ${e.message}`;
      this.save();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.pump(), 30_000);
      return;
    } finally {
      this.checking = false;
    }
    if (this.running || next.status !== 'queued') return void this.pump();
    this.running = next;
    this.abort = new AbortController();
    // Resumed jobs keep what they already made.
    Object.assign(next, { status: 'running', started: Date.now(), detail: 'connecting to the GPU server', seeds: (next.seeds ?? []).slice(0, next.outputs?.length ?? 0), outputs: next.outputs ?? [], graphs: next.graphs ?? [] });
    this.save();
    try {
      const comfy = new Comfy(endpoint);
      // The server keeps models on the GPU between jobs (fast), but image and video models
      // don't fit together: switching family unloads the last one first.
      const family = FAMILY[next.type];
      if (this.family !== family) {
        this.step(next, 'unloading the last models to make room');
        await comfy.free().catch(() => undefined);
      }
      this.family = family;
      // Paint jobs work out their own prompt from the stage (tools/maps/paint.mjs).
      if (next.type !== 'paint') next.resolved = resolve(next, this.info(next.fighter, next.clip));
      await this[next.type](next, comfy);
      Object.assign(next, { status: 'done', finished: Date.now() });
    } catch (e) {
      Object.assign(next, { status: e.message === 'Cancelled' ? 'cancelled' : 'failed', detail: e.message, finished: Date.now() });
      next.log.push(`error: ${e.message}`);
    } finally {
      if (next.gpuSeconds) next.cost = Math.round((next.gpuSeconds / 3600) * (await currentPrice().catch(() => 0)) * 1000) / 1000;
      this.running = null;
      this.abort = null;
      this.save();
      void this.pump();
    }
  }

  step(job, detail) {
    job.detail = detail;
    job.log.push(detail);
    this.save();
  }

  animsDir(fighter, sub = '') {
    const dir = path.join(this.folderFor(fighter, true), 'anims', sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The best reference for a fighter: their chosen side view, else the front cutout. */
  reference(fighter) {
    const side = path.join(this.animsDir(fighter), '_side.png');
    if (fs.existsSync(side)) return { file: side, side: true };
    return { file: path.join(ROOT, 'characters', 'img', `${fighter}.png`), side: false };
  }

  /** Runs one graph, keeping a copy of it; returns its output files. */
  async run(job, comfy, graph) {
    fs.mkdirSync(GRAPHS, { recursive: true });
    const name = `${job.id}-${job.graphs.length + 1}.json`;
    fs.writeFileSync(path.join(GRAPHS, name), JSON.stringify(graph, null, 1));
    job.graphs.push(name);
    const t = Date.now();
    const result = await comfy.run(graph, { signal: this.abort.signal, onProgress: (d) => { job.detail = d; } });
    job.gpuSeconds = (job.gpuSeconds ?? 0) + (Date.now() - t) / 1000;
    if (!result.files.length) throw new Error('The workflow finished without saving anything');
    return result.files;
  }

  /** The seed for the n-th output: the job's own seed counts up, otherwise random. */
  seed(job, n) {
    const s = job.seed ? job.seed + n : crypto.randomInt(1, 2 ** 31);
    job.seeds.push(s);
    return s;
  }

  /** Writes an output and its recipe. */
  keep(job, dest, buffer, seed) {
    fs.writeFileSync(dest, buffer);
    const r = job.resolved;
    const recipe = { job: job.id, type: job.type, fighter: job.fighter, clip: job.clip, seed, prompt: r.prompt, negative: r.negative, settings: r.settings, size: r.size, fps: r.fps, frames: job.frames, created: Date.now() };
    fs.writeFileSync(dest.replace(/\.[^.]+$/, '.json'), JSON.stringify(recipe, null, 1));
    job.outputs.push(path.basename(dest));
  }

  // ------------------------------------------------------------- job types

  async side(job, comfy) {
    const { prompt, settings: s } = job.resolved;
    const count = s.count ?? 4;
    const res = String(s.resolution ?? 1024);
    const input = tmp(`${job.fighter}-front.png`);
    await prep(['frame', path.join(ROOT, 'characters', 'img', `${job.fighter}.png`), input, res, res, String(s.fill ?? 0.86)]);
    this.step(job, 'uploading the front view');
    const image = await comfy.upload(fs.readFileSync(input), `${job.fighter}-front.png`);
    for (let i = job.outputs.length; i < count; i++) {
      const seed = this.seed(job, i);
      this.step(job, `side view ${i + 1} of ${count}`);
      const files = await this.run(job, comfy, sideView({ image, prompt, seed, prefix: `dod/${job.fighter}-side`, s }));
      this.keep(job, path.join(this.animsDir(job.fighter), `_side-${seed}.png`), await comfy.download(files[0]), seed);
    }
    this.step(job, `${count} side view${count > 1 ? 's' : ''} ready to choose from`);
  }

  async upRef(job, comfy, fill) {
    const { size } = job.resolved;
    const ref = this.reference(job.fighter);
    const input = tmp(`${job.fighter}-ref.png`);
    await prep(['frame', ref.file, input, String(size), String(size), String(fill ?? 0.78)]);
    this.step(job, `uploading the ${ref.side ? 'side view' : 'front view (no side view chosen yet)'}`);
    return comfy.upload(fs.readFileSync(input), `${job.fighter}-ref.png`);
  }

  async i2v(job, comfy) {
    const r = job.resolved;
    const image = await this.upRef(job, comfy, r.settings.fill);
    job.frames = i2vFrames(r);
    await this.takes(job, comfy, (seed) =>
      imageToVideo({ image, prompt: r.prompt, negative: r.negative, width: r.size, height: r.size, frames: job.frames, fps: r.fps, seed, prefix: `dod/${job.fighter}-${job.clip}`, s: r.settings }));
  }

  async animate(job, comfy) {
    const r = job.resolved;
    const motionSrc = job.motion ? path.resolve(job.motion) : motionPath(this.folderFor, job.clip);
    if (!fs.existsSync(motionSrc)) throw new Error(`The motion library has no ${job.clip}. Add a good ${job.clip} clip to it first (clip editor).`);
    const reference = await this.upRef(job, comfy, r.settings.fill);
    const motionInput = tmp(`${job.clip}-motion.mp4`);
    const count = Number((await prep(['motion', motionSrc, motionInput, String(r.size), String(r.size), String(r.settings.maxFrames ?? 77), String(r.fps)])).trim());
    // Animate makes 4n + 1 frames, no more than the driving video has.
    job.frames = Math.max(5, Math.floor((count - 1) / 4) * 4 + 1);
    this.step(job, 'uploading the motion');
    const motion = await comfy.upload(fs.readFileSync(motionInput), `${job.clip}-motion.mp4`);
    await this.takes(job, comfy, (seed) =>
      animate({ reference, motion, prompt: r.prompt, negative: r.negative, width: r.size, height: r.size, frames: job.frames, fps: r.fps, seed, prefix: `dod/${job.fighter}-${job.clip}`, s: r.settings }));
  }

  /**
   * Paints a stage piece over its blockout, styled on the concept: job.takes
   * takes. Pieces that sit on the collision are painted in two passes (a
   * partial repaint of the colored blockout keeps their flat, straight-on
   * shapes; a lighter one adds detail), keeping whichever pass lands on the
   * platforms better, and a take that misses the fit target is painted again
   * with a new seed (up to the retry limit). Settings: AI Settings, Painting
   * stages (content/generation.json "paint"); a job's settings override them.
   * See docs/comfyui.md.
   */
  async paint(job, comfy) {
    const prep = await preparePiece(job.stage, job.piece, { prompt: job.prompt, tmpDir: TMP });
    const P = paintSettings();
    // The same model and speed LoRA as side views, so their sampler settings apply.
    const side = loadGeneration().side ?? {};
    const flat = prep.piece.kind !== 'backdrop';
    const s = {
      steps: side.steps, cfg: side.cfg, shift: side.shift, lora: side.lora, sampler: side.sampler, scheduler: side.scheduler,
      ...(flat ? { denoise: P.pass, refine: P.detail } : {}),
      ...(job.settings ?? {}),
    };
    const fits = prep.piece.kind === 'stage';
    const target = fits ? Number(s.fitTarget ?? P.fitTarget) : 0;
    const retries = fits ? Math.round(Number(s.retries ?? P.retries)) : 0;
    job.resolved = { prompt: prep.prompt, negative: '', settings: s, size: prep.size[0], fps: 0, seconds: 0 };
    this.step(job, `uploading the ${prep.piece.kind} blockout and the concept`);
    const blockout = await comfy.upload(fs.readFileSync(prep.blockout), `${job.stage}-${job.piece}-blockout.png`);
    const reference = await comfy.upload(fs.readFileSync(prep.reference), `${job.stage}-reference${path.extname(prep.reference)}`);
    const n = job.takes ?? 2;
    const size = { width: prep.size[0], height: prep.size[1], prefix: `dod/${job.stage}-${job.piece}` };
    job.fits ??= [];
    let tries = 0;
    for (let i = job.outputs.length; i < n; ) {
      // Spaced so a fixed seed's retries never land on the next take's seed.
      const seed = this.seed(job, i * 10 + tries);
      const label = `take ${i + 1} of ${n}${tries ? ` (retry ${tries})` : ''}`;
      this.step(job, `painting ${job.piece}, ${label} (${prep.size.join('x')})`);
      const first = await comfy.download((await this.run(job, comfy, paintOver({ images: [blockout, reference], prompt: prep.prompt, seed, s, ...size })))[0]);
      let buffer = first;
      if (s.refine > 0 && s.refine < 1) {
        this.step(job, `adding detail to ${label}`);
        const up = await comfy.upload(first, `${job.stage}-${job.piece}-pass1.png`);
        const detail = `Refine image 1 without moving anything: keep every shape, edge, outline and position exactly, and keep it a flat, straight-on side view. Add rich detail, texture, materials and lighting: ${prep.prompt}`;
        buffer = await comfy.download((await this.run(job, comfy, paintOver({ images: [up, reference], prompt: detail, seed: seed + 1, s: { ...s, denoise: s.refine }, ...size })))[0]);
      }
      this.step(job, prep.cutout ? 'cutting it out' : 'saving it');
      let take = await finishTake(prep, buffer, seed, { job: job.id, settings: s });
      if (fits && buffer !== first && take.fit !== null) {
        // The detail pass can tilt the piece off the platforms: keep pass 1 if it lands much better.
        const plain = await finishTake(prep, first, seed, {}, { scoreOnly: true });
        if (plain.fit !== null && plain.fit - take.fit > 0.15) {
          take = await finishTake(prep, first, seed, { job: job.id, settings: { ...s, refine: 0 }, kept: 'pass 1 (the detail pass moved it off the platforms)' });
          job.log.push(`take ${i + 1}: kept pass 1, it fits ${Math.round(plain.fit * 100)}% vs ${Math.round((take.fit ?? 0) * 100)}%`);
        }
      }
      if (fits && take.fit !== null && take.fit < target && tries < retries) {
        // Off the collision: paint it again with a new seed (it doesn't count as a take).
        job.log.push(`${label} fits ${Math.round(take.fit * 100)}%, below ${Math.round(target * 100)}%: trying another seed`);
        dropTake(job.stage, take.name);
        tries++;
        continue;
      }
      job.outputs.push(take.name);
      job.fits.push(take.fit);
      tries = 0;
      i++;
    }
    const scored = job.fits.filter((f) => f !== null);
    this.step(job, `${n} take${n > 1 ? 's' : ''} of ${job.piece} ready in the Maps tab${scored.length ? ` (best fits ${Math.round(Math.max(...scored) * 100)}%)` : ''}`);
  }

  /** Makes job.takes takes into anims/_takes/, then uses the first if the job says to. */
  async takes(job, comfy, build) {
    const n = job.takes ?? 1;
    const dir = this.animsDir(job.fighter, '_takes');
    // Takes a resumed job already saved count.
    const made = job.outputs.map((f) => path.join(dir, f));
    for (let i = made.length; i < n; i++) {
      const seed = this.seed(job, i);
      this.step(job, `take ${i + 1} of ${n}: ${job.frames} frames`);
      const files = await this.run(job, comfy, build(seed));
      const dest = path.join(dir, `${job.clip}-${seed}.mp4`);
      this.keep(job, dest, await comfy.download(files[0]), seed);
      made.push(dest);
    }
    const has = this.current(job.fighter, job.clip);
    if (job.use === 'replace' || (job.use === 'auto' && !has)) {
      await this.useTake(job.fighter, job.clip, path.basename(made[0]), job);
      this.step(job, `${n > 1 ? `${n} takes saved; the first is` : 'saved and'} in the game as ${job.clip}`);
    } else {
      this.step(job, `${n} take${n > 1 ? 's' : ''} ready to review in the clip editor`);
    }
  }

  /** The fighter's current video for a clip, if any. */
  current(fighter, clip) {
    const dir = this.animsDir(fighter);
    return fs.readdirSync(dir).find((f) => VIDEO.includes(path.extname(f).toLowerCase()) && path.basename(f, path.extname(f)).toLowerCase() === clip) ?? null;
  }

  /** Makes a take the clip: the old video moves to anims/_old/, then it builds. */
  async useTake(fighter, clip, file, job = null) {
    if (!this.clipNames().has(clip)) throw new Error(`Unknown clip: ${clip}`);
    const takes = this.animsDir(fighter, '_takes');
    const src = path.join(takes, path.basename(file));
    if (!fs.existsSync(src) || !path.basename(file).startsWith(`${clip}-`)) throw new Error('No such take');
    const dir = this.animsDir(fighter);
    const old = this.current(fighter, clip);
    if (old) {
      const ext = path.extname(old);
      this.animsDir(fighter, '_old');
      fs.renameSync(path.join(dir, old), path.join(dir, '_old', `${clip}-${Date.now()}${ext}`));
    }
    fs.copyFileSync(src, path.join(dir, `${clip}.mp4`));
    if (job) this.step(job, 'building the clip for the game');
    const out = await runPython(['-u', '_build_anims.py', fighter, '--clip', clip]);
    job?.log.push(...out.trim().split(/\r?\n/).slice(-4));
    return out;
  }

  /** Moves a take (and its recipe) out of the way, into anims/_old/. */
  discardTake(fighter, file) {
    const takes = this.animsDir(fighter, '_takes');
    const base = path.basename(file);
    if (!/^[a-z0-9]+-\d+\.mp4$/i.test(base)) throw new Error('No such take');
    const old = this.animsDir(fighter, '_old');
    for (const f of [base, base.replace(/\.mp4$/i, '.json')]) {
      if (fs.existsSync(path.join(takes, f))) fs.renameSync(path.join(takes, f), path.join(old, `take-${f}`));
    }
  }
}

function i2vFrames(r) {
  // Wan wants 4n + 1 frames.
  return Math.max(5, Math.round((r.seconds * r.fps) / 4) * 4 + 1);
}

export function motionPath(folderFor, clip) {
  const root = path.dirname(folderFor('exit-punk', true));
  return path.join(root, '_motions', `${clip}.mp4`);
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

function tmp(name) {
  fs.mkdirSync(TMP, { recursive: true });
  return path.join(TMP, name);
}

function prep(args) {
  return runPython([path.join(ROOT, 'tools', 'gpu', 'prep.py'), ...args]);
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().slice(-500) || `python exited ${code}`))));
  });
}
