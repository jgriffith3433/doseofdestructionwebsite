// The Hawkes playtest contract (v1) for Dose Of Destruction. The runner in
// Hawkes Gen opens /Game/?playtest=<scenario>, or calls
// window.hawkesPlaytest.start(id), and this plays the game like a person:
// menus are clicked and pause is the Esc key, and in a match the fighter is
// driven by the CPU bot (ai/bot.ts) plugged into the input layer as a virtual
// pad (input/devices.ts), read on the same path as the keyboard and gamepad.
// It never edits sim state. The `roster` scenario is the one exception for
// setup: it starts each training match directly instead of through menus.
//
// Spec: hawkesstudio/docs/playtest.md. Nothing here runs until a scenario starts.

import { installPlaytest, type Outcome, type RunOptions, type Tracker } from './hawkes-playtest.js';
import { Bot } from '../ai/bot.ts';
import { setVirtualPad } from '../input/devices.ts';
import { currentScreen, switching, type ScreenId } from '../ui/screens.ts';
import { CHARACTERS, MOVE, MOVE_KEYS } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput } from '../sim/input.ts';
import { STAGES } from '../sim/stage.ts';
import { FX } from '../sim/fixed.ts';
import { ACT } from '../sim/state.ts';
import { CHAPTERS } from '../campaign/story.ts';
import { stagesFor } from '../modes.ts';
import { SOUNDS, VOICE } from '../audio.ts';
import { loadAnimSet } from '../render/anims.ts';
import type { Match, MatchSetup } from '../match.ts';
import type { SimEvent } from '../sim/step.ts';

export type MatchWatcher = (m: Match, events: SimEvent[]) => void;

/** What main.ts lends the playtest. */
export interface GameHooks {
  match(): Match | null;
  phase(): string;
  /** Seeds the next matches (null: random again). */
  setSeed(seed: number | null): void;
  /** Sim speed multiplier, 1 to 4. */
  setSpeed(speed: number): void;
  /** Called after every sim tick; returns an unsubscribe. */
  watch(w: MatchWatcher): () => void;
  /** Setup shortcut (roster only): straight into a match, no menus. */
  startMatch(setup: MatchSetup): Promise<void>;
  /** Setup shortcut (roster only): leave the match for the main menu. */
  quitMatch(): Promise<void>;
}

const SCENARIOS = [
  { id: 'smoke', title: 'Boot, menus, a quick versus match for 20 s, quit to the menu', seconds: 50, tags: ['smoke'] },
  { id: 'match', title: 'A full 1v1 versus match against the CPU (2 stocks), to the results screen', seconds: 150, tags: ['full'] },
  { id: 'campaign', title: 'The campaign from chapter 1, as far as the bot gets in 10 minutes', seconds: 600, tags: ['full'] },
  { id: 'roster', title: 'Every fighter spawns in training and does each move once (starts matches directly)', seconds: 480, tags: ['full', 'roster'] },
];

/** How well the bot playing "you" fights (1-9). */
const BOT_LEVEL = 9;
/** Wall-clock budget for the campaign before it stops cleanly. */
const CAMPAIGN_BUDGET_MS = 9.5 * 60 * 1000;
/** Core clips every fighter should have, besides one per move. */
const CORE_CLIPS = ['idle', 'walk', 'jump', 'fall', 'land', 'hurt', 'shield'];

const SCREEN_NAMES: Record<ScreenId, string> = {
  title: 'Title', main: 'Main Menu', select: 'Character Select', stages: 'Stage Select', versus: 'VS',
  campaign: 'Campaign Map', dialogue: 'Dialogue', howto: 'How To Play', settings: 'Settings', results: 'Results', match: 'Match',
};

const MOVE_NAMES = Object.fromEntries(Object.entries(MOVE).map(([k, v]) => [v, k.toLowerCase()])) as Record<number, string>;

