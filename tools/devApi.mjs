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
 *
 * File access is limited to this project and the fighter art folder. The
 * ElevenLabs key is ELEVENLABS_API_KEY, from the environment or .env.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const CONTENT = new Set(['stages', 'fighters', 'campaign', 'sounds', 'voice', 'anim-clips']);
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('ElevenLabs timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

const elevenError = (r) => new Error(`ElevenLabs ${r.status}: ${r.buffer.toString('utf8').slice(0, 300)}`);

// ------------------------------------------------------------------ plugin

export function devApi({ root, artRoot }) {
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

  const clipNames = () => {
    const c = JSON.parse(fs.readFileSync(path.join(contentDir, 'anim-clips.json'), 'utf8'));
    return new Set([...c.loops, ...c.once, ...c.moves]);
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
      const r = await eleven('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', key, body });
      if (r.status < 200 || r.status >= 300 || r.buffer[0] === 0x7b) throw elevenError(r);
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
      const r = await eleven(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        key,
        body: { text: String(text).trim(), model_id: model || 'eleven_v4' },
      });
      if (r.status < 200 || r.status >= 300 || r.buffer[0] === 0x7b) throw elevenError(r);
      const file = saveAudio('voice', id, r.buffer, '.mp3');
      return send(res, 200, { file, take: { text: String(text).trim(), voice } });
    }

    return fail(res, 404, `No such devtools route: ${req.method} ${route}`);
  }

  /** A content file changed: refresh Vite's copy, and tell game tabs (not devtools) to reload. */
  function contentChanged(server, file) {
    for (const mod of server.moduleGraph.getModulesByFile(file) ?? []) server.moduleGraph.invalidateModule(mod);
    server.ws.send({ type: 'custom', event: 'dod:content', data: { file: path.basename(file) } });
  }

  return {
    name: 'dod-devtools',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/dev', (req, res) => {
        handle(req, res, server).catch((e) => {
          if (!res.headersSent) fail(res, 500, e.message);
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
