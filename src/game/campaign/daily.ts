// Tonight's Episode: one fight a day, the same for every player, picked from the UTC date with no server call.
// The pick is a pure function of the date and a pool read from content/campaign.json (objectives, their targets and
// clocks, the damage / gravity / scale / start-percent values the chapters already use), so a new chapter widens
// tomorrow's menu by itself. Scoring and the day streak are pure too; storage and the board are elsewhere
// (campaign/dailyStore.ts, net/daily.ts).

import { CHARACTERS, characterIndex } from '../sim/characters.ts';
import { STAGES, stageIndex } from '../sim/stage.ts';
import type { MatchSetup, SlotSetup } from '../match.ts';
import { CHAPTER_ENTRIES, type ChapterEntry } from './story.ts';

export type DailyObjective = 'ko' | 'quota' | 'streak' | 'survive';
export type TwistKind = 'damage' | 'gravity' | 'startPercent' | 'scale' | 'teams';

export interface Twist {
  kind: TwistKind;
  /** The number for it (percent), 0 for teams. */
  value: number;
  /** A short line for the card ("Low gravity", "Giant foe"). */
  line: string;
}

export interface DailyEpisode {
  /** The UTC date, YYYY-MM-DD: the episode's name and the board's key. */
  date: string;
  /** Fighter ids. */
  player: string;
  foes: string[];
  ally: string | null;
  stage: string;
  cpu: number;
  stocks: number;
  objective: DailyObjective;
  kos?: number;
  quota?: number;
  streak?: number;
  /** The clock in frames. */
  timeLimit: number;
  twists: Twist[];
  /** The chapter whose Blog Man intro (voice.json `blog-man.intro.<id>`) opens the card. */
  blogChapter: string;
}

/** What the picker draws from (campaign.json, read by `poolFromCampaign`). */
export interface DailyPool {
  /** Who the show lends the player for the night: the whole cast, locked or not (a loaner, nothing is unlocked by it). */
  players: string[];
  /** Anyone may stand across (CPU picks are not gated). */
  foes: string[];
  stages: string[];
  cpu: number[];
  objectives: { objective: DailyObjective; target: number; timeLimit: number; stocks: number }[];
  damage: number[];
  gravity: number[];
  scale: number[];
  startPercent: number[];
  blogChapters: { id: string; stage: string }[];
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)].sort();

/** The pool from the campaign's chapters. */
export function poolFromCampaign(entries: ChapterEntry[], fighters: string[], stages: string[]): DailyPool {
  const objectives: DailyPool['objectives'] = [];
  const seen = new Set<string>();
  const damage: number[] = [];
  const gravity: number[] = [];
  const scale: number[] = [];
  const startPercent: number[] = [];
  const cpu: number[] = [];
  for (const c of entries) {
    const f = c.fight;
    const o = f.objective;
    const timeLimit = f.rules?.timeLimit ?? 0;
    if (o === 'ko' || o === 'quota' || o === 'streak' || o === 'survive') {
      const target = o === 'ko' ? f.kos ?? 3 : o === 'quota' ? f.quota ?? 250 : o === 'streak' ? f.streak ?? 4 : 0;
      const key = `${o}|${target}|${timeLimit}`;
      if (timeLimit > 0 && !seen.has(key)) {
        seen.add(key);
        objectives.push({ objective: o, target, timeLimit, stocks: f.stocks });
      }
    }
    if (f.rules?.damage) damage.push(f.rules.damage);
    if (f.rules?.gravity) gravity.push(f.rules.gravity);
    for (const s of f.slots) {
      if (s.scale && s.scale !== 100) scale.push(s.scale);
      if (s.startPercent) startPercent.push(s.startPercent);
      if (s.cpu && s.cpu >= 2 && s.cpu <= 8) cpu.push(s.cpu);
    }
  }
  // The Mechanic is candidate canon: never on a card (docs/world-bible.md).
  const cast = fighters.filter((id) => id !== 'the-mechanic');
  return {
    players: cast,
    foes: cast,
    stages: [...stages],
    cpu: uniq(cpu),
    objectives: objectives.sort((a, b) => (a.objective + a.target + a.timeLimit).localeCompare(b.objective + b.target + b.timeLimit)),
    damage: uniq(damage),
    gravity: uniq(gravity),
    scale: uniq(scale.filter((s) => s > 100)),
    startPercent: uniq(startPercent),
    blogChapters: entries.map((c) => ({ id: c.id, stage: c.fight.stage })),
  };
}