export function installDodPlaytest(game: GameHooks): void {
  let run: Run | null = null;
  installPlaytest({
    product: 'doseofdestruction',
    scenarios: SCENARIOS,
    isReady: () => currentScreen() !== null && !switching(),
    async start(id, options, t) {
      run?.dispose();
      const r = new Run(game, t, options);
      run = r;
      try {
        if (id === 'smoke') await r.smoke();
        else if (id === 'match') await r.match();
        else if (id === 'campaign') await r.campaign();
        else if (id === 'roster') await r.roster();
      } finally {
        r.dispose();
      }
    },
    stop() {
      run?.dispose();
    },
    input: pressAction,
  });
}

// --------------------------------------------------------------- the run

class Run {
  private readonly unwatch: () => void;
  private readonly poll: number;
  private bot: Bot | null = null;
  private botMatch: Match | null = null;
  /** Set by the roster driver; when not null it is the pad's whole input. */
  private manual: number | null = null;
  private seen: Match | null = null;
  private lastHitFrame = 0;
  private quietWarned = false;
  private overSeen = false;
  private lastFrame = -1;
  private lastFrameAt = 0;
  private matches = 0;
  /** Moves the playing fighter started this match (roster). */
  readonly movesSeen = new Set<number>();
  private readonly checked = new Set<string>();
  private disposed = false;

  private readonly game: GameHooks;
  private readonly t: Tracker;
  private readonly options: RunOptions;

  constructor(game: GameHooks, t: Tracker, options: RunOptions) {
    this.game = game;
    this.t = t;
    this.options = options;
    game.setSeed(options.seed);
    game.setSpeed(options.speed);
    setVirtualPad(() => this.read());
    this.unwatch = game.watch((m, ev) => this.onTick(m, ev));
    this.poll = window.setInterval(() => this.onPoll(), 250);
    void this.checkSounds();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setVirtualPad(null);
    this.game.setSeed(null);
    this.game.setSpeed(1);
    this.unwatch();
    clearInterval(this.poll);
  }

  // ---------------------------------------------------------- input

  /** The virtual pad: read once per sim tick, like a gamepad. */
  private read(): number {
    if (this.manual !== null) return this.manual;
    const m = this.game.match();
    if (!m || m.player < 0) return NO_INPUT;
    if (m !== this.botMatch) {
      this.botMatch = m;
      this.bot = new Bot(m.player, BOT_LEVEL, (this.options.seed * 7919 + this.matches) | 0);
    }
    return this.bot!.think(m.state);
  }

  // ---------------------------------------------------------- watching

  private onTick(m: Match, events: SimEvent[]): void {
    const s = m.state;
    const me = m.player;
    if (m !== this.seen) this.onMatchStart(m);
    for (const e of events) {
      if (e.type === 'hit') {
        this.lastHitFrame = s.frame;
        if (e.shield) continue;
        if (e.attacker === me) this.damage('damageDealt', e.dmg);
        if (e.victim === me) this.damage('damageTaken', e.dmg);
      } else if (e.type === 'hurt') {
        this.lastHitFrame = s.frame;
        if (e.victim === me) this.damage('damageTaken', e.dmg);
      } else if (e.type === 'ko') {
        const victim = name(m, e.victim);
        const by = e.by >= 0 && e.by !== e.victim ? name(m, e.by) : null;
        this.t.event('ko', by ? `${by} KO'd ${victim}` : `${victim} fell (self-destruct)`);
        if (e.victim === me) this.t.add('falls');
        else if (e.by === me) this.t.add('kos');
        if (e.victim === me && !by) this.t.add('selfDestructs');
      }
    }
    for (const f of s.fighters) {
      if (f.action === ACT.ATTACK && f.id === me) this.movesSeen.add(f.move);
      if (![f.x, f.y, f.vx, f.vy, f.percent].every(Number.isFinite)) {
        this.t.problem('bug', `NaN position: ${name(m, f.id)} on ${STAGES[s.stage].name} (x ${f.x}, y ${f.y})`);
        continue;
      }
      // The sim KOs anyone past a blast zone in the same tick, so a living fighter out there is a bug.
      const b = STAGES[s.stage].blast;
      const pad = 50 * FX;
      if (f.action !== ACT.DEAD && (f.x < b.left * FX - pad || f.x > b.right * FX + pad || f.y < b.bottom * FX - pad || f.y > b.top * FX + pad)) {
        this.t.problem('bug', `${name(m, f.id)} is out of bounds on ${STAGES[s.stage].name} without being KO'd (${Math.round(f.x / FX)}, ${Math.round(f.y / FX)})`);
      }
    }
    if (!s.over && s.frame - this.lastHitFrame > 30 * 60 && !this.quietWarned && m.setup.mode !== 'training') {
      this.quietWarned = true;
      this.t.problem('warning', `no hits for 30 s in a match on ${STAGES[s.stage].name} (fighters can't reach each other?)`);
    }
    if (s.over && !this.overSeen) {
      this.overSeen = true;
      const won = m.playerWon();
      const secs = s.frame / 60;
      this.t.add('matchSeconds', Math.round(secs));
      this.t.metric('lastMatchSeconds', Math.round(secs));
      this.t.metric('stocksLeft', Math.max(0, s.fighters[me]?.stocks ?? 0));
      this.t.add(won ? 'wins' : 'losses');
      this.t.event('match-end', `${won ? 'won' : 'lost'} in ${Math.round(secs)} s${s.timedOut ? ' (time)' : ''}`);
    }
    this.t.progress(this.progressNow());
  }

