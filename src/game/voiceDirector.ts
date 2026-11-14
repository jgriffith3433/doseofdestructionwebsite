// The voice director: every speaking path in the game (announcer calls, commentary, story scene takes, rival banter, win
// quotes and the fighters' efforts, hurts, KO cries and taunts) goes through one of these, so only one speaker is ever on
// the air. Pure: no audio, no timers, no window. audio.ts feeds it takes (with their real length) and runs what it returns
// (start, cut with a fade, drop, end) and sets one timer at `nextWake()` to call `pump()`. Tests drive it with a fake clock.
//
// Priority, highest first: scene > announcer > win quote > rival banter > commentary > KO cry > taunt > hurt > effort.
// - A lower line waits at most WAIT_MS for the speaker ahead to finish, then is dropped. Efforts and hurts never wait: they
//   are dropped at once (a grunt played late is wrong).
// - A higher line cuts a bark (ko / taunt / hurt / effort) at once with a FADE_MS fade, and cuts a lower spoken line once it
//   has waited WAIT_MS. A scene take replaces the scene take before it, an announcer call the call before it.
// - Commentary and the announcer's pooled lines never repeat inside REPEAT_MS; no fighter plays the same bark take twice in
//   a row (a kind with one take is exempt).

export type VoiceKind = 'scene' | 'announcer' | 'win-quote' | 'banter' | 'commentary' | 'ko' | 'taunt' | 'hurt' | 'effort';

export const PRIORITY: Readonly<Record<VoiceKind, number>> = {
  scene: 8,
  announcer: 7,
  'win-quote': 6,
  banter: 5,
  commentary: 4,
  ko: 3,
  taunt: 2,
  hurt: 1,
  effort: 0,
};

export const BARKS: readonly VoiceKind[] = ['ko', 'taunt', 'hurt', 'effort'];
export const isBark = (k: VoiceKind): boolean => BARKS.includes(k);

/** A lower line waits this long for the speaker ahead. */
export const WAIT_MS = 600;
/** The fade a cut take gets; the only overlap the director allows. */
export const FADE_MS = 60;
/** Commentary and pooled announcer lines never repeat inside this. */
export const REPEAT_MS = 5 * 60 * 1000;

export interface VoiceReq {
  kind: VoiceKind;
  /** Who speaks: a fighter id, `announcer`, `blog-man`, `narrator`... */
  speaker: string;
  /** The catalog line id (or the file name when a take has no line). */
  id: string;
  /** The take's length in ms. */
  ms: number;
  /** Apply the 5 minute no-repeat rule (commentary, pooled announcer lines). */
  once?: boolean;
  /** For a bark: how many takes this fighter has of this kind (1 = exempt from the back-to-back rule). */
  pool?: number;
  /** Whatever the caller wants back with the outcome (a resolver, a source). */
  ref?: unknown;
}

export interface Take extends VoiceReq {
  prio: number;
  /** When it was asked for. */
  asked: number;
  /** A waiting take is dropped when the clock passes this. */
  deadline: number;
  start: number;
  /** When it ends, or when it was cut (plus the fade is `FADE_MS` more). */
  end: number;
  state: 'waiting' | 'on-air' | 'done' | 'dropped';
  cut: boolean;
  reason?: 'busy' | 'timeout' | 'repeat' | 'bark-repeat';
}

export type Outcome =
  | { type: 'start'; take: Take }
  | { type: 'cut'; take: Take; by: Take }
  | { type: 'drop'; take: Take }
  | { type: 'end'; take: Take };

export interface VoiceStats {
  /** Takes asked for, played (started), dropped, cut short. */
  asked: number;
  played: number;
  dropped: number;
  cut: number;
  /** The longest time two takes were on the air together, ms (a cut take's fade counts). */
  maxOverlapMs: number;
  /** Total overlap beyond the FADE_MS crossfade, summed over every pair, ms. */
  overBudgetMs: number;
  /** Pairs of takes by different speakers that overlapped beyond the crossfade. */
  overlaps: number;
  /** Commentary / pooled announcer ids that played twice inside REPEAT_MS. */
  repeats: number;
  /** Same bark take twice in a row from one fighter and kind. */
  barkRepeats: number;
  /** Longest a take waited before it started, ms. */
  maxWaitMs: number;
}

