// Painting a stage on the GPU server. A stage's art is split into pieces:
//
//   backdrop   each far layer (z 10+): painted fresh, inspired by the concept
//   stage      every layer that draws platforms, painted as one picture over
//              a blockout of exactly those shapes and walkable tops, so the
//              art lands on the collision; becomes the "stage-art" layer
//   <layer>    each other layer (scenery behind, pieces in front)
//
// Each piece is painted by Qwen-Image-Edit from its blockout (image 1) in the
// style of the concept art (image 2), then (except backdrops) cut out with
// BiRefNet. Results are takes in stages/<id>/_takes/<piece>-<seed>.webp with
// a .json recipe holding the frame they were painted for; the Maps tab
// applies a take to the stage.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../gpu/env.mjs';
import { paintSettings } from '../gpu/settings.mjs';

const python = process.platform === 'win32' ? 'python' : 'python3';
const venvPython = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PLACEHOLDER_ASPECT = 0.56;
const BACKDROP_ASPECT = 1568 / 672;
const STYLE = 'Polished stylized 2D fighting game art, painterly with clean readable shapes, strong silhouettes and rim light';

export function loadStage(id) {
  const stages = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'stages.json'), 'utf8'));
  const st = stages.find((s) => s.id === id);
  if (!st) throw new Error(`No saved stage "${id}". Save stages first: painting uses the saved stage.`);
  return st;
}

/** The aspect a layer was painted (or will be painted) at. */
function aspectOf(stage, l) {
  if (l.aspect) return l.aspect;
  if (l.image) {
    const recipe = l.image.replace(/\.\w+$/, '.json');
    try {
      const r = JSON.parse(fs.readFileSync(path.join(ROOT, recipe), 'utf8'));
      if (r.size) return r.size[1] / r.size[0];
    } catch {
      // Not a painted take (an upload or the concept): read nothing, use the default.
    }
  }
  return l.z >= 10 ? 1 / BACKDROP_ASPECT : PLACEHOLDER_ASPECT;
}

function box(stage, l) {
  const hh = (l.width * aspectOf(stage, l)) / 2;
  return { x1: l.x - l.width / 2, x2: l.x + l.width / 2, y1: l.y - hh, y2: l.y + hh };
}

/** A layer's silhouette in world units: its sketched shape, or its box. */
function parts(stage, l) {
  if (l.shape?.length) return l.shape.map((r) => ({ x1: l.x + r.x1, x2: l.x + r.x2, y1: l.y + r.y1, y2: l.y + r.y2 }));
  return [box(stage, l)];
}

/** Everything that can be painted for a stage. */
export function paintPlan(stage) {
  const layers = stage.layers ?? [];
  const pieces = [];
  for (const l of layers) if (l.z >= 10 && !l.hidden) pieces.push({ id: l.id, kind: 'backdrop', layers: [l.id] });
  // Platform art that moves on its own (loops, reacts, comes and goes with an
  // event, or draws a platform that moves or switches) is painted as its own
  // piece, so it can move apart from the rest. The rest is one painting.
  const dynamic = (l) => l.anim || l.reacts?.length || l.showDuring || l.hideDuring
    || (l.platforms ?? []).some((n) => { const p = stage.platforms[n]; return p?.motion || p?.offDuring || p?.onlyDuring; });
  const drawers = layers.filter((l) => l.platforms?.length && l.id !== 'stage-art' && !l.hidden);
  const still = layers.filter((l) => l.platforms?.length && !dynamic(l));
  if (still.length) pieces.push({ id: 'stage', kind: 'stage', layers: still.map((l) => l.id) });
  for (const l of drawers) if (dynamic(l)) pieces.push({ id: l.id, kind: 'stage', layers: [l.id] });
  for (const l of layers) {
    if (l.z >= 10 || l.platforms?.length || l.id === 'stage-art' || l.hidden) continue;
    pieces.push({ id: l.id, kind: l.z < 0 ? 'front' : 'scenery', layers: [l.id] });
  }
  return pieces;
}