  /** Damage totals in percent; the sim counts tenths. */
  private readonly totals: Record<string, number> = {};
  private damage(metric: string, tenths: number): void {
    this.totals[metric] = (this.totals[metric] ?? 0) + tenths;
    this.t.metric(metric, this.totals[metric] / 10);
  }

  private onMatchStart(m: Match): void {
    this.seen = m;
    this.lastHitFrame = m.state.frame;
    this.quietWarned = false;
    this.overSeen = false;
    this.movesSeen.clear();
    this.matches++;
    this.t.add('matches');
    const st = STAGES[m.state.stage];
    const who = m.state.fighters.map((f) => name(m, f.id)).join(' vs ');
    this.t.event('match-start', `${who} on ${st.name}`);
    for (const f of m.state.fighters) void this.checkFighter(CHARACTERS[f.char].id);
    void this.checkStage(m.state.stage);
  }

  private onPoll(): void {
    const id = currentScreen();
    const m = this.game.match();
    if (id) this.t.scene(id === 'match' && m ? `Match · ${STAGES[m.state.stage].name}` : SCREEN_NAMES[id]);
    // A match that is meant to be running but whose clock has stopped.
    const now = performance.now();
    if (m && this.game.phase() === 'play' && !m.state.over) {
      if (m.state.frame !== this.lastFrame) {
        this.lastFrame = m.state.frame;
        this.lastFrameAt = now;
      } else if (now - this.lastFrameAt > 5000 && !document.hidden) {
        this.t.problem('bug', 'the match clock stopped for 5 s while playing');
      }
    } else {
      this.lastFrameAt = now;
    }
    if (m) {
      const me = m.state.fighters[m.player];
      if (me) this.t.note(`${Math.floor(me.percent / 10)}% · ${me.stocks} stock${me.stocks === 1 ? '' : 's'} · ${Math.round(m.state.frame / 60)} s`);
    }
  }

  /** Overridden per scenario so progress moves during matches. */
  progressNow: () => number = () => 0;

  // ---------------------------------------------------------- asset checks

  private async checkSounds(): Promise<void> {
    const noFile = SOUNDS.filter((s) => !s.file).map((s) => s.id);
    if (noFile.length) this.t.problem('polish', `sounds not generated yet: ${noFile.join(', ')}`);
    const missing: string[] = [];
    await Promise.all(SOUNDS.filter((s) => s.file).map(async (s) => { if (!(await exists(s.file!))) missing.push(s.file!); }));
    if (missing.length) this.t.problem('bug', `sound files missing (404): ${missing.join(', ')}`);
  }

