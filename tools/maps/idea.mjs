// "Generate Map Idea": turns a folder in C:\Projects\AllTheMaps (concept
// images and a reference.txt) into a few distinct stage designs to pick from:
// layout, art direction, silhouettes for every piece of art (which the GPU
// server then paints, tools/maps/paint.mjs), and the effects the reference
// asks for. A design can be revised with feedback. The Maps tab opens the
// chosen one unsaved, to edit and save.
//
// With ANTHROPIC_API_KEY in .env, Claude reads the concept art and the
// reference and designs the stage (structured output, so the JSON always
// fits). Without it, a plain draft is built from the image's colors and
// keywords in the reference.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { readEnv } from '../gpu/env.mjs';

const MODEL = 'claude-opus-5-5';
const PROPS = ['frame', 'skyline', 'clouds', 'embers', 'pipes'];
const HEX = { type: 'string', description: 'A #rrggbb color' };
const INT = { type: 'integer' };
const NUM = { type: 'number' };
const BOOL = { type: 'boolean' };
const STR = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** What Claude must return. Every field is required, so the stage is always complete. */
const SCHEMA = obj({
  name: { type: 'string', description: 'Display name, two or three words' },
  blurb: { type: 'string', description: 'One short sentence for the stage select screen' },
  platforms: {
    type: 'array',
    items: obj({
      label: { type: 'string', description: 'What it is in the art, e.g. "main rooftop", "fire escape landing"' },
      x1: INT, x2: INT, y: INT,
      solid: BOOL,
      depth: { type: 'integer', description: 'Solid only: how far the block goes down; 0 for thin' },
      hidden: { type: 'boolean', description: 'True when the stage art will draw this platform (no default block)' },
      moves: BOOL,
      swingX: { type: 'integer', description: 'Moving thin platforms: units each way; else 0' },
      swingY: INT,
      period: { type: 'integer', description: 'Frames per cycle (60 = 1 second); 0 if it does not move' },
    }),
  },
  spawns: { type: 'array', items: obj({ x: INT, y: INT }), description: 'Exactly four, each standing on a platform top' },
  respawn: obj({ x: INT, y: INT }),
  blast: obj({ left: INT, right: INT, top: INT, bottom: INT }),
  theme: obj({
    sky: { type: 'array', items: HEX, description: 'Backdrop gradient center, middle, edge' },
    glow: HEX, body: HEX, under: HEX, edge: HEX, thinEdge: HEX,
    props: { type: 'string', enum: PROPS },
  }),
  backdrop: obj({
    x: INT, y: INT,
    width: { type: 'integer', description: 'Width in world units as seen from the default camera' },
    z: { type: 'number', description: 'Depth behind the fighters, 12 to 30 for a distant backdrop' },
  }),
  art: {
    type: 'array',
    description: 'Art layers the artist should paint, as placeholders positioned where they go',
    items: obj({
      id: { type: 'string', description: 'kebab-case, e.g. "front-railing"' },
      note: { type: 'string', description: 'What to paint, for the artist' },
      x: INT, y: INT, width: INT,
      z: { type: 'number', description: 'Behind the fighters 3 to 12; in front -1.5 to -5' },
      occluder: { type: 'boolean', description: 'In front of the fighters and covers them (they show as a silhouette)' },
      draws: { type: 'array', items: INT, description: 'Indices into "platforms" of the platforms this art draws (their walkable tops are part of it); [] for scenery' },
      paint: { type: 'string', description: 'For the painter: what it looks like (materials, colors, details, lighting), no coordinates' },
      shape: { type: 'string', description: '1 to 8 rectangles in world units sketching its silhouette, as "x1 y1 x2 y2" separated by ";" (e.g. a water tower: tank; leg; leg; deck). Walkable tops must sit exactly at their platform y' },
    }),
  },
  effects: {
    type: 'array',
    items: obj({
      on: { type: 'string', enum: ['start', 'ko', 'end', 'ambient'] },
      kind: { type: 'string', enum: ['firework', 'burst', 'shake', 'embers'] },
      colors: { type: 'array', items: HEX },
      count: INT,
      every: { type: 'number', description: 'Ambient only: seconds between; else 0' },
      at: { type: 'string', enum: ['sky', 'ko'] },
      sound: { type: 'string', description: 'A sound id from the list, or "" for none' },
    }),
  },
  style: { type: 'string', description: 'Art direction for the whole stage: rendering style, palette, lighting, mood, in two or three sentences' },
  backdropPrompt: { type: 'string', description: 'For the painter: the far background to paint, inspired by the concept but a new composition' },
  notes: { type: 'string', description: 'Design notes for the team: how the stage plays, and what art to paint, in priority order' },
});