export const DAILY_POOL: DailyPool = poolFromCampaign(CHAPTER_ENTRIES, CHARACTERS.map((c) => c.id), STAGES.map((s) => s.id));

// ------------------------------------------------------------------ the seed

/** A 32-bit hash of a string (cyrb-style), the seed's start. */
function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The UTC date of a time in ms: "2026-11-11". */
export function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isDateKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dateKey(Date.parse(`${s}T00:00:00Z`)) === s;
}

/** The day before / after a date key. */
export function addDays(date: string, n: number): string {
  return dateKey(Date.parse(`${date}T00:00:00Z`) + n * 86400000);
}

/** Milliseconds until the next UTC midnight. */
export function msToNext(ms: number): number {
  return 86400000 - (ms % 86400000);
}

/** "5h 02m" / "12m 09s": the countdown on the card. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${two(m)}m` : `${m}m ${two(sec)}s`;
}

// ------------------------------------------------------------------ the pick

const TWIST_LINES: Record<TwistKind, (v: number) => string> = {
  damage: (v) => (v < 100 ? 'Soft hits' : 'Hard hits'),
  gravity: (v) => (v < 100 ? 'Low gravity' : 'Heavy gravity'),
  startPercent: () => 'Foe starts hurt',
  scale: () => 'Giant foe',
  teams: () => 'You have a partner',
};

/** One day's episode. Pure: the same date and pool give the same episode everywhere. */
export function dailyEpisode(date: string, pool: DailyPool = DAILY_POOL): DailyEpisode {
  const r = rng(hash(`dod-daily|${date}`));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
  const without = <T>(xs: readonly T[], gone: readonly T[]): T[] => xs.filter((x) => !gone.includes(x));

  const player = pick(pool.players);
  const obj = pick(pool.objectives);
  const stage = pick(pool.stages);
  const cpu = pick(pool.cpu);

  const kinds: TwistKind[] = (['damage', 'gravity', 'startPercent', 'scale', 'teams'] as TwistKind[]).filter((k) => {
    if (k === 'damage') return pool.damage.length > 0;
    if (k === 'gravity') return pool.gravity.length > 0;
    if (k === 'startPercent') return pool.startPercent.length > 0;
    if (k === 'scale') return pool.scale.length > 0;
    return pool.foes.length > 3;
  });
  // One twist most nights, two on about a third of them.
  const count = r() < 0.35 ? 2 : 1;
  const twists: Twist[] = [];
  for (let i = 0; i < count && kinds.length; i++) {
    const kind = kinds.splice(Math.floor(r() * kinds.length), 1)[0];
    const value = kind === 'teams' ? 0 : pick(kind === 'damage' ? pool.damage : kind === 'gravity' ? pool.gravity : kind === 'startPercent' ? pool.startPercent : pool.scale);
    twists.push({ kind, value, line: TWIST_LINES[kind](value) });
  }
  const teams = twists.some((t) => t.kind === 'teams');
  const foeCount = teams ? 2 : r() < 0.25 ? 2 : 1;
  const foes: string[] = [];
  let left = without(pool.foes, [player]);
  for (let i = 0; i < foeCount; i++) {
    const f = pick(left);
    foes.push(f);
    left = without(left, [f]);
  }
  const ally = teams ? pick(without(left, foes)) : null;

  const onStage = pool.blogChapters.filter((c) => c.stage === stage);
  const blogChapter = pick(onStage.length ? onStage : pool.blogChapters).id;

  return {
    date,
    player,
    foes,
    ally,
    stage,
    cpu,
    stocks: Math.max(2, obj.stocks),
    objective: obj.objective,
    ...(obj.objective === 'ko' ? { kos: obj.target } : obj.objective === 'quota' ? { quota: obj.target } : obj.objective === 'streak' ? { streak: obj.target } : {}),
    timeLimit: obj.timeLimit,
    twists,
    blogChapter,
  };
}

