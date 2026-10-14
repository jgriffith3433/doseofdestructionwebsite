/**
 * The devtools API. It exists only on `npm run dev` (a Vite plugin with
 * apply: 'serve'), never in a build, and serves devtools.html:
 *
 *   GET  /api/dev/state                 fighters, art, clips, and what is configured
 *   GET  /api/dev/content/<name>        a content/*.json file
 *   POST /api/dev/content/<name>        save one (body: the JSON)
 *   GET  /api/dev/source?fighter&file   a file from that fighter's art folder (videos seek)
 *   POST /api/dev/anim/upload?fighter&clip&name    import a clip video (body: the file)
 *   POST /api/dev/anim/options          { fighter, clip, options } into anims/clips.json
 *   POST /api/dev/anim/delete           { fighter, clip } removes the source video
 *   POST /api/dev/art/upload?fighter&name&key      replace a fighter's cutout (body: the file;
 *                                       key=black clears a black backdrop)
 *   POST /api/dev/audio/upload?kind&id&name        save an audio file under /audio/<kind>/
 *   POST /api/dev/audio/delete          { file } removes one of those
 *   POST /api/dev/run                   { task, fighter?, clip? } streams a script's output
 *   POST /api/dev/sfx/generate          ElevenLabs sound generation
 *   GET  /api/dev/voice/voices          ElevenLabs voices on the account
 *   POST /api/dev/voice/generate        ElevenLabs speech for one line
 *   GET  /api/dev/gpu                   the AWS GPU server, regions, retries, and the job queue
 *   POST /api/dev/gpu/launch|start|stop|terminate|access   manage the GPU server
 *                                       (launch/start take keepTrying: { minutes })
 *   POST /api/dev/gpu/retry/stop        stop keep-trying
 *   GET  /api/dev/gpu/health           ComfyUI's flags, memory, disk and GPU vs docs/comfyui.md (over SSH)
 *   POST /api/dev/gpu/health/fix       put ComfyUI on the flags that work and restart it
 *   GET  /api/dev/gpu/log?lines        the server's setup log, disk, memory and GPU (over SSH)
 *   GET  /api/dev/gpu/capacity          AWS spot placement scores per type and region (read-only)
 *   POST /api/dev/gpu/regions/refresh   re-read quotas and offerings
 *   POST /api/dev/gpu/quota             { region, value } ask AWS for more GPU quota
 *   POST /api/dev/gpu/preview           { job, generation? } the prompt and settings a job would use
 *   GET  /api/dev/gpu/defaults          default generation settings and their limits
 *   POST /api/dev/gpu/jobs              queue generation jobs (side views, clips)
 *   POST /api/dev/gpu/jobs/cancel|clear|rerun   manage the queue
 *   GET  /api/dev/gpu/graph?name        a job's ComfyUI graph (loads into ComfyUI)
 *   POST /api/dev/gpu/take/use|discard  { fighter, clip?, file } pick or drop a take
 *   GET  /api/dev/maps/concepts         every folder in the maps root (AllTheMaps) and its stage
 *   GET  /api/dev/maps/concept-file?folder&file   a concept image
 *   POST /api/dev/maps/generate         { folder, direction?, count?, base?, feedback? } stage designs
 *                                       from that folder ("Generate Map Idea"), or revisions of base
 *   GET  /api/dev/maps/design-file?name a design's blockout preview
 *   GET  /api/dev/maps/takes?stage      what can be painted for a saved stage, and the painted takes
 *   POST /api/dev/maps/take/discard     { stage, file } moves a painted take to _takes/_old/
 *   POST /api/dev/maps/review           { stage } the art-director review of a stage (Claude)
 *   GET  /api/dev/maps/review-file?name the image a review looked at
 *   POST /api/dev/maps/layer/upload?stage&name     an art layer image into stages/<stage>/
 *   GET  /api/dev/maps/art?stage        the images already in stages/<stage>/
 *   POST /api/dev/gpu/side/choose       { fighter, file } picks a side view
 *   POST /api/dev/gpu/motion/promote    { fighter, clip } adds a clip to the motion library
 *   GET  /api/dev/gpu/motion?clip       a motion library video
 *
 * File access is limited to this project and the fighter art folder. The
 * ElevenLabs key is ELEVENLABS_API_KEY, from the environment or .env.
 */
import { spawn } from 'node:child_process';
import { normalizePath } from 'vite';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { checkAccount } from './gpu/check.mjs';
import { fixServer, launchServer, serverHealth, serverLog, refreshAccess, regionsInfo, requestQuota, serverStatus, startServer, stopServer, terminateServer, DEFAULT_TYPE, DISK_PER_MONTH, TYPES } from './gpu/aws.mjs';
import { GRAPHS, Jobs, motionPath } from './gpu/jobs.mjs';
import { Retry } from './gpu/retry.mjs';
import { capacityScores } from './gpu/capacity.mjs';
import { DEFAULTS, LIMITS } from './gpu/settings.mjs';
import { mapIdeas } from './maps/idea.mjs';
import { composite, designPreview, loadStage, paintPlan } from './maps/paint.mjs';
import { reviewStage } from './maps/review.mjs';