const SYSTEM = `You design stages for Dose of Destruction, a 2D platform fighter in the style of Super Smash Bros: up to four fighters knock each other off the stage, and a fighter is out when launched past the blast zone.

Coordinates (world units): x to the right, y up. The main floor's top is at y = 0. Platforms are horizontal: x1 to x2 at height y.
- Solid platforms have sides, a bottom and grabbable ledges at both top corners; fighters can't pass through them. The main stage is solid.
- Thin platforms are one-way: fighters jump up through them and can drop down. Only thin platforms may move.
- A fighter is about 110 units tall and 50 wide. A full jump rises 115 to 160 units; with the air jump, about 210 to 290 in all. Thin platforms 110 to 150 above what is below them are easy to reach; more than 250 is out of reach.
- The main stage is usually 900 to 1300 wide, centered on x = 0. Leave room off both sides to fall and recover.
- Blast zone: typically left/right at +-1300 to +-1600, top 1050 to 1300, bottom -700 to -900. A narrow blast zone makes KOs come too early.
- Four spawns standing on platform tops (y equal to that platform's y, x inside it), spread out; respawn about 350 to 500 above the stage center.

Art: the concept images are references, not the art. Every piece is painted new by an image model that takes a blockout of your shapes and paints it in the style of the concept, so your shapes decide what the stage looks like.
Read the concept for composition first: where the big masses are, how high the horizon sits, what dominates the view, the scale of things. Translate that into a playable side view.
"style" is the shared art direction every piece is painted in. "backdropPrompt" is the far background, painted fresh (inspired by the concept, a new composition). Place it with "backdrop": x and y are its center and width its width as seen from the default camera, which shows roughly x -800..800 and y -300..600 of the fighters' plane; the camera zooms out to about twice that, so make it at least 2600 wide. Its z (12 to 30) pushes it back for parallax.
Then list every other piece of art in "art". Give each a "paint" description for the painter and a "shape": a few rectangles sketching its silhouette in world units (a penthouse: its block and a door; a water tower: tank, two legs, deck; a fire escape: landings, ladder, railing). The painter follows the shape closely, so make it read as the thing. x, y and width are the piece's overall box. Depth matters because the camera moves and z gives parallax:
- Art that draws a platform fighters stand on (a rooftop, a catwalk, a landing, a ledge) must sit at z 0.3, the fighters' own depth, so it stays lined up with the collision as the camera moves. Size and place it so the walkable top lines up with the platform's y.
- Scenery nobody stands on (buildings in the distance, the wall below the main floor when the main floor keeps its default block) goes at z 3 to 12.
- Things in front of the fighters go at z -1.5 to -5: railings, signs, chimneys, foliage. Foreground pieces that fighters pass behind are occluders: the game shows a silhouette of anyone behind them, so fighters are never lost. Use one or two, not a wall.
For each art layer that draws platforms, list their indices in "draws" and set those platforms "hidden" (the game draws no default block for them once the art is painted; until then it still draws blocks, so the stage is always playable). This includes the main stage when its art (a rooftop, an island, a deck) draws it. One layer per platform: if a building has a fire escape bolted to it, the fire escape draws the landings and the building is scenery behind it (z 3 or more), not a second layer at 0.3.

Effects react to the match: on "ko" (a fighter is KO'd), "end" (the match ends, a finale over two seconds), "start", or "ambient" (every few seconds). Kinds: firework (rises from below and bursts in the sky), burst (sparks at the KO or in the sky), shake (camera), embers (rising sparks). Only add effects the reference asks for or that clearly suit it.

Theme colors also paint any default platform blocks: body is the platform face, under its underside, edge the glowing top edge of solid platforms and thinEdge of thin ones. Pick colors from the concept so default blocks blend in.

Make the stage fun and fair first, true to the concept second. Follow the reference text closely: it is the designer's intent. When you are asked for several designs, make them genuinely different (layout, verticality, which parts of the concept they build on), not variations of one.`;

/** How each of several designs should differ, so they aren't variations of one. */
const ANGLES = [
  'Stay close to the concept art and the reference.',
  'Push verticality: more levels and bigger height differences, still easy to move around.',
  'Take a bolder, more surprising interpretation of the concept that still honors the reference.',
  'Keep it compact and competitive: fewer, cleaner platforms with strong edge play.',
];
const REVISE_ANGLES = [
  'Address the feedback directly and keep everything else.',
  'Address the feedback and go a step further where it points.',
  'Address the feedback with a different solution than the obvious one.',
  'Address the feedback while simplifying the stage.',
];