  private async checkFighter(id: string): Promise<void> {
    if (this.checked.has(id)) return;
    this.checked.add(id);
    const c = CHARACTERS.find((x) => x.id === id)!;
    for (const url of [`/characters/large/${id}.webp`, `/characters/thumb/${id}.webp`]) {
      if (!(await exists(url))) this.t.problem('bug', `${c.name}: missing image ${url}`);
    }
    const set = await loadAnimSet(id);
    if (!set) {
      this.t.problem('warning', `${c.name}: no animation clips (shows the still image only)`);
    } else {
      const want = [...CORE_CLIPS, ...MOVE_KEYS];
      const missing = want.filter((k) => !set.clips[k]);
      if (missing.length) this.t.problem('polish', `${c.name}: missing animation clips (stand-ins used): ${missing.join(', ')}`);
      const broken: string[] = [];
      await Promise.all(Object.entries(set.clips).map(async ([k, clip]) => { if (!(await exists(`${set.base}${clip.file}`))) broken.push(k); }));
      if (broken.length) this.t.problem('bug', `${c.name}: clip sheets missing (404): ${broken.join(', ')}`);
    }
    const lines = [`announcer.name.${id}`, `fighter.${id}.ko`, `fighter.${id}.win`];
    const silent: string[] = [];
    for (const lineId of lines) {
      const l = VOICE.lines.find((x) => x.id === lineId);
      if (!l?.audio) silent.push(lineId);
      else if (!(await exists(l.audio))) this.t.problem('bug', `${c.name}: voice file missing (404): ${l.audio}`);
    }
    if (silent.length) this.t.problem('polish', `${c.name}: voice lines not recorded: ${silent.join(', ')}`);
  }

  private async checkStage(index: number): Promise<void> {
    const st = STAGES[index];
    if (this.checked.has(`stage:${st.id}`)) return;
    this.checked.add(`stage:${st.id}`);
    const layers = (st.layers ?? []).filter((l) => !l.hidden);
    if (!layers.length) this.t.problem('polish', `${st.name}: no painted art (the theme backdrop stands in)`);
    const unpainted = layers.filter((l) => !l.image).map((l) => l.id);
    if (unpainted.length) this.t.problem('polish', `${st.name}: placeholder art layers not painted yet: ${unpainted.join(', ')}`);
    const missing: string[] = [];
    await Promise.all(layers.filter((l) => l.image).map(async (l) => { if (!(await exists(`/${l.image.replace(/^\//, '')}`))) missing.push(l.image); }));
    if (missing.length) this.t.problem('bug', `${st.name}: stage art missing (404): ${missing.join(', ')}`);
    const music = SOUNDS.find((s) => s.id === `music-${st.id}`);
    if (!music?.file) this.t.problem('polish', `${st.name}: no stage music (music-${st.id})`);
  }

  // ---------------------------------------------------------- menu driving

  private async screen(id: ScreenId, timeoutMs = 20000): Promise<void> {
    await this.t.until(() => currentScreen() === id && !switching(), timeoutMs, `the ${SCREEN_NAMES[id]} screen`);
  }

  /** Clicks a control the way a mouse player would, once it is on screen and enabled. */
  private async click(find: () => HTMLElement | null | undefined, what: string, timeoutMs = 15000): Promise<void> {
    let el: HTMLElement | null | undefined = null;
    await this.t.until(() => {
      el = find();
      return !!el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled && !switching();
    }, timeoutMs, what);
    this.t.log(`click ${what}`);
    (el as unknown as HTMLElement).focus();
    (el as unknown as HTMLElement).click();
    await this.t.wait(150);
  }

  private q(sel: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(sel);
  }

