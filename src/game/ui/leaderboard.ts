// The leaderboard's screens (docs/online.md, "The leaderboard"): the Leaderboard screen from the main menu (top 100,
// this week and all time, with your own row pinned when you're outside the list), the rating change on the online results, and your line in
// Profile and on the menu button. Everything reads the cached table first and redraws when the relays add to it.

import { CHARACTERS } from '../sim/characters.ts';
import { $, h, headUrl, kids } from './dom.ts';
import { currentScreen } from './screens.ts';
import { sharedBoard, type Leaderboard, type Tab } from '../net/board.ts';
import { formatDelta, PAIR_PER_DAY, type PlayerStats } from '../net/ratings.ts';
import { profileId } from '../net/profile.ts';
import type { FightEnd } from '../net/fight.ts';

const TOP = 100;
let tab: Tab = 'week';
let wired = false;

function wire(board: Leaderboard): void {
  if (wired) return;
  wired = true;
  board.on('change', () => {
    if (currentScreen() === 'leaderboard') renderBoard();
    renderMenuLine();
    if (!$('profile').hidden) renderProfileStats();
    renderRatingLine();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#board-tabs [data-tab]')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab === 'all' ? 'all' : 'week';
      renderBoard();
    });
  }
  // "Updated 3 min ago" keeps itself true.
  setInterval(() => {
    if (currentScreen() === 'leaderboard') renderStatus();
  }, 30000);
}

export function initLeaderboardUi(): void {
  const board = sharedBoard();
  if (board) wire(board);
  renderMenuLine();
}

/** Fills the Leaderboard screen (call while it's covered by the wipe). */
export function renderBoard(): void {
  const board = sharedBoard();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#board-tabs [data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  renderStatus();
  const list = $('board-list');
  const you = $('board-you');
  if (!board) {
    list.replaceChildren(h('li', { class: 'board-empty' }, 'Online play is unavailable in this browser, so there is no leaderboard here.'));
    you.replaceChildren();
    return;
  }
  const table = board.board(tab).table;
  const me = profileId();
  const top = table.slice(0, TOP);
  list.replaceChildren(
    ...(top.length
      ? top.map((p) => row(board, p, p.id === me))
      : [h('li', { class: 'board-empty' }, tab === 'week' ? 'Nobody has played a rated match this week. Be the first on the card.' : 'No rated matches yet. Find match to put your name up there.')]),
  );
  const mine = table.find((p) => p.id === me);
  // Pinned only when your row isn't already in the list above (outside the top 100, or unranked).
  you.replaceChildren(
    ...(mine && top.includes(mine)
      ? []
      : [mine
      ? row(board, mine, true, true)
      : h(
          'div',
          { class: 'board-row you unranked' },
          h('b', { class: 'board-rank' }, '—'),
          avatarImg(board.who(me).avatar),
          h('span', { class: 'board-name' }, h('strong', {}, board.who(me).name), h('em', {}, tab === 'week' ? 'Unranked this week' : 'Unranked: one online match puts you on the board')),
          h('span', { class: 'board-rating' }, ''),
          h('span', { class: 'board-wl' }, ''),
        )]),
  );
}

function avatarImg(avatar: string): HTMLElement {
  return avatar ? h('img', { src: headUrl(avatar), alt: '', loading: 'lazy' }) : h('i', { class: 'board-noimg' });
}

function row(board: Leaderboard, p: PlayerStats & { rank: number }, you: boolean, pinned = false): HTMLElement {
  const who = board.who(p.id);
  const tag = pinned ? 'div' : 'li';
  return h(
    tag as 'li',
    { class: `board-row${you ? ' you' : ''}`, 'data-player': p.id, 'data-rank': p.rank },
    h('b', { class: 'board-rank' }, `#${p.rank}`),
    avatarImg(who.avatar),
    h('span', { class: 'board-name' }, h('strong', {}, who.name), you ? h('em', {}, 'You') : null),
    h('span', { class: 'board-rating', title: 'Rating' }, String(p.rating)),
    h('span', { class: 'board-wl', title: `${p.wins} wins, ${p.losses} losses${p.draws ? `, ${p.draws} draws` : ''}` }, `${p.wins}–${p.losses}`),
  );
}

