// The generation queue. Each ready GPU server runs one job at a time, so with
// several servers (the GPU tab's "Servers to use") jobs run side by side:
//
//   side     front art -> side-view candidates     anims/_side-<seed>.png
//            (the "Standing" pose; anims/_side.png once chosen)
//   pose     side view + front art -> a pose       poses/_takes/<pose>-<seed>.png
//            (crouching, in the air...; poses/<pose>.png once chosen)
//   i2v      start pose (+ end pose) + prompt -> clip takes  anims/_takes/<clip>-<seed>.mp4
//            Each clip starts on a pose and usually ends on one (content/anim-clips.json
//            "frames"): loops on the same pose, so they loop; moves back to their stance.
//   animate  side view + a driving video -> the same motion by this fighter
//            (opt-in: the shared motion library's clip, or the fighter's own
//            upload in anims/_motion/; otherwise clips come from prompts, i2v)
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
import { comfyEndpoints, fleetStatus, startServer } from './aws.mjs';
import { loadFleet } from './fleet.mjs';
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
const FAMILY = { side: 'qwen', pose: 'qwen', paint: 'qwen', i2v: 'wan-i2v', animate: 'wan-animate' };

export class Jobs {
  /**
   * folderFor(id, create) gives a fighter's art folder, info(fighter, clip, pose)
   * their { name, action, seconds, frames, start, end } (start and end: the
   * clip's poses), clipNames() the clips the game knows and poseNames() the poses.
   */
  constructor({ folderFor, info, clipNames, poseNames }) {
    this.folderFor = folderFor;
    this.info = info;
    this.clipNames = clipNames;
    this.poseNames = poseNames;
    this.jobs = this.load();
    /** Server id -> the job running on it. */
    this.busy = new Map();
    /** Job id -> its AbortController. */
    this.aborts = new Map();
    /** Server id -> the model family it last loaded. */
    this.families = new Map();
    /** Post-processing that touches a fighter's shared files runs one at a time. */
    this.serial = Promise.resolve();
    this.lastAutoStart = 0;
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
    for (const a of this.aborts.values()) a.abort();
  }

  save() {
    if (this.disposed) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Keep every job still to do; trim only finished ones (the newest 300 of those).
    const active = (j) => j.status === 'queued' || j.status === 'running';
    const finished = this.jobs.filter((j) => !active(j)).slice(-300);
    const keep = new Set([...this.jobs.filter(active), ...finished]);
    fs.writeFileSync(FILE, JSON.stringify(this.jobs.filter((j) => keep.has(j)), null, 1));
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
    const info = this.info(spec.fighter, spec.clip, spec.pose);
    if (spec.clip && actions?.[spec.clip] !== undefined) info.action = actions[spec.clip];
    if (spec.clip && seconds?.[spec.clip] !== undefined) info.seconds = seconds[spec.clip];
    const r = resolve(spec, info, gen ?? undefined);
    return { ...r, frames: spec.type === 'i2v' ? i2vFrames(r) : spec.type === 'animate' ? r.settings.maxFrames ?? 77 : null };
  }

  validate(spec) {
    if (!['side', 'pose', 'i2v', 'animate', 'paint'].includes(spec.type)) throw new Error(`Unknown job type: ${spec.type}`);
    if (spec.type === 'paint') {
      if (!/^[a-z0-9-]+$/.test(spec.stage ?? '') || !/^[a-z0-9-]+$/.test(spec.piece ?? '')) throw new Error('A paint job needs a stage and a piece');
    } else if (spec.type === 'pose') {
      // Standing is the side view (a side job).
      if (!this.poseNames().has(spec.pose) || spec.pose === 'stand') throw new Error(`Unknown pose: ${spec.pose}`);
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
      clip: spec.type === 'side' || spec.type === 'paint' || spec.type === 'pose' ? undefined : spec.clip,
      pose: spec.type === 'pose' ? spec.pose : undefined,
      prompt: spec.prompt?.trim() || undefined,
      negative: spec.negative?.trim() || undefined,
      settings: spec.settings && typeof spec.settings === 'object' ? spec.settings : undefined,
      seed: spec.seed ?? undefined,
      // The stage piece varies most between seeds (and is scored on fit), so it gets more takes.
      takes: spec.type === 'side' ? undefined : Math.max(1, Math.min(MAX_TAKES, Number(spec.takes) || (spec.type === 'paint' ? (spec.piece === 'stage' ? paint.stageTakes : paint.takes) : spec.type === 'pose' ? Number(loadGeneration().pose?.count) || 2 : defaultTakes))),
      use: spec.type === 'side' || spec.type === 'paint' || spec.type === 'pose' ? undefined : spec.use ?? 'auto',
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
    return this.add([{ ...pick(j, ['type', 'fighter', 'stage', 'piece', 'clip', 'pose', 'prompt', 'negative', 'settings', 'takes', 'use', 'seconds', 'motion']), seed }])[0];
  }

  cancel(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.status === 'queued') Object.assign(j, { status: 'cancelled', detail: 'cancelled before it started' });
    if (j.status === 'running') this.aborts.get(j.id)?.abort();
    this.save();
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    this.save();
  }

