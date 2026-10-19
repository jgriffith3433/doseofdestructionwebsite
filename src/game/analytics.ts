// Hawkes Analytics in the game (hawkesgen/docs/analytics.md; how it is wired: AGENTS.md "Analytics").
//
// The SDK is /site/hawkes-analytics.js (a copy of hawkesgen/clients/js/hawkes-analytics.js), loaded by a plain
// script tag in Game/index.html before this module. It counts page views, sessions, devices, load times, errors and
// fps by itself; this file adds what only the game knows: screens, picks, matches, KOs, the campaign, settings, the
// controls in use and the feedback cards. Every call goes through here, and none of it can stop the game: with the
// SDK missing (blocked, offline) each one does nothing.
//
// Events are sent at real moments only (a screen, a pick, a KO, a match's end), never per frame.

import type { HawkesAnalytics, HawkesAsk, Props } from './hawkes-analytics.d.ts';
import { CHARACTERS, MOVE_KEYS } from './sim/characters.ts';
import { STAGES } from './sim/stage.ts';
import { FX } from './sim/fixed.ts';
import { ACT } from './sim/state.ts';
import { CHAPTERS, type Chapter } from './campaign/story.ts';
import type { Match } from './match.ts';
import type { SimEvent } from './sim/step.ts';

/** The build this page is: { version, commit, date } from tools/buildStamp.mjs (a Vite define). */
declare const __DOD_BUILD__: { version: string; commit?: string; date: string };

export const PRODUCT = 'doseofdestruction';

const params = new URLSearchParams(location.search);

function sdk(): HawkesAnalytics | null {
  const a = (window as { hawkesAnalytics?: HawkesAnalytics }).hawkesAnalytics;
  return a && a.version ? a : null;
}

// ------------------------------------------------------------------ start

window.HAWKES_BUILD = __DOD_BUILD__;
// Playtests (?playtest=<id>) keep every event on hawkesAnalytics.debugLog, so the run can show what went out.
sdk()?.init({ product: PRODUCT, debug: params.has('playtest') || params.get('hawkes-analytics-debug') === '1' || undefined });
sdk()?.loadStart();

/** The playtest runner can start a scenario without ?playtest in the URL: it turns debug on itself. */
export function analyticsDebug(): void {
  sdk()?.init({ debug: true });
}

/** game_ready: the title screen is up and the game can be played. */
export function ready(): void {
  sdk()?.ready();
}

export function track(name: string, props?: Props): void {
  sdk()?.track(name, props);
}

export function feature(name: string, props?: Props): void {
  sdk()?.feature(name, props);
}

// ------------------------------------------------------------------ screens and context

/** Screens that are menus: on them no match is on, so the match's context goes. */
const MENU_SCREENS = new Set(['title', 'main', 'select', 'stages', 'campaign', 'howto', 'leaderboard']);

/** Every screen the game shows (ui/screens.ts), and overlays (settings, profile) as they open. */
export function screen(id: string): void {
  if (MENU_SCREENS.has(id)) sdk()?.setContext({ fighter: null, opponent: null, stage: null, level: null });
  if (id === 'title' || id === 'main') {
    endRun();
    sdk()?.setContext({ mode: null, chapter: null });
  }
  if (id === 'campaign') sdk()?.setContext({ mode: 'campaign' });
  sdk()?.screen(id);
}

export function setMode(mode: string): void {
  sdk()?.setContext({ mode, chapter: null });
}

const charId = (i: number | undefined) => (i === undefined ? undefined : CHARACTERS[i]?.id);

/** Who a slot is, from the local player's side: you, cpu, dummy, opponent (online) or player (another person here). */
function role(m: Match, i: number): string {
  const s = m.setup.slots[i];
  if (i === m.player) return 'you';
  if (s?.remote) return 'opponent';
  if (s?.cpu === 0) return 'dummy';
  return s?.cpu ? 'cpu' : 'player';
}