function renderStatus(): void {
  const board = sharedBoard();
  const el = $('board-status');
  if (!board) {
    el.textContent = '';
    return;
  }
  const ago = board.updatedAt ? Math.floor((Date.now() - board.updatedAt) / 60000) : -1;
  el.dataset.state = board.state;
  el.textContent =
    board.state === 'offline'
      ? 'Offline: showing the results this device has saved.'
      : board.state === 'live'
        ? ago <= 0 ? 'Live.' : `Live · updated ${ago} min ago.`
        : 'Saved results · updating…';
}

/** The menu button's line: your rank and rating, or how to get one. */
function renderMenuLine(): void {
  const el = document.getElementById('board-sub');
  if (!el) return;
  const board = sharedBoard();
  const mine = board?.stats('all');
  el.textContent = !board ? 'Online rankings (offline here).' : mine ? `You: #${mine.rank} · ${mine.rating} · ${mine.wins}–${mine.losses}` : 'Top 100 online, this week and all time.';
}

/** Your line in Profile: rating, rank, record, streak, favourite. */
export function renderProfileStats(): void {
  const el = document.getElementById('profile-stats');
  if (!el) return;
  const board = sharedBoard();
  const mine = board?.stats('all');
  if (!board || !mine) {
    el.textContent = 'Unranked. Play an online match to get a rating (everyone starts at 1000).';
    return;
  }
  const streak = mine.streak > 1 ? ` · ${mine.streak} wins in a row` : mine.streak < -1 ? ` · ${-mine.streak} losses in a row` : '';
  const fav = CHARACTERS.find((c) => c.id === mine.favourite)?.name;
  el.textContent = `Rating ${mine.rating} · #${mine.rank} all time · ${mine.wins}–${mine.losses}${streak}${fav ? ` · mostly ${fav}` : ''}`;
}

// ------------------------------------------------------------ result screen

let shown: { matchId: string; opponent: string; fighter: string; link: string; state: 'signing' | 'void' | 'same' | 'dropped' | 'done' } | null = null;
let countRaf = 0;

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** "Direct · 42 ms", "Relay · 80 ms": how the two pages were joined. */
function linkText(link: FightEnd['link']): string {
  const route = link.route === 'direct' ? 'Direct' : link.route === 'relay' ? 'Relay' : link.route ? 'Signal' : '';
  return [route, link.ping >= 0 ? `${link.ping} ms` : ''].filter(Boolean).join(' · ') || 'Connection unknown';
}

/**
 * The online results get an opponent card (name, fighter, connection), the rating change counting up or down to its
 * final value, and your place on the board, once both signatures are in. Called when the results show; the signed
 * record lands a moment later.
 */
export function showRatingChange(end: FightEnd, slot: number): void {
  const r = end.result;
  const opponent = r.players[1 - slot];
  const same = r.players[0].pid === r.players[1].pid;
  const fighter = CHARACTERS.find((c) => c.id === opponent.fighter)?.name ?? opponent.fighter;
  const unrated = end.reason === 'desync' || end.reason === 'no-start';
  shown = { matchId: r.matchId, opponent: opponent.name, fighter, link: linkText(end.link), state: unrated ? 'void' : end.reason === 'disconnect' ? 'dropped' : same ? 'same' : 'signing' };
  cancelAnimationFrame(countRaf);
  renderRatingLine(opponent.fighter);
  void end.rated.then((rated) => {
    if (shown?.matchId !== r.matchId) return;
    if (!rated || same) {
      if (shown.state === 'signing') shown.state = same ? 'same' : 'void';
    } else {
      sharedBoard()?.addOwn(rated.record, { n: opponent.name, a: opponent.avatar });
      shown.state = 'done';
    }
    renderRatingLine();
  });
}

let counted = '';

