// "Replay as…": the fighter picker for a cleared episode (campaign map). A sheet over the map with the unlocked fighters as
// big tiles in a wrapping grid (no sideways scroll, 56 px+ targets, so it fits a 390x844 phone and 844x390 landscape);
// a tap starts the episode with that fighter in Exit Punk's place. Escape or Cancel closes it.

import { CHARACTERS } from '../sim/characters.ts';
import { isUnlocked } from '../campaign/story.ts';
import { h, headUrl } from './dom.ts';

const ID = 'replay-picker';

export function closeReplayPicker(): void {
  document.getElementById(ID)?.remove();
}

/** The fighters a replay may use: unlocked ones only, in roster order. */
export function replayRoster(): number[] {
  return CHARACTERS.map((_, i) => i).filter((i) => isUnlocked(CHARACTERS[i].id));
}

function say(phase: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('dod:replay-as', { detail: { phase, ...detail } }));
}

export function openReplayPicker(opts: { title: string; chapter: string; current: number; onPick: (char: number) => void }): void {
  closeReplayPicker();
  const roster = replayRoster();
  const close = (why: string) => {
    document.removeEventListener('keydown', onKey, true);
    closeReplayPicker();
    say('close', { chapter: opts.chapter, why });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close('escape');
  };
  document.addEventListener('keydown', onKey, true);
  const tiles = roster.map((i) => {
    const c = CHARACTERS[i];
    return h(
      'button',
      {
        type: 'button',
        class: 'replay-tile',
        'data-fighter': c.id,
        'data-char': String(i),
        'aria-label': c.name,
        onclick: () => {
          document.removeEventListener('keydown', onKey, true);
          closeReplayPicker();
          say('pick', { chapter: opts.chapter, fighter: c.id });
          opts.onPick(i);
        },
      },
      h('img', { src: headUrl(c.id), alt: '', draggable: 'false' }),
      h('span', {}, c.name),
    );
  });
  const sheet = h(
    'div',
    { id: ID, class: 'replay-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Replay ${opts.title} as` },
    h(
      'div',
      { class: 'replay-sheet' },
      h('p', { class: 'kicker' }, 'Replay as…'),
      h('h3', {}, opts.title),
      h('p', { class: 'replay-note' }, 'Same foes, same rules, same story. Stars count toward your best.'),
      h('div', { class: 'replay-grid', role: 'listbox', 'aria-label': 'Fighter' }, ...tiles),
      h('button', { type: 'button', class: 'replay-cancel', onclick: () => close('cancel') }, 'Cancel'),
    ),
  );
  document.body.append(sheet);
  say('open', { chapter: opts.chapter, fighters: roster.map((i) => CHARACTERS[i].id) });
  const first = tiles.find((t) => Number(t.dataset.char) === opts.current) ?? tiles[0];
  first?.focus();
}