  /** Starts queued jobs on every ready server that is free; checks again shortly while jobs wait. */
  async pump() {
    if (this.disposed) return;
    // A pump already checking the servers goes round again when it's done.
    if (this.pumping) {
      this.again = true;
      return;
    }
    if (!this.jobs.some((j) => j.status === 'queued')) return;
    this.pumping = true;
    this.again = false;
    let endpoints;
    try {
      endpoints = await comfyEndpoints();
    } catch (e) {
      endpoints = [];
      this.waitReason = e.message;
    } finally {
      this.pumping = false;
    }
    if (this.disposed) return;
    if (this.again) return void this.pump();
    const limit = loadFleet().servers;
    let free = endpoints.filter((ep) => !this.busy.has(ep.id));
    // Never more jobs at once than "Servers to use" allows.
    free = free.slice(0, Math.max(0, limit - this.busy.size));
    for (const ep of free) {
      const next = this.jobs.find((j) => j.status === 'queued');
      if (!next) break;
      void this.runOn(next, ep);
    }
    const waiting = this.jobs.filter((j) => j.status === 'queued');
    if (waiting.length) {
      const why = endpoints.length
        ? `waiting for a free GPU server (${this.busy.size} of ${endpoints.length} busy)`
        : `waiting: ${this.waitReason ?? 'no GPU server is ready. Start one in the GPU tab.'}`;
      for (const j of waiting) j.detail = why;
      this.save();
      if (!endpoints.length || endpoints.length < Math.min(limit, waiting.length + this.busy.size)) void this.autoStart(waiting.length + this.busy.size);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.pump(), endpoints.length ? 10_000 : 30_000);
    }
  }

  /**
   * With "start servers by themselves" on: starts stopped servers (already set
   * up) until there is one per job, up to "Servers to use". Never launches new
   * ones. At most once every two minutes.
   */
  async autoStart(want) {
    const fleet = loadFleet();
    if (!fleet.auto || Date.now() - this.lastAutoStart < 120_000) return;
    this.lastAutoStart = Date.now();
    try {
      const all = await fleetStatus();
      const up = all.filter((st) => ['running', 'pending'].includes(st.state)).length;
      const need = Math.min(fleet.servers, want) - up;
      const stopped = all.filter((st) => st.state === 'stopped').slice(0, Math.max(0, need));
      for (const st of stopped) {
        await startServer(st.id).catch((e) => console.warn(`[gpu] couldn't start ${st.id}: ${e.message}`));
      }
      if (stopped.length) console.log(`[gpu] started ${stopped.length} server${stopped.length > 1 ? 's' : ''} for the queue`);
    } catch (e) {
      console.warn(`[gpu] auto start: ${e.message}`);
    }
  }

  async runOn(next, ep) {
    if (this.busy.has(ep.id) || next.status !== 'queued') return;
    this.busy.set(ep.id, next);
    const abort = new AbortController();
    this.aborts.set(next.id, abort);
    // Resumed jobs keep what they already made.
    Object.assign(next, {
      status: 'running', started: Date.now(), detail: `connecting to the GPU server in ${ep.region}`, server: ep.id, serverRegion: ep.region,
      seeds: (next.seeds ?? []).slice(0, next.outputs?.length ?? 0), outputs: next.outputs ?? [], graphs: next.graphs ?? [],
    });
    this.save();
    try {
      const comfy = new Comfy(ep);
      // A server keeps models on the GPU between jobs (fast), but image and video models
      // don't fit together: switching family unloads the last one first.
      const family = FAMILY[next.type];
      if (this.families.get(ep.id) !== family) {
        this.step(next, 'unloading the last models to make room');
        await comfy.free().catch(() => undefined);
      }
      this.families.set(ep.id, family);
      // Paint jobs work out their own prompt from the stage (tools/maps/paint.mjs).
      if (next.type !== 'paint') next.resolved = resolve(next, this.info(next.fighter, next.clip, next.pose));
      await this[next.type](next, comfy);
      Object.assign(next, { status: 'done', finished: Date.now() });
    } catch (e) {
      Object.assign(next, { status: e.message === 'Cancelled' ? 'cancelled' : 'failed', detail: e.message, finished: Date.now() });
      next.log.push(`error: ${e.message}`);
    } finally {
      if (next.gpuSeconds) next.cost = Math.round((next.gpuSeconds / 3600) * (ep.price ?? 0) * 1000) / 1000;
      this.busy.delete(ep.id);
      this.aborts.delete(next.id);
      fs.rmSync(path.join(TMP, next.id), { recursive: true, force: true });
      this.save();
      void this.pump();
    }
  }

  /** A scratch file for one job (jobs run side by side, so they never share one). */
  tmp(job, name) {
    const dir = path.join(TMP, job.id);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
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

  /** A fighter's chosen pose image: Standing is the side view (anims/_side.png), the rest poses/<pose>.png. */
  posePath(fighter, pose) {
    return pose === 'stand' ? path.join(this.animsDir(fighter), '_side.png') : path.join(this.folderFor(fighter, true), 'poses', `${pose}.png`);
  }

  /** Frames a pose for video and uploads it. Every pose gets the same framing, so sizes match between them. */
  async upPose(job, comfy, pose, label, fill) {
    const file = this.posePath(job.fighter, pose);
    if (!fs.existsSync(file)) throw new Error(`${this.info(job.fighter).name} has no ${label} pose yet. Make it in the Poses tab first.`);
    const { size } = job.resolved;
    const input = this.tmp(job, `${job.fighter}-${pose}.png`);
    await prep(['frame', file, input, String(size), String(size), String(fill ?? 0.78)]);
    (job.posesUsed ??= {})[pose] = Math.round(fs.statSync(file).mtimeMs);
    return comfy.upload(fs.readFileSync(input), `${job.fighter}-${pose}.png`);
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
    const result = await comfy.run(graph, { signal: this.aborts.get(job.id)?.signal, onProgress: (d) => { job.detail = d; } });
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
    const recipe = { job: job.id, type: job.type, fighter: job.fighter, clip: job.clip, pose: job.pose, poses: job.posesUsed, seed, template: job.prompt ?? null, extraNegative: job.negative ?? null, prompt: r.prompt, negative: r.negative, settings: r.settings, size: r.size, fps: r.fps, frames: job.frames, ...(job.type === 'animate' ? { motion: job.motion ?? 'library' } : {}), created: Date.now() };
    fs.writeFileSync(dest.replace(/\.[^.]+$/, '.json'), JSON.stringify(recipe, null, 1));
    job.outputs.push(path.basename(dest));
  }

  // ------------------------------------------------------------- job types

  async side(job, comfy) {
    const { prompt, settings: s } = job.resolved;
    const count = s.count ?? 4;
    const res = String(s.resolution ?? 1024);
    const input = this.tmp(job, `${job.fighter}-front.png`);
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

  /**
   * A pose, made from the chosen Standing pose (the side view): it is the only
   * reference unless the "front" setting adds the front art for details the
   * side hides. Every pose shares Standing's size and framing. job.takes
   * candidates, to pick from in the Poses tab.
   */
  async pose(job, comfy) {
    const { prompt, settings: s } = job.resolved;
    const count = job.takes ?? s.count ?? 2;
    const side = this.posePath(job.fighter, 'stand');
    if (!fs.existsSync(side)) throw new Error(`${this.info(job.fighter).name} has no standing side view yet: choose one first (Poses tab, Standing).`);
    this.step(job, s.front ? 'uploading the Standing pose and the front art' : 'uploading the Standing pose');
    const image = await comfy.upload(fs.readFileSync(side), `${job.fighter}-side.png`);
    let image2;
    if (s.front) {
      const front = this.tmp(job, `${job.fighter}-front.png`);
      await prep(['frame', path.join(ROOT, 'characters', 'img', `${job.fighter}.png`), front, '1024', '1024', '0.86']);
      image2 = await comfy.upload(fs.readFileSync(front), `${job.fighter}-front.png`);
    }
    const dir = path.join(this.folderFor(job.fighter, true), 'poses', '_takes');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = job.outputs.length; i < count; i++) {
      const seed = this.seed(job, i);
      this.step(job, `${job.pose} ${i + 1} of ${count}`);
      const files = await this.run(job, comfy, sideView({ image, image2, prompt, seed, prefix: `dod/${job.fighter}-${job.pose}`, s }));
      this.keep(job, path.join(dir, `${job.pose}-${seed}.png`), await comfy.download(files[0]), seed);
    }
    this.step(job, `${count} ${job.pose} pose${count > 1 ? 's' : ''} ready to choose from in the Poses tab`);
  }

  async upRef(job, comfy, fill) {
    const { size } = job.resolved;
    const ref = this.reference(job.fighter);
    const input = this.tmp(job, `${job.fighter}-ref.png`);
    await prep(['frame', ref.file, input, String(size), String(size), String(fill ?? 0.78)]);
    this.step(job, `uploading the ${ref.side ? 'side view' : 'front view (no side view chosen yet)'}`);
    return comfy.upload(fs.readFileSync(input), `${job.fighter}-ref.png`);
  }

  /** A clip from its start pose to its end pose (the same pose for a loop), as the prompt says. */
  async i2v(job, comfy) {
    const r = job.resolved;
    const info = this.info(job.fighter, job.clip);
    job.posesUsed = {};
    this.step(job, `uploading the ${info.startLabel ?? 'start'} pose${info.end && info.end !== info.start ? ` and the ${info.endLabel} pose` : ''}`);
    const image = await this.upPose(job, comfy, info.start ?? 'stand', info.startLabel ?? 'Standing', r.settings.fill);
    const pinEnd = info.end && Number(r.settings.endFrame ?? 1) !== 0;
    const end = !pinEnd ? undefined : info.end === info.start ? image : await this.upPose(job, comfy, info.end, info.endLabel, r.settings.fill);
    job.frames = i2vFrames(r);
    await this.takes(job, comfy, (seed) =>
      imageToVideo({ image, end, prompt: r.prompt, negative: r.negative, width: r.size, height: r.size, frames: job.frames, fps: r.fps, seed, prefix: `dod/${job.fighter}-${job.clip}`, s: r.settings }));
  }

  async animate(job, comfy) {
    const r = job.resolved;
    const motionSrc = job.motion ? path.resolve(job.motion) : motionPath(this.folderFor, job.clip);
    if (!fs.existsSync(motionSrc)) throw new Error(`The motion library has no ${job.clip}. Add a good ${job.clip} clip to it first (clip editor).`);
    const reference = await this.upRef(job, comfy, r.settings.fill);
    const motionInput = this.tmp(job, `${job.clip}-motion.mp4`);
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
    const prep = await preparePiece(job.stage, job.piece, { prompt: job.prompt, tmpDir: path.join(TMP, job.id) });
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
      // The same seed again (a rerun, a settings test) gets its own file instead of overwriting.
      // Claim the name by creating it, so two takes finishing at once can't pick the same one.
      let dest = path.join(dir, `${job.clip}-${seed}.mp4`);
      for (let n = 2; ; n++) {
        try {
          fs.closeSync(fs.openSync(dest, 'wx'));
          break;
        } catch {
          dest = path.join(dir, `${job.clip}-${seed}-${n}.mp4`);
        }
      }
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
    // Remember what made the clip, so devtools can tell when AI Settings have moved on.
    const recipe = src.replace(/\.mp4$/i, '.json');
    fs.mkdirSync(path.join(dir, '_recipes'), { recursive: true });
    if (fs.existsSync(recipe)) fs.writeFileSync(path.join(dir, '_recipes', `${clip}.json`), JSON.stringify({ ...JSON.parse(fs.readFileSync(recipe, 'utf8')), take: path.basename(file) }, null, 1));
    else fs.rmSync(path.join(dir, '_recipes', `${clip}.json`), { force: true });
    if (job) this.step(job, 'building the clip for the game');
    // Builds rewrite the fighter's shared manifest, so they take turns.
    const build = this.serial.then(() => runPython(['-u', '_build_anims.py', fighter, '--clip', clip]));
    this.serial = build.catch(() => undefined);
    const out = await build;
    job?.log.push(...out.trim().split(/\r?\n/).slice(-4));
    return out;
  }

  /** Moves a take (and its recipe) out of the way, into anims/_old/. */
  discardTake(fighter, file) {
    const takes = this.animsDir(fighter, '_takes');
    const base = path.basename(file);
    if (!/^[a-z0-9]+-\d+(-\d+)?\.mp4$/i.test(base)) throw new Error('No such take');
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