  private button(scope: string, text: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>(`${scope} button`)].find((b) => b.textContent?.trim() === text);
  }

  private async toMainMenu(): Promise<void> {
    await this.screen('title', 30000);
    await this.click(() => this.q('#btn-start'), 'Press start');
    await this.screen('main');
  }

  /** Main menu → Versus → a 1v1 against one CPU → a stage → the match is live. */
  private async startVersus(stocks: number): Promise<void> {
    await this.click(() => this.q('[data-go="versus"]'), 'Versus');
    await this.screen('select');
    const rule = (label: string) => [...document.querySelectorAll<HTMLElement>('#select-rules .rule')].find((r) => r.querySelector('span')?.textContent === label);
    // Saved choices from an earlier visit: back to a plain 1v1.
    for (let i = 0; i < 4 && document.querySelectorAll('#select-slots .slot:not(.add)').length > 2; i++) {
      await this.click(() => [...document.querySelectorAll<HTMLElement>('#select-slots [aria-label="Remove"]')].pop(), 'remove a CPU');
    }
    for (let i = 0; i < 2 && rule('Teams')?.querySelector('.value')?.textContent === 'On'; i++) await this.click(() => rule('Teams')?.querySelector<HTMLElement>('.value'), 'Teams off');
    for (let i = 0; i < 4 && rule('Time')?.querySelector('.value')?.textContent !== 'Off'; i++) await this.click(() => rule('Time')?.querySelector<HTMLElement>('.value'), 'Time');
    for (let i = 0; i < 10; i++) {
      const have = Number(rule('Stocks')?.querySelector('b')?.textContent);
      if (have === stocks) break;
      const label = have > stocks ? 'Fewer stocks' : 'More stocks';
      await this.click(() => rule('Stocks')?.querySelector<HTMLElement>(`[aria-label="${label}"]`), label);
    }
    // Fighters from the seed, so a run is repeatable.
    const n = CHARACTERS.length;
    const meIdx = Math.abs(this.options.seed * 11) % n;
    const foeIdx = (meIdx + 1 + (Math.abs(this.options.seed * 17) % (n - 1))) % n;
    await this.click(() => this.q('#select-slots .slot-pick'), 'your slot');
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[meIdx], CHARACTERS[meIdx].name);
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[foeIdx], `CPU: ${CHARACTERS[foeIdx].name}`);
    await this.click(() => this.q('#select-slots .fight'), 'Fight');
    await this.screen('stages');
    const cards = () => document.querySelectorAll<HTMLElement>('#stage-grid .stage-card:not(.random)');
    await this.t.until(() => cards().length > 0, 5000, 'stage cards');
    const pick = Math.abs(this.options.seed - 1) % cards().length;
    await this.click(() => cards()[pick], `stage ${pick + 1}`);
    await this.matchLive();
  }

  /** Waits through the VS splash and loading until "Go!". */
  private async matchLive(): Promise<void> {
    await this.screen('match', 60000);
    await this.t.until(() => this.game.phase() === 'play', 10000, 'the match to start');
  }

  /** Lets the bot fight until the match ends, or until `stopAt` says so. Returns 'over' or 'stopped'. */
  private async fight(stopAt: () => boolean, timeoutMs: number): Promise<'over' | 'stopped'> {
    let result: 'over' | 'stopped' = 'over';
    await this.t.until(() => {
      const m = this.game.match();
      if (m?.state.over || currentScreen() === 'results') return true;
      if (stopAt()) {
        result = 'stopped';
        return true;
      }
      return false;
    }, timeoutMs, 'the match to end');
    return result;
  }

  /** Esc to pause, then Quit. */
  private async quitFromPause(to: ScreenId): Promise<void> {
    await tapKey('Escape');
    await this.click(() => this.q('#btn-quit'), 'Quit');
    await this.screen(to);
  }

  private async results(): Promise<boolean> {
    const m = this.game.match() ?? this.seen;
    const won = m?.playerWon() ?? false;
    await this.screen('results', 30000);
    return won;
  }

  private async playDialogue(): Promise<void> {
    await this.screen('dialogue');
    const t0 = performance.now();
    // Next finishes the typing, the next Next moves on: read each line for a moment like a player.
    while (currentScreen() === 'dialogue' && performance.now() - t0 < 120000) {
      if (!switching()) this.q('#dlg-next')?.click();
      await this.t.wait(700);
    }
    if (currentScreen() === 'dialogue') throw new Error('timed out waiting for the dialogue to end');
  }

  // ---------------------------------------------------------- scenarios

  async smoke(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    t.progress(0.15);
    await this.startVersus(3);
    t.progress(0.4);
    const start = () => this.game.match()?.state.frame ?? 0;
    this.progressNow = () => 0.4 + 0.5 * Math.min(1, start() / 1200);
    const ended = await this.fight(() => start() >= 20 * 60, 60000);
    this.progressNow = () => 0.9;
    if (ended === 'stopped') await this.quitFromPause('main');
    else {
      await this.results();
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
    }
    t.progress(1);
    t.finish('done');
  }

  async match(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    t.progress(0.05);
    await this.startVersus(2);
    t.progress(0.1);
    this.progressNow = () => {
      const m = this.game.match();
      if (!m) return 0.95;
      const s = m.state;
      const stocks = m.setup.stocks;
      // A 1v1 is over once one side has lost every stock: about half of all stocks.
      const lost = s.fighters.reduce((n, f) => n + (stocks - Math.max(0, f.stocks)), 0);
      return 0.1 + 0.85 * Math.min(1, lost / Math.max(1, (s.fighters.length * stocks) / 2));
    };
    await this.fight(() => false, 6 * 60 * 1000);
    const won = await this.results();
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish(won ? 'won' : 'lost');
  }

  async campaign(): Promise<void> {
    const t = this.t;
    const t0 = performance.now();
    const late = () => performance.now() - t0 > CAMPAIGN_BUDGET_MS;
    await this.toMainMenu();
    await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
    await this.screen('campaign');
    let cleared = 0;
    let outcome: Outcome = 'won';
    t.metric('chaptersCleared', 0);
    chapters: for (let i = 0; i < CHAPTERS.length; i++) {
      const c = CHAPTERS[i];
      const label = `Chapter ${i + 1} · ${c.title}`;
      this.progressNow = () => (i + 0.5) / CHAPTERS.length;
      t.event('chapter', label);
      t.metric('chapter', i + 1);
      await this.click(() => document.querySelectorAll<HTMLElement>('#chapter-path .chapter')[i], label);
      await this.playDialogue();
      await this.matchLive();
      for (let attempt = 1; ; attempt++) {
        const ended = await this.fight(late, 8 * 60 * 1000);
        if (ended === 'stopped') {
          t.note(`out of time in ${label}`);
          t.log(`stopped at the 10-minute budget in ${label}`);
          await this.quitFromPause('campaign');
          outcome = 'done';
          break chapters;
        }
        const won = await this.results();
        if (won) {
          await this.click(() => this.button('#results-actions', 'Continue'), 'Continue');
          await this.playDialogue();
          await this.screen('campaign');
          cleared++;
          t.metric('chaptersCleared', cleared);
          t.event('chapter-cleared', label);
          break;
        }
        if (attempt >= 2 || late()) {
          t.event('chapter-failed', `${label} (${attempt} tries)`);
          await this.click(() => this.button('#results-actions', 'Campaign map'), 'Campaign map');
          await this.screen('campaign');
          outcome = 'lost';
          break chapters;
        }
        t.add('retries');
        await this.click(() => this.button('#results-actions', 'Retry'), 'Retry');
        await this.matchLive();
      }
      t.progress((i + 1) / CHAPTERS.length);
    }
    t.progress(1);
    t.finish(outcome);
  }

  async roster(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    const stage = stagesFor('training')[0]?.index ?? 0;
    for (let i = 0; i < CHARACTERS.length; i++) {
      const c = CHARACTERS[i];
      this.progressNow = () => i / CHARACTERS.length;
      t.progress(i / CHARACTERS.length);
      t.event('fighter', c.name);
      // Setup shortcut: straight into training, no menus.
      void this.game.startMatch({
        mode: 'training', stage, stocks: 1, rules: {},
        slots: [{ char: i, cpu: null }, { char: (i + 1) % CHARACTERS.length, cpu: 0 }],
      });
      await this.matchLive();
      await this.checkFighter(c.id);
      await this.everyMove(c.name);
      this.manual = null;
      await this.game.quitMatch();
      await this.screen('main');
      t.add('fightersTested');
    }
    t.progress(1);
    t.finish('done');
  }

  /** Each of the fighter's moves once, from its input, like a player would press it. */
  private async everyMove(who: string): Promise<void> {
    const me = () => {
      const m = this.game.match();
      return m ? m.state.fighters[m.player] : null;
    };
    const frame = () => this.game.match()?.state.frame ?? 0;
    const hold = async (input: number, frames: number) => {
      this.manual = input;
      const end = frame() + frames;
      await this.t.until(() => frame() >= end, 5000 + frames * 50, 'frames to pass');
    };
    const settle = async () => {
      this.manual = NO_INPUT;
      try {
        await this.t.until(() => {
          const f = me();
          return !!f && f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
        }, 8000, 'the fighter to stand');
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
        this.t.problem('warning', `${who}: never got back on their feet in training (stage ${STAGES[this.game.match()?.state.stage ?? 0].name})`);
      }
      await hold(NO_INPUT, 4);
    };
    const side = () => ((me()?.facing ?? 1) > 0 ? 100 : -100);
    const ground: [number, () => number][] = [
      [MOVE.JAB, () => packInput(0, 0, BTN.ATTACK)],
      [MOVE.FTILT, () => packInput(side(), 0, BTN.ATTACK)],
      [MOVE.UTILT, () => packInput(0, 100, BTN.ATTACK)],
      [MOVE.DTILT, () => packInput(0, -100, BTN.ATTACK)],
      [MOVE.FSMASH, () => packInput(0, 0, side() > 0 ? BTN.C_RIGHT : BTN.C_LEFT)],
      [MOVE.USMASH, () => packInput(0, 0, BTN.C_UP)],
      [MOVE.DSMASH, () => packInput(0, 0, BTN.C_DOWN)],
      [MOVE.NSPECIAL, () => packInput(0, 0, BTN.SPECIAL)],
      [MOVE.UPB, () => packInput(0, 100, BTN.SPECIAL)],
    ];
    const air: [number, () => number][] = [
      [MOVE.NAIR, () => packInput(0, 0, BTN.ATTACK)],
      [MOVE.FAIR, () => packInput(side(), 0, BTN.ATTACK)],
      [MOVE.BAIR, () => packInput(-side(), 0, BTN.ATTACK)],
      [MOVE.UAIR, () => packInput(0, 100, BTN.ATTACK)],
      [MOVE.DAIR, () => packInput(0, -100, BTN.ATTACK)],
    ];
    const failed: string[] = [];
    for (const [move, input] of ground) {
      await settle();
      this.movesSeen.delete(move);
      await hold(input(), 2);
      await hold(NO_INPUT, 3);
      if (!this.movesSeen.has(move)) failed.push(MOVE_NAMES[move]);
    }
    for (const [move, input] of air) {
      await settle();
      this.movesSeen.delete(move);
      // A full hop, then the aerial near the top.
      await hold(packInput(0, 0, BTN.JUMP), 6);
      await hold(NO_INPUT, 8);
      await hold(input(), 2);
      await hold(NO_INPUT, 3);
      if (!this.movesSeen.has(move)) failed.push(MOVE_NAMES[move]);
    }
    await settle();
    if (failed.length) this.t.problem('bug', `${who}: these moves didn't come out from their inputs: ${failed.join(', ')}`);
    this.t.add('movesTested', ground.length + air.length - failed.length);
  }
}

// ---------------------------------------------------------------- helpers

function name(m: Match, slot: number): string {
  return CHARACTERS[m.state.fighters[slot].char].name;
}

const existCache = new Map<string, Promise<boolean>>();
function exists(url: string): Promise<boolean> {
  let p = existCache.get(url);
  if (!p) {
    p = fetch(url, { method: 'HEAD', cache: 'no-store' })
      .then((r) => r.ok && !(r.headers.get('content-type') ?? '').includes('text/html'))
      .catch(() => false);
    existCache.set(url, p);
  }
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real key press on the window, as the browser would deliver it. */
async function tapKey(code: string): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  await sleep(120);
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  await sleep(120);
}

/** The contract's optional input(action, down): the game's keyboard controls by name. */
const ACTION_KEYS: Record<string, string> = {
  left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', jump: 'Space', attack: 'KeyJ',
  special: 'KeyK', shield: 'KeyL', smash: 'KeyI', pause: 'Escape', confirm: 'Enter', back: 'Backspace',
};
function pressAction(action: string, down: boolean): void {
  const code = ACTION_KEYS[action] ?? action;
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
}
