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
import { SOUNDS, VOICE, audio } from '../audio.ts';
import { SOUND_KEY, soundSettings } from '../soundSettings.ts';
import { loadAnimSet } from '../render/anims.ts';
import type { Match, MatchSetup } from '../match.ts';
import type { SimEvent } from '../sim/step.ts';
import { PLAYTEST_PEER, TEST_LOBBY, onlineParts } from '../net/online.ts';

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
  { id: 'smoke', title: 'Boot, menus, a quick versus match for 20 s, quit to the menu', description: 'options: stage, fighter (ids) to play specific content', seconds: 50, tags: ['smoke'] },
  { id: 'match', title: 'A full 1v1 versus match against the CPU (2 stocks), to the results screen', description: 'options: stage, fighter (ids) to play specific content', seconds: 150, tags: ['full'] },
  { id: 'campaign', title: 'The campaign from chapter 1, as far as the bot gets in 10 minutes', seconds: 600, tags: ['full'] },
  { id: 'sound-settings', title: 'Tap to play, sound on, Settings from the menu and Pause, a setting kept across a reload', description: 'Taps the Tap to play prompt with a pointer press on the spot (hit-tested, so a covered prompt fails), checks the AudioContext runs and the menu music plays with no more taps, opens Settings from the main menu, turns Sound off and Music to 40%, reloads (the run carries on through ?playtest=sound-settings), checks the prompt and the choice are back, then opens Settings from Pause in a match. The player\'s own hawkes.sound is put back at the end.', seconds: 120, tags: ['smoke', 'sound'] },
  { id: 'site-links', title: 'The website around the game: Powered by HAWKES GEN on every page, Hawkes Biomedical on the landing page, the game screen without them', description: 'Checks the game screen has no site footer marks, then opens the landing page over the game in a full-screen frame and walks the site through its own links (footer Characters, a fighter card picked from the seed, Privacy, What\'s new), checking on each page that "Powered by HAWKES GEN" links to https://hawkesgen.com (shown, not covered) and on the landing page that Hawkes Biomedical links to https://hawkesbiomedical.com. Every fighter page is also read and checked. The frame is removed at the end and the game checked again.', seconds: 60, tags: ['smoke', 'site'] },
  { id: 'online', title: 'Two players online (peers: 2): the lobby with no clicks, a profile change seen by the other, Find match, CPU while searching, Match found, the online fight to its end, results', description: 'Needs Hawkes Gen playtest.run with peers: 2 (the two tabs share ?room=<id>, a private test lobby, and get ?peer=0/1). Both land in the lobby and see "2 online"; peer 1 renames itself in Profile and peer 0 sees the new name; peer 0 presses Find match and plays a CPU versus match while it searches; peer 1 presses Find match 30 s later; both see "Match found vs <name> · Starting in N", fight each other (the CPU bot on each pad; test lobbies play 1 stock, 90 s) with the names on the HUD, and see the result with Queue again.', seconds: 330, tags: ['full', 'online'] },
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
  campaign: 'Campaign Map', dialogue: 'Dialogue', howto: 'How To Play', results: 'Results', match: 'Match',
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
        else if (id === 'sound-settings') await r.soundSettings();
        else if (id === 'site-links') await r.siteLinks();
        else if (id === 'online') await r.online();
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
    if (promptShowing()) this.t.scene('Tap to play');
    else if (settingsShowing()) this.t.scene(m ? 'Settings (paused)' : 'Settings');
    else if (id) this.t.scene(id === 'match' && m ? `Match · ${STAGES[m.state.stage].name}` : SCREEN_NAMES[id]);
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

  /**
   * A tap on a control the way a finger or mouse does it: pointer down and up at its centre, then the click.
   * The press is hit-tested, so a control covered by something else is reported.
   */
  private async tap(find: () => HTMLElement | null | undefined, what: string, timeoutMs = 15000): Promise<void> {
    let el: HTMLElement | null | undefined = null;
    await this.t.until(() => {
      el = find();
      return !!el && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled && !switching();
    }, timeoutMs, what);
    const r = (el as unknown as HTMLElement).getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? (el as unknown as HTMLElement);
    if (!(el as unknown as HTMLElement).contains(target)) this.t.problem('bug', `${what} is covered: a press on it lands on ${target.id ? `#${target.id}` : target.tagName.toLowerCase()}`);
    const touch = matchMedia('(pointer: coarse)').matches;
    const init = { pointerType: touch ? 'touch' : 'mouse', pointerId: touch ? 51 : 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    this.t.log(`tap ${what}`);
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    await this.t.wait(60);
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 }));
    this.t.add('interactions');
    await this.t.wait(150);
  }

  /** The studio's Tap to play prompt, tapped like a player. */
  private async tapToPlay(): Promise<void> {
    await this.tap(() => this.q('#tap-to-play'), 'Tap to play');
    await this.t.until(() => !promptShowing() && this.q('#tap-to-play')?.hidden, 5000, 'the Tap to play prompt to go');
    this.t.event('tap-to-play', 'prompt tapped');
  }

  private async toMainMenu(): Promise<void> {
    await this.screen('title', 30000);
    if (promptShowing()) await this.tapToPlay();
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
    // Fighters from the seed, so a run is repeatable (options.fighter plays that one).
    const n = CHARACTERS.length;
    const asked = typeof this.options.fighter === 'string' ? CHARACTERS.findIndex((c) => c.id === this.options.fighter) : -1;
    if (typeof this.options.fighter === 'string' && asked < 0) this.t.problem('bug', `fighter "${this.options.fighter}" is not in the roster`);
    const meIdx = asked >= 0 ? asked : Math.abs(this.options.seed * 11) % n;
    const foeIdx = (meIdx + 1 + (Math.abs(this.options.seed * 17) % (n - 1))) % n;
    await this.click(() => this.q('#select-slots .slot-pick'), 'your slot');
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[meIdx], CHARACTERS[meIdx].name);
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[foeIdx], `CPU: ${CHARACTERS[foeIdx].name}`);
    await this.click(() => this.q('#select-slots .fight'), 'Fight');
    await this.screen('stages');
    const cards = () => document.querySelectorAll<HTMLElement>('#stage-grid .stage-card:not(.random)');
    await this.t.until(() => cards().length > 0, 5000, 'stage cards');
    // options.stage plays that stage (a content playtest of a new one); else one from the seed.
    const want = typeof this.options.stage === 'string' ? this.options.stage : null;
    const byId = want ? [...cards()].findIndex((c) => c.dataset.stage === want) : -1;
    if (want && byId < 0) this.t.problem('bug', `stage "${want}" is not offered in Versus (content/modes.json)`);
    const pick = byId >= 0 ? byId : Math.abs(this.options.seed - 1) % cards().length;
    await this.click(() => cards()[pick], `stage ${want && byId >= 0 ? want : pick + 1}`);
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

  // ---------------------------------------------------------- online

  /** Two tabs (peers: 2) in one private test lobby: see each other, rename, queue, get matched, fight, results. */
  async online(): Promise<void> {
    const t = this.t;
    const peer = Math.max(0, PLAYTEST_PEER);
    const parts = onlineParts();
    if (!parts) {
      t.problem('bug', 'online play did not start on this page (see the console)');
      t.finish('error');
      return;
    }
    if (!TEST_LOBBY) {
      // Never pair a playtest bot with real players in the global lobby.
      t.problem('warning', 'the online scenario needs ?room=<id> (Hawkes Gen playtest.run with peers: 2); without it there is nobody to meet');
      t.finish('done');
      return;
    }
    const { lobby, mm } = parts;
    t.log(`peer ${peer} in lobby ${lobby.lobby} as ${lobby.me.name} (${lobby.id})`);
    await this.toMainMenu();
    t.progress(0.05);

    // 1. The lobby, with no clicks: the other tab shows up.
    await t.until(() => lobby.count() >= 2, 90000, 'the other player in the lobby ("2 online")');
    const countText = this.q('#lobby-count')?.textContent ?? '';
    if (!/\b2 online\b/.test(countText)) t.problem('bug', `the lobby count says "${countText}" with two players in the lobby`);
    t.event('lobby', `${countText}: ${lobby.players().map((p) => p.name).join(', ')}`);
    t.metric('online', lobby.count());
    t.progress(0.1);

    // 2. Profile: peer 1 renames itself and picks a picture; peer 0 sees both on its menu.
    const NEW_NAME = 'Tester Two';
    const avatar = CHARACTERS[Math.abs(this.options.seed * 13 + 5) % CHARACTERS.length].id;
    if (peer === 1) {
      await this.click(() => this.q('#btn-profile'), 'Profile');
      const input = this.q('#profile-name') as HTMLInputElement;
      input.focus();
      input.value = NEW_NAME;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await this.click(() => this.q(`#profile-grid [data-avatar="${avatar}"]`), `picture ${avatar}`);
      await this.click(() => this.q('#profile-save'), 'Save');
      t.event('profile', `renamed to ${NEW_NAME}, picture ${avatar}`);
    } else {
      const seen = () => [...document.querySelectorAll<HTMLElement>('#lobby-list .lobby-player')].find((li) => li.textContent?.includes(NEW_NAME));
      await t.until(() => !!seen(), 60000, `the other player's new name "${NEW_NAME}" on the menu`);
      const img = seen()!.querySelector('img');
      if (!img?.getAttribute('src')?.includes(avatar)) t.problem('bug', `the other player's new picture (${avatar}) isn't shown with their name`);
      t.event('profile-seen', `the menu shows ${NEW_NAME} with ${avatar}`);
    }
    t.progress(0.2);

    // 3. Find match. Peer 0 then plays a CPU match while it searches; peer 1 joins the queue 30 s later.
    if (peer === 1) {
      const other = () => lobby.players().find((p) => !p.self);
      await t.until(() => other()?.status === 'queued', 60000, 'the other player to start searching');
      await t.wait(30000);
    }
    await this.click(() => this.q('#btn-find'), 'Find match');
    await t.until(() => mm.state !== 'idle', 5000, 'the search to start');
    t.event('queued', 'searching for an opponent');
    if (peer === 0) {
      await t.until(() => !this.q('#mm-chip')?.hidden && /Searching for opponent/.test(this.q('#mm-chip')?.textContent ?? ''), 5000, 'the "Searching for opponent…" chip');
      try {
        await this.startVersus(3);
      } catch (e) {
        // The match was found before the CPU match got going: that's fine, the online one takes over.
        if (mm.state === 'idle') throw e;
        t.log(`the match was found while setting up the CPU match (${e instanceof Error ? e.message : e})`);
      }
      const chip = this.q('#mm-chip');
      if (mm.state === 'searching' && (chip?.hidden || chip?.getClientRects().length === 0)) t.problem('bug', 'the searching chip is not shown during the CPU match');
      else if (mm.state === 'searching') t.event('cpu-while-searching', `CPU match live, chip: ${chip?.textContent?.trim()}`);
    }
    t.progress(0.3);

    // 4. Match found: the banner and its countdown, over whatever is on.
    const banner = () => this.q('#mm-found');
    await t.until(() => (banner() && !banner()!.hidden) || this.game.match()?.setup.mode === 'online', 150000, 'Match found');
    const text = banner()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!/Match found/.test(text) || !/vs /.test(text) || !/Starting in \d/.test(text)) t.problem('bug', `the match-found banner says "${text}"`);
    t.event('match-found', text);
    t.progress(0.4);

    // 5. The online fight: names on the VS screen and the HUD, the bot on the pad.
    await t.until(() => this.game.match()?.setup.mode === 'online' && currentScreen() === 'match' && this.game.phase() === 'play', 90000, 'the online match to start');
    const m = this.game.match()!;
    const names = m.setup.online!.names;
    const opp = names[1 - m.player];
    const hud = this.q('#hud')?.textContent ?? '';
    if (!hud.includes(opp)) t.problem('bug', `the opponent's name (${opp}) isn't on the fight HUD`);
    t.event('online-start', `${names[0]} vs ${names[1]} on ${STAGES[m.state.stage].name}, this tab is slot ${m.player}`);
    this.progressNow = () => 0.45 + 0.45 * Math.min(1, (this.game.match()?.state.frame ?? 0) / Math.max(1, m.state.rules.timeLimit || 5400));
    await t.until(() => currentScreen() === 'results', 5 * 60 * 1000, 'the online match to end');
    this.progressNow = () => 0.95;

    // 6. Results, with Queue again.
    const headline = this.q('#results-body h2')?.textContent ?? '';
    t.event('online-result', `${headline}${this.q('.results-note') ? ` (${this.q('.results-note')!.textContent})` : ''}`);
    if (!this.button('#results-actions', 'Queue again')) t.problem('bug', 'no Queue again on the online results');
    if (/void|lost/i.test(headline)) t.problem('bug', `the online match ended "${headline}": ${this.q('.results-note')?.textContent ?? ''}`);
    const won = /^You win/.test(headline);
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish(won ? 'won' : 'lost');
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

  // ---------------------------------------------------------- sound-settings

  /** The studio standard: the Tap to play prompt, sound running, Settings from the menu and Pause, kept across a reload. */
  async soundSettings(): Promise<void> {
    const t = this.t;
    const carried = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(SOUND_RUN_KEY) ?? 'null') as { original: string | null; saved: string } | null;
      } catch {
        return null;
      }
    })();
    const saved = () => {
      try {
        return JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null') as { on: boolean; music: number; sfx: number } | null;
      } catch {
        return null;
      }
    };
    const checkPrompt = (where: string) => {
      const prompt = this.q('#tap-to-play');
      if (!prompt || !promptShowing()) {
        t.problem('bug', `no Tap to play prompt ${where}`);
        return;
      }
      const r = prompt.getBoundingClientRect();
      if (r.width < innerWidth - 1 || r.height < innerHeight - 1) t.problem('bug', `the Tap to play prompt does not fill the screen ${where} (${Math.round(r.width)}x${Math.round(r.height)} of ${innerWidth}x${innerHeight})`);
      t.event('prompt-shown', `${where}, ${innerWidth}x${innerHeight} ${innerWidth > innerHeight ? 'landscape' : 'portrait'}`);
    };
    const checkSound = async (where: string) => {
      try {
        await t.until(() => audio.state === 'running', 5000, 'the AudioContext to run');
        t.event('audio-running', `AudioContext ${audio.state} ${where}`);
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
        t.problem('bug', `the AudioContext is "${audio.state}" ${where}`);
      }
    };
    const checkMusic = async (where: string) => {
      // The menu loop starts by itself once sound is on: no more taps.
      if (!SOUNDS.find((s) => s.id === 'music-menu')?.file) return;
      try {
        await t.until(() => audio.musicPlaying === 'music-menu', 15000, 'the menu music');
        t.event('music-playing', `music-menu ${where}, with no more taps`);
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
        t.problem('bug', `the menu music did not start ${where}`);
      }
    };
    const slide = (id: string, percent: number, label: string) => {
      // A range input has no drag a page can fake; set it as a drag ends and send the same events.
      const input = this.q(id) as HTMLInputElement;
      input.value = String(percent);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      t.add('interactions');
      t.log(`slide ${label} to ${percent}%`);
    };
    const openFromMenu = async (where: string) => {
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, `Settings to open from the main menu ${where}`);
      t.event('settings-open', `from the main menu ${where}`);
    };

    await this.screen('title', 30000);
    if (!carried) {
      checkPrompt('on load');
      await t.wait(1200);
      await this.tapToPlay();
      await checkSound('after the tap');
      await checkMusic('after the tap');
      t.progress(0.15);

      await this.tap(() => this.q('#btn-start'), 'Press start');
      await this.screen('main');
      await openFromMenu('');
      const original = localStorage.getItem(SOUND_KEY);
      if (!soundSettings().on) await this.tap(() => this.q('#sound-switch'), 'Sound on');
      await t.wait(500);
      await this.tap(() => this.q('#sound-switch'), 'Sound off');
      slide('#vol-music', 40, 'Music');
      await t.wait(800);
      const now = saved();
      if (!now || now.on !== false || Math.abs(now.music - 0.4) > 0.001) t.problem('bug', `hawkes.sound did not save Sound off and Music 40%: ${JSON.stringify(now)}`);
      else t.event('setting-saved', JSON.stringify(now));
      if (soundSettings().on !== false) t.problem('bug', 'Sound off did not apply right away');
      t.progress(0.35);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(400);

      sessionStorage.setItem(SOUND_RUN_KEY, JSON.stringify({ original, saved: JSON.stringify(now) }));
      t.event('reload', 'the page reloads; the run carries on after it');
      const url = new URL(location.href);
      url.searchParams.set('playtest', 'sound-settings');
      url.searchParams.set('seed', String(this.options.seed ?? 1));
      url.searchParams.set('speed', String(this.options.speed ?? 1));
      await t.wait(300);
      location.replace(url.toString());
      await new Promise(() => {}); // the page is going away
      return;
    }

    sessionStorage.removeItem(SOUND_RUN_KEY);
    t.event('before-reload:setting-saved', carried.saved);
    checkPrompt('after the reload');
    await t.wait(1000);
    await this.tapToPlay();
    await checkSound('after the reload');
    t.progress(0.5);
    const back = soundSettings();
    if (back.on !== false || Math.abs(back.music - 0.4) > 0.001) t.problem('bug', `the setting did not survive the reload: ${JSON.stringify(back)}`);
    else t.event('setting-survived-reload', JSON.stringify(back));

    await this.tap(() => this.q('#btn-start'), 'Press start');
    await this.screen('main');
    await openFromMenu('after the reload');
    const shows = `${this.q('#sound-switch')?.textContent} / Music ${(this.q('#vol-music') as HTMLInputElement).value}%`;
    if (shows !== 'Off / Music 40%') t.problem('bug', `Settings shows "${shows}" after the reload, not Off / Music 40%`);
    else t.event('settings-shows-saved', shows);
    await t.wait(1200);
    // Sound back on for the match, at the level the run found.
    await this.tap(() => this.q('#sound-switch'), 'Sound on');
    slide('#vol-music', 60, 'Music');
    await checkMusic('with Sound back on');
    await this.tap(() => this.q('#settings-done'), 'Done');
    t.progress(0.65);

    await this.startVersus(3);
    await t.wait(2000);
    await tapKey('Escape');
    await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
    await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
    await t.until(settingsShowing, 3000, 'Settings to open from Pause');
    t.event('settings-open', 'from Pause in a match');
    await t.wait(800);
    slide('#vol-sfx', 70, 'Effects');
    const fx = saved();
    if (!fx || Math.abs(fx.sfx - 0.7) > 0.001) t.problem('bug', `Effects 70% from Pause was not saved: ${JSON.stringify(fx)}`);
    else t.event('setting-saved', `from Pause: ${JSON.stringify(fx)}`);
    await t.wait(800);
    await this.tap(() => this.q('#settings-done'), 'Done');
    await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
    t.progress(0.9);
    await this.click(() => this.q('#btn-quit'), 'Quit');
    await this.screen('main');

    // The player's own settings back as they were.
    try {
      if (carried.original === null) localStorage.removeItem(SOUND_KEY);
      else localStorage.setItem(SOUND_KEY, carried.original);
    } catch {
      // Storage blocked.
    }
    t.progress(1);
    t.finish('done');
  }

  // -------------------------------------------------------------- site-links

  /** The site pages carry the Hawkes Gen mark (and the landing page Hawkes Biomedical); the game screen doesn't. */
  async siteLinks(): Promise<void> {
    const t = this.t;
    const gameUnchanged = (where: string) => {
      const marks = document.querySelectorAll(`a[href^="${HAWKES_GEN}"], a[href^="${HAWKES_BIOMEDICAL}"], .footer-credit, .site-footer`);
      if (marks.length) t.problem('bug', `the game screen shows site footer marks ${where} (${marks.length})`);
      else t.event('game-unchanged', `no Hawkes Gen or Hawkes Biomedical mark on the game screen ${where} (${SCREEN_NAMES[currentScreen() ?? 'title']})`);
    };

    await this.screen('title', 30000);
    gameUnchanged('on the title screen');
    await this.toMainMenu();
    gameUnchanged('on the main menu');
    t.progress(0.1);

    // The site opens over the game in a full-screen frame, so the video shows it and the run carries on here.
    const frame = document.createElement('iframe');
    frame.title = 'Dose of Destruction website (playtest)';
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#0c0a09;z-index:2147483647';
    frame.src = '/';
    document.body.appendChild(frame);
    const doc = () => frame.contentDocument;
    const loaded = async (path: string, what: string) => {
      await t.until(() => {
        const d = doc();
        return !!d && d.readyState === 'complete' && frame.contentWindow?.location.pathname === path;
      }, 15000, what);
      t.event('page', path);
      await t.wait(800);
    };
    const footerLink = (text: string) => [...(doc()?.querySelectorAll<HTMLElement>('.footer-links a') ?? [])].find((a) => a.textContent?.trim() === text);
    /** A press on a link in the page, hit-tested there like a finger or a mouse. */
    const press = async (el: HTMLElement | null | undefined, what: string) => {
      if (!el) {
        t.problem('bug', `no ${what} link on ${frame.contentWindow?.location.pathname}`);
        throw new Error(`no ${what} link`);
      }
      el.scrollIntoView({ block: 'center' });
      await t.wait(500);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const target = (doc()!.elementFromPoint(x, y) as HTMLElement | null) ?? el;
      if (!el.contains(target)) t.problem('bug', `${what} is covered: a press on it lands on ${target.tagName.toLowerCase()}`);
      const init = { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: x, clientY: y };
      t.log(`press ${what}`);
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      await t.wait(60);
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      t.add('interactions');
    };
    /** A link to an outside site: there, says what it should, shown and not covered. Not followed (the run stays here). */
    const checkLink = async (selector: string, href: string, text: string, label: string) => {
      const d = doc()!;
      const path = frame.contentWindow!.location.pathname;
      const a = d.querySelector<HTMLAnchorElement>(selector);
      if (!a) {
        t.problem('bug', `${path}: no ${label} link`);
        return;
      }
      if (a.href.replace(/\/$/, '') !== href) t.problem('bug', `${path}: ${label} links to ${a.href}, not ${href}`);
      const says = a.textContent?.replace(/\s+/g, ' ').trim();
      if (says !== text) t.problem('bug', `${path}: ${label} reads "${says}", not "${text}"`);
      a.scrollIntoView({ block: 'center' });
      await t.wait(400);
      const r = a.getBoundingClientRect();
      const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (r.width < 1 || r.height < 1 || !hit || !a.contains(hit)) t.problem('bug', `${path}: the ${label} link is hidden or covered`);
      else t.event('link', `${path}: "${says}" → ${a.href}`);
      // Held on screen for the video, outlined for a moment.
      a.style.outline = '2px solid #ffd15a';
      a.style.outlineOffset = '4px';
      await t.wait(1200);
      a.style.outline = '';
      a.style.outlineOffset = '';
    };
    const checkCredit = () => checkLink('.footer-credit a', HAWKES_GEN, 'Powered by HAWKES GEN', 'Powered by HAWKES GEN');

    try {
      await loaded('/', 'the landing page');
      await checkLink('a[data-hawkes-parent]', HAWKES_BIOMEDICAL, 'Hawkes Biomedical', 'Hawkes Biomedical');
      await checkCredit();
      t.progress(0.25);

      await press(footerLink('Characters'), 'Characters (footer)');
      await loaded('/characters.html', 'the characters page');
      await checkCredit();
      t.progress(0.4);

      const cards = [...doc()!.querySelectorAll<HTMLAnchorElement>('a.roster-card')];
      const card = cards[Math.abs(this.options.seed ?? 1) % Math.max(1, cards.length)];
      await press(card, card ? `the ${new URL(card.href).pathname} card` : 'a fighter card');
      await loaded(new URL(card.href).pathname, 'a fighter page');
      await checkCredit();
      t.progress(0.55);

      await press(footerLink('Privacy'), 'Privacy (footer)');
      await loaded('/privacypolicy.html', 'the privacy page');
      await checkCredit();
      await press(footerLink('What\u2019s new'), 'What\u2019s new (footer)');
      await loaded('/whatsnew.html', 'the What\u2019s new page');
      await checkCredit();
      t.progress(0.75);

      // Every fighter page, read rather than visited.
      let ok = 0;
      for (const c of cards) {
        const html = await fetch(c.href, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        const a = new DOMParser().parseFromString(html, 'text/html').querySelector<HTMLAnchorElement>('.footer-credit a');
        if (a && a.getAttribute('href')?.replace(/\/$/, '') === HAWKES_GEN && a.textContent?.replace(/\s+/g, ' ').trim() === 'Powered by HAWKES GEN') ok++;
        else t.problem('bug', `${new URL(c.href).pathname}: no "Powered by HAWKES GEN" link to ${HAWKES_GEN}`);
      }
      t.metric('fighterPagesWithMark', ok);
      t.event('fighter-pages', `${ok} of ${cards.length} fighter pages show Powered by HAWKES GEN`);
      t.progress(0.9);
    } finally {
      frame.remove();
    }

    await t.wait(800);
    if (currentScreen() !== 'main') t.problem('bug', `the game left the main menu while the site was open (${currentScreen()})`);
    gameUnchanged('after the site visit');
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

const HAWKES_GEN = 'https://hawkesgen.com';
const HAWKES_BIOMEDICAL = 'https://hawkesbiomedical.com';

/** Carries the sound-settings run across its reload. */
const SOUND_RUN_KEY = 'hawkes.playtest.sound-settings';

function promptShowing(): boolean {
  const prompt = document.getElementById('tap-to-play');
  return !!prompt && !prompt.hidden && !prompt.classList.contains('gone');
}

function settingsShowing(): boolean {
  return document.getElementById('settings')?.hidden === false;
}

function name(m: Match, slot: number): string {
  return CHARACTERS[m.state.fighters[slot].char].name;
}

const existCache = new Map<string, Promise<boolean>>();
function exists(url: string): Promise<boolean> {
  let p = existCache.get(url);
  if (!p) {
    // A 5xx or a network error is a host hiccup, not a missing file: try once more before saying it's missing.
    const head = () => fetch(url, { method: 'HEAD', cache: 'no-store' });
    p = head()
      .then((r) => (r.status >= 500 ? sleep(500).then(head) : r))
      .catch(() => sleep(500).then(head))
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
