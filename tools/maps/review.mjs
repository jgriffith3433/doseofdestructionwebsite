// The art-director review: Claude looks at the stage as the default camera
// sees it (tools/maps/paint.mjs composite) next to the concept art and the
// reference, and says what works and what to fix: per piece, with a new
// description for the painter where repainting would fix it.

import { askClaude, claudeAvailable } from '../gpu/gen.mjs';
import { paintPlan } from './paint.mjs';
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
  if (!(await claudeAvailable())) throw new Error('The art-director review needs Hawkes Gen running (C:\\Projects\\hawkesgen\\auto-start.bat) with ANTHROPIC_API_KEY in its .env.');
  const pieces = paintPlan(stage).map((p) => {
    const layers = (stage.layers ?? []).filter((l) => p.layers.includes(l.id));
    const painted = layers.some((l) => l.image) || (p.kind === 'stage' && (stage.layers ?? []).some((l) => l.id === 'stage-art' && l.image));
    return `- ${p.id} (${p.kind}${painted ? ', painted' : ', not painted yet'}): ${layers.map((l) => l.prompt || l.note || l.id).join(' / ')}`;
  });
  const shots = concepts.slice(0, 3);
  const r = await askClaude({
    prompt: [
      `Image 1 is the stage as the default camera sees it.${shots.length ? ` Images 2 to ${shots.length + 1} are concept art.` : ''}`,
      `Stage: ${stage.name}. ${stage.blurb}`,
      `Reference from the designer:\n"""\n${reference.trim() || '(none)'}\n"""`,
      `Art direction: ${stage.art?.style || '(none set)'}`,
      `Pieces:\n${pieces.join('\n') || '(none)'}`,
      'Review it.',
    ].join('\n\n'),
    system: SYSTEM,
    images: [composite, ...shots],
    schema: SCHEMA,
    maxTokens: 16000,
    labels: { stage: stage.id, step: 'map-review' },
  });
  if (!r.value) throw new Error('Claude returned something that is not a review. Try again.');
  return { review: r.value, usage: r.usage };
}