/** The local player's opponents (other teams, else everyone else), as fighter ids. */
function opponents(m: Match): string[] {
  const me = m.state.fighters[m.player];
  return m.state.fighters
    .filter((f) => f.id !== m.player && (!me || f.team < 0 || f.team !== me.team))
    .map((f) => CHARACTERS[f.char].id);
}

function matchContext(m: Match, chapter: Chapter | null): Record<string, string | null> {
  return {
    mode: m.setup.mode,
    fighter: charId(m.state.fighters[m.player]?.char) ?? null,
    opponent: opponents(m).join('+') || null,
    stage: STAGES[m.setup.stage]?.id ?? null,
    chapter: chapter?.id ?? null,
  };
}

// ------------------------------------------------------------------ picks

/** The fighters picked on the select screen (each person's slot) and who they face. */
export function fighterPicks(mode: string, slots: { char: number; cpu: number | null }[]): void {
  const cpus = slots.filter((s) => s.cpu !== null);
  slots.forEach((s, i) => {
    if (s.cpu !== null) return;
    feature('fighter_pick', {
      value: charId(s.char),
      mode,
      slot: i,
      vs: cpus.map((c) => charId(c.char)).join('+') || undefined,
      cpu_level: cpus.length ? Math.max(...cpus.map((c) => c.cpu ?? 0)) : undefined,
      players: slots.length,
    });
  });
}

export function stagePick(mode: string, stage: number, random: boolean): void {
  feature('stage_pick', { value: STAGES[stage]?.id, mode, random });
}

// ------------------------------------------------------------------ matches (levels) and KOs

interface OpenLevel {
  m: Match;
  level: string;
  /** What last hurt each fighter: a move id (fsmash, nair…) or the stage (hazard, zone). Cleared on respawn. */
  cause: (string | null)[];
  /** Each fighter's move as of the last tick: a trade puts the attacker in hitstun (no move) as its hit lands. */
  moves: (string | null)[];
}
let open: OpenLevel | null = null;
const ended = new WeakSet<Match>();
/** The last campaign fight's result, for how a run ends. */
let lastCampaignResult: string | null = null;

/** A match is on (its Ready): level_start. A campaign fight's level is its chapter; else the mode. */
export function matchStart(m: Match, chapter: Chapter | null): void {
  if (open && open.m !== m) matchEnd(open.m, 'quit', { reason: 'replaced' });
  closeAsks();
  const level = chapter && m.setup.mode === 'campaign' ? chapter.id : m.setup.mode;
  open = { m, level, cause: m.state.fighters.map(() => null), moves: m.state.fighters.map(() => null) };
  const ctx = matchContext(m, chapter);
  sdk()?.setContext(ctx);
  const cpus = m.setup.slots.filter((s) => s.cpu);
  sdk()?.levelStart(level, {
    mode: m.setup.mode,
    stage: ctx.stage,
    fighter: ctx.fighter,
    opponent: ctx.opponent,
    stocks: m.setup.stocks,
    players: m.setup.slots.length,
    cpu_level: cpus.length ? Math.max(...cpus.map((s) => s.cpu ?? 0)) : undefined,
    chapter: chapter ? CHAPTERS.indexOf(chapter) + 1 : undefined,
  });
}