/**
 * Stage designs for one AllTheMaps folder: { designs: StageDef[], ai }.
 * direction: what the designer imagines, on top of reference.txt.
 * base + feedback: revise that design instead of starting over.
 * Each design is its own request (in parallel), with its own angle.
 */
export async function mapIdeas({ id, name, folder, reference, images, backdrop, palette, sounds, example, count = 3, direction = '', base = null, feedback = '' }) {
  const env = readEnv();
  const key = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return { designs: [plainIdea({ id, name, folder, reference, backdrop, palette }).stage], ai: false, why: 'Add ANTHROPIC_API_KEY to .env for AI-designed stages.' };
  count = Math.max(1, Math.min(4, Number(count) || 3));

  const client = new Anthropic({ apiKey: key });
  const shared = [];
  for (const img of images.slice(0, 4)) {
    shared.push({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: fs.readFileSync(img.file).toString('base64') } });
    shared.push({ type: 'text', text: `Concept image: ${img.label}` });
  }
  const context = [
    `Stage: ${name} (folder ${folder}).`,
    `Reference from the designer:
"""
${reference.trim() || '(none)'}
"""`,
    `Colors in the first concept image, most common first: ${palette.colors.map((c) => c.hex).join(', ')}. Bright accents: ${palette.accents.join(', ') || 'none'}.`,
    `Sound ids you may use for effects: ${sounds.join(', ') || '(none yet)'}.`,
    `An existing stage, for scale:
${JSON.stringify(example)}`,
    direction.trim() && `How the designer imagines it (follow this closely):
"""
${direction.trim()}
"""`,
    base && `The current design:
${JSON.stringify(base)}

The designer's feedback on it:
"""
${feedback.trim() || '(none: improve it)'}
"""`,
  ].filter(Boolean).join('\n\n');

  const one = async (i) => {
    const angle = (base ? REVISE_ANGLES : ANGLES)[i % 4];
    const ask = base
      ? `Revise this design. ${angle} Keep what the feedback doesn't mention, unless it is what makes the stage worse.`
      : count > 1 ? `Design this stage. This is take ${i + 1} of ${count}: ${angle}` : 'Design this stage.';
    let response;
    try {
      response = await client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: [...shared, { type: 'text', text: `${context}

${ask}` }] }],
      }).finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('The ANTHROPIC_API_KEY in .env was rejected.');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate limited right now; try again in a minute.');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
      throw e;
    }
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to design this stage. Try rewording reference.txt.');
    if (response.stop_reason === 'max_tokens') throw new Error('A design ran out of room before it finished. Try again.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return { stage: toStage(JSON.parse(text), { id, folder, backdrop }), usage: response.usage, model: response.model };
    } catch {
      throw new Error('Claude returned something that is not a stage design. Try again.');
    }
  };
  // Keep whichever designs came back; fail only if none did.
  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => one(i)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  const usage = ok.reduce((u, r) => ({ input_tokens: u.input_tokens + (r.usage.input_tokens ?? 0), output_tokens: u.output_tokens + (r.usage.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
  return { designs: ok.map((r) => r.stage), ai: true, model: ok[0].model, usage, failed: results.length - ok.length };
}

/** Claude's design as a StageDef: integers where the sim needs them, sane limits, layers wired up. */
function toStage(idea, { id, folder, backdrop }) {
  const int = (v, lo = -5000, hi = 5000) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
  const platforms = (idea.platforms ?? []).map((p) => {
    const x1 = int(Math.min(p.x1, p.x2));
    const x2 = Math.max(x1 + 40, int(Math.max(p.x1, p.x2)));
    const out = { x1, x2, y: int(p.y), solid: !!p.solid };
    if (out.solid) out.depth = Math.max(20, int(p.depth || 90, 20, 600));
    if (p.hidden) out.hidden = true;
    if (!out.solid && p.moves && p.period > 0) out.motion = { ax: int(p.swingX, -800, 800), ay: int(p.swingY, -800, 800), period: Math.max(90, int(p.period, 1, 3600)) };
    return out;
  });
  const shift = platforms.some((p) => p.solid) ? 0 : 1;
  if (shift) platforms.unshift({ x1: -560, x2: 560, y: 0, solid: true, depth: 90 });
  const blast = { left: int(idea.blast?.left ?? -1400), right: int(idea.blast?.right ?? 1400), top: int(idea.blast?.top ?? 1150), bottom: int(idea.blast?.bottom ?? -750) };
  const spawns = (idea.spawns ?? []).slice(0, 4).map((s) => ({ x: int(s.x), y: int(s.y) }));
  while (spawns.length < 4) spawns.push({ x: [-300, 300, -110, 110][spawns.length], y: 0 });
  const t = idea.theme ?? {};
  const layers = [
    { id: 'backdrop', image: '', x: int(idea.backdrop?.x ?? 0), y: int(idea.backdrop?.y ?? 250), width: Math.max(800, int(idea.backdrop?.width ?? 2800, 100, 20000)), z: clampZ(idea.backdrop?.z ?? 20, 6, 60), note: 'The far background, painted fresh from the concept.', prompt: String(idea.backdropPrompt ?? '') },
    ...(idea.art ?? []).map((a, i) => {
      // Platform indices shift by one if a missing main stage was added at the front.
      const draws = [...new Set((a.draws ?? []).map((n) => int(n) + shift))].filter((n) => n >= 0 && n < platforms.length);
      const layer = {
        id: slug(a.id) || `art-${i + 1}`, image: '', x: int(a.x), y: int(a.y), width: Math.max(40, int(a.width, 1, 20000)),
        z: draws.length ? 0.3 : clampZ(a.z, -8, 40), ...(a.occluder && a.z < 0 && !draws.length ? { occluder: true } : {}), note: String(a.note ?? ''),
        ...(a.paint ? { prompt: String(a.paint) } : {}),
        ...(draws.length ? { platforms: draws } : {}),
      };
      // The silhouette sets the box, and is kept relative to its center so it moves with the layer.
      // "x1 y1 x2 y2; x1 y1 x2 y2; ..." (a string keeps the schema small enough to enforce).
      const rects = String(a.shape ?? '').split(';').map((t) => t.trim().split(/[\s,]+/).map(Number)).filter((n) => n.length === 4 && n.every(Number.isFinite));
      const parts = rects.map(([ax, ay, bx, by]) => ({ x1: int(Math.min(ax, bx)), x2: int(Math.max(ax, bx)), y1: int(Math.min(ay, by)), y2: int(Math.max(ay, by)) })).filter((r) => r.x2 > r.x1 && r.y2 > r.y1).slice(0, 12);
      if (parts.length) {
        const bx = { x1: Math.min(...parts.map((r) => r.x1)), x2: Math.max(...parts.map((r) => r.x2)), y1: Math.min(...parts.map((r) => r.y1)), y2: Math.max(...parts.map((r) => r.y2)) };
        layer.x = Math.round((bx.x1 + bx.x2) / 2);
        layer.y = Math.round((bx.y1 + bx.y2) / 2);
        layer.width = Math.max(20, bx.x2 - bx.x1);
        layer.aspect = Math.round(((bx.y2 - bx.y1) / layer.width) * 1000) / 1000;
        layer.shape = parts.map((r) => ({ x1: r.x1 - layer.x, x2: r.x2 - layer.x, y1: r.y1 - layer.y, y2: r.y2 - layer.y }));
      }
      return layer;
    }),
  ];
  for (const l of layers) for (const n of l.platforms ?? []) platforms[n].hidden = true;
  const effects = (idea.effects ?? []).map((e) => {
    const out = { on: e.on, kind: e.kind };
    const colors = (e.colors ?? []).map((c) => hex(c, null)).filter(Boolean);
    if (colors.length) out.colors = colors;
    // Each firework is ~36 particles; keep a finale smooth on slower machines.
    if (e.count > 0) out.count = Math.min(e.on === 'end' ? 20 : 6, int(e.count, 1, 30));
    if (e.on === 'ambient') out.every = Math.max(1, Math.min(60, Number(e.every) || 5));
    if (e.at) out.at = e.at;
    if (e.sound) out.sound = String(e.sound);
    return out;
  });
  alignPlatformArt(layers, platforms);
  return {
    id,
    name: String(idea.name || id),
    blurb: String(idea.blurb || ''),
    platforms,
    blast,
    spawns,
    respawn: { x: int(idea.respawn?.x ?? 0), y: int(idea.respawn?.y ?? 420) },
    theme: {
      sky: [0, 1, 2].map((i) => hex(t.sky?.[i], ['#2a2440', '#151225', '#0b0a12'][i])),
      glow: hex(t.glow, '#ff5a1f'), body: hex(t.body, '#3a3340'), under: hex(t.under, '#1c1820'),
      edge: hex(t.edge, '#ffb020'), thinEdge: hex(t.thinEdge, '#ffd15a'), props: PROPS.includes(t.props) ? t.props : 'skyline',
    },
    layers,
    effects,
    source: folder,
    art: { style: String(idea.style || ''), reference: backdrop.reference },
    notes: String(idea.notes || ''),
  };
}

/** A draft without AI: a standard layout, colors from the concept, effects from keywords. */
function plainIdea({ id, name, folder, reference, backdrop, palette }) {
  const dark = [...palette.colors].sort((a, b) => a.lum - b.lum);
  const accent = palette.accents[0] ?? '#ffb020';
  const text = reference.toLowerCase();
  const effects = [];
  if (/firework/.test(text)) {
    effects.push({ on: 'ko', kind: 'firework', at: 'sky', count: 2 });
    if (/end|final|finish/.test(text)) effects.push({ on: 'end', kind: 'firework', at: 'sky', count: 14 });
  }
  if (/ember|lava|volcan|burning|inferno/.test(text)) effects.push({ on: 'ambient', kind: 'embers', every: 3, count: 8 });
  if (/quake|shake|earthquake/.test(text)) effects.push({ on: 'ko', kind: 'shake' });
  return {
    stage: {
      id,
      name,
      blurb: reference.split(/[.\n]/)[0].trim().slice(0, 90),
      platforms: [
        { x1: -600, x2: 600, y: 0, solid: true, depth: 120 },
        { x1: -420, x2: -180, y: 140, solid: false },
        { x1: 180, x2: 420, y: 140, solid: false },
        { x1: -120, x2: 120, y: 280, solid: false },
      ],
      blast: { left: -1450, right: 1450, top: 1150, bottom: -780 },
      spawns: [{ x: -320, y: 0 }, { x: 320, y: 0 }, { x: -120, y: 0 }, { x: 120, y: 0 }],
      respawn: { x: 0, y: 440 },
      theme: {
        sky: [dark[2]?.hex ?? '#232120', dark[1]?.hex ?? '#101011', dark[0]?.hex ?? '#050a0e'],
        glow: accent, body: dark[3]?.hex ?? '#403730', under: dark[1]?.hex ?? '#161311', edge: accent, thinEdge: palette.accents[1] ?? accent, props: 'skyline',
      },
      layers: [{ id: 'backdrop', image: '', x: 0, y: 250, width: 2800, z: 20, note: 'The far background, painted fresh from the concept.' }],
      art: { style: '', reference: backdrop.reference },
      effects,
      source: folder,
      notes: `Plain draft (no AI). The layout is the standard three-platform one; reshape it to the concept.\n\nReference:\n${reference.trim()}`,
    },
  };
}

/**
 * Art that draws a collision-only platform has to sit at the fighters' depth,
 * or parallax slides it off the collision as the camera moves. Any layer
 * behind the fighters whose box holds a hidden platform's top moves there.
 */
export function alignPlatformArt(layers, platforms) {
  const linked = new Set(layers.flatMap((l) => l.platforms ?? []));
  platforms.forEach((p, n) => {
    if (!p.hidden || linked.has(n)) return;
    // The smallest layer behind the fighters whose box holds the platform's top draws it.
    const holders = layers.filter((l) => {
      if (l.id === 'backdrop' || l.z <= 0) return false;
      const hh = (l.width * (l.aspect ?? 0.56)) / 2;
      // A walkway often runs along the bottom edge of its art (a catwalk under a billboard).
      const m = Math.min(60, Math.max(20, hh * 0.5));
      return p.x2 > l.x - l.width / 2 && p.x1 < l.x + l.width / 2 && p.y <= l.y + hh + m && p.y >= l.y - hh - m;
    });
    const best = holders.sort((a, b) => a.width - b.width)[0];
    if (best) {
      best.z = 0.3;
      best.platforms = [...(best.platforms ?? []), n];
    }
  });
  // Back to front; at one depth, the bigger piece goes behind.
  layers.sort((a, b) => (a.id === 'backdrop' ? -1 : b.id === 'backdrop' ? 1 : b.z - a.z || b.width - a.width));
}

function clampZ(z, lo, hi) {
  const n = Number(z);
  return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0)) * 10) / 10;
}

function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
