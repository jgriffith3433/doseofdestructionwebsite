#!/usr/bin/env node
/**
 * Smooth Season 1 (or any) fighter clips: fringe-clean sheets, prepare source
 * videos for Hawkes Gen video.interpolate ×2, pack interpolated videos back to
 * 30 fps WebP sheets (max side 2048) and half-size sheets for Low quality.
 *
 *   node tools/smooth-clips.mjs --fringe --season1
 *   node tools/smooth-clips.mjs --fringe --fighters exit-punk,kaelen --clips idle,walk
 *   node tools/smooth-clips.mjs --prepare --season1 --clips idle,walk,jab,fsmash
 *   node tools/smooth-clips.mjs --pack --from .hawkes/smooth-out
 *   node tools/smooth-clips.mjs --list --season1 --clips idle,walk,jab,fsmash
 *
 * "run" is accepted as an alias for this game's walk clip.
 * Needs ffmpeg and Pillow (uses .hawkes/venv when present).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANIM = join(ROOT, 'characters', 'anim');
const LIB = join(ROOT, 'tools', 'smooth_clips_lib.py');
const WORK = join(ROOT, '.hawkes', 'smooth-work');
const SRC = join(ROOT, '.hawkes', 'smooth-src');
const OUT = join(ROOT, '.hawkes', 'smooth-out');

export const SEASON_ONE = [
  'exit-punk', 'kaelen', 'break', 'dj-wont-read', 'shutup-bot', 'small-weather',
  'blog-man', 'evil-blue-bird', 'got-ur-back', 'slice', 'ss-boulder', 'stratabots', 'orchestrator',
];

/** The four most-seen clips (brief "run" = walk). */
export const SMOOTH_CLIPS = ['idle', 'walk', 'jab', 'fsmash'];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

function pythonBin() {
  const venv = join(ROOT, '.hawkes', 'venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return 'python3';
}

function py(...argv) {
  const r = spawnSync(pythonBin(), [LIB, ...argv], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `python failed (${r.status})\n`);
    throw new Error(`smooth_clips_lib.py ${argv[0]} failed`);
  }
  return (r.stdout || '').trim();
}

function aliasClip(name) {
  return name === 'run' ? 'walk' : name;
}

function fightersFromArgs() {
  if (has('--season1')) return [...SEASON_ONE];
  const raw = val('--fighters');
  if (!raw) throw new Error('pass --season1 or --fighters a,b');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function clipsFromArgs(fallback = null) {
  const raw = val('--clips');
  if (!raw) return fallback;
  return raw.split(',').map((s) => aliasClip(s.trim())).filter(Boolean);
}

function allClips(fighter) {
  const data = JSON.parse(readFileSync(join(ANIM, fighter, 'anims.json'), 'utf8'));
  return Object.keys(data.clips);
}

function ensureSparse() {
  // characters/anim is often absent in agent sparse checkouts (m_cd7520fb5b38).
  if (!existsSync(join(ANIM, 'exit-punk', 'idle.webp'))) {
    execFileSync('git', ['sparse-checkout', 'add', 'characters/anim'], { cwd: ROOT, stdio: 'inherit' });
  }
}

function fringe() {
  ensureSparse();
  const fighters = fightersFromArgs();
  const only = clipsFromArgs(null);
  let n = 0;
  for (const id of fighters) {
    const clips = only ?? allClips(id);
    for (const clip of clips) {
      process.stdout.write(`fringe ${id}/${clip}… `);
      py('fringe', join(ANIM, id), clip);
      console.log('ok');
      n++;
    }
  }
  console.log(`fringe-cleaned ${n} clips`);
}

function prepare() {
  ensureSparse();
  mkdirSync(SRC, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const fighters = fightersFromArgs();
  const clips = clipsFromArgs(SMOOTH_CLIPS);
  const manifest = [];
  for (const id of fighters) {
    for (const clip of clips) {
      const out = join(SRC, `${id}__${clip}.mp4`);
      const work = join(WORK, `${id}__${clip}`);
      mkdirSync(work, { recursive: true });
      process.stdout.write(`prepare ${id}/${clip}… `);
      const info = JSON.parse(py('prepare', join(ANIM, id), clip, out, work));
      manifest.push(info);
      console.log(`${info.frames}f @ ${info.fps}fps → ${out}`);
    }
  }
  writeFileSync(join(SRC, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`prepared ${manifest.length} videos in ${SRC}`);
  return manifest;
}

function packFromDir(dir = val('--from') || OUT) {
  ensureSparse();
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mp4'));
  let n = 0;
  for (const file of files) {
    // name: fighter__clip.mp4 or fighter__clip__job.mp4
    const base = file.replace(/\.mp4$/i, '');
    const parts = base.split('__');
    if (parts.length < 2) {
      console.warn(`skip ${file}: want fighter__clip.mp4`);
      continue;
    }
    const [id, clip] = [parts[0], aliasClip(parts[1])];
    process.stdout.write(`pack ${id}/${clip} from ${file}… `);
    const out = py('pack', join(ANIM, id), clip, join(dir, file), '30');
    console.log(out || 'ok');
    n++;
  }
  console.log(`packed ${n} interpolated clips`);
}

function listJobs() {
  const fighters = fightersFromArgs();
  const clips = clipsFromArgs(SMOOTH_CLIPS);
  const rows = [];
  for (const id of fighters) {
    for (const clip of clips) {
      rows.push({ fighter: id, clip, video: join(SRC, `${id}__${clip}.mp4`) });
    }
  }
  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

function main() {
  if (has('--fringe')) return fringe();
  if (has('--prepare')) return prepare();
  if (has('--pack')) return packFromDir();
  if (has('--list')) return listJobs();
  console.log(`Usage:
  node tools/smooth-clips.mjs --fringe --season1
  node tools/smooth-clips.mjs --prepare --season1 --clips idle,walk,jab,fsmash
  node tools/smooth-clips.mjs --pack --from .hawkes/smooth-out
  node tools/smooth-clips.mjs --list --season1`);
  process.exit(args.length ? 1 : 0);
}

main();
