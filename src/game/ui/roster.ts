// The roster screen, right after Press start (docs/story.md "The roster"): every fighter on the card, who is open and who is
// still locked with the episode that opens them, how far the next unlock is, and the size of the show (stages, seasons, Tours,
// online). Read only from the game's own data: nothing here is typed in, so it never goes stale.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { CHAPTERS, SEASONS, isUnlocked, loadProgress, nextUnlock, unlockRoute } from '../campaign/story.ts';
import { TOURS } from '../campaign/tour.ts';
import { $, h, headUrl } from './dom.ts';

/** A playtest scenario other than the roster's own sets this so the menus it clicks through still come straight after Press start. */
let suppressed = false;
export function suppressRoster(on = true): void {
  suppressed = on;
}

/** The URL flags that start something else (a chapter, a quick match, an invite, a test lobby) and so skip the roster. */
function otherRoute(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.has('chapter') || q.has('play') || q.has('room') || q.has('invite')) return true;
  const pt = q.get('playtest');
  return pt !== null && pt !== 'roster-intro';
}

/** True when Press start should open the roster before the main menu. */
export function rosterWanted(): boolean {
  return !suppressed && !otherRoute();
}

export interface RosterFacts {
  fighters: number;
  open: number;
  locked: number;
  stages: number;
  seasons: number;
  episodes: number;
  episodesCleared: number;
  tours: number;
  next: { id: string; name: string; route: string; away: number; fill: number } | null;
}

/** The numbers the screen shows, from the data and the player's save. */
export function rosterFacts(): RosterFacts {
  const done = loadProgress();
  const open = CHARACTERS.filter((c) => isUnlocked(c.id)).length;
  const nu = nextUnlock(done);
  return {
    fighters: CHARACTERS.length,
    open,
    locked: CHARACTERS.length - open,
    stages: STAGES.length,
    seasons: SEASONS.length,
    episodes: CHAPTERS.length,
    episodesCleared: CHAPTERS.filter((c) => done.has(c.id)).length,
    tours: TOURS.length,
    next: nu
      ? { id: nu.fighter, name: CHARACTERS.find((c) => c.id === nu.fighter)?.name ?? nu.fighter, route: nu.route.text, away: nu.away, fill: nu.fill }
      : null,
  };
}

export interface RosterHooks {
  onContinue(): void;
}

function detail(id: string): { head: string; line: string; locked: boolean } {
  const c = CHARACTERS.find((x) => x.id === id)!;
  const locked = !isUnlocked(id);
  const r = unlockRoute(id);
  return locked
    ? { head: `${c.name} · locked`, line: r ? r.text : 'Clear the campaign to open them.', locked }
    : { head: `${c.name} · ${c.role}`, line: c.blurb, locked };
}

export function renderRoster(hooks: RosterHooks): RosterFacts {
  const f = rosterFacts();
  $('roster-count').textContent = `${f.open} of ${f.fighters} open`;
  const bar = h('i', { style: `width:${Math.round((f.open / f.fighters) * 100)}%` });
  const stat = (n: number, label: string) => h('li', {}, h('b', {}, String(n)), h('span', {}, label));
  const next = f.next;
  const nextFill = next ? Math.round(next.fill * 100) : 100;
  $('roster-progress').replaceChildren(
    h('div', { class: 'roster-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(f.fighters), 'aria-valuenow': String(f.open), 'aria-label': 'Fighters open' }, bar),
    h(
      'p',
      { class: 'roster-next', id: 'roster-next', 'data-fighter': next?.id ?? '' },
      h('b', {}, next ? `Next to unlock: ${next.name}` : 'Every fighter is open.'),
      next ? ` · ${next.route} · ${next.away} ${next.away === 1 ? 'episode' : 'episodes'} away` : ' The Tours are what is left.',
    ),
    h('div', { class: 'roster-bar next', 'aria-hidden': 'true' }, h('i', { style: `width:${nextFill}%` })),
    h(
      'ul',
      { class: 'roster-stats', id: 'roster-stats' },
      stat(f.fighters, 'fighters'),
      stat(f.stages, 'stages'),
      stat(f.seasons, 'seasons'),
      stat(f.episodesCleared, `of ${f.episodes} episodes`),
      stat(f.tours, 'Tours'),
    ),
  );
  const show = (id: string) => {
    const d = detail(id);
    const box = $('roster-detail');
    box.classList.toggle('is-locked', d.locked);
    box.dataset.fighter = id;
    box.replaceChildren(h('b', {}, d.head), h('span', {}, d.line));
    document.querySelectorAll('#roster-grid .roster-tile').forEach((t) => t.classList.toggle('picked', (t as HTMLElement).dataset.fighter === id));
    window.dispatchEvent(new CustomEvent('dod:roster-detail', { detail: { id, locked: d.locked, line: d.line } }));
  };
  $('roster-grid').replaceChildren(
    ...CHARACTERS.map((c) => {
      const locked = !isUnlocked(c.id);
      const r = unlockRoute(c.id);
      return h(
        'button',
        {
          type: 'button',
          class: `roster-tile ${locked ? 'locked' : 'open'}`,
          'data-fighter': c.id,
          'data-locked': locked ? '1' : '0',
          'aria-label': locked ? `${c.name}, locked${r ? `: ${r.short}` : ''}` : c.name,
          onclick: () => show(c.id),
        },
        h('img', { src: headUrl(c.id), alt: '', loading: 'lazy' }),
        h('span', { class: 'roster-name' }, locked ? '???' : c.name),
        locked && r ? h('em', {}, `S${r.season} · E${r.episode}`) : null,
      );
    }),
  );
  const first = CHARACTERS.find((c) => !isUnlocked(c.id)) ?? CHARACTERS[0];
  show(next?.id ?? first.id);
  $('btn-roster-go').onclick = () => hooks.onContinue();
  window.dispatchEvent(new CustomEvent('dod:roster', { detail: { ...f, tiles: CHARACTERS.length } }));
  return f;
}