export class VoiceDirector {
  private onAir: Take | null = null;
  private waiting: Take[] = [];
  /** Every take that reached the air, in order (for the stats and the playtest). */
  readonly played: Take[] = [];
  readonly dropped: Take[] = [];
  private lastPlayedAt = new Map<string, number>();
  private lastBark = new Map<string, string>();
  private asked = 0;

  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** The take on the air now (null when none, or it has ended). */
  current(): Take | null {
    const t = this.clock();
    return this.onAir && this.onAir.end > t ? this.onAir : null;
  }

  /** True when this id may be said now under the 5 minute rule (nothing queued or played of it inside REPEAT_MS). */
  fresh(id: string): boolean {
    const at = this.lastPlayedAt.get(id);
    return at === undefined || this.clock() - at >= REPEAT_MS || this.waiting.some((w) => w.id === id);
  }

  /** Asks for a take. Returns what to do now (start it, cut the one on the air, drop it, or nothing: it waits). */
  request(req: VoiceReq): Outcome[] {
    const now = this.clock();
    const out: Outcome[] = [...this.retire(now)];
    this.asked++;
    const take: Take = { ...req, prio: PRIORITY[req.kind], asked: now, deadline: now, start: 0, end: 0, state: 'waiting', cut: false };

    if (req.once) {
      const at = this.lastPlayedAt.get(req.id);
      if ((at !== undefined && now - at < REPEAT_MS) || this.waiting.some((w) => w.id === req.id)) return [...out, this.drop(take, 'repeat')];
    }
    if (isBark(req.kind) && (req.pool ?? 2) > 1 && this.lastBark.get(`${req.speaker}.${req.kind}`) === req.id) {
      return [...out, this.drop(take, 'bark-repeat')];
    }

    const cur = this.onAir;
    if (!cur) {
      // Free air: a higher waiting line goes first.
      const best = this.waiting.find((w) => w.prio > take.prio);
      if (best) return [...out, ...this.enqueue(take)];
      return [...out, ...this.begin(take, now)];
    }
    const replaces = cur.kind === take.kind && (take.kind === 'scene' || take.kind === 'announcer');
    if (take.prio > cur.prio && isBark(cur.kind)) return [...out, ...this.cutAndBegin(cur, take, now)];
    if (replaces) return [...out, ...this.cutAndBegin(cur, take, now)];
    if (isBark(take.kind) && (take.kind === 'effort' || take.kind === 'hurt')) return [...out, this.drop(take, 'busy')];
    return [...out, ...this.enqueue(take)];
  }

  /** Ends takes whose time is up, drops waiters past their deadline, starts the best waiter if the air is free. */
  pump(): Outcome[] {
    const now = this.clock();
    const out: Outcome[] = [];
    // A waiter whose wait ran out while the air was still taken is gone, even if the air frees in the same tick.
    for (const w of [...this.waiting]) {
      if (this.onAir && w.prio <= this.onAir.prio && now >= w.deadline && this.onAir.end > w.deadline) {
        this.waiting = this.waiting.filter((x) => x !== w);
        out.push(this.drop(w, 'timeout'));
      }
    }
    // A waiter that outranks the one on the air has waited long enough: it cuts it.
    const cur = this.onAir;
    if (cur && cur.end > now) {
      const w = [...this.waiting].sort((a, b) => b.prio - a.prio).find((x) => x.prio > cur.prio && now >= x.deadline);
      if (w) {
        this.waiting = this.waiting.filter((x) => x !== w);
        out.push(...this.cutAndBegin(cur, w, now));
      }
    }
    out.push(...this.retire(now));
    if (!this.onAir && this.waiting.length) {
      const best = [...this.waiting].sort((a, b) => b.prio - a.prio || a.asked - b.asked)[0];
      this.waiting = this.waiting.filter((x) => x !== best);
      out.push(...this.begin(best, now));
    }
    return out;
  }

  /** When pump() next has something to do (ms on the clock), or null. */
  nextWake(): number | null {
    let at: number | null = null;
    const min = (v: number): void => {
      if (at === null || v < at) at = v;
    };
    if (this.onAir) min(this.onAir.end);
    for (const w of this.waiting) min(w.deadline);
    return at;
  }

