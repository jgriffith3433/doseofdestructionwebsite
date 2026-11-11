// Tour on screen: the select screen (one tile per fighter, cleared ones marked), the compact "knocked out" panel with
// Continue or Quit between fights, and the banner on the final results. Rules and data are campaign/tour.ts.
import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { TOURS, TOUR_LENGTH, TWIST_RULE, type Tour, type TourFight } from '../campaign/tour.ts';
import { $, h, headUrl, thumbUrl } from './dom.ts';

const nameOf = (id: string): string => CHARACTERS.find((c) => c.id === id)?.name ?? id;
const stageName = (id: string): string => STAGES.find((s) => s.id === id)?.name ?? id;

export interface TourSelectHooks {
  /** Whether the fighter may be picked (campaign unlocks). */
  open(id: string): boolean;
  onPlay(tour: Tour): void;
}

/** The select screen: every fighter that has a Tour, cleared ones marked, locked ones greyed. */
export function renderTourSelect(done: ReadonlySet<string>, hooks: TourSelectHooks): void {
  const cleared = TOURS.filter((t) => done.has(t.fighter)).length;
  $('tour-count').textContent = `${cleared} of ${TOURS.length} Tours cleared`;
  const ordered = [...TOURS].sort((a, b) => Number(hooks.open(b.fighter)) - Number(hooks.open(a.fighter)));
  $('tour-grid').replaceChildren(
    ...ordered.map((t) => {
      const open = hooks.open(t.fighter);
      const isDone = done.has(t.fighter);
      return h(
        'button',
        {
          type: 'button',
          class: `tour-tile ${isDone ? 'cleared' : open ? 'open' : 'locked'}`,
          'data-tour': t.fighter,
          'data-cleared': isDone ? '1' : '0',
          disabled: !open,
          'aria-label': `${nameOf(t.fighter)}: ${open ? t.title : 'locked'}${isDone ? ', Tour cleared' : ''}`,
          onclick: () => hooks.onPlay(t),
        },
        h('img', { src: thumbUrl(t.fighter), alt: '' }),
        h('strong', {}, nameOf(t.fighter)),
        h('span', { class: 'tour-route' }, open ? t.title : 'Locked'),
        h('em', { class: 'tour-status' }, isDone ? '★ Tour cleared' : open ? `${TOUR_LENGTH} fights · rival ${nameOf(t.rival)}` : 'Clear its episode to open'),
      );
    }),
  );
}

export interface ChoiceOpts {
  tour: Tour;
  /** Zero-based fight that was lost. */
  index: number;
  fight: TourFight;
  /** Continues used so far in this run, this one included. */
  continues: number;
  onContinue(): void;
  onQuit(): void;
}

/** After a lost fight: a compact card on the results screen with Continue (the same fight again) or Quit. */
export function renderTourChoice(o: ChoiceOpts): void {
  const foes = o.fight.foes.map(nameOf).join(' + ');
  $('results-body').replaceChildren(
    h(
      'article',
      { class: 'tour-choice', id: 'tour-choice', 'data-fight': String(o.index + 1) },
      h('p', { class: 'kicker' }, `${nameOf(o.tour.fighter)} · Tour · Fight ${o.index + 1} of ${o.tour.fights.length}`),
      h('div', { class: 'tour-choice-cast', 'aria-hidden': 'true' }, h('img', { src: headUrl(o.tour.fighter), alt: '' }), h('i', {}, 'vs'), ...o.fight.foes.map((f) => h('img', { src: headUrl(f), alt: '' }))),
      h('h2', {}, 'Knocked out'),
      h('p', { class: 'tour-choice-line' }, `${o.fight.title} against ${foes}, ${stageName(o.fight.stage)}. ${TWIST_RULE[o.fight.twist]}.`),
      h('p', { class: 'tour-choice-note' }, 'Continue plays this fight again. Quit goes back to the Tour list.'),
    ),
  );
  $('results-actions').replaceChildren(
    h('button', { type: 'button', class: 'primary', id: 'tour-continue', 'data-autofocus': true, onclick: o.onContinue }, 'Continue'),
    h('button', { type: 'button', class: 'secondary', id: 'tour-quit', onclick: o.onQuit }, 'Quit'),
  );
}

/** The final results' banner: "<Fighter> clears the Tour". */
export function tourBanner(tour: Tour, continues: number): HTMLElement {
  return h(
    'section',
    { class: 'tour-banner', id: 'tour-cleared', role: 'status' },
    h('img', { src: thumbUrl(tour.fighter), alt: '' }),
    h(
      'div',
      {},
      h('p', { class: 'kicker' }, `Tour · ${tour.title}`),
      h('h2', {}, `${nameOf(tour.fighter)} clears the Tour`),
      h('p', {}, tour.ending, continues ? ` ${continues} continue${continues > 1 ? 's' : ''} used.` : ' No continues used.'),
    ),
  );
}
