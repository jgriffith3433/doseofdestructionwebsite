// A whole stage from a concept folder, without clicking through devtools: what an agent (or J) runs for
// "add a DoD stage from the CityTop concept". It drives the dev server's own API (tools/devApi.mjs), so it is
// exactly the Maps tab's pipeline: Generate Map Idea -> pick a design -> save -> paint every piece -> use the best
// takes -> art director review -> stage music in hawkes.assets.json.
//
//   node tools/maps/make.mjs <Folder> --estimate            what painting would cost (no GPU, no Claude)
//   node tools/maps/make.mjs <Folder> --design             designs only: Claude writes them, picks one, saves the stage
//   node tools/maps/make.mjs <Folder> --paint              paint the saved stage (GPU: ask J first, with the estimate)
//   node tools/maps/make.mjs <Folder> --all                design, paint, use takes, review, music asset
//   options: --direction "what to stress" --count 3 --pick 2 (a design by number) --id city-top-2 --takes 4
//            --replace (redesign a stage that already came from this folder) --wait (paint even with no GPU server up)
//
// Needs the dev server (auto-start.bat or `npm run dev`, http://localhost:8089, DOD_DEV_URL to change it) and Hawkes
// Gen. Writes content/stages.json, content/modes.json (Versus, Training), stages/<id>/, content/sounds.json (the music entry) and hawkes.assets.json (the
// music recipe, made by Studio: studio.cmd assets doseofdestruction make). Prints a JSON report at the end and keeps
// it in .cache/maps/<id>/make-report.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paintPlan } from './paint.mjs';
import { askClaude, gen } from '../gpu/gen.mjs';
import { sharedRoot } from '../roots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = (process.env.DOD_DEV_URL || 'http://localhost:8089').replace(/\/$/, '');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const folder = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const log = (...m) => console.error('[make]', ...m);

async function api(route, body) {
  const r = await fetch(`${DEV}/api/dev${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const stages = () => api('/content/stages');
async function saveStage(stage) {
  const all = await stages();
  const i = all.findIndex((s) => s.id === stage.id);
  if (i >= 0) all[i] = stage;
  else all.push(stage);
  await api('/content/stages', all);
  // The music recipe is written here, next to this script: it must be the checkout the dev server serves.
  const here = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'stages.json'), 'utf8'));
  if (!here.some((s) => s.id === stage.id)) throw new Error(`The dev server at ${DEV} serves another checkout than ${ROOT}: run this script from that one`);
}
const mapSlug = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Paint settings: takes per piece (content/generation.json "paint"). */
function takesFor(piece) {
  const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'generation.json'), 'utf8')).paint ?? {};
  const n = Number(opt('takes', 0));
  return n || (piece === 'stage' ? P.stageTakes ?? 4 : P.takes ?? 2);
}

/** GPU cost of painting a stage, from Hawkes Gen's job history (each take is two image.edit passes on platform art). */
async function estimate(stage) {
  const pieces = paintPlan(stage);
  const edits = pieces.reduce((n, p) => n + takesFor(p.id) * (p.kind === 'stage' || p.kind === 'platform' ? 2 : 1), 0);
  return gen.estimate([
    { tool: 'image.edit', params: { prompt: 'stage piece', width: 1344, height: 768 }, count: edits, label: `paint ${pieces.length} pieces (${edits} passes)` },
    { tool: 'llm.json', count: 2, label: 'design + review (Claude)' },
    { tool: 'audio.music', params: { seconds: 60 }, count: 1, label: 'stage music' },
  ]);
}

async function design() {
  const all = await stages();
  const mine = all.find((s) => s.source === folder);
  if (mine && !flag('replace')) {
    log(`${folder} already has a stage (${mine.id}); using it (--replace to design it again)`);
    return mine;
  }
  log(`Claude is designing ${opt('count', 3)} takes on ${folder}...`);
  const out = await api('/maps/generate', { folder, direction: opt('direction', ''), count: Number(opt('count', 3)) });
  const designs = out.designs ?? [];
  if (!designs.length) throw new Error('No designs came back');
  let pick = Number(opt('pick', 0)) - 1;
  let why = 'chosen by number';
  if (pick < 0 && designs.length > 1) {
    // Claude picks between the blockouts, against the concept and what the reference asks for.
    const tmp = path.join(ROOT, '.cache', 'maps', designs[0].stage.id);
    const previews = [];
    for (const [i, d] of designs.entries()) {
      const f = path.join(tmp, `pick-${i + 1}.png`);
      fs.writeFileSync(f, Buffer.from(await (await fetch(`${DEV}${d.preview}`)).arrayBuffer()));
      previews.push(f);
    }
    const ref = path.join(sharedRoot('AllTheMaps', 'DOD_MAPS_ROOT', ROOT), folder, 'reference.txt');
    const r = await askClaude({
      system: 'You are the level designer of a 2D platform fighter. Pick the stage design that plays best for 2 to 4 fighters (readable layout, ledges, room to recover, varied heights, no camping spots) and best delivers the concept.',
      prompt: `Concept: ${folder}\n${fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').slice(0, 3000) : ''}\nDirection: ${opt('direction', 'none')}\n\nThe images are blockouts of designs 1 to ${designs.length}, in order. ${designs.map((d, i) => `Design ${i + 1}: ${d.stage.name}: ${d.stage.blurb}. ${d.stage.notes ?? ''}`.slice(0, 600)).join('\n')}`,
      images: previews, effort: 'medium', maxTokens: 3000, labels: { stage: designs[0].stage.id, step: 'pick-design' },
      schema: { type: 'object', additionalProperties: false, required: ['best', 'why'], properties: { best: { type: 'integer' }, why: { type: 'string' } } },
    });
    pick = Math.max(0, Math.min(designs.length - 1, Number(r.value?.best) - 1));
    why = r.value?.why ?? '';
  }
  const stage = designs[Math.max(0, pick)].stage;
  if (opt('id')) stage.id = opt('id');
  log(`design ${pick + 1}: ${stage.name} (${stage.id}): ${why}`);
  await saveStage(stage);
  report.design = { picked: pick + 1, of: designs.length, why, name: stage.name, id: stage.id };
  return stage;
}