/** The sim's events after a tick: a death for every KO, with what caused it. */
export function matchEvents(m: Match, events: SimEvent[]): void {
  const o = open;
  if (!o || o.m !== m) return;
  for (const e of events) {
    if (e.type === 'hit' && !e.shield) {
      const a = m.state.fighters[e.attacker];
      o.cause[e.victim] = (a && MOVE_KEYS[a.move]) || o.moves[e.attacker] || 'hit';
    } else if (e.type === 'hurt') {
      o.cause[e.victim] = e.source;
    } else if (e.type === 'respawn') {
      o.cause[e.id] = null;
    } else if (e.type === 'ko') {
      const credited = e.by >= 0 && e.by !== e.victim;
      // The attacker's move; a fall with nobody's hit on you is a self-destruct.
      const cause = credited ? (o.cause[e.victim] ?? 'hit') : o.cause[e.victim] === 'hazard' || o.cause[e.victim] === 'zone' ? 'hazard' : 'fall';
      const ko = m.kos[m.kos.length - 1];
      sdk()?.death(cause, {
        victim: role(m, e.victim),
        fighter: charId(m.state.fighters[e.victim]?.char),
        by: credited ? charId(m.state.fighters[e.by]?.char) : 'none',
        by_role: credited ? role(m, e.by) : 'none',
        stage: STAGES[m.setup.stage]?.id,
        percent: ko && ko.victim === e.victim ? Math.round(ko.percent / 10) : undefined,
        x: Math.round(e.x / FX),
        y: Math.round(e.y / FX),
        at: Math.round(m.state.frame / 60),
      });
      o.cause[e.victim] = null;
    }
  }
  for (const f of m.state.fighters) if (f.action === ACT.ATTACK && MOVE_KEYS[f.move]) o.moves[f.id] = MOVE_KEYS[f.move];
}

/** The match is over or left: level_end with how it went. Once per match; quits before Ready send nothing. */
export function matchEnd(m: Match, result: 'complete' | 'death' | 'quit' | 'restart', extra?: Props): void {
  if (ended.has(m) || !open || open.m !== m) return;
  ended.add(m);
  const level = open.level;
  open = null;
  const me = m.player;
  const st = m.stats[me];
  const f = m.state.fighters[me];
  if (m.setup.mode === 'campaign') lastCampaignResult = result;
  sdk()?.levelEnd(level, result, {
    mode: m.setup.mode,
    stage: STAGES[m.setup.stage]?.id,
    fighter: charId(f?.char),
    opponent: opponents(m).join('+') || undefined,
    won: result === 'complete',
    match_seconds: Math.round(m.state.frame / 60),
    timed_out: m.state.timedOut || undefined,
    stocks_left: f && f.stocks < 90 ? Math.max(0, f.stocks) : undefined,
    damage_dealt: st ? Math.round(st.dealt) / 10 : undefined,
    damage_taken: st ? Math.round(st.taken) / 10 : undefined,
    kos: st?.kos,
    // The SDK counts every KO in the match as a death; the player's own falls are what this level cost them.
    deaths: st?.falls,
    self_destructs: st?.selfDestructs || undefined,
    longest_combo: st?.longestCombo,
    ...extra,
  });
}

// ------------------------------------------------------------------ the campaign: runs and progress

let run: { t: number; from: string; cleared: number } | null = null;

/** A chapter is played from the map: the campaign run starts with the first one. */
export function chapterPlayed(c: Chapter): void {
  sdk()?.setContext({ mode: 'campaign', chapter: c.id });
  if (run) return;
  run = { t: Date.now(), from: c.id, cleared: 0 };
  lastCampaignResult = null;
  track('run_start', { run: 'campaign', mode: 'campaign', from: c.id, chapter: CHAPTERS.indexOf(c) + 1 });
}

/** A chapter cleared for the first time: progress, the next one unlocked (or the whole campaign done). */
export function chapterCleared(c: Chapter, firstTime: boolean, done: Set<string>): void {
  if (run) run.cleared++;
  if (firstTime) {
    const next = CHAPTERS.find((x) => !done.has(x.id));
    track('progress', { step: done.size, of: CHAPTERS.length, label: next ? next.id : 'complete', cleared: c.id });
  }
  if (CHAPTERS.every((x) => done.has(x.id))) endRun('win');
}

/** The run ends when the player leaves the campaign for the main menu (or clears it all). */
function endRun(result?: 'win' | 'lose' | 'quit'): void {
  if (!run) return;
  const r = run;
  run = null;
  track('run_end', {
    run: 'campaign',
    mode: 'campaign',
    result: result ?? (lastCampaignResult === 'death' ? 'lose' : 'quit'),
    duration: Math.round((Date.now() - r.t) / 1000),
    from: r.from,
    cleared: r.cleared,
  });
}