const CONTENT = new Set(['stages', 'fighters', 'campaign', 'sounds', 'voice', 'anim-clips', 'generation']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif', '.avi']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO = new Set(['.mp3', '.ogg', '.wav', '.m4a']);
const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.gif': 'image/gif', '.avi': 'video/x-msvideo', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

// ---------------------------------------------------------------- helpers

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const fail = (res, status, message) => send(res, status, { error: message });

const readBody = (req, max = 400 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('File too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const readJson = async (req) => {
  const raw = (await readBody(req, 20 * 1024 * 1024)).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

/** 'DJWontRead' -> 'dj-wont-read'. Matches _build_anims.py. */
export const folderToId = (name) =>
  (name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? []).map((w) => w.toLowerCase()).join('-');

const idToFolder = (id) => id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

const inside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const elevenKey = (root) => {
  if (process.env.ELEVENLABS_API_KEY?.trim()) return process.env.ELEVENLABS_API_KEY.trim();
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
};

const eleven = (url, { method = 'GET', key, body }) =>
  new Promise((resolve, reject) => {
    const headers = { 'xi-api-key': key };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers.Accept = 'application/octet-stream';
    }
    const req = https.request(url, { method, headers, family: 4, timeout: 120000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('ElevenLabs timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

const elevenOk = (r) => r.status >= 200 && r.status < 300 && r.buffer[0] !== 0x7b;
const elevenStatus = (r) => {
  try {
    return String(JSON.parse(r.buffer.toString('utf8'))?.detail?.status ?? '');
  } catch {
    return '';
  }
};
// 429 is both "too many concurrent requests" (wait and retry) and, on some
// plans, "out of credits" (stop). The detail status tells them apart.
const throttled = (r) =>
  r.status === 503 || (r.status === 429 && !/quota/.test(elevenStatus(r))) || /too_many_concurrent|rate_limit|system_busy/.test(elevenStatus(r));
const retryAfter = (r, tries) => {
  const s = Number(r.headers?.['retry-after']);
  return Number.isFinite(s) && s > 0 ? Math.min(60, s) : Math.min(30, 2 ** tries);
};

/** Calls ElevenLabs, waiting out short throttles here so the browser sees fewer of them. */
async function elevenRetry(url, opts) {
  for (let tries = 1; ; tries++) {
    let r;
    try {
      r = await eleven(url, opts);
    } catch (e) {
      // Dropped connections and timeouts are worth one more go.
      if (tries >= 3) throw Object.assign(e, { status: 503, code: 'throttled', retryAfter: 10 });
      await new Promise((done) => setTimeout(done, 2000 * tries));
      continue;
    }
    if (!throttled(r)) return r;
    const wait = retryAfter(r, tries);
    if (tries >= 4) throw elevenError(r, wait);
    await new Promise((done) => setTimeout(done, wait * 1000));
  }
}

/** An error the devtools can act on: code is throttled (retry later), quota or auth (stop), or failed. */
const elevenError = (r, wait) => {
  const detail = elevenStatus(r);
  const code = throttled(r) ? 'throttled' : /quota|credits/.test(detail) || r.status === 402 ? 'quota' : r.status === 401 ? 'auth' : 'failed';
  return Object.assign(new Error(`ElevenLabs ${r.status}: ${r.buffer.toString('utf8').slice(0, 300)}`), {
    status: code === 'throttled' ? 429 : r.status >= 400 ? r.status : 502,
    code,
    retryAfter: code === 'throttled' ? (wait ?? retryAfter(r, 1)) : undefined,
  });
};

// ------------------------------------------------------------------ plugin

export function devApi({ root, artRoot, mapsRoot }) {
  const contentDir = path.join(root, 'content');
  const audioDir = path.join(root, 'audio');
  const imgDir = path.join(root, 'characters', 'img');
  const backupDir = path.join(root, '_backup', 'art');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  let job = null;

  const fighterIds = () => JSON.parse(fs.readFileSync(path.join(contentDir, 'fighters.json'), 'utf8')).map((f) => f.id);

  /** Each fighter's folder under the art root, matched by name like _build_anims.py does. */
  const folders = () => {
    const out = {};
    if (!fs.existsSync(artRoot)) return out;
    for (const d of fs.readdirSync(artRoot, { withFileTypes: true })) {
      if (d.isDirectory()) out[folderToId(d.name)] = path.join(artRoot, d.name);
    }
    return out;
  };

  const folderFor = (id, create = false) => {
    const known = folders()[id];
    if (known) return known;
    if (!create) return null;
    const dir = path.join(artRoot, idToFolder(id));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const checkFighter = (id) => {
    if (!SAFE_ID.test(id || '') || !fighterIds().includes(id)) throw new Error(`Unknown fighter: ${id}`);
    return id;
  };

  const clipList = () => JSON.parse(fs.readFileSync(path.join(contentDir, 'anim-clips.json'), 'utf8'));
  const clipNames = () => {
    const c = clipList();
    return new Set([...c.loops, ...c.once, ...c.moves]);
  };

  const jobs = new Jobs({
    folderFor: (id, create) => folderFor(id, create),
    info: (id, clip) => {
      const c = clipList();
      return {
        name: JSON.parse(fs.readFileSync(path.join(contentDir, 'fighters.json'), 'utf8')).find((f) => f.id === id)?.name ?? id,
        action: clip ? c.actions?.[clip] ?? clip : '',
        seconds: clip ? c.seconds?.[clip] ?? 2 : 2,
      };
    },
    clipNames,
  });
  const retry = new Retry();
  // Vite re-runs this when its config changes; the old queue and retries must stop,
  // or two queues would share jobs.json and could run the same job twice.
  globalThis.__dodGpu?.dispose();
  globalThis.__dodGpu = { dispose: () => { jobs.dispose(); retry.suspend(); } };
  // The last launch or start that failed, with every zone it tried, for the GPU tab.
  let lastFailure = null;
  const gpuFail = (res, e) => {
    if (!e.kind) throw e;
    lastFailure = { at: Date.now(), message: e.message, kind: e.kind, attempts: e.attempts ?? [] };
    return send(res, 409, { error: e.message, kind: e.kind, attempts: e.attempts ?? [] });
  };
  // The account barely changes, so ask AWS at most every few minutes.
  let account = { at: 0, value: null };
  const accountInfo = async () => {
    if (Date.now() - account.at > 5 * 60 * 1000) {
      try {
        account = { at: Date.now(), value: await checkAccount() };
      } catch (e) {
        account = { at: Date.now(), value: { error: e.message } };
      }
    }
    return account.value;
  };
  const motionsDir = () => path.dirname(motionPath(folderFor, 'idle'));

  // ---------------------------------------------------------------- maps

  const stagesDir = path.join(root, 'stages');
  const mapSlug = (folder) => folder.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const mapName = (folder) => folder.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  const conceptDir = (folder) => {
    const dir = path.resolve(mapsRoot, String(folder || ''));
    if (!inside(mapsRoot, dir) || dir === path.resolve(mapsRoot) || !fs.existsSync(dir)) throw new Error(`No folder ${folder} in ${mapsRoot}`);
    return dir;
  };
  const conceptImages = (dir) => fs.readdirSync(dir).filter((f) => IMAGE.has(path.extname(f).toLowerCase())).sort();

  function concepts() {
    const stages = JSON.parse(fs.readFileSync(path.join(contentDir, 'stages.json'), 'utf8'));
    if (!fs.existsSync(mapsRoot)) return [];
    return fs.readdirSync(mapsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => {
      const dir = path.join(mapsRoot, d.name);
      const ref = path.join(dir, 'reference.txt');
      const stage = stages.find((s) => s.source === d.name) ?? null;
      return {
        folder: d.name,
        id: mapSlug(d.name),
        name: mapName(d.name),
        reference: fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8') : '',
        images: conceptImages(dir).map((f) => ({ file: f, ...fileInfo(path.join(dir, f)) })),
        stage: stage ? { id: stage.id, name: stage.name } : null,
      };
    });
  }

  /** Runs tools/map_art.py; resolves to its parsed JSON output. */
  function mapArt(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(root, 'tools', 'map_art.py'), ...args]);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(err.trim().slice(-400) || `map_art.py exited ${code}`));
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(`map_art.py printed ${out.slice(0, 200)}`));
        }
      });
    });
  }

  /** The .json recipe saved beside a generated file, if any. */
  const readRecipe = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file.replace(/\.[^.]+$/, '.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const fileInfo = (file) => {
    const st = fs.statSync(file);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  };

  function state() {
    const all = folders();
    const fighters = fighterIds().map((id) => {
      const folder = all[id] ?? null;
      const sources = [];
      const clipSources = {};
      const sides = [];
      const takes = [];
      let clipOptions = {};
      if (folder) {
        for (const f of fs.readdirSync(folder, { withFileTypes: true })) {
          if (f.isFile() && IMAGE.has(path.extname(f.name).toLowerCase())) sources.push({ file: f.name, ...fileInfo(path.join(folder, f.name)) });
        }
        const animDir = path.join(folder, 'anims');
        if (fs.existsSync(animDir)) {
          for (const f of fs.readdirSync(animDir)) {
            const ext = path.extname(f).toLowerCase();
            if (VIDEO.has(ext)) clipSources[path.basename(f, ext).toLowerCase()] = { file: `anims/${f}`, ...fileInfo(path.join(animDir, f)) };
            if (/^_side(-\d+)?\.png$/i.test(f)) sides.push({ file: `anims/${f}`, chosen: f === '_side.png', recipe: readRecipe(path.join(animDir, f)), ...fileInfo(path.join(animDir, f)) });
          }
          const takeDir = path.join(animDir, '_takes');
          if (fs.existsSync(takeDir)) {
            for (const f of fs.readdirSync(takeDir)) {
              const m = /^([a-z0-9]+)-(\d+)\.mp4$/i.exec(f);
              if (m) takes.push({ clip: m[1].toLowerCase(), seed: Number(m[2]), file: `anims/_takes/${f}`, recipe: readRecipe(path.join(takeDir, f)), ...fileInfo(path.join(takeDir, f)) });
            }
          }
          const opts = path.join(animDir, 'clips.json');
          if (fs.existsSync(opts)) {
            try {
              clipOptions = JSON.parse(fs.readFileSync(opts, 'utf8'));
            } catch {
              clipOptions = {};
            }
          }
        }
      }
      const manifestFile = path.join(root, 'characters', 'anim', id, 'anims.json');
      const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
      const exists = (p) => fs.existsSync(path.join(root, p));
      return {
        id,
        folder: folder ? path.basename(folder) : null,
        sources,
        clipSources,
        clipOptions,
        sides,
        takes,
        manifest,
        art: {
          img: exists(`characters/img/${id}.png`) ? fileInfo(path.join(imgDir, `${id}.png`)).mtime : 0,
          thumb: exists(`characters/thumb/${id}.webp`),
          large: exists(`characters/large/${id}.webp`),
        },
      };
    });
    return {
      artRoot,
      artRootExists: fs.existsSync(artRoot),
      elevenLabs: Boolean(elevenKey(root)),
      ffmpeg: true,
      running: job ? job.task : null,
      fighters,
    };
  }

  // Scripts devtools can run, by name. Nothing else can be spawned.
  // The project venv has rembg for AI cutouts; fall back to system Python for everything else.
  const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

  function command(task, fighter, clip, mode, file) {
    const node = process.execPath;
    switch (task) {
      case 'test':
        return [node, ['src/game/test/sim.test.ts']];
      case 'typecheck':
        return [node, ['node_modules/typescript/bin/tsc', '-p', '.']];
      case 'build':
        return [node, ['node_modules/vite/bin/vite.js', 'build']];
      case 'lineup':
        return [python, ['-u', '_build_lineup.py']];
      case 'fighter-images':
        return [python, ['-u', '_build_lineup.py', '--only', checkFighter(fighter)]];
      case 'anims': {
        const args = ['-u', '_build_anims.py'];
        if (fighter) args.push(checkFighter(fighter));
        if (clip) {
          if (!fighter || !clipNames().has(clip)) throw new Error('A clip rebuild needs a fighter and a known clip.');
          args.push('--clip', clip);
        }
        return [python, args];
      }
      case 'cutout': {
        if (!fs.existsSync(venvPython)) throw new Error('AI cutouts need the project venv: python -m venv .venv, then .venv\\Scripts\\pip install "rembg[cpu]"');
        const args = ['-u', 'tools/cutout.py'];
        if (fighter) args.push(checkFighter(fighter));
        if (mode) {
          if (!['birefnet', 'isnet', 'union'].includes(mode)) throw new Error(`Unknown cutout mode: ${mode}`);
          args.push('--mode', mode);
        }
        if (file) {
          if (!fighter || /[\\/]|\.\./.test(file)) throw new Error('A source file needs a fighter and a plain file name.');
          args.push('--file', file);
        }
        return [venvPython, args];
      }
      case 'anim-folders':
        return [python, ['-u', 'tools/make_anim_folders.py']];
      case 'recut':
        if (!fs.existsSync(path.join(root, '_recut.py'))) throw new Error('_recut.py is not in the project.');
        return [python, ['-u', '_recut.py']];
      default:
        throw new Error(`Unknown task: ${task}`);
    }
  }

  function run(res, task, fighter, clip, mode, file) {
    if (job) return fail(res, 409, `Already running: ${job.task}`);
    let cmd;
    try {
      cmd = command(task, fighter, clip, mode, file);
    } catch (e) {
      return fail(res, 400, e.message);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`$ ${path.basename(cmd[0])} ${cmd[1].join(' ')}\n`);
    const child = spawn(cmd[0], cmd[1], { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0' } });
    job = { task, child };
    child.stdout.on('data', (d) => res.write(d));
    child.stderr.on('data', (d) => res.write(d));
    child.on('error', (e) => {
      res.write(`\n${e.message}\n`);
    });
    child.on('close', (code) => {
      job = null;
      res.end(`\n[exit ${code}]\n`);
    });
  }

  function serveFile(req, res, file) {
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    // Videos need byte ranges to seek.
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
  }

  /** Converts any image to a cutout PNG with Pillow, backing up the old one first. */
  function replaceArt(id, buffer, ext, keyBlack) {
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `dod-art-${Date.now()}${ext}`);
      fs.writeFileSync(tmp, buffer);
      const dest = path.join(imgDir, `${id}.png`);
      if (fs.existsSync(dest)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(dest, path.join(backupDir, `${id}-${Date.now()}.png`));
      }
      const args = [path.join(root, 'tools', 'convert_art.py'), tmp, dest];
      if (keyBlack) args.push('--key-black');
      const child = spawn(python, args);
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => {
        fs.rmSync(tmp, { force: true });
        if (code === 0) resolve();
        else reject(new Error(err.trim().slice(-400) || `Pillow exited ${code}`));
      });
    });
  }

  function saveAudio(kind, id, buffer, ext) {
    if (!['sfx', 'voice'].includes(kind)) throw new Error('kind must be sfx or voice');
    if (!SAFE_ID.test(id)) throw new Error(`Bad id: ${id}`);
    const dir = path.join(audioDir, kind);
    fs.mkdirSync(dir, { recursive: true });
    for (const old of AUDIO) fs.rmSync(path.join(dir, `${id}${old}`), { force: true });
    fs.writeFileSync(path.join(dir, `${id}${ext}`), buffer);
    return `/audio/${kind}/${id}${ext}`;
  }

  async function handle(req, res, server) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    const q = (k) => url.searchParams.get(k) ?? '';

    if (req.method === 'GET' && route === '/state') return send(res, 200, state());

    const content = /^\/content\/([a-z-]+)$/.exec(route);
    if (content) {
      const name = content[1];
      if (!CONTENT.has(name)) return fail(res, 404, `No content file named ${name}`);
      const file = path.join(contentDir, `${name}.json`);
      if (req.method === 'GET') return serveFile(req, res, file);
      if (req.method === 'POST') {
        const data = await readJson(req);
        if (typeof data !== 'object' || data === null) return fail(res, 400, 'Expected JSON');
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
        contentChanged(server, file);
        return send(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && route === '/source') {
      const id = checkFighter(q('fighter'));
      const folder = folderFor(id);
      if (!folder) return fail(res, 404, 'No art folder for this fighter');
      const file = path.resolve(folder, q('file'));
      if (!inside(folder, file) || !fs.existsSync(file)) return fail(res, 404, 'Not found');
      return serveFile(req, res, file);
    }

    if (req.method === 'POST' && route === '/anim/upload') {
      const id = checkFighter(q('fighter'));
      const clip = q('clip').toLowerCase();
      if (!clipNames().has(clip)) return fail(res, 400, `Unknown clip: ${clip}`);
      const ext = path.extname(q('name')).toLowerCase();
      if (!VIDEO.has(ext)) return fail(res, 400, `Use a video file (${[...VIDEO].join(', ')})`);
      const animDir = path.join(folderFor(id, true), 'anims');
      fs.mkdirSync(animDir, { recursive: true });
      for (const f of fs.readdirSync(animDir)) {
        const fe = path.extname(f).toLowerCase();
        if (VIDEO.has(fe) && path.basename(f, fe).toLowerCase() === clip) fs.rmSync(path.join(animDir, f));
      }
      fs.writeFileSync(path.join(animDir, `${clip}${ext}`), await readBody(req));
      return send(res, 200, { ok: true, file: `anims/${clip}${ext}` });
    }

    if (req.method === 'POST' && route === '/anim/options') {
      const { fighter, clip, options } = await readJson(req);
      const id = checkFighter(fighter);
      if (!clipNames().has(clip)) return fail(res, 400, `Unknown clip: ${clip}`);
      const animDir = path.join(folderFor(id, true), 'anims');
      fs.mkdirSync(animDir, { recursive: true });
      const file = path.join(animDir, 'clips.json');
      const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      const clean = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== null && v !== '' && v !== undefined));
      if (Object.keys(clean).length) all[clip] = clean;
      else delete all[clip];
      fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
      return send(res, 200, { ok: true, options: all });
    }

    if (req.method === 'POST' && route === '/anim/rename') {
      // A video dropped in with the wrong name: give it a clip name.
      const { fighter, from, to } = await readJson(req);
      const id = checkFighter(fighter);
      if (!clipNames().has(to)) return fail(res, 400, `Unknown clip: ${to}`);
      const animDir = path.join(folderFor(id) ?? '', 'anims');
      const src = path.resolve(animDir, String(from || ''));
      if (!inside(animDir, src) || !fs.existsSync(src) || !VIDEO.has(path.extname(src).toLowerCase())) return fail(res, 404, 'No such video');
      for (const f of fs.readdirSync(animDir)) {
        const fe = path.extname(f).toLowerCase();
        if (VIDEO.has(fe) && path.basename(f, fe).toLowerCase() === to && path.join(animDir, f) !== src) {
          return fail(res, 409, `${f} is already the ${to} clip. Delete or rename it first.`);
        }
      }
      const dest = path.join(animDir, `${to}${path.extname(src).toLowerCase()}`);
      fs.renameSync(src, dest);
      return send(res, 200, { ok: true, file: `anims/${path.basename(dest)}` });
    }

    if (req.method === 'POST' && route === '/anim/delete') {
      const { fighter, clip } = await readJson(req);
      const id = checkFighter(fighter);
      if (!clipNames().has(clip)) return fail(res, 400, `Unknown clip: ${clip}`);
      const folder = folderFor(id);
      const animDir = folder && path.join(folder, 'anims');
      if (animDir && fs.existsSync(animDir)) {
        for (const f of fs.readdirSync(animDir)) {
          const fe = path.extname(f).toLowerCase();
          if (VIDEO.has(fe) && path.basename(f, fe).toLowerCase() === clip) fs.rmSync(path.join(animDir, f));
        }
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/art/upload') {
      const id = checkFighter(q('fighter'));
      const ext = path.extname(q('name')).toLowerCase();
      if (!IMAGE.has(ext)) return fail(res, 400, 'Use a PNG, JPG or WebP image');
      await replaceArt(id, await readBody(req, 60 * 1024 * 1024), ext, q('key') === 'black');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/audio/upload') {
      const ext = path.extname(q('name')).toLowerCase();
      if (!AUDIO.has(ext)) return fail(res, 400, `Use an audio file (${[...AUDIO].join(', ')})`);
      const file = saveAudio(q('kind'), q('id'), await readBody(req, 60 * 1024 * 1024), ext);
      return send(res, 200, { ok: true, file });
    }

    if (req.method === 'POST' && route === '/audio/delete') {
      const { file } = await readJson(req);
      const abs = path.resolve(root, String(file || '').replace(/^\/+/, ''));
      if (!inside(audioDir, abs) || !AUDIO.has(path.extname(abs).toLowerCase())) return fail(res, 400, 'Not an audio file in /audio/');
      fs.rmSync(abs, { force: true });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && route === '/run') {
      const { task, fighter, clip, mode, file } = await readJson(req);
      return run(res, task, fighter, clip, mode, file);
    }

    if (req.method === 'POST' && route === '/sfx/generate') {
      const key = elevenKey(root);
      if (!key) return fail(res, 400, 'Add ELEVENLABS_API_KEY=... to a .env file in the project, then restart npm run dev.');
      const { id, text, loop, duration, influence } = await readJson(req);
      if (!String(text || '').trim()) return fail(res, 400, 'This effect has no description.');
      const body = {
        text: String(text).trim(),
        model_id: 'eleven_text_to_sound_v2',
        prompt_influence: Math.max(0, Math.min(1, Number(influence ?? 0.55))),
        loop: loop === true,
      };
      if (duration) body.duration_seconds = Math.max(0.5, Math.min(30, Number(duration)));
      const r = await elevenRetry('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', key, body });
      if (!elevenOk(r)) throw elevenError(r);
      const file = saveAudio('sfx', id, r.buffer, '.mp3');
      return send(res, 200, { file, take: { text: body.text, loop: body.loop, duration: body.duration_seconds ?? null, influence: body.prompt_influence } });
    }

    if (req.method === 'GET' && route === '/voice/voices') {
      const key = elevenKey(root);
      if (!key) return fail(res, 400, 'Add ELEVENLABS_API_KEY=... to a .env file in the project, then restart npm run dev.');
      const r = await eleven('https://api.elevenlabs.io/v1/voices', { key });
      if (r.status < 200 || r.status >= 300) throw elevenError(r);
      const voices = (JSON.parse(r.buffer.toString('utf8')).voices ?? [])
        .map((v) => ({ id: v.voice_id, name: v.name, category: v.category ?? '', preview: v.preview_url ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { voices });
    }

    if (req.method === 'POST' && route === '/voice/generate') {
      const key = elevenKey(root);
      if (!key) return fail(res, 400, 'Add ELEVENLABS_API_KEY=... to a .env file in the project, then restart npm run dev.');
      const { id, text, voice, model } = await readJson(req);
      if (!String(text || '').trim()) return fail(res, 400, 'This line has no text.');
      if (!/^[A-Za-z0-9]{8,40}$/.test(voice || '')) return fail(res, 400, 'Pick a voice for this speaker first.');
      const r = await elevenRetry(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        key,
        body: { text: String(text).trim(), model_id: model || 'eleven_v4' },
      });
      if (!elevenOk(r)) throw elevenError(r);
      const file = saveAudio('voice', id, r.buffer, '.mp3');
      return send(res, 200, { file, take: { text: String(text).trim(), voice } });
    }

    if (route === '/gpu' && req.method === 'GET') {
      const motions = fs.existsSync(motionsDir())
        ? fs.readdirSync(motionsDir()).filter((f) => VIDEO.has(path.extname(f).toLowerCase())).map((f) => ({ clip: path.basename(f, path.extname(f)), ...fileInfo(path.join(motionsDir(), f)) }))
        : [];
      let server;
      try {
        server = await serverStatus();
      } catch (e) {
        server = { exists: false, error: `${e.name}: ${e.message}`, types: TYPES, type: DEFAULT_TYPE, pricePerHour: TYPES[DEFAULT_TYPE].price, diskPerMonth: DISK_PER_MONTH };
      }
      const regions = await regionsInfo().catch((e) => [{ region: '?', error: e.message, quota: null, requests: [], zones: {} }]);
      return send(res, 200, { account: await accountInfo(), server, regions, retry: retry.state, lastFailure, jobs: jobs.list(), motions, motionsDir: motionsDir() });
    }
    const gpuAction = /^\/gpu\/(launch|start|stop|terminate|access)$/.exec(route);
    if (gpuAction && req.method === 'POST') {
      const body = await readJson(req);
      const act = gpuAction[1];
      // Anything that costs money or deletes the server must be confirmed by the caller.
      if ((act === 'launch' || act === 'start' || act === 'terminate') && body.confirm !== true) return fail(res, 400, `${act} needs { confirm: true }`);
      const opts = {
        idleMinutes: Math.max(10, Math.min(240, Number(body.idleMinutes) || 30)),
        region: typeof body.region === 'string' ? body.region : 'auto',
        type: body.type === 'auto' || TYPES[body.type] ? body.type : DEFAULT_TYPE,
      };
      if ((act === 'launch' || act === 'start') && body.keepTrying) {
        lastFailure = null;
        const minutes = Number(body.keepTrying.minutes) || 60;
        return send(res, 200, { ok: true, retry: retry.start({ action: act, opts, minutes, every: Number(body.keepTrying.every) || 180 }) });
      }
      try {
        const out =
          act === 'launch' ? await launchServer(opts)
          : act === 'start' ? await startServer()
          : act === 'stop' ? await stopServer()
          : act === 'terminate' ? await terminateServer()
          : await refreshAccess();
        if (act === 'launch' || act === 'start') lastFailure = null;
        if (act === 'stop' || act === 'terminate') retry.stop();
        return send(res, 200, { ok: true, ...out });
      } catch (e) {
        return gpuFail(res, e);
      }
    }
    if (route === '/gpu/health' && req.method === 'GET') {
      try {
        return send(res, 200, await serverHealth());
      } catch (e) {
        return gpuFail(res, e);
      }
    }
    if (route === '/gpu/health/fix' && req.method === 'POST') {
      try {
        return send(res, 200, await fixServer());
      } catch (e) {
        return gpuFail(res, e);
      }
    }
    if (route === '/gpu/log' && req.method === 'GET') {
      try {
        return send(res, 200, { log: await serverLog(q('lines')) });
      } catch (e) {
        return gpuFail(res, e);
      }
    }
    if (route === '/gpu/capacity' && req.method === 'GET') {
      return send(res, 200, { scores: await capacityScores(Object.keys(TYPES)) });
    }
    if (route === '/gpu/retry/stop' && req.method === 'POST') {
      retry.stop();
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/regions/refresh' && req.method === 'POST') {
      return send(res, 200, { regions: await regionsInfo({ force: true }) });
    }
    if (route === '/gpu/quota' && req.method === 'POST') {
      const { region, value } = await readJson(req);
      try {
        return send(res, 200, { ok: true, ...(await requestQuota(region, value)) });
      } catch (e) {
        return gpuFail(res, e);
      }
    }
    if (route === '/gpu/preview' && req.method === 'POST') {
      const { job, generation, actions, seconds } = await readJson(req);
      checkFighter(job?.fighter);
      return send(res, 200, jobs.preview(job, { gen: generation, actions, seconds }));
    }
    if (route === '/gpu/defaults' && req.method === 'GET') {
      return send(res, 200, { defaults: DEFAULTS, limits: LIMITS });
    }
    if (route === '/gpu/jobs/rerun' && req.method === 'POST') {
      const { id, sameSeed } = await readJson(req);
      return send(res, 200, { ok: true, added: [jobs.rerun(id, { sameSeed: !!sameSeed }).id] });
    }
    if (route === '/gpu/graph' && req.method === 'GET') {
      const name = q('name');
      if (!/^[0-9a-f]{12}-\d+\.json$/.test(name)) return fail(res, 400, 'Bad graph name');
      const file = path.join(GRAPHS, name);
      if (!fs.existsSync(file)) return fail(res, 404, 'That graph is gone');
      res.setHeader('Content-Disposition', `attachment; filename="dod-${name}"`);
      return serveFile(req, res, file);
    }
    if (route === '/gpu/take/use' && req.method === 'POST') {
      const { fighter, clip, file } = await readJson(req);
      const id = checkFighter(fighter);
      const out = await jobs.useTake(id, String(clip), path.basename(String(file || '')));
      return send(res, 200, { ok: true, log: out.trim().split(/\r?\n/).slice(-4) });
    }
    if (route === '/gpu/take/discard' && req.method === 'POST') {
      const { fighter, file } = await readJson(req);
      jobs.discardTake(checkFighter(fighter), path.basename(String(file || '')));
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/jobs' && req.method === 'POST') {
      const { jobs: specs } = await readJson(req);
      for (const s of specs ?? []) {
        if (s.type === 'paint') {
          // Painting reads the saved stage; check now rather than on the GPU.
          const st = loadStage(String(s.stage));
          if (!paintPlan(st).some((p) => p.id === s.piece)) return fail(res, 400, `${st.name} has no piece "${s.piece}" to paint (save the stage first?)`);
        } else checkFighter(s.fighter);
      }
      return send(res, 200, { ok: true, added: jobs.add(specs ?? []).map((j) => j.id) });
    }
    if (route === '/gpu/jobs/cancel' && req.method === 'POST') {
      jobs.cancel((await readJson(req)).id);
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/jobs/clear' && req.method === 'POST') {
      jobs.clearFinished();
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/side/choose' && req.method === 'POST') {
      const { fighter, file } = await readJson(req);
      const id = checkFighter(fighter);
      const animDir = path.join(folderFor(id) ?? '', 'anims');
      const src = path.resolve(animDir, path.basename(String(file || '')));
      if (!inside(animDir, src) || !/^_side-\d+\.png$/i.test(path.basename(src)) || !fs.existsSync(src)) return fail(res, 404, 'No such side view');
      fs.copyFileSync(src, path.join(animDir, '_side.png'));
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/motion/promote' && req.method === 'POST') {
      const { fighter, clip } = await readJson(req);
      const id = checkFighter(fighter);
      if (!clipNames().has(clip)) return fail(res, 400, `Unknown clip: ${clip}`);
      const animDir = path.join(folderFor(id) ?? '', 'anims');
      const src = fs.existsSync(animDir) && fs.readdirSync(animDir).find((f) => VIDEO.has(path.extname(f).toLowerCase()) && path.basename(f, path.extname(f)).toLowerCase() === clip);
      if (!src) return fail(res, 404, `${id} has no ${clip} video`);
      fs.mkdirSync(motionsDir(), { recursive: true });
      fs.copyFileSync(path.join(animDir, src), path.join(motionsDir(), `${clip}.mp4`));
      return send(res, 200, { ok: true });
    }
    if (route === '/gpu/motion' && req.method === 'GET') {
      const clip = q('clip');
      if (!clipNames().has(clip)) return fail(res, 400, 'Unknown clip');
      const file = path.join(motionsDir(), `${clip}.mp4`);
      if (!fs.existsSync(file)) return fail(res, 404, 'No motion for that clip');
      return serveFile(req, res, file);
    }

    if (route === '/maps/concepts' && req.method === 'GET') {
      return send(res, 200, { root: mapsRoot, exists: fs.existsSync(mapsRoot), concepts: concepts() });
    }
    if (route === '/maps/concept-file' && req.method === 'GET') {
      const dir = conceptDir(q('folder'));
      const file = path.resolve(dir, q('file'));
      if (!inside(dir, file) || !fs.existsSync(file)) return fail(res, 404, 'Not found');
      return serveFile(req, res, file);
    }
    if (route === '/maps/generate' && req.method === 'POST') {
      const { folder, direction = '', count = 3, base = null, feedback = '' } = await readJson(req);
      const dir = conceptDir(folder);
      const images = conceptImages(dir);
      if (!images.length) return fail(res, 400, `${folder} has no images yet. Add concept art (PNG, JPG or WebP) first.`);
      const ref = path.join(dir, 'reference.txt');
      const reference = fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8') : '';
      // A stage id that doesn't clash with a stage from somewhere else.
      const stages = JSON.parse(fs.readFileSync(path.join(contentDir, 'stages.json'), 'utf8'));
      let id = mapSlug(folder) || 'stage';
      for (let n = 2; stages.some((s) => s.id === id && s.source !== folder); n++) id = `${mapSlug(folder)}-${n}`;
      // The first image is the reference the art is painted from; smaller copies of every image go to Claude.
      const outDir = path.join(stagesDir, id);
      fs.mkdirSync(outDir, { recursive: true });
      await mapArt(['prep', path.join(dir, images[0]), path.join(outDir, 'reference.webp'), '1568']);
      const cache = path.join(root, '.cache', 'maps', id);
      fs.mkdirSync(cache, { recursive: true });
      const looks = [];
      for (const [i, f] of images.slice(0, 4).entries()) {
        const file = path.join(cache, `concept-${i + 1}.webp`);
        await mapArt(['prep', path.join(dir, f), file, '1568']);
        looks.push({ file, label: f });
      }
      const palette = await mapArt(['palette', path.join(dir, images[0]), '6']);
      const sounds = JSON.parse(fs.readFileSync(path.join(contentDir, 'sounds.json'), 'utf8')).map((s) => s.id);
      const out = await mapIdeas({
        id, name: mapName(folder), folder, reference, images: looks,
        backdrop: { reference: `stages/${id}/reference.webp` }, palette, sounds, example: stages[0],
        direction: String(direction), count, base, feedback: String(feedback),
      });
      // A blockout of each design, to pick from.
      const stamp = Date.now();
      const designs = [];
      for (const [i, stage] of out.designs.entries()) {
        const name = `${id}-${stamp}-${i + 1}.png`;
        await designPreview(stage, path.join(cache, name));
        designs.push({ stage, preview: `/api/dev/maps/design-file?stage=${id}&name=${name}` });
      }
      return send(res, 200, { ...out, designs });
    }
    if (route === '/maps/design-file' && req.method === 'GET') {
      const stage = String(q('stage') || '').replace(/[^a-z0-9-]/g, '');
      const name = String(q('name') || '');
      if (!/^[a-z0-9-]+-\d+-\d\.png$/.test(name)) return fail(res, 400, 'Bad name');
      const file = path.join(root, '.cache', 'maps', stage, name);
      if (!fs.existsSync(file)) return fail(res, 404, 'Gone');
      return serveFile(req, res, file);
    }
    if (route === '/maps/takes' && req.method === 'GET') {
      const id = String(q('stage') || '').replace(/[^a-z0-9-]/g, '');
      let pieces = [];
      try {
        pieces = paintPlan(loadStage(id));
      } catch {
        // Not saved yet: nothing to paint.
      }
      const dir = path.join(stagesDir, id, '_takes');
      const takes = {};
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          const m = /^([a-z0-9-]+)-(\d+)\.webp$/.exec(f);
          if (!m) continue;
          let recipe = null;
          try {
            recipe = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.webp$/, '.json')), 'utf8'));
          } catch {
            // A take without its recipe can't be placed.
          }
          (takes[m[1]] ??= []).push({ file: `stages/${id}/_takes/${f}`, seed: Number(m[2]), recipe, ...fileInfo(path.join(dir, f)) });
        }
      }
      for (const list of Object.values(takes)) list.sort((a, b) => b.mtime - a.mtime);
      return send(res, 200, { pieces, takes });
    }
    if (route === '/maps/take/discard' && req.method === 'POST') {
      const { stage, file } = await readJson(req);
      const id = String(stage || '').replace(/[^a-z0-9-]/g, '');
      const base = path.basename(String(file || ''));
      if (!/^[a-z0-9-]+-\d+\.webp$/.test(base)) return fail(res, 400, 'No such take');
      const dir = path.join(stagesDir, id, '_takes');
      fs.mkdirSync(path.join(dir, '_old'), { recursive: true });
      for (const f of [base, base.replace(/\.webp$/, '.json')]) if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(dir, '_old', f));
      return send(res, 200, { ok: true });
    }
    if (route === '/maps/review' && req.method === 'POST') {
      const { stage } = await readJson(req);
      if (!stage?.id || !Array.isArray(stage.platforms)) return fail(res, 400, 'Send the stage to review');
      const id = String(stage.id).replace(/[^a-z0-9-]/g, '');
      const cache = path.join(root, '.cache', 'maps', id);
      fs.mkdirSync(cache, { recursive: true });
      const name = `review-${Date.now()}.png`;
      await composite(stage, path.join(cache, name));
      // The concept: the folder's images (prepared when the idea was generated), else the reference copy.
      const concepts = fs.readdirSync(cache).filter((f) => /^concept-\d\.webp$/.test(f)).sort().map((f) => path.join(cache, f));
      if (!concepts.length && stage.art?.reference && fs.existsSync(path.join(root, stage.art.reference))) concepts.push(path.join(root, stage.art.reference));
      let reference = '';
      if (stage.source) {
        const ref = path.join(mapsRoot, path.basename(String(stage.source)), 'reference.txt');
        if (fs.existsSync(ref)) reference = fs.readFileSync(ref, 'utf8');
      }
      const out = await reviewStage({ stage, composite: path.join(cache, name), concepts, reference });
      return send(res, 200, { ...out, image: `/api/dev/maps/review-file?stage=${id}&name=${name}` });
    }
    if (route === '/maps/review-file' && req.method === 'GET') {
      const stage = String(q('stage') || '').replace(/[^a-z0-9-]/g, '');
      const name = String(q('name') || '');
      if (!/^review-\d+\.png$/.test(name)) return fail(res, 400, 'Bad name');
      const file = path.join(root, '.cache', 'maps', stage, name);
      if (!fs.existsSync(file)) return fail(res, 404, 'Gone');
      return serveFile(req, res, file);
    }
    if (route === '/maps/layer/upload' && req.method === 'POST') {
      const stage = String(q('stage') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const name = String(q('name') || 'layer');
      const ext = path.extname(name).toLowerCase();
      if (!stage) return fail(res, 400, 'Which stage?');
      if (!IMAGE.has(ext)) return fail(res, 400, 'Use a PNG, JPG or WebP');
      const base = path.basename(name, ext).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';
      const outDir = path.join(stagesDir, stage);
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = path.join(os.tmpdir(), `dod-layer-${Date.now()}${ext}`);
      fs.writeFileSync(tmp, await readBody(req, 80 * 1024 * 1024));
      try {
        const size = await mapArt(['prep', tmp, path.join(outDir, `${base}.webp`), '4096']);
        return send(res, 200, { path: `stages/${stage}/${base}.webp`, ...size });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    if (route === '/maps/art' && req.method === 'GET') {
      const stage = String(q('stage') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const dir = path.join(stagesDir, stage);
      const files = stage && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => IMAGE.has(path.extname(f).toLowerCase())) : [];
      return send(res, 200, { files: files.map((f) => ({ path: `stages/${stage}/${f}`, ...fileInfo(path.join(dir, f)) })) });
    }

    return fail(res, 404, `No such devtools route: ${req.method} ${route}`);
  }

  /** A content file changed: refresh Vite's copy, and tell game tabs (not devtools) to reload. */
  function contentChanged(server, file) {
    // Vite keys modules by forward-slash paths; a Windows path finds nothing (and the game
    // would keep serving the old content until the dev server restarted).
    const graphs = [server.moduleGraph, ...Object.values(server.environments ?? {}).map((e) => e.moduleGraph)].filter(Boolean);
    for (const graph of new Set(graphs)) {
      for (const key of new Set([file, normalizePath(file)])) {
        for (const mod of graph.getModulesByFile?.(key) ?? []) graph.invalidateModule(mod);
      }
    }
    server.ws.send({ type: 'custom', event: 'dod:content', data: { file: path.basename(file) } });
  }

  return {
    name: 'dod-devtools',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/dev', (req, res) => {
        handle(req, res, server).catch((e) => {
          if (!res.headersSent) send(res, e.status ?? 500, { error: e.message, code: e.code, retryAfter: e.retryAfter });
          else res.end(`\n${e.message}\n`);
        });
      });
      // Vite does not watch content/ (a full reload would wipe devtools), so
      // hand edits are picked up here instead.
      let timer = null;
      fs.watch(contentDir, (_event, name) => {
        if (!name?.endsWith('.json')) return;
        clearTimeout(timer);
        timer = setTimeout(() => contentChanged(server, path.join(contentDir, name)), 120);
      });
    },
  };
}
