// Extras: the Endings gallery. One slot per fighter (33): a painted ending you have earned by clearing that fighter's Tour
// shows its picture and replays on a tap; the rest are locked and say how to open them.
import { CHARACTERS } from '../sim/characters.ts';
import { ENDINGS, MECHANIC, endingUnlocked, type Ending } from '../campaign/endings.ts';
import { $, h, thumbUrl } from './dom.ts';

const nameOf = (id: string): string => CHARACTERS.find((c) => c.id === id)?.name ?? id;

export function renderEndings(cleared: ReadonlySet<string>, onPlay: (e: Ending) => void): void {
  const open = ENDINGS.filter((e) => endingUnlocked(e.fighter, cleared)).length;
  $('extras-count').textContent = `${open} of ${ENDINGS.length} endings unlocked`;
  const ordered = [...ENDINGS].sort((a, b) => Number(endingUnlocked(b.fighter, cleared)) - Number(endingUnlocked(a.fighter, cleared)));
  $('ending-grid').replaceChildren(
    ...ordered.map((e) => {
      const ok = endingUnlocked(e.fighter, cleared);
      const hint = e.fighter === MECHANIC ? 'Clear every Tour' : `Clear ${nameOf(e.fighter)}'s Tour`;
      return h(
        'button',
        {
          type: 'button',
          class: `ending-tile ${ok ? 'open' : 'locked'}`,
          'data-ending': e.fighter,
          'data-unlocked': ok ? '1' : '0',
          disabled: !ok,
          'aria-label': ok ? `Replay ${nameOf(e.fighter)}'s ending` : `${nameOf(e.fighter)}'s ending, locked. ${hint}`,
          onclick: () => onPlay(e),
        },
        ok
          ? h('img', { class: 'ending-thumb', src: e.art, alt: '', loading: 'lazy' })
          : h('span', { class: 'ending-thumb locked-thumb' }, h('img', { src: thumbUrl(e.fighter), alt: '' })),
        h('strong', {}, nameOf(e.fighter)),
        h('em', { class: 'ending-status' }, ok ? '▶ Replay ending' : hint),
      );
    }),
  );
}
