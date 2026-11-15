// Tonight's Episode on screen: the card on the main menu (cast, rule and twist in one short line, Blog Man's intro, the
// day streak and a countdown to tomorrow) and the panel on its results (score, streak, today's board). The numbers come
// from campaign/daily.ts, the board from net/daily.ts; nothing here fetches by itself.
import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { countdown, objectiveLine, twistLine, type DailyEpisode, type DailyState } from '../campaign/daily.ts';
import { $, h, headUrl, kids } from './dom.ts';
import type { DailyBoard } from '../net/daily.ts';

const nameOf = (id: string): string => CHARACTERS.find((c) => c.id === id)?.name ?? id;
const stageName = (id: string): string => STAGES.find((s) => s.id === id)?.name ?? id;
const head = (id: string, cls = ''): HTMLElement => h('img', { class: `daily-head ${cls}`.trim(), src: headUrl(id), alt: nameOf(id) });
const num = (n: number): string => n.toLocaleString('en-US');

export interface CardHooks {
  onPlay(): void;
  onListen(): void;
}

/** The title line: "Slow Rider vs Lapis Man, Cel". */
export function castLine(ep: DailyEpisode): string {
  const own = ep.ally ? `${nameOf(ep.player)} + ${nameOf(ep.ally)}` : nameOf(ep.player);
  return `${own} vs ${ep.foes.map(nameOf).join(' + ')}`;
}

/** The main menu's card. `blog` is Blog Man's intro (text), `streak` the live day streak, `best` today's best score (0: not yet cleared). */
export function renderDailyCard(ep: DailyEpisode, state: DailyState, streak: number, blog: string, hooks: CardHooks): void {
  const best = state.best[ep.date] ?? 0;
  const card = $('daily-card');
  card.dataset.date = ep.date;
  card.dataset.cleared = best ? '1' : '0';
  const rule = twistLine(ep);
  card.replaceChildren(
    ...kids(
    h(
      'header',
      { class: 'daily-top' },
      h('b', { class: 'daily-tag' }, "Tonight's Episode"),
      h('span', { class: 'daily-streak', 'data-streak': String(streak) }, streak > 0 ? `Day streak ${streak}` : 'Day streak 0'),
    ),
    h(
      'div',
      { class: 'daily-cast', 'aria-hidden': 'true' },
      head(ep.player, 'you'),
      ep.ally ? head(ep.ally) : null,
      h('i', {}, 'vs'),
      ...ep.foes.map((f) => head(f, 'foe')),
    ),
    h('h3', { class: 'daily-title' }, castLine(ep)),
    h('p', { class: 'daily-stage' }, stageName(ep.stage)),
    h('p', { class: 'daily-rule' }, h('strong', {}, objectiveLine(ep)), rule ? ` · ${rule}` : ''),
    blog ? h('p', { class: 'daily-blog' }, h('b', {}, 'Blog Man: '), `“${blog}”`) : null,
    h(
      'div',
      { class: 'daily-actions' },
      h('button', { type: 'button', class: 'primary daily-play', id: 'daily-play', onclick: () => hooks.onPlay() }, best ? 'Beat your score' : 'Play tonight'),
      h('button', { type: 'button', class: 'secondary daily-listen', id: 'daily-listen', 'aria-label': 'Hear Blog Man', onclick: () => hooks.onListen() }, '▶ Blog Man'),
    ),
    h(
      'p',
      { class: 'daily-foot' },
      best ? h('span', { class: 'daily-best' }, `Best ${num(best)}`) : h('span', {}, 'Not played yet'),
      h('span', { class: 'daily-count', id: 'daily-count' }, ''),
    ),
    ),
  );
}

/** The countdown text (kept apart: it ticks each second without rebuilding the card). */
export function setCountdown(ms: number): void {
  const el = document.getElementById('daily-count');
  if (el) el.textContent = `Next episode in ${countdown(ms)}`;
}

export interface ResultsInfo {
  ep: DailyEpisode;
  won: boolean;
  score: number;
  /** Today's best (this one or an earlier try). */
  best: number;
  newBest: boolean;
  streak: number;
  longest: number;
  breakdown: string;
}

const rankLine = (b: DailyBoard & { ok: boolean }): string =>
  b.rank ? `You are #${b.rank} of ${b.total} tonight.` : b.ok ? 'Clear the episode to join tonight’s board.' : 'The board did not answer; your score is saved here.';

/** The panel on the results screen: score, streak and the board (filled in when the read comes back). */
export function renderDailyResults(info: ResultsInfo): HTMLElement {
  const { ep } = info;
  const panel = h(
    'section',
    { class: `daily-results${info.newBest ? ' new-best' : ''}`, id: 'daily-results', 'data-date': ep.date, 'aria-label': "Tonight's Episode" },
    h('h3', {}, "Tonight's Episode"),
    h(
      'div',
      { class: 'daily-score' },
      h('div', { class: 'stat', 'data-stat': 'daily-score' }, h('span', {}, 'Score'), h('strong', {}, info.won ? num(info.score) : 'No score')),
      h('div', { class: 'stat', 'data-stat': 'daily-streak' }, h('span', {}, 'Day streak'), h('strong', {}, `${info.streak}`)),
      h('div', { class: 'stat', 'data-stat': 'daily-best' }, h('span', {}, 'Best tonight'), h('strong', {}, info.best ? num(info.best) : '–')),
    ),
    h(
      'p',
      { class: 'daily-note' },
      info.won ? (info.newBest ? `New best. ${info.breakdown}` : `${info.breakdown} Your best tonight stands.`) : 'Not cleared. Try again: the same episode waits until midnight UTC.',
      info.longest > 1 ? ` Longest streak ${info.longest}.` : '',
    ),
    h('p', { class: 'daily-rank', id: 'daily-rank', 'aria-live': 'polite' }, 'Reading tonight’s board…'),
    h('ol', { class: 'daily-board', id: 'daily-board', 'aria-label': "Tonight's board" }),
  );
  return panel;
}

/** Fills the board list (top ten, and the player's own line when they are further down). */
export function fillBoard(b: DailyBoard & { ok: boolean }, me: string, shown: number): void {
  const list = document.getElementById('daily-board');
  const rank = document.getElementById('daily-rank');
  if (!list || !rank) return;
  rank.textContent = rankLine(b);
  list.dataset.total = String(b.total);
  list.dataset.rank = String(b.rank);
  const row = (e: DailyBoard['entries'][number], i: number) =>
    h(
      'li',
      { class: e.id === me ? 'daily-row me' : 'daily-row', 'data-rank': String(i + 1) },
      h('b', {}, String(i + 1)),
      e.avatar ? h('img', { src: headUrl(e.avatar), alt: '' }) : h('i', {}),
      h('span', { class: 'daily-name' }, e.id === me ? `${e.name} (you)` : e.name),
      h('strong', {}, num(e.score)),
    );
  const top = b.entries.slice(0, shown).map(row);
  const mine = b.rank > shown ? [h('li', { class: 'daily-gap', 'aria-hidden': 'true' }, '…'), row(b.entries[b.rank - 1], b.rank - 1)] : [];
  list.replaceChildren(...top, ...mine);
}