/** The world box a piece is painted for, and the pixel size to paint it at (~1 megapixel, multiples of 16). */
function framing(stage, piece) {
  const members = (stage.layers ?? []).filter((l) => piece.layers.includes(l.id) && l.id !== 'stage-art');
  let f;
  if (piece.kind === 'backdrop') {
    const l = members[0];
    const hh = l.width / BACKDROP_ASPECT / 2;
    f = { x1: l.x - l.width / 2, x2: l.x + l.width / 2, y1: l.y - hh, y2: l.y + hh };
  } else {
    const boxes = members.map((l) => box(stage, l));
    if (piece.kind === 'stage') {
      for (const n of new Set(members.flatMap((l) => l.platforms ?? []))) {
        const p = stage.platforms[n];
        if (p) boxes.push({ x1: p.x1, x2: p.x2, y1: p.y - (p.solid ? p.depth ?? 90 : 12), y2: p.y + 10 });
      }
    }
    f = {
      x1: Math.min(...boxes.map((b) => b.x1)), x2: Math.max(...boxes.map((b) => b.x2)),
      y1: Math.min(...boxes.map((b) => b.y1)), y2: Math.max(...boxes.map((b) => b.y2)),
    };
    // A little room around the shapes, and no aspect more extreme than the model likes.
    const pad = 0.05 * Math.max(f.x2 - f.x1, f.y2 - f.y1);
    f = { x1: f.x1 - pad, x2: f.x2 + pad, y1: f.y1 - pad, y2: f.y2 + pad };
    const aspect = (f.x2 - f.x1) / (f.y2 - f.y1);
    if (aspect > 2.4) {
      const grow = ((f.x2 - f.x1) / 2.4 - (f.y2 - f.y1)) / 2;
      f.y1 -= grow;
      f.y2 += grow;
    } else if (aspect < 0.45) {
      const grow = ((f.y2 - f.y1) * 0.45 - (f.x2 - f.x1)) / 2;
      f.x1 -= grow;
      f.x2 += grow;
    }
  }
  const aspect = (f.x2 - f.x1) / (f.y2 - f.y1);
  const w = Math.round(Math.sqrt(1048576 * aspect) / 16) * 16;
  const h = Math.round(w / aspect / 16) * 16;
  return { frame: f, size: [w, h] };
}

/** "upper left", "center", "lower right"... where a box sits in a frame, for prompts. */
function where(f, b) {
  const cx = ((b.x1 + b.x2) / 2 - f.x1) / (f.x2 - f.x1);
  const cy = ((b.y1 + b.y2) / 2 - f.y1) / (f.y2 - f.y1);
  const h = cx < 0.36 ? 'left' : cx > 0.64 ? 'right' : 'center';
  const v = cy > 0.64 ? 'upper ' : cy < 0.36 ? 'lower ' : '';
  return `${v}${h}`.trim();
}

function blockoutSpec(stage, piece, { frame, size }) {
  const members = (stage.layers ?? []).filter((l) => piece.layers.includes(l.id) && l.id !== 'stage-art');
  if (piece.kind === 'backdrop') {
    const sky = stage.theme?.sky ?? ['#2a2440', '#151225', '#0b0a12'];
    // Just the sky's colors: a band here gets painted as a floor (with people on it).
    return { frame, size, background: { top: sky[2], bottom: sky[0] }, shapes: [] };
  }
  // In the stage's own colors, so a partial repaint (which keeps the flat, straight-on
  // shapes) only has to add detail and light, not change every color.
  const t = stage.theme ?? {};
  const body = t.body ?? '#6a6a6a';
  const shade = t.under ?? '#3a3a3a';
  const edge = t.edge ?? '#c0c0c0';
  // Buildings get windows to become; everything gets shading and grain.
  const facade = (l) => /building|facade|tower|wall|apartment|office|window|brick|high-rise/i.test(`${l.prompt ?? ''} ${l.note ?? ''} ${l.id}`);
  const scale = size[0] / (frame.x2 - frame.x1);
  const windowsFor = (l, r) => paintSettings().windows && facade(l) && (r.x2 - r.x1) > 160 && (r.y2 - r.y1) > 160 ? { size: Math.max(10, Math.round(26 * scale * 1.6)), lit: t.glow && t.glow !== '#ff5a1f' ? t.glow : '#f0b45a', dark: shade, share: 0.55 } : undefined;
  const shapes = members.flatMap((l) => parts(stage, l).map((r) => ({ kind: 'box', ...r, fill: body, line: shade, texture: true, windows: windowsFor(l, r) })));
  if (piece.kind === 'stage') {
    for (const n of new Set(members.flatMap((l) => l.platforms ?? []))) {
      const p = stage.platforms[n];
      if (!p) continue;
      if (p.solid) shapes.push({ kind: 'box', x1: p.x1, x2: p.x2, y1: p.y - (p.depth ?? 90), y2: p.y, fill: body, line: shade, texture: true });
      shapes.push({ kind: 'top', x1: p.x1, x2: p.x2, y: p.y, thick: 8, color: edge });
    }
  }
  return { frame, size, background: '#ffffff', shapes };
}