/**
 * Is a GPU server ready or on its way? With none and the fleet's auto start off, paint jobs would sit in the queue
 * with no warning: say so up front (--wait queues anyway; Hawkes Gen's keep-trying or J starts one).
 */
async function gpuReady() {
  let f;
  try {
    f = await gen.fleet();
  } catch (e) {
    log(`couldn't read the GPU fleet (${e.message}); queueing anyway`);
    return;
  }
  const up = (f.servers ?? []).filter((s) => s.state === 'running' || s.state === 'pending');
  if (up.length || f.settings?.auto) return;
  if (flag('wait')) return log('no GPU server is running and auto start is off: queueing anyway (--wait); the jobs start when one does');
  throw new Error(`No GPU server is running (${(f.servers ?? []).length} stopped) and Hawkes Gen's auto start is off, so painting would only queue. Start one with J's OK (hawkesgen_fleet start, or Gen's keep-trying when AWS has no capacity), or pass --wait to queue anyway.`);
}

/** Queues every piece's takes at once (one model load, all servers), then waits. */
async function paint(stage) {
  await gpuReady();
  const pieces = paintPlan(stage);
  const specs = pieces.map((p) => ({ type: 'paint', stage: stage.id, piece: p.id, takes: takesFor(p.id) }));
  log(`painting ${pieces.length} pieces: ${pieces.map((p) => `${p.id} x${takesFor(p.id)}`).join(', ')}`);
  const { added } = await api('/gpu/jobs', { jobs: specs });
  const ids = new Set(added);
  let last = '';
  for (;;) {
    const jobs = (await api('/gpu')).jobs.filter((j) => ids.has(j.id));
    const line = jobs.map((j) => `${j.piece}:${j.status}`).join(' ');
    if (line !== last) log((last = line), jobs.find((j) => j.status === 'running')?.detail ?? '');
    if (jobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.status))) {
      report.paint = jobs.map((j) => ({ piece: j.piece, status: j.status, detail: j.detail }));
      const bad = jobs.filter((j) => j.status !== 'done');
      if (bad.length) log(`not painted: ${bad.map((j) => `${j.piece} (${j.detail})`).join('; ')}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** The best take per piece: platform art by how well it lands on the collision, the rest the newest. As useTake in devtools. */
async function useTakes(stage) {
  const { pieces, takes } = await api(`/maps/takes?stage=${stage.id}`);
  stage.layers ??= [];
  report.takes = [];
  for (const p of pieces) {
    const list = (takes[p.id] ?? []).filter((t) => t.recipe);
    const fit = (t) => t.recipe?.fit?.score ?? -1;
    list.sort((a, b) => fit(b) - fit(a) || b.mtime - a.mtime);
    const t = list[0];
    if (!t) continue;
    const r = t.recipe;
    const place = { image: t.file, x: r.x, y: r.y, width: r.width, aspect: Math.round((r.size[1] / r.size[0]) * 1000) / 1000 };
    if (r.kind === 'stage' && p.id === 'stage') {
      const members = stage.layers.filter((l) => r.layers.includes(l.id) && l.id !== 'stage-art');
      const links = [...new Set(members.flatMap((l) => l.platforms ?? []))].sort((a, b) => a - b);
      let art = stage.layers.find((l) => l.id === 'stage-art');
      if (!art) stage.layers.push((art = { id: 'stage-art', image: '', x: 0, y: 0, width: 1, z: 0.3, note: 'The painted stage: every piece that draws platforms.' }));
      Object.assign(art, place, { z: 0.3, platforms: links });
      delete art.hidden;
      for (const m of members) m.hidden = true;
    } else {
      const l = stage.layers.find((x) => x.id === p.id);
      if (!l) continue;
      Object.assign(l, place);
      if (r.kind === 'backdrop') delete l.shape;
    }
    report.takes.push({ piece: p.id, take: t.file, fit: r.fit?.score ?? null, of: list.length });
  }
  await saveStage(stage);
}

async function review(stage) {
  log('the art director is reviewing it...');
  const out = await api('/maps/review', { stage });
  report.review = { ...out.review, image: out.image };
}

/** Versus and Training only offer the stages listed in content/modes.json. */
async function offer(stage) {
  const modes = await api('/content/modes');
  const added = [];
  for (const [key, m] of Object.entries(modes)) {
    if (!Array.isArray(m?.stages) || m.stages.some((x) => x.stage === stage.id)) continue;
    if (!['Versus', 'Training'].includes(m.name)) continue;
    m.stages.push({ stage: stage.id });
    added.push(m.name ?? key);
  }
  if (added.length) await api('/content/modes', modes);
  report.modes = added;
}

/** The stage's music: a sounds.json entry and an hawkes.assets.json recipe (Studio makes it). */
function music(stage) {
  const id = `music-${stage.id}`;
  const soundsFile = path.join(ROOT, 'content', 'sounds.json');
  const sounds = JSON.parse(fs.readFileSync(soundsFile, 'utf8'));
  const manifestFile = path.join(ROOT, 'hawkes.assets.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.assets.some((a) => a.id === id)) return (report.music = { id, already: true });
  const prompt = String(stage.art?.music ?? `${stage.name}: ${stage.blurb} Driving fighting-game stage theme that fits the place, big hook, steady groove, 120 to 140 BPM, instrumental`).slice(0, 600);
  manifest.assets.push({ id, note: `${stage.name} (AllTheMaps/${stage.source ?? folder}). content/sounds.json ${id}. Written by tools/maps/make.mjs.`, steps: [{ preset: 'stage-theme', params: { prompt, seconds: 60 }, save: 'music' }], files: { music: `audio/sfx/${id}.mp3` } });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
  if (!sounds.some((s) => s.id === id)) {
    sounds.push({ id, group: 'music', text: `${prompt}. Made by Hawkes Gen audio.music from hawkes.assets.json (studio.cmd assets doseofdestruction make).`, loop: true, duration: 60, influence: 0.45, volume: 0.5, file: `/audio/sfx/${id}.mp3`, take: null });
    fs.writeFileSync(soundsFile, `${JSON.stringify(sounds, null, 2)}\n`);
  }
  report.music = { id, prompt };
}

const report = { folder, started: new Date().toISOString() };
async function main() {
  if (!folder) throw new Error('Which concept? node tools/maps/make.mjs <AllTheMaps folder> --all');
  await api('/maps/concepts').catch(() => {
    throw new Error(`The DoD dev server isn't answering at ${DEV} (auto-start.bat or npm run dev)`);
  });
  let stage = (await stages()).find((s) => s.source === folder || s.id === (opt('id') ?? mapSlug(folder)));
  if (flag('estimate')) {
    if (!stage) throw new Error(`${folder} has no saved stage yet: --design first (Claude only, about 15 cents)`);
    console.log(JSON.stringify(await estimate(stage), null, 2));
    return;
  }
  if (flag('design') || flag('all') || !stage) stage = await design();
  if (flag('design') && !flag('all')) report.estimate = await estimate(stage);
  if (flag('paint') || flag('all')) {
    await paint(stage);
    stage = (await stages()).find((s) => s.id === stage.id);
    await useTakes(stage);
    await review(stage);
    music(stage);
    await offer(stage);
  }
  report.stage = stage.id;
  report.finished = new Date().toISOString();
  const out = path.join(ROOT, '.cache', 'maps', stage.id, 'make-report.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(`[make] ${e.message}`);
  process.exit(1);
});
