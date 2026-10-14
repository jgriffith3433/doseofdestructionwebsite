// The art-director review: Claude looks at the stage as the default camera
// sees it (tools/maps/paint.mjs composite) next to the concept art and the
// reference, and says what works and what to fix: per piece, with a new
// description for the painter where repainting would fix it.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { readEnv } from '../gpu/env.mjs';
import { paintPlan } from './paint.mjs';

const MODEL = 'claude-opus-5-5';
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const SCHEMA = obj({
  score: { type: 'integer', description: '1 to 10: how close this is to a finished stage the designer would be happy with' },
  summary: { type: 'string', description: 'Two or three sentences: the overall read' },
  works: { type: 'string', description: 'What already works and should be kept' },
  issues: {
    type: 'array',
    description: 'Most important first; at most eight',
    items: obj({
      target: { type: 'string', description: 'A piece id from the list, or "layout" or "style"' },
      problem: { type: 'string' },
      fix: { type: 'string', description: 'What to change, concretely' },
      repaint: { type: 'string', description: 'If repainting that piece fixes it: the new description for the painter (what it should look like). Otherwise ""' },
    }),
  },
});

const SYSTEM = `You are the art director for Dose of Destruction, a 2D platform fighter in the style of Super Smash Bros. You review stages before they ship.

You see the stage as the game's default camera frames it: painted layers (unpainted ones are pink outlined boxes), the walkable platform tops as thin green lines, and yellow boxes where fighters spawn (a fighter is about that size). You also see the designer's concept art and read their reference text: that is the target.

Judge it like a game art director:
- Does it feel like the concept and the reference: place, mood, palette, scale?
- Readability: can players see where they can stand? Do the walkable tops in the art sit on the green lines? Do fighters (bright, saturated) stand out against it, or would they get lost?
- Composition: is there a clear focal area, depth from back to front, nothing cluttering the play space?
- Consistency: do the pieces look like one painting, in one style and light?

Be specific and practical. Each issue names its target: a piece id from the list you are given, "layout" for changes to the platforms, or "style" for the art direction as a whole. When repainting a piece would fix it, write the new painter's description in "repaint": what it should look like, not where it goes.`;

export async function reviewStage({ stage, composite, concepts, reference }) {
  const env = readEnv();
  const key = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('The art-director review needs ANTHROPIC_API_KEY in .env.');
  const client = new Anthropic({ apiKey: key });
  const pieces = paintPlan(stage).map((p) => {
    const layers = (stage.layers ?? []).filter((l) => p.layers.includes(l.id));
    const painted = layers.some((l) => l.image) || (p.kind === 'stage' && (stage.layers ?? []).some((l) => l.id === 'stage-art' && l.image));
    return `- ${p.id} (${p.kind}${painted ? ', painted' : ', not painted yet'}): ${layers.map((l) => l.prompt || l.note || l.id).join(' / ')}`;
  });
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(composite).toString('base64') } },
    { type: 'text', text: 'The stage as the default camera sees it.' },
  ];
  for (const c of concepts.slice(0, 3)) {
    content.push({ type: 'image', source: { type: 'base64', media_type: c.endsWith('.png') ? 'image/png' : 'image/webp', data: fs.readFileSync(c).toString('base64') } });
    content.push({ type: 'text', text: 'Concept art.' });
  }
  content.push({
    type: 'text',
    text: [
      `Stage: ${stage.name}. ${stage.blurb}`,
      `Reference from the designer:\n"""\n${reference.trim() || '(none)'}\n"""`,
      `Art direction: ${stage.art?.style || '(none set)'}`,
      `Pieces:\n${pieces.join('\n') || '(none)'}`,
      'Review it.',
    ].join('\n\n'),
  });
  let response;
  try {
    response = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    }).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('The ANTHROPIC_API_KEY in .env was rejected.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate limited right now; try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to review this stage.');
  if (response.stop_reason === 'max_tokens') throw new Error('The review ran out of room. Try again.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { review: JSON.parse(text), usage: response.usage };
  } catch {
    throw new Error('Claude returned something that is not a review. Try again.');
  }
}