/** A campaign scene (intro or outro): played to the end or skipped, and where. */
export function scene(id: string, end: { skipped: boolean; line: number }, lines: number): void {
  sdk()?.video(id, end.skipped ? 'skip' : 'complete', undefined, { line: end.line + 1, of: lines });
}

// ------------------------------------------------------------------ settings, pause, quit

export function setting(name: 'sound' | 'music' | 'sfx', value: boolean | number, from: string): void {
  feature(`settings.${name}`, { value, from });
}

export function paused(m: Match): void {
  track('pause', { mode: m.setup.mode, stage: STAGES[m.setup.stage]?.id, at: Math.round(m.state.frame / 60) });
}

export function quitToMenu(m: Match, to: string): void {
  track('quit_to_menu', { mode: m.setup.mode, to, stage: STAGES[m.setup.stage]?.id, at: Math.round(m.state.frame / 60) });
}

// ------------------------------------------------------------------ the controls in use, once per session each

const CONTROLS_KEY = 'dod.analytics.controls';
const controlsSeen = new Set<string>();
try {
  for (const d of JSON.parse(sessionStorage.getItem(CONTROLS_KEY) ?? '[]')) controlsSeen.add(String(d));
} catch {
  // No session storage: once per page instead.
}
function usedControls(device: 'keyboard' | 'gamepad' | 'touch' | 'mouse'): void {
  if (controlsSeen.has(device)) return;
  controlsSeen.add(device);
  try {
    sessionStorage.setItem(CONTROLS_KEY, JSON.stringify([...controlsSeen]));
  } catch {
    // Blocked storage: fine.
  }
  feature(`controls_${device}`, { value: device });
}
addEventListener('keydown', () => usedControls('keyboard'), { capture: true, passive: true });
addEventListener('gamepadconnected', () => usedControls('gamepad'));
addEventListener(
  'pointerdown',
  (e) => usedControls(e.pointerType === 'touch' || e.pointerType === 'pen' ? 'touch' : 'mouse'),
  { capture: true, passive: true },
);

// ------------------------------------------------------------------ feedback cards (never mid-match)

/** The card in the game's colours: the panel, the cream text, the hot orange (src/game/game.css). */
const THEME = { background: 'rgba(20, 15, 12, 0.96)', color: '#fff4e8', accent: '#ff5a1f', font: 'Barlow, system-ui, sans-serif', radius: '6px' };

function ask(o: HawkesAsk): void {
  const a = sdk();
  if (!a) return;
  // The card takes the focus as it opens: give it back, so Enter on the screen still does what it says.
  const had = document.activeElement as HTMLElement | null;
  void a.ask({ theme: THEME, ...o });
  had?.focus?.({ preventScroll: true });
}

/** After a versus or online match, on its results screen. */
export function askAfterMatch(m: Match): void {
  const ctx = matchContext(m, null);
  ask({
    id: 'after-match',
    question: 'How was that fight?',
    kind: 'thumbs',
    comment: true,
    placeholder: 'What made it? What broke it? (optional)',
    thanks: 'Noted. See you next round.',
    context: [m.setup.mode, `${ctx.fighter} vs ${ctx.opponent}`, ctx.stage].filter(Boolean).join(' · '),
  });
}

/** After a campaign episode's outro, back on the map: stars for the episode. */
export function askAfterEpisode(c: Chapter): void {
  const n = CHAPTERS.indexOf(c) + 1;
  ask({
    id: `after-episode-${c.id}`,
    question: `Rate tonight's episode: ${c.title}`,
    kind: 'stars',
    comment: true,
    placeholder: 'Anything for the producers? (optional)',
    thanks: 'Thanks. The producers are listening.',
    context: `chapter ${n} · ${c.id}`,
  });
}

/** A match is starting: a card still up from the last results goes. */
export function closeAsks(): void {
  document.querySelectorAll('[data-hawkes-ask]').forEach((el) => el.remove());
}
