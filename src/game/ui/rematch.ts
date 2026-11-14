// The rematch panel on an online result (net/rematch.ts has the protocol): a status line with the clock, and, once both
// pressed Rematch, the quick pick: a scrollable row of the fighters you've unlocked (the last pick selected), the stage
// row when you lost the last game (the loser picks), and Lock in. Buttons are 44 px and up; the rows scroll sideways inside
// the panel, never the page.

import { CHARACTERS } from '../sim/characters.ts';
import { isUnlocked } from '../campaign/story.ts';
import { preferredLook } from '../looks.ts';
import { rematchStages, type Rematch } from '../net/rematch.ts';
import { $, h, headUrl } from './dom.ts';

const PANEL = 'rematch';

export function clearRematchPanel(): void {
  document.getElementById(PANEL)?.remove();
}

function panel(): HTMLElement {
  let el = document.getElementById(PANEL);
  if (!el) {
    el = h('div', { id: PANEL, class: 'rematch', role: 'group', 'aria-label': 'Rematch' });
    $('results-body').after(el);
  }
  return el;
}

/** The status line for a phase. */
export function rematchLine(s: Rematch, left: number): string {
  const who = s.opponent;
  switch (s.phase) {
    case 'open': return s.theyWant ? `${who} wants a rematch · ${left} s` : `Run it back? ${left} s`;
    case 'waiting': return `Waiting for ${who}… ${left} s`;
    case 'picking': return `Pick your fighter · ${left} s`;
    case 'locked': return `Locked in. Waiting for ${who}…`;
    case 'starting': return 'Rematch starting…';
    case 'declined': return `${who} left. Queue again?`;
    case 'closed': return `${who} left. Queue again?`;
    case 'timeout': return s.weWant ? `${who} didn't answer. Queue again?` : 'Rematch window closed. Queue again?';
  }
}

/** Draws the panel for the session's current phase (call on every phase, tick and draft). */
export function renderRematch(s: Rematch): void {
  const el = panel();
  el.dataset.phase = s.phase;
  let line = el.querySelector<HTMLElement>('.rematch-line');
  if (!line) {
    line = h('p', { class: 'rematch-line', role: 'status', 'aria-live': 'polite' });
    el.prepend(line);
  }
  const text = rematchLine(s, s.secondsLeft());
  if (line.textContent !== text) line.textContent = text;
  const picking = s.phase === 'picking';
  const pick = el.querySelector('.rematch-pick');
  if (!picking) return void pick?.remove();
  if (pick) return void syncPick(s, pick as HTMLElement);
  el.append(buildPick(s));
}

function buildPick(s: Rematch): HTMLElement {
  const open = CHARACTERS.map((c, i) => ({ c, i })).filter((x) => isUnlocked(x.c.id));
  const fighters = h(
    'div',
    { class: 'rematch-row rematch-fighters', role: 'listbox', 'aria-label': 'Fighter' },
    ...open.map(({ c, i }) =>
      h(
        'button',
        {
          type: 'button',
          class: 'rematch-tile',
          role: 'option',
          'data-fighter': c.id,
          'data-char': String(i),
          'aria-label': c.name,
          title: c.name,
          onclick: () => s.choose(i, preferredLook(i)),
        },
        h('img', { src: headUrl(c.id), alt: '' }),
      ),
    ),
  );
  const kids: HTMLElement[] = [fighters];
  if (s.iPickStage) {
    const chip = (label: string, stage: number | undefined) =>
      h('button', { type: 'button', class: 'rematch-chip', role: 'option', 'data-stage': stage === undefined ? 'random' : String(stage), onclick: () => s.chooseStage(stage) }, label);
    kids.push(
      h('p', { class: 'rematch-sub' }, 'You lost, so you pick the stage'),
      h('div', { class: 'rematch-row rematch-stages', role: 'listbox', 'aria-label': 'Stage' }, chip('Random', undefined), ...rematchStages().map((st) => chip(st.name, st.index))),
    );
  } else {
    kids.push(h('p', { class: 'rematch-sub' }, s.picker < 0 ? 'Stage: random' : `${s.opponent} picks the stage`));
  }
  kids.push(h('button', { type: 'button', class: 'primary rematch-lock', 'data-autofocus': true, onclick: () => s.lock() }, 'Lock in'));
  const el = h('div', { class: 'rematch-pick' }, ...kids);
  syncPick(s, el);
  // The selected tile is in view (a long row scrolls to it).
  queueMicrotask(() => el.querySelector('.rematch-tile.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  return el;
}

function syncPick(s: Rematch, el: HTMLElement): void {
  const d = s.current;
  for (const b of el.querySelectorAll<HTMLElement>('.rematch-tile')) {
    const on = Number(b.dataset.char) === d.char;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const b of el.querySelectorAll<HTMLElement>('.rematch-chip')) {
    const on = b.dataset.stage === (d.stage === undefined ? 'random' : String(d.stage));
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}