  /** Cuts whatever of this kind is on the air or waiting (a new announcer call, leaving a screen). */
  stopKind(kind: VoiceKind): Outcome[] {
    const now = this.clock();
    const out: Outcome[] = [...this.retire(now)];
    for (const w of this.waiting.filter((x) => x.kind === kind)) out.push(this.drop(w, 'busy'));
    this.waiting = this.waiting.filter((x) => x.kind !== kind);
    const cur = this.onAir;
    if (cur && cur.kind === kind) {
      cur.cut = true;
      cur.end = now;
      cur.state = 'done';
      this.onAir = null;
      out.push({ type: 'cut', take: cur, by: cur });
    }
    return out;
  }

  /** Milliseconds left on the take on the air (0 when none). */
  busyMs(kind?: VoiceKind): number {
    const c = this.current();
    return c && (!kind || c.kind === kind) ? Math.max(0, c.end - this.clock()) : 0;
  }

  stats(): VoiceStats {
    const takes = [...this.played].sort((a, b) => a.start - b.start);
    let maxOverlapMs = 0;
    let overBudgetMs = 0;
    let overlaps = 0;
    for (let i = 0; i < takes.length; i++) {
      for (let j = i + 1; j < takes.length; j++) {
        const a = takes[i];
        const b = takes[j];
        if (b.start >= a.end + (a.cut ? FADE_MS : 0)) break;
        const o = Math.min(a.end + (a.cut ? FADE_MS : 0), b.end + (b.cut ? FADE_MS : 0)) - b.start;
        if (o <= 0) continue;
        maxOverlapMs = Math.max(maxOverlapMs, o);
        if (o > FADE_MS && a.speaker !== b.speaker) {
          overBudgetMs += o - FADE_MS;
          overlaps++;
        }
      }
    }
    const lastOnce = new Map<string, number>();
    const lastBark = new Map<string, string>();
    let repeats = 0;
    let barkRepeats = 0;
    for (const t of takes) {
      if (t.once) {
        const at = lastOnce.get(t.id);
        if (at !== undefined && t.start - at < REPEAT_MS) repeats++;
        lastOnce.set(t.id, t.start);
      }
      if (isBark(t.kind) && (t.pool ?? 2) > 1) {
        const k = `${t.speaker}.${t.kind}`;
        if (lastBark.get(k) === t.id) barkRepeats++;
        lastBark.set(k, t.id);
      }
    }
    return {
      asked: this.asked,
      played: this.played.length,
      dropped: this.dropped.length,
      cut: this.played.filter((t) => t.cut).length,
      maxOverlapMs,
      overBudgetMs,
      overlaps,
      repeats,
      barkRepeats,
      maxWaitMs: this.played.reduce((m, t) => Math.max(m, t.start - t.asked), 0),
    };
  }

  /** Forgets everything (tests, a new session). */
  reset(): void {
    this.onAir = null;
    this.waiting = [];
    this.played.length = 0;
    this.dropped.length = 0;
    this.lastPlayedAt.clear();
    this.lastBark.clear();
    this.asked = 0;
  }

  // ---- internals ----

  private retire(now: number): Outcome[] {
    const cur = this.onAir;
    if (cur && cur.end <= now) {
      cur.state = 'done';
      this.onAir = null;
      return [{ type: 'end', take: cur }];
    }
    return [];
  }

  private begin(take: Take, now: number): Outcome[] {
    take.state = 'on-air';
    take.start = now;
    take.end = now + Math.max(1, take.ms);
    this.onAir = take;
    this.played.push(take);
    this.lastPlayedAt.set(take.id, now);
    if (isBark(take.kind)) this.lastBark.set(`${take.speaker}.${take.kind}`, take.id);
    return [{ type: 'start', take }];
  }

  private cutAndBegin(cur: Take, take: Take, now: number): Outcome[] {
    cur.cut = true;
    cur.end = now;
    cur.state = 'done';
    this.onAir = null;
    return [{ type: 'cut', take: cur, by: take }, ...this.begin(take, now)];
  }

  private enqueue(take: Take): Outcome[] {
    // The wait is for a lower line; a higher line also gets WAIT_MS before it cuts the spoken line ahead.
    take.deadline = take.asked + (isBark(take.kind) && take.kind !== 'ko' && take.kind !== 'taunt' ? 0 : WAIT_MS);
    this.waiting.push(take);
    return [];
  }

  private drop(take: Take, reason: NonNullable<Take['reason']>): Outcome {
    take.state = 'dropped';
    take.reason = reason;
    this.dropped.push(take);
    return { type: 'drop', take };
  }
}