/** The objective in one short line ("3 KOs in 2:00"). */
export function objectiveLine(ep: DailyEpisode): string {
  const secs = ep.timeLimit / 60;
  const clock = `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
  if (ep.objective === 'ko') return `${ep.kos} KOs in ${clock}`;
  if (ep.objective === 'quota') return `Deal ${ep.quota}% in ${clock}`;
  if (ep.objective === 'streak') return `${ep.streak} clean hits in ${clock}`;
  return `Last ${clock} on the air`;
}

/** The card's twist line: "Low gravity · Giant foe". */
export function twistLine(ep: DailyEpisode): string {
  return ep.twists.map((t) => t.line).join(' · ');
}

/** The fight as a campaign-style match. */
export function dailySetup(ep: DailyEpisode, pool: DailyPool = DAILY_POOL): MatchSetup {
  void pool;
  const has = (k: TwistKind) => ep.twists.find((t) => t.kind === k);
  const scale = has('scale')?.value;
  const hurt = has('startPercent')?.value;
  const slots: SlotSetup[] = [{ char: characterIndex(ep.player), cpu: null, team: 0, stocks: ep.stocks }];
  if (ep.ally) slots.push({ char: characterIndex(ep.ally), cpu: Math.max(2, ep.cpu - 1), team: 0, stocks: ep.stocks });
  const foeStocks = ep.objective === 'survive' ? ep.stocks : Math.min(ep.stocks, 3);
  ep.foes.forEach((f, i) => {
    const s: SlotSetup = { char: characterIndex(f), cpu: ep.cpu, team: 1, stocks: foeStocks };
    if (scale && i === 0) s.scale = scale;
    if (hurt) s.startPercent = hurt;
    slots.push(s);
  });
  const rules: MatchSetup['rules'] = { timeLimit: ep.timeLimit };
  const dmg = has('damage');
  const grav = has('gravity');
  if (dmg) rules.damage = dmg.value;
  if (grav) rules.gravity = grav.value;
  return {
    mode: 'campaign',
    stage: stageIndex(ep.stage),
    stocks: ep.stocks,
    rules,
    objective: ep.objective,
    ...(ep.kos ? { kos: ep.kos } : {}),
    ...(ep.quota ? { quota: ep.quota } : {}),
    ...(ep.streak ? { streak: ep.streak } : {}),
    slots,
    title: `Tonight's Episode · ${ep.date}`,
    subtitle: `${objectiveLine(ep)}${ep.twists.length ? ` · ${twistLine(ep)}` : ''}`,
  };
}

// ------------------------------------------------------------------ score

export interface DailyRun {
  won: boolean;
  /** Match frames played. */
  frames: number;
  /** Damage the player took, in percent (whole). */
  taken: number;
  /** Stocks the player has left. */
  stocksLeft: number;
  /** How far past the target the objective went: KOs over, percent of quota over, hits over (0 for survive and win). */
  margin: number;
}

export const SCORE_MAX = 3000;

/**
 * The run's score: nothing for a loss; a win is 1000, plus up to 400 for the clock left, 100 a stock left, 50 per unit of
 * objective margin (at most 400) and minus 2 a percent taken (at most 600), never under 100.
 */
export function dailyScore(ep: DailyEpisode, run: DailyRun): number {
  if (!run.won) return 0;
  const total = Math.max(1, ep.timeLimit);
  const timePts = Math.round(400 * Math.max(0, Math.min(1, 1 - run.frames / total)));
  const stockPts = Math.max(0, Math.min(5, run.stocksLeft)) * 100;
  const unit = ep.objective === 'quota' ? 0.5 : 1;
  const marginPts = Math.min(400, Math.round(Math.max(0, run.margin) * unit * 50));
  const damagePts = Math.min(600, Math.round(Math.max(0, run.taken) * 2));
  return Math.max(100, Math.min(SCORE_MAX, 1000 + timePts + stockPts + marginPts - damagePts));
}

// ------------------------------------------------------------------ streak

export interface DailyState {
  /** Best score by date (only dates cleared). */
  best: Record<string, number>;
  /** Days in a row cleared, ending at `last`. */
  streak: number;
  /** The longest streak ever. */
  longest: number;
  /** The date of the last clear, '' for none. */
  last: string;
}

export const EMPTY_DAILY: DailyState = { best: {}, streak: 0, longest: 0, last: '' };

/** A clear on `date`: a day after the last keeps the streak going, the same day changes nothing, a gap starts again. */
export function recordClear(state: DailyState, date: string, score: number): DailyState {
  const best = { ...state.best, [date]: Math.max(state.best[date] ?? 0, score) };
  // Keep a month of dates: the card needs only today's.
  for (const d of Object.keys(best)) if (d < addDays(date, -40)) delete best[d];
  let streak = state.streak;
  if (state.last === date) streak = Math.max(1, streak);
  else if (state.last === addDays(date, -1)) streak += 1;
  else streak = 1;
  const last = state.last > date ? state.last : date;
  return { best, streak, longest: Math.max(state.longest, streak), last };
}

/** The streak the card shows today: alive while the last clear was today or yesterday, else 0. */
export function liveStreak(state: DailyState, today: string): number {
  return state.last === today || state.last === addDays(today, -1) ? state.streak : 0;
}