function renderRatingLine(fighterId?: string): void {
  if (!shown || currentScreen() !== 'results') return;
  let el = document.getElementById('results-rating');
  if (!el) {
    const panel = document.querySelector('#results-body .results-panel');
    const hero = panel?.querySelector('.results-hero');
    if (!panel || !hero) return;
    el = h('p', { id: 'results-rating', class: 'results-rating', 'aria-live': 'polite' });
    const card = h(
      'section',
      { class: 'online-card', id: 'results-opponent', 'aria-label': 'Opponent' },
      h('img', { class: 'online-face', src: fighterId ? headUrl(fighterId) : '', alt: '' }),
      h('div', { class: 'online-who' }, h('span', { class: 'online-vs' }, 'You played'), h('strong', {}, shown.opponent), h('span', { class: 'online-fighter' }, shown.fighter)),
      h('span', { class: 'online-link' }, shown.link),
      el,
    );
    hero.after(card);
    panel.closest('.results-row')?.classList.add('results-online');
  }
  const board = sharedBoard();
  const c = shown.state === 'done' ? board?.change(shown.matchId) : null;
  // Redraw only when something changed, so a board update never restarts the count.
  const sig = `${shown.state}|${JSON.stringify(c)}|${board?.stats('all')?.rank ?? ''}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (shown.state === 'void') el.replaceChildren('Void matches don’t change ratings.');
  else if (shown.state === 'same') el.replaceChildren('Unrated: both sides are the same profile.');
  else if (shown.state === 'dropped') el.replaceChildren('Unrated: a dropped link isn’t a quit, so no rating change.');
  else if (shown.state === 'signing' || !c) el.replaceChildren(`Rating: confirming the result with ${shown.opponent}…`);
  else if (c.overLimit) el.replaceChildren(`Unrated: you two have played ${PAIR_PER_DAY} rated matches today.`);
  else {
    const place = board?.stats('all');
    const up = c.delta >= 0;
    const ratingEl = h('strong', { class: 'rating-now' }, String(c.rating - c.delta));
    const deltaEl = h('b', { class: 'rating-delta' }, formatDelta(0));
    el.replaceChildren(
      ...kids(
        h('span', { class: `rating-you ${up ? 'up' : 'down'}` }, 'Rating ', ratingEl, ' ', deltaEl),
        place ? h('span', { class: 'rating-place' }, `#${place.rank} on the board`) : null,
        h('span', { class: 'rating-them' }, `${shown.opponent} ${c.theirRating} (${formatDelta(c.theirs)})`),
        c.confirmed ? null : h('em', {}, `Counts once ${shown.opponent}’s copy reaches the board.`),
      ),
    );
    countUp(ratingEl, deltaEl, c.rating, c.delta, `${shown.matchId}:${c.confirmed}`);
  }
  el.dataset.state = shown.state === 'done' && c ? (c.confirmed ? 'confirmed' : 'expected') : shown.state;
}

/** The rating walks from what it was to what it is, and the change from 0 to its final value (instant with reduced motion). */
function countUp(ratingEl: HTMLElement, deltaEl: HTMLElement, rating: number, delta: number, key: string): void {
  const el = document.getElementById('results-rating');
  const finish = () => {
    ratingEl.textContent = String(rating);
    deltaEl.textContent = formatDelta(delta);
    if (el) el.dataset.counted = '1';
  };
  if (el) el.dataset.counted = '0';
  cancelAnimationFrame(countRaf);
  const again = counted === key;
  counted = key;
  if (reduced() || again || delta === 0) {
    finish();
    if (!again) window.dispatchEvent(new CustomEvent('dod:rating-count', { detail: { from: rating - delta, to: rating, delta, steps: 1 } }));
    return;
  }
  const start = performance.now();
  const MS = 1100;
  let steps = 0;
  const tick = (t: number) => {
    const k = Math.min(1, (t - start) / MS);
    const eased = 1 - Math.pow(1 - k, 3);
    ratingEl.textContent = String(Math.round(rating - delta + delta * eased));
    deltaEl.textContent = formatDelta(Math.round(delta * eased));
    steps++;
    if (k < 1) countRaf = requestAnimationFrame(tick);
    else {
      finish();
      window.dispatchEvent(new CustomEvent('dod:rating-count', { detail: { from: rating - delta, to: rating, delta, steps } }));
    }
  };
  countRaf = requestAnimationFrame(tick);
}