function describe(l) {
  return (l.prompt || l.note || l.id.replace(/-/g, ' ')).trim().replace(/\.$/, '');
}

/** The prompt for a piece. override replaces the description part (from the review, say). */
export function piecePrompt(stage, piece, { frame }, override) {
  const style = (stage.art?.style || STYLE).trim().replace(/\.$/, '');
  const members = (stage.layers ?? []).filter((l) => piece.layers.includes(l.id) && l.id !== 'stage-art');
  // Never "fighting game": the model paints fighters for it, and at cfg 1 a negative prompt does nothing.
  const empty = 'An empty scene: nobody in it, no figures, no text, no logos.';
  // Qwen likes three-quarter views; a platformer needs a flat elevation that lines up with the collision.
  const tail = `A flat orthographic side elevation, like a classic 2D side-scrolling platformer level: the camera looks straight at the front faces. No perspective, no vanishing points, no visible rooftops or top surfaces; each walkable top shows only as the straight top edge of its structure. ${empty}`;
  if (piece.kind === 'backdrop') {
    const what = override || stage.art?.backdrop || `the far distance of ${stage.name}: ${stage.blurb}`;
    return `Paint a wide, distant background landscape over image 1: ${what}. Use the colors and light of image 2 (a blurred mood board), but compose the scene yourself from this description. Distant scenery only: no ground, floor, ledge or platform in the foreground. The lower third stays darker and calmer. Style: ${style}, game environment art. ${empty}`;
  }
  const parts = override || members.map((l) => `${where(frame, box(stage, l))}: ${describe(l)}`).join('; ');
  if (piece.kind === 'stage') {
    return `Paint image 1 as finished 2D game environment art. Each shape becomes the structure described for its place, at exactly the same position, size and outline: ${parts}. The bright horizontal bars are walkable surfaces (rooftop edges, ledges, catwalks, landings): keep each one exactly where it is, flat and level, as the visible top edge of its structure. Match the art style, palette and lighting of image 2. Style: ${style}. Everything outside the shapes stays plain white. ${tail}`;
  }
  const front = piece.kind === 'front' ? ' It sits close to the camera, in front of the action: darker, slightly silhouetted, with a crisp outline.' : '';
  return `Paint image 1: the shape becomes ${parts.replace(/^[a-z ]+: /, '')}, filling the same position and size.${front} Match the art style, palette and lighting of image 2. Style: ${style}. The background stays plain white. ${tail}`;
}

/**
 * Everything a paint job needs for one piece: the blockout (written to tmp),
 * the concept to style it on, the prompt, and the frame to fit it back into.
 */
export async function preparePiece(stageId, pieceId, opts) {
  const stage = loadStage(stageId);
  // Styled on the stage's concept image.
  let reference = stage.art?.reference ? path.join(ROOT, stage.art.reference) : null;
  if (!reference || !fs.existsSync(reference)) throw new Error(`${stage.name} has no concept image to paint from. Generate it from its AllTheMaps folder first.`);
  // Given the concept itself, Qwen copies it (backdrops) or takes its camera angle (a photo
  // looking down makes three-quarter rooftops). Give every piece only the concept's palette
  // and light; the look comes from the art direction text.
  {
    const mood = path.join(opts.tmpDir, `${stageId}-mood.png`);
    fs.mkdirSync(opts.tmpDir, { recursive: true });
    await run(python, [path.join(ROOT, 'tools', 'maps', 'stage_art.py'), 'moodboard', reference, mood, String(paintSettings().mood)]);
    reference = mood;
  }
  return pieceInputs(stage, pieceId, { ...opts, reference });
}

/** preparePiece for a stage object (saved or not). */
export async function pieceInputs(stage, pieceId, { reference, prompt: override, tmpDir }) {
  const piece = paintPlan(stage).find((p) => p.id === pieceId);
  if (!piece) throw new Error(`${stage.name} has nothing called "${pieceId}" to paint.`);
  const fr = framing(stage, piece);
  fs.mkdirSync(tmpDir, { recursive: true });
  const specFile = path.join(tmpDir, `${stage.id}-${pieceId}-blockout.json`);
  const blockout = path.join(tmpDir, `${stage.id}-${pieceId}-blockout.png`);
  fs.writeFileSync(specFile, JSON.stringify(blockoutSpec(stage, piece, fr)));
  await run(python, [path.join(ROOT, 'tools', 'maps', 'stage_art.py'), 'blockout', specFile, blockout]);
  return { stage, piece, ...fr, blockout, reference, prompt: piecePrompt(stage, piece, fr, override), cutout: piece.kind !== 'backdrop' };
}

/**
 * Saves a painted piece as a take: fitted to its frame, cut out unless it's a
 * backdrop. Returns { name, fit } (fit: how well it lands on its platforms, or
 * null). scoreOnly: just measure it (in a scratch file) and keep nothing.
 */
export async function finishTake(prep, buffer, seed, recipe, { scoreOnly = false } = {}) {
  const dir = scoreOnly ? path.join(ROOT, '.cache', 'gpu', 'tmp') : path.join(ROOT, 'stages', prep.stage.id, '_takes');
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${prep.piece.id}-${seed}.raw.png`);
  const out = path.join(dir, scoreOnly ? `${prep.piece.id}-${seed}.score.webp` : `${prep.piece.id}-${seed}.webp`);
  fs.writeFileSync(raw, buffer);
  const py = prep.cutout ? venvPython : python;
  if (prep.cutout && !fs.existsSync(venvPython)) throw new Error('Cutting out painted pieces needs the project .venv with rembg (see tools/cutout.py).');
  // Pieces that draw platforms get scored on how well their walkable tops land on them.
  const links = [...new Set((prep.stage.layers ?? []).filter((l) => prep.piece.layers.includes(l.id)).flatMap((l) => l.platforms ?? []))];
  let fitArgs = [];
  if (links.length) {
    const fitFile = `${raw}.fit.json`;
    fs.writeFileSync(fitFile, JSON.stringify({ frame: prep.frame, platforms: links.map((n) => prep.stage.platforms[n]).filter(Boolean) }));
    fitArgs = ['--fit', fitFile];
  }
  const res = JSON.parse(await run(py, [path.join(ROOT, 'tools', 'maps', 'stage_art.py'), 'finish', raw, out, String(prep.size[0]), String(prep.size[1]), ...(prep.cutout ? ['--cutout'] : []), ...fitArgs]));
  if (fitArgs.length) fs.rmSync(fitArgs[1], { force: true });
  fs.rmSync(raw, { force: true });
  const fit = res.fit?.score ?? null;
  if (scoreOnly) {
    fs.rmSync(out, { force: true });
    return { name: null, fit: res.empty ? 0 : fit };
  }
  if (res.empty) throw new Error('The cutout removed everything; try another take or a clearer prompt.');
  const f = prep.frame;
  fs.writeFileSync(out.replace(/\.webp$/, '.json'), JSON.stringify({
    ...recipe, stage: prep.stage.id, piece: prep.piece.id, kind: prep.piece.kind, layers: prep.piece.layers, seed, prompt: prep.prompt,
    frame: f, size: prep.size, x: Math.round((f.x1 + f.x2) / 2), y: Math.round((f.y1 + f.y2) / 2), width: Math.round(f.x2 - f.x1), created: Date.now(),
    ...(res.fit ? { fit: res.fit } : {}),
  }, null, 1));
  return { name: path.basename(out), fit };
}

/** Moves a take (and its recipe) out of the way: one that missed the fit target. */
export function dropTake(stageId, name) {
  const dir = path.join(ROOT, 'stages', stageId, '_takes');
  fs.mkdirSync(path.join(dir, '_old'), { recursive: true });
  for (const f of [name, name.replace(/\.webp$/, '.json')]) {
    if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(dir, '_old', f));
  }
}

/** A blockout of a whole design, for picking between generated layouts. */
export async function designPreview(stage, out) {
  const xs = stage.platforms.flatMap((p) => [p.x1, p.x2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const frame = { x1: cx - 1150, x2: cx + 1150, y1: -650, y2: 650 };
  const sky = stage.theme?.sky ?? ['#2a2440', '#151225', '#0b0a12'];
  const shapes = [];
  const layers = [...(stage.layers ?? [])].filter((l) => l.z < 10).sort((a, b) => b.z - a.z);
  for (const l of layers.filter((l) => l.z > 0)) for (const r of parts(stage, l)) shapes.push({ kind: 'box', ...r, fill: l.platforms?.length ? '#5b6b8c' : '#3a4256', line: '#8090b0' });
  for (const p of stage.platforms) {
    if (p.solid) shapes.push({ kind: 'box', x1: p.x1, x2: p.x2, y1: p.y - (p.depth ?? 90), y2: p.y, fill: p.hidden ? '#4a5a7a' : stage.theme?.body ?? '#444444', line: '#202020' });
    shapes.push({ kind: 'top', x1: p.x1, x2: p.x2, y: p.y, thick: 6, color: '#7ee2a0' });
  }
  for (const l of layers.filter((l) => l.z <= 0)) for (const r of parts(stage, l)) shapes.push({ kind: 'box', ...r, fill: '#6a3550', line: '#ff78b4' });
  for (const s of stage.spawns) shapes.push({ kind: 'box', x1: s.x - 25, x2: s.x + 25, y1: s.y, y2: s.y + 112, fill: '#ffd15a', line: '#806020' });
  const specFile = `${out}.json`;
  fs.writeFileSync(specFile, JSON.stringify({ frame, size: [960, 542], background: { top: sky[2], bottom: sky[0] }, shapes }));
  await run(python, [path.join(ROOT, 'tools', 'maps', 'stage_art.py'), 'blockout', specFile, out]);
  fs.rmSync(specFile, { force: true });
}

/** The stage as the default camera sees it, for the art-director review. */
export async function composite(stage, out) {
  const xs = stage.platforms.flatMap((p) => [p.x1, p.x2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const frame = { x1: cx - 1100, x2: cx + 1100, y1: -560, y2: 680 };
  const item = (l) => ({
    file: l.image && fs.existsSync(path.join(ROOT, l.image)) ? path.join(ROOT, l.image) : null,
    x: l.x, y: l.y, width: l.width, aspect: aspectOf(stage, l), opacity: l.opacity ?? 1, label: l.id,
  });
  const visible = (stage.layers ?? []).filter((l) => !l.hidden);
  const spec = {
    frame, size: [1280, 724], sky: stage.theme?.sky,
    back: visible.filter((l) => l.z > 0).sort((a, b) => b.z - a.z).map(item),
    front: visible.filter((l) => l.z <= 0).sort((a, b) => b.z - a.z).map(item),
    platforms: stage.platforms.map((p) => ({ x1: p.x1, x2: p.x2, y: p.y })),
    fighters: stage.spawns,
  };
  const specFile = `${out}.json`;
  fs.writeFileSync(specFile, JSON.stringify(spec));
  await run(python, [path.join(ROOT, 'tools', 'maps', 'stage_art.py'), 'composite', specFile, out]);
  fs.rmSync(specFile, { force: true });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error((err || out).trim().slice(-500) || `${path.basename(cmd)} exited ${code}`))));
  });
}
