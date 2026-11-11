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
import { readTouch, touchDevice, touchOverlay } from '../input/touch.ts';
import { TOUCH_KEY, forceTouchUi, touchSettings } from '../touchSettings.ts';
import { forceTouchPrompt, lockLandscape, rotateShowing } from '../ui/rotate.ts';
import { currentScreen, switching, type ScreenId } from '../ui/screens.ts';
import { CHARACTERS, MOVE, MOVE_KEYS } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput, stickX, stickY } from '../sim/input.ts';
import { STAGES } from '../sim/stage.ts';
import { FX } from '../sim/fixed.ts';
import { ACT, ACT_NAMES } from '../sim/state.ts';
import { AnimTrace } from '../sim/trace.ts';
import { SCENE_CARD_MS, sceneShowing } from '../ui/scene.ts';
import { MAX_WORDS } from '../campaign/sceneText.ts';
import { CHAPTERS, LOCKABLE, SEASONS, isUnlocked, saveUnlocks, unlocks } from '../campaign/story.ts';
import { SCENARIOS } from './scenarios.ts';
import { suppressFirstVisit } from '../campaign/firstVisit.ts';
import { PROMPTS, type TeachStep } from '../ui/teach.ts';
import { stagesFor } from '../modes.ts';
import { SOUNDS, VOICE, audio } from '../audio.ts';
import { SOUND_KEY, soundSettings } from '../soundSettings.ts';
import { GFX_KEY, graphics, setGraphics, isTouchDevice, renderScaleCap } from '../graphics.ts';
import { SHAKE_STORAGE_KEY, screenShake, hitTier, type HitTier } from '../hitFeel.ts';
import { loadAnimSet } from '../render/anims.ts';
import type { Match, MatchSetup } from '../match.ts';
import { BUFFER_FRAMES, COYOTE_FRAMES, type SimEvent } from '../sim/step.ts';
import { onlineReady } from '../net/loader.ts';
import { analyticsDebug } from '../analytics.ts';

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
  /** Setup shortcut (campaign `chapter` only): the cleared chapter ids (localStorage dod-campaign); returns the ones before. */
  setCampaignProgress(ids: string[]): string[];
  /** Renderer particle and warm-up diagnostics. */
  /** What the renderer did for the last hits (hit effect tier, shake applied); reset clears the counters. */
  camFxStats?(reset?: boolean): { cameraJumps: number; framingMisses: number; killCues: number; slowFpsMin: number; killActive: boolean; lastCue: { zoom: boolean; slow: boolean; whistle: boolean; shake: number; punch: number } | null };
  trailStats?(reset?: boolean): { log: { seq: number; victim: number; tier: HitTier; kb: number; kind: 'none' | 'grey' | 'white' | 'streak'; ko: boolean; puffs: number }[]; active: number; puffs: number };
  markerStats?(): { shown: number; frames: number; unclear: number; last: { id: number; size: number; danger: boolean; clear: boolean; rect: { l: number; t: number; r: number; b: number } } | null; events: { id: number; size: number; danger: boolean }[]; rects: { id: number; rect: { l: number; t: number; r: number; b: number }; danger: boolean }[] };
  hitFxStats?(reset?: boolean): { hits: number; last: { tier: HitTier; lag: number; sparks: number; stars: number; ring: boolean; shake: number; flash: number } | null; tiers: Record<HitTier, number>; shakeApplied: number; shakeMax: number; shakeOn: boolean };
  /** The graphics settings in force and what the renderer is doing with them (render scale, glow layer, readout, fps). */
  aliveStats?(): { pieces: string[]; positions: (readonly [string, number, number, number])[]; screen: 'live' | 'loop'; screenRefresh: number; depths: number[] } | null;
  gfxStats?(): { quality: 'high' | 'low'; glow: boolean; showFps: boolean; dpr: number; scale: number; glowOn: boolean; fpsShown: boolean; fpsNow: number };
  fxStats?(): { active: number; dustBehind: number; dustInFront: number; maxCap: number; sparkPool: number; readyLayers: number; totalLayers: number; readyClips: number; totalClips: number };
  /** Layered stage bed: calm/intense, ambience under the theme, intensity stem. */
  musicBedStats?(): {
    stageId: string | null;
    state: 'calm' | 'intense' | null;
    music: string | null;
    ambience: string | null;
    intense: string | null;
    bed: string | null;
    ambienceOn: boolean;
    intenseOn: boolean;
    stung: boolean;
    musicOn: boolean;
  };
}


/** How well the bot playing "you" fights (1-9). */
const BOT_LEVEL = 9;
/** Wall-clock budget for the campaign before it stops cleanly. */
const CAMPAIGN_BUDGET_MS = 9.5 * 60 * 1000;
/** Core clips every fighter should have, besides one per move. */
const CORE_CLIPS = ['idle', 'walk', 'jump', 'fall', 'land', 'hurt', 'shield'];

const SCREEN_NAMES: Record<ScreenId, string> = {
  title: 'Title', main: 'Main Menu', select: 'Character Select', stages: 'Stage Select', versus: 'VS',
  campaign: 'Campaign Map', howto: 'How To Play', results: 'Results', match: 'Match', leaderboard: 'Leaderboard',
};

/** The 13 fighters a new player meets in Season 1; the other 20 are the "newer" fighters (also each with its own four specials). */
const SEASON_ONE = ['exit-punk', 'kaelen', 'break', 'dj-wont-read', 'shutup-bot', 'small-weather', 'blog-man', 'evil-blue-bird', 'got-ur-back', 'slice', 'ss-boulder', 'stratabots', 'orchestrator'];
/** A special's archetype for the kit report; a recovery says which way it moves. */
function kindOf(mv: (typeof CHARACTERS)[number]['moves'][number]): string {
  if (mv.kind !== 'recovery') return mv.kind ?? 'shared';
  return mv.helpless ? (mv.drive?.[0]?.aim ? 'recovery-angled' : 'recovery-straight') : 'recovery-glide';
}

/** A fighter's four specials, in kit order: neutral, side, up, down. */
const SPECIAL_MOVES: number[] = [MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL];
const MOVE_NAMES = Object.fromEntries(Object.entries(MOVE).map(([k, v]) => [v, k.toLowerCase()])) as Record<number, string>;

export function installDodPlaytest(game: GameHooks): void {
  let run: Run | null = null;
  /** The playtest feel sensor's view of the local fighter (hawkes-feel.js, docs/playtest.md#feel). */
  const mine = () => {
    const m = game.match();
    return m && m.player >= 0 ? m.state.fighters[m.player] ?? null : null;
  };
  installPlaytest({
    product: 'doseofdestruction',
    scenarios: SCENARIOS,
    feel: {
      // The local fighter as a point in stage pixels (x right, y up, z 0): what a feel flag's `spot` replays.
      player: () => {
        const f = mine();
        return f ? { x: f.x / FX, y: f.y / FX, z: 0 } : null;
      },
      // Only while the fighter is the player's to move: in the fight, not in a story scene, Ready, Pause, the results,
      // after Game!, or out of the stage between a KO and the respawn.
      active: () => {
        const m = game.match();
        const f = mine();
        return !!m && !!f && game.phase() === 'play' && !m.state.over && f.action !== ACT.DEAD && f.action !== ACT.RESPAWN;
      },
      grounded: () => {
        const f = mine();
        return !!f && f.grounded > 0 && f.platform >= 0;
      },
    },
    isReady: () => currentScreen() !== null && !switching(),
    async start(id, options, t) {
      run?.dispose();
      // Every other scenario clicks through the title and main menu: only first-visit meets the pilot.
      suppressFirstVisit(id !== 'first-visit');
      const r = new Run(game, t, options, t.spot);
      run = r;
      try {
        if (id === 'smoke') await r.smoke();
        else if (id === 'match') await r.match();
        else if (id === 'campaign') await r.campaign();
        else if (id === 'unlocks') await r.unlocksRun();
        else if (id === 'ko-objective') await r.koObjective();
        else if (id === 'quota') await r.quotaObjective();
        else if (id === 'streak') await r.streakObjective();
        else if (id === 'story-cards') await r.storyCards();
        else if (id === 'rotate') await r.rotate();
        else if (id === 'first-visit') await r.firstVisit();
        else if (id === 'presentation') await r.presentation();
        else if (id === 'roster') await r.roster();
        else if (id === 'specials') await r.specialsRun();
        else if (id === 'grab') await r.grabRun();
        else if (id === 'select-specials') await r.selectSpecials();
        else if (id === 'sound-settings') await r.soundSettings();
        else if (id === 'hit-feel') await r.hitFeel();
        else if (id === 'input-feel') await r.inputFeel();
        else if (id === 'touch-match') await r.touchMatch();
        else if (id === 'touch-settings') await r.touchSettingsRun();
        else if (id === 'graphics') await r.graphicsRun();
        else if (id === 'stage-life') await r.stageLife();
        else if (id === 'stage-bed') await r.stageBed();
        else if (id === 'commentary') await r.commentary();
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
  /** Which of the playing fighter's four specials it used this match (the bot drives it in `match`). */
  private readonly specialsUsed = new Set<number>();
  private readonly checked = new Set<string>();
  private disposed = false;

  private readonly game: GameHooks;
  private readonly t: Tracker;
  private readonly options: RunOptions;

  /** A place to replay (a feel flag's spot, in stage pixels): the fighter starts there. Setup shortcut. */
  private readonly spot: { x: number; y: number; yaw?: number } | null;
  private lastPhase = '';

  constructor(game: GameHooks, t: Tracker, options: RunOptions, spot: { x: number; y: number; z: number; yaw?: number } | null = null) {
    this.spot = spot;
    this.game = game;
    this.t = t;
    this.options = options;
    game.setSeed(options.seed);
    game.setSpeed(options.speed);
    setVirtualPad(() => this.read());
    // Every analytics event of the run stays on hawkesAnalytics.debugLog (analytics.ts), so it can be shown going out.
    analyticsDebug();
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

  /** Animation over time (studio rule 5): each match's per-frame state is checked against the motion. */
  private trace = new AnimTrace();
  private traceFrames = 0;

  private onTick(m: Match, events: SimEvent[]): void {
    const s = m.state;
    const me = m.player;
    if (m !== this.seen) this.onMatchStart(m);
    this.traceFrames++;
    for (const p of this.trace.check(s)) {
      this.t.problem('bug', `animation over time on ${STAGES[s.stage].name}: ${p.text}`);
    }
    for (const e of events) {
      // A respawn or a KO moves the fighter and the camera on purpose: the feel sensor rests a moment.
      if ((e.type === 'respawn' && e.id === me) || (e.type === 'ko' && e.victim === me)) this.t.cut();
      if (e.type === 'hit') {
        this.lastHitFrame = s.frame;
        if (e.shield) continue;
        if (e.attacker === me) this.damage('damageDealt', e.dmg);
        if (e.victim === me) this.damage('damageTaken', e.dmg);
      } else if (e.type === 'grab') {
        this.grabSeen(m, e);
      } else if (e.type === 'throw') {
        this.throwSeen(m, e);
      } else if (e.type === 'grab-break') {
        this.t.event('grab-break', `${name(m, e.attacker)} held ${name(m, e.victim)} for ${e.held} frames and ${e.mashed ? 'they mashed free early' : 'the hold ran out'}`);
        this.t.add('grabBreaks');
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
      if (f.action === ACT.ATTACK && f.id === me) {
        this.movesSeen.add(f.move);
        if (SPECIAL_MOVES.includes(f.move)) this.specialsUsed.add(f.move);
      }
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
    const fx = this.game.fxStats?.();
    if (fx) {
      if (fx.dustInFront > 0 && !this.checked.has('dust-front-bug')) {
        this.checked.add('dust-front-bug');
        this.t.problem('bug', `${STAGES[s.stage].name}: ${fx.dustInFront} dust particles rendered in front of fighters`);
      }
      if (fx.active > fx.maxCap && !this.checked.has('fx-cap-bug')) {
        this.checked.add('fx-cap-bug');
        this.t.problem('bug', `${STAGES[s.stage].name}: ${fx.active} active stage particles exceeded cap ${fx.maxCap}`);
      }
      if (fx.dustBehind > 0 && !this.checked.has(`dust-seen:${STAGES[s.stage].id}`)) {
        this.checked.add(`dust-seen:${STAGES[s.stage].id}`);
        this.t.event('dust-effects', `${STAGES[s.stage].name}: ${fx.dustBehind} dust particles active behind fighters (0 in front, cap ${fx.maxCap})`);
      }
    }
    if (!s.over && s.frame - this.lastHitFrame > 30 * 60 && !this.quietWarned && m.setup.mode !== 'training') {
      this.quietWarned = true;
      this.t.problem('warning', `no hits for 30 s in a match on ${STAGES[s.stage].name} (fighters can't reach each other?)`);
    }
    if (m.bufferedActions > 0) {
      this.t.metric('bufferedInputs', m.bufferedActions);
      if (!this.checked.has(`buf:${this.matches}`)) {
        this.checked.add(`buf:${this.matches}`);
        this.t.event('input-buffer', `buffered input came out on first actionable frame (${BUFFER_FRAMES} frames / ${Math.round((BUFFER_FRAMES * 1000) / 60)} ms window)`);
      }
    }
    if (m.coyoteJumps > 0) {
      this.t.metric('coyoteJumps', m.coyoteJumps);
      if (!this.checked.has(`coyote:${this.matches}`)) {
        this.checked.add(`coyote:${this.matches}`);
        this.t.event('coyote-jump', `coyote jump came out after leaving ledge (${COYOTE_FRAMES} frames / ${Math.round((COYOTE_FRAMES * 1000) / 60)} ms window)`);
      }
    }
    if (m.inputLatencies.length > 0) {
      const lat = m.latencyStats();
      this.t.metric('inputLatencyMedianMs', lat.median);
      this.t.metric('inputLatencyWorstMs', lat.worst);
      this.t.metric('inputLatencyMs', lat.median);
      this.t.metric('inputLatencySamples', lat.samples);
      this.t.metric('feel.inputLatencyMs', lat.median);
      this.t.metric('feel.inputLatencyWorstMs', lat.worst);
      this.t.metric('feel.inputSamples', lat.samples);
      if (lat.samples >= 5 && !this.checked.has(`lat:${this.matches}`)) {
        this.checked.add(`lat:${this.matches}`);
        this.t.event('input-latency', `median ${lat.median} ms, worst ${lat.worst} ms across ${lat.samples} inputs (${BUFFER_FRAMES}-frame buffer, ${COYOTE_FRAMES}-frame coyote)`);
      }
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
      const used = [...this.specialsUsed].map((x) => CHARACTERS[m.state.fighters[me].char].moves[x].name);
      this.t.event('specials-used', `${CHARACTERS[m.state.fighters[me].char].name} used ${used.length} different specials this match: ${used.join(', ') || 'none'}`);
      this.t.metric('specialsUsed', used.length);
      this.t.event('anim-trace', `${this.traceFrames} frames traced, ${this.trace.problems.length} state/motion mismatches`);
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
    this.trace = new AnimTrace();
    this.traceFrames = 0;
    this.lastHitFrame = m.state.frame;
    this.quietWarned = false;
    this.overSeen = false;
    this.movesSeen.clear();
    this.specialsUsed.clear();
    this.matches++;
    this.t.add('matches');
    this.t.metric('feel.coyoteMs', Math.round((COYOTE_FRAMES * 1000) / 60));
    this.t.metric('feel.jumpBufferMs', Math.round((BUFFER_FRAMES * 1000) / 60));
    this.t.metric('feel.hitStopMs', Math.round((8 * 1000) / 60));
    this.t.cut(); // a new stage: an intended cut for the feel sensor
    this.placeAtSpot(m);
    const st = STAGES[m.state.stage];
    const who = m.state.fighters.map((f) => name(m, f.id)).join(' vs ');
    this.t.event('match-start', `${who} on ${st.name}`);
    const fx = this.game.fxStats?.();
    if (fx) {
      this.t.event('warmup', `${st.name}: ${fx.readyLayers}/${fx.totalLayers} stage layers, ${fx.readyClips}/${fx.totalClips} fighter clips, ${fx.sparkPool} sparks warmed up`);
      if (fx.sparkPool < 32) this.t.problem('bug', `${st.name}: spark/KO burst pool not warmed up before match start (${fx.sparkPool})`);
    }
    void this.checkTouchControls();
    for (const f of m.state.fighters) void this.checkFighter(CHARACTERS[f.char].id);
    void this.checkStage(m.state.stage);
  }

  /** Spot replay: puts the playing fighter at the flagged place of the first local match, still. */
  private placeAtSpot(m: Match): void {
    const spot = this.spot;
    const f = m.state.fighters[m.player];
    if (!spot || !f || m.setup.mode === 'online' || this.checked.has('spot')) return;
    this.checked.add('spot');
    const b = STAGES[m.state.stage].blast;
    f.x = Math.max(b.left, Math.min(b.right, spot.x)) * FX;
    f.y = Math.max(b.bottom, Math.min(b.top, spot.y)) * FX;
    f.vx = f.vy = f.kbx = f.kby = 0;
    if (spot.yaw !== undefined && Number.isFinite(spot.yaw)) f.facing = spot.yaw >= 0 ? 1 : -1;
    this.t.event('spot', `replaying at ${Math.round(spot.x)}, ${Math.round(spot.y)}`);
  }

  private onPoll(): void {
    const id = currentScreen();
    const m = this.game.match();
    // Ready, Go, Pause and story scenes cut the camera: the feel sensor rests on each change.
    const ph = this.game.phase();
    if (ph !== this.lastPhase) { if (this.lastPhase) this.t.cut(); this.lastPhase = ph; }
    if (promptShowing()) this.t.scene('Tap to play');
    else if (settingsShowing()) this.t.scene(m ? 'Settings (paused)' : 'Settings');
    else if (sceneShowing()) this.t.scene(`Story scene (${this.q('#scene')?.getAttribute('data-scene') ?? ''})`);
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

  /**
   * A round profile picture shows the fighter's face: the square head crop (characters/head/, boxes in
   * content/heads.json), loaded, drawn square with cover. A full-body thumb in a circle shows the torso.
   */
  private async avatarFace(img: HTMLImageElement | null | undefined, where: string): Promise<void> {
    const src = img?.getAttribute('src') ?? '';
    if (!img || !src.includes('/characters/head/')) {
      this.t.problem('bug', `${where}: the profile picture isn't a head crop (${src || 'no image'}), so it shows the body, not the face`);
      return;
    }
    const loaded = await this.t.until(() => img.complete && img.naturalWidth > 0, 10000, `${where} picture to load`).then(() => true, () => false);
    if (!loaded) { this.t.problem('bug', `${where}: the profile picture ${src} didn't load`); return; }
    const box = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    if (img.naturalWidth !== img.naturalHeight || fit !== 'cover' || (box.width && Math.abs(box.width - box.height) > 1)) {
      this.t.problem('bug', `${where}: the face crop is distorted or off-centre (${img.naturalWidth}x${img.naturalHeight} image, ${Math.round(box.width)}x${Math.round(box.height)} box, object-fit ${fit})`);
      return;
    }
    this.t.event('avatar-face', `${where}: ${src}`);
  }

  private async checkFighter(id: string): Promise<void> {
    if (this.checked.has(id)) return;
    this.checked.add(id);
    const c = CHARACTERS.find((x) => x.id === id)!;
    for (const url of [`/characters/large/${id}.webp`, `/characters/thumb/${id}.webp`, `/characters/head/${id}.webp`]) {
      if (!(await exists(url))) this.t.problem('bug', `${c.name}: missing image ${url}`);
    }
    const set = await loadAnimSet(id);
    if (!set) {
      this.t.problem('warning', `${c.name}: no animation clips (shows the still image only)`);
    } else {
      // Side and down special borrow existing clips (nspecial, fsmash, dsmash, upb, roll), so they aren't missing ones.
      const want = [...CORE_CLIPS, ...MOVE_KEYS.filter((k) => k !== 'sspecial' && k !== 'dspecial')];
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
    for (const l of layers) {
      if (/dust|smoke/i.test(l.id)) {
        if (l.z <= 0) this.t.problem('bug', `${st.name}: dust/smoke layer "${l.id}" is in front of fighters (z=${l.z})`);
        if ((l.opacity ?? 1) > 0.4) this.t.problem('bug', `${st.name}: dust/smoke layer "${l.id}" opacity ${l.opacity ?? 1} is too high and washes out the stage`);
        if (l.glow) this.t.problem('bug', `${st.name}: dust/smoke layer "${l.id}" uses additive glow`);
        this.t.event('dust-layer', `${st.name} ${l.id}: z=${l.z} (behind fighters), opacity=${l.opacity ?? 1}`);
      }
    }
  }

  private async checkTouchControls(): Promise<void> {
    if (this.checked.has('touch-controls')) return;
    this.checked.add('touch-controls');
    const root = touchOverlay() ?? this.q('.touch');
    if (!root) {
      this.t.problem('bug', 'touch controls overlay (.touch) was not built');
      return;
    }
    const wasHidden = root.hidden;
    root.hidden = false;
    const btn = root.querySelector<HTMLElement>('.touch-btn');
    const pause = root.querySelector<HTMLElement>('.touch-pause');
    if (!btn || !pause) {
      this.t.problem('bug', 'touch control buttons (.touch-btn, .touch-pause) missing');
      if (wasHidden && !touchDevice()) root.hidden = true;
      return;
    }
    const bs = getComputedStyle(btn);
    const ps = getComputedStyle(pause);
    const fontPx = parseFloat(bs.fontSize);
    const pausePx = parseFloat(ps.fontSize);
    const rgba = bs.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    const alpha = rgba.length >= 4 ? rgba[3] : 1;
    const lum = rgba.length >= 3 ? (rgba[0] + rgba[1] + rgba[2]) / 3 : 255;
    if (fontPx < 13 || pausePx < 13) {
      this.t.problem('bug', `touch button labels are too small (${fontPx}px / ${pausePx}px, expected >= 13px)`);
    }
    if (alpha < 0.45 || lum > 40) {
      this.t.problem('bug', `touch button fill is not dark semi-opaque (${bs.backgroundColor})`);
    }
    if (!bs.textShadow || bs.textShadow === 'none') {
      this.t.problem('bug', 'touch button labels have no text-shadow for readability over bright stages');
    }
    this.t.event('touch-controls', `fill ${bs.backgroundColor}, font ${fontPx}px/${pausePx}px, text-shadow on`);
    await this.t.wait(2500);
    if (wasHidden && !touchDevice()) root.hidden = true;
  }

  // ---------------------------------------------------------- menu driving

  private async screen(id: ScreenId, timeoutMs = 20000): Promise<void> {
    await this.t.until(() => currentScreen() === id && !switching(), timeoutMs, `the ${SCREEN_NAMES[id]} screen`);
  }

  /** Clicks a control the way a mouse player would, once it is on screen and enabled. */
  private async click(find: () => HTMLElement | null | undefined, what: string, timeoutMs = 15000): Promise<void> {
    if (this.useTap) return this.tap(find, what, timeoutMs);
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

  /** Set by touch-match: every menu click is a pointer tap (hit-tested), like a finger. */
  private useTap = false;

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
    // Only fighters a fresh save may pick (the locked tiles don't take a click).
    const pool = CHARACTERS.map((_, i) => i).filter((i) => isUnlocked(CHARACTERS[i].id));
    const n = pool.length;
    const asked = typeof this.options.fighter === 'string' ? CHARACTERS.findIndex((c) => c.id === this.options.fighter) : -1;
    if (typeof this.options.fighter === 'string' && asked < 0) this.t.problem('bug', `fighter "${this.options.fighter}" is not in the roster`);
    if (asked >= 0 && !pool.includes(asked)) this.t.problem('bug', `fighter "${this.options.fighter}" is locked in Versus (clear its chapter first)`);
    const mePos = asked >= 0 ? pool.indexOf(asked) : Math.abs(this.options.seed * 11) % n;
    const meIdx = pool[Math.max(0, mePos)];
    const foeIdx = pool[(Math.max(0, mePos) + 1 + (Math.abs(this.options.seed * 17) % (n - 1))) % n];
    await this.click(() => this.q('#select-slots .slot-pick'), 'your slot');
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[meIdx], CHARACTERS[meIdx].name);
    await this.click(() => document.querySelectorAll<HTMLElement>('#select-grid .tile')[foeIdx], `CPU: ${CHARACTERS[foeIdx].name}`);
    // The hovered fighter's preview must show a loaded portrait, not just the stats.
    // Images load asynchronously after the click: wait for it (up to 5 s) before judging.
    const previewImg = () => document.querySelector<HTMLImageElement>('#select-preview img');
    const tp = Date.now();
    while (Date.now() - tp < 5000 && !(previewImg()?.complete && (previewImg()?.naturalWidth ?? 0) > 0)) await new Promise((r) => setTimeout(r, 100));
    const shown = previewImg();
    if (shown && shown.complete && shown.naturalWidth > 0) {
      this.t.event('select-preview', `${CHARACTERS[foeIdx].name}: portrait shown (${shown.naturalWidth}x${shown.naturalHeight})`);
    } else {
      this.t.problem('bug', `Character select preview has no portrait for ${CHARACTERS[foeIdx].name}`);
    }
    // Every roster tile and slot must show a loaded portrait, not just a name.
    const imgs = [...document.querySelectorAll<HTMLImageElement>('#select-grid .tile:not(.random) img, #select-slots .slot-pick img')];
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && imgs.some((i) => !(i.complete && i.naturalWidth > 0))) await new Promise((r) => setTimeout(r, 200));
    const empty = imgs.filter((i) => !(i.complete && i.naturalWidth > 0));
    if (imgs.length && !empty.length) this.t.event('roster-portraits', `${imgs.length} roster/slot portraits loaded`);
    else this.t.problem('bug', `Character select: ${empty.length}/${imgs.length} roster tiles/slots have no portrait`);
    if (this.onVersus) this.checkClipping('character select', this.q('#select'));
    await this.click(() => this.q('#select-slots .fight'), 'Fight');
    await this.screen('stages');
    const cards = () => document.querySelectorAll<HTMLElement>('#stage-grid .stage-card:not(.random)');
    await this.t.until(() => cards().length > 0, 5000, 'stage cards');
    if (this.onVersus) this.checkClipping('stage select', this.q('#stages'));
    // options.stage plays that stage (a content playtest of a new one); else one from the seed.
    const want = typeof this.options.stage === 'string' ? this.options.stage : null;
    const byId = want ? [...cards()].findIndex((c) => c.dataset.stage === want) : -1;
    if (want && byId < 0) this.t.problem('bug', `stage "${want}" is not offered in Versus (content/modes.json)`);
    const pick = byId >= 0 ? byId : Math.abs(this.options.seed - 1) % cards().length;
    type Timing = { selectToVs: number | null; vsToMatch: number; vsHoldMs: number | null; warmUpMs: number | null; selectToMatch: number | null };
    let timing: Timing | null = null;
    let warmUpMs: number | null = null;
    const onTiming = (e: Event) => { timing = (e as CustomEvent).detail; };
    const onWarm = (e: Event) => { warmUpMs = (e as CustomEvent).detail.warmUpMs; };
    window.addEventListener('dod:scene-timing', onTiming);
    window.addEventListener('dod:warm-up', onWarm);
    await this.click(() => cards()[pick], `stage ${want && byId >= 0 ? want : pick + 1}`);
    const confirmAt = performance.now();
    this.vsWipePending = this.vsHoldWanted;
    if (this.onVersus) await this.onVersus();
    await this.matchLive();
    window.removeEventListener('dod:scene-timing', onTiming);
    const tm = timing as Timing | null;
    if (tm) {
      const sec = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
      // The VS card on screen: from the wipe into it to the wipe into the match (capped at 4 s in main.ts; the
      // meshes are the only thing it can still wait on past the cap).
      if (tm.vsHoldMs !== null) {
        this.t.metric('vsCardHoldMs', tm.vsHoldMs);
        this.t.event('vsCardHoldMs', `VS card shown to match wipe start: ${tm.vsHoldMs} ms`);
        if (tm.vsHoldMs > 5000) this.t.problem('bug', `The VS card was held ${tm.vsHoldMs} ms before the match wipe (cap 4000 ms)`);
        // The warm-up carries on behind the match intro: give it up to 20 s to report.
        await this.t.until(() => warmUpMs !== null, 20000, 'the warm-up to finish').catch(() => undefined);
        if (warmUpMs !== null) {
          this.t.metric('warmUpMs', warmUpMs);
          this.t.event('warmUpMs', `renderer warm-up took ${warmUpMs} ms (behind the VS card and match intro)`);
        }
      }
      window.removeEventListener('dod:warm-up', onWarm);
      this.t.event('select-to-vs', `stage picked to VS card up: ${sec(tm.selectToVs)}`);
      this.t.event('vs-to-match', `VS card to match: ${sec(tm.vsToMatch)}`);
      this.t.event('select-to-match', `stage picked to match: ${sec(tm.selectToMatch)}`);
      if (tm.selectToMatch !== null && tm.selectToMatch > 3000) this.t.problem('bug', `the VS card took ${sec(tm.selectToMatch)} after the stage pick (limit 3 s)`);
    } else this.t.problem('bug', 'no scene timing reported for the match start');
    if (this.vsHoldWanted) {
      await this.t.until(() => (this.game.match()?.state.frame ?? 0) > 0, 10000, 'the first match frame');
      const ms = Math.round(performance.now() - confirmAt);
      this.t.metric('vsHoldMs', ms);
      this.t.event('vsHoldMs', `${ms} ms from the stage confirm to the first match frame`);
      if (ms > 3000) this.t.problem('bug', `The VS card held ${ms} ms from the stage confirm to the first match frame (limit 3000 ms)`);
    }
  }

  private vsHoldWanted = false;
  private vsWipePending = false;

  /**
   * From landing to Title: every painted frame (a requestAnimationFrame callback, no timers) is checked, and the
   * page plus canvas both near-uniform black for over 100 ms is a problem. Returns the stop function.
   */
  private watchBlank(): () => void {
    const t = this.t;
    let stop = false;
    let since = -1;
    let worst = 0;
    let frames = 0;
    let blankFrames = 0;
    const probe = document.createElement('canvas');
    probe.width = probe.height = 16;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    const dark = (c: string) => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
      return c === 'transparent' || (m.length >= 4 && m[3] === 0) || (m.length >= 3 && m[0] + m[1] + m[2] < 24);
    };
    const canvasBlack = () => {
      const cv = document.querySelector<HTMLCanvasElement>('#stage canvas, canvas');
      if (!cv || !ctx || !cv.width) return true;
      try {
        ctx.clearRect(0, 0, 16, 16);
        ctx.drawImage(cv, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
        return max < 12;
      } catch { return false; }
    };
    const pageBlack = () => {
      if (promptShowing() || currentScreen()) return false;
      for (let e: Element | null = document.elementFromPoint(innerWidth / 2, innerHeight / 2); e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none' || !dark(cs.backgroundColor)) return false;
      }
      return true;
    };
    const finish = () => {
      stop = true;
      t.metric('blankFrames', blankFrames);
      t.event('blankFrames', `${blankFrames} near-black frames of ${frames} from landing to Title, longest run ${Math.round(worst)} ms`);
      if (worst > 100) t.problem('bug', `The page and canvas were near-uniform black for ${Math.round(worst)} ms between landing and Title (limit 100 ms)`);
    };
    const tick = (now: number) => {
      if (stop) return;
      frames++;
      if (pageBlack() && canvasBlack()) {
        blankFrames++;
        if (since < 0) since = now;
        worst = Math.max(worst, now - since);
      } else since = -1;
      if (currentScreen() === 'title') return finish();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { if (!stop) finish(); };
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
    // A won campaign episode signs off in the arena first (the outro scene), then the results come.
    await this.t.until(() => sceneShowing() || currentScreen() === 'results', 30000, 'the outro or the results');
    if (sceneShowing()) await this.passScene();
    await this.screen('results', 30000);
    return won;
  }

  /** The first story card of a run is left to time out by itself (the story-cards scenario); the others are cut short. */
  private cardAuto = false;
  private cardsSeen = 0;

  /**
   * A story card: the live scene's lower third (`#scene-card`, "Tonight" before the episode, "Signing off" after
   * it). Checks it names the episode and says the line content/campaign.json gives the chapter for it, then cuts
   * it short with Next (or, once, waits for it to move on by itself).
   */
  private async playCard(): Promise<void> {
    const t = this.t;
    const text = (id: string) => this.q(id)?.textContent?.trim() ?? '';
    const onCard = () => this.q('#scene')?.getAttribute('data-beat') === 'card';
    const title = text('#scene-card-title');
    const which = text('#scene-card-tag') === 'Tonight' ? 'before' : 'after';
    const line = text('#scene-card-line');
    const c = CHAPTERS.find((x) => x.title === title);
    const want = c?.card?.[which];
    const shownAt = performance.now();
    this.cardsSeen++;
    t.event(`card-${which}`, `${text('#scene-card-kicker')} · ${title}: "${line}"`);
    if (!c) t.problem('bug', `the story card names "${title}", which is no episode in content/campaign.json`);
    else if (!line || line !== want) t.problem('bug', `the ${which} card of ${c.id} says "${line}", content/campaign.json has "${want ?? ''}"`);
    if (!/^Season \d+ · Episode \d+$/.test(text('#scene-card-kicker'))) t.problem('bug', `the story card has no season and episode line ("${text('#scene-card-kicker')}")`);
    if (this.cardAuto) {
      this.cardAuto = false;
      await this.t.until(() => !onCard(), SCENE_CARD_MS + 8000, 'the story card to move on by itself');
      const ms = Math.round(performance.now() - shownAt);
      t.metric('cardAutoMs', ms);
      t.event('card-auto', `moved on by itself after ${(ms / 1000).toFixed(1)} s`);
      return;
    }
    await this.wait(900);
    if (!onCard()) return;
    await this.click(() => this.q('#scene-next'), 'Next (story card)');
    const t0 = performance.now();
    await this.t.until(() => !onCard(), 5000, 'the story card to be cut short');
    t.event('card-skipped', `${which} card of ${title} cut short, gone in ${Math.round(performance.now() - t0)} ms`);
  }

  private async wait(ms: number): Promise<void> {
    await this.t.wait(ms);
  }

  /**
   * A chapter's story: the intro plays live in the arena (ui/scene.ts) after the VS card, before Ready. After
   * Continue on the results nothing more comes (the outro played after Game!, see results()), so this returns
   * once the map is back.
   */
  private async playDialogue(): Promise<void> {
    await this.t.until(
      () => sceneShowing() || currentScreen() === 'campaign' || currentScreen() === 'results' || this.game.phase() === 'play',
      60000,
      'the story scene',
    );
    if (sceneShowing()) await this.passScene();
  }

  /**
   * Plays through a live story scene like a player: reads the card, then each line for a moment and Next.
   * Every piece of on-screen story text must be one short line (studio rule 6e); the beats are logged.
   */
  private async passScene(): Promise<void> {
    const t = this.t;
    const root = this.q('#scene');
    const which = root?.getAttribute('data-scene') ?? '?';
    const t0 = performance.now();
    const seen = new Set<string>();
    let longest = 0;
    if (which === 'cold-open') {
      const cards = !!this.q('#scene-card') && !this.q('#scene-card')!.hidden;
      if (cards) t.problem('bug', 'a premiere cold open shows a text story card');
      await this.wait(2500);
      const beat = root?.getAttribute('data-beat') ?? '';
      t.event('cold-open', `premiere cold open playing on the stage (${beat}), caption "${this.q('#scene-text')?.textContent ?? ''}", no story card: ${!cards}`);
      await this.click(() => this.q('#scene-next'), 'Fight (skip the cold open)');
      const t1 = performance.now();
      await this.t.until(() => !sceneShowing(), 5000, 'the cold open to be skipped');
      t.event('cold-open-skipped', `skipped with one click, gone in ${Math.round(performance.now() - t1)} ms`);
      return;
    }
    while (sceneShowing() && performance.now() - t0 < 120000) {
      const beat = root?.getAttribute('data-beat') ?? '';
      if (beat === 'card' && !seen.has('card')) {
        seen.add('card');
        await this.playCard();
        continue;
      }
      if (beat.startsWith('line-') && !seen.has(beat)) {
        seen.add(beat);
        const words = (this.q('#scene-text')?.textContent ?? '').trim().split(/\s+/).filter(Boolean).length;
        longest = Math.max(longest, words);
        if (words > MAX_WORDS) t.problem('bug', `story scene (${which}) shows ${words} words at once ("${this.q('#scene-text')?.textContent}"), more than one short line`);
      }
      if (!switching() && beat !== 'card') this.q('#scene-next')?.click();
      await this.t.wait(700);
    }
    if (sceneShowing()) throw new Error('timed out waiting for the story scene to end');
    const lines = [...seen].filter((b) => b.startsWith('line-')).length;
    t.event('scene', `${which}: ${lines} line pieces in the arena, longest ${longest} words, ${Math.round((performance.now() - t0) / 1000)} s`);
  }

  // ---------------------------------------------------------- scenarios

  /**
   * Watches the page's frames while a wipe is switching screens (VS, match start, menu return): the longest
   * gap between two frames and the frame rate under the wipe. A gap over 500 ms is a stalled wipe.
   */
  private watchWipe(): () => void {
    const t = this.t;
    let stop = false;
    let prev = performance.now();
    let wipeMs = 0;
    let wipeFrames = 0;
    let worst = 0;
    let wasSwitching = false;
    const tick = (now: number) => {
      if (stop) return;
      const gap = now - prev;
      prev = now;
      const covered = switching();
      if (covered && wasSwitching) {
        wipeMs += gap;
        wipeFrames++;
        if (gap > worst) {
          worst = gap;
          t.metric('wipeWorstGapMs', Math.round(worst));
        }
        if (gap > 500) t.problem('bug', `The wipe stalled: ${Math.round(gap)} ms between two frames while switching screens (${currentScreen() ?? '?'})`);
      }
      if (wasSwitching && !covered && wipeFrames > 0) {
        t.event('wipe', `${wipeFrames} frames in ${Math.round(wipeMs)} ms (${Math.round((wipeFrames * 1000) / Math.max(1, wipeMs))} fps), worst gap ${Math.round(worst)} ms`);
        t.metric('wipeFps', Math.round((wipeFrames * 1000) / Math.max(1, wipeMs)));
        if (this.vsWipePending) {
          this.vsWipePending = false;
          t.metric('vsWipeFps', Math.round((wipeFrames * 1000) / Math.max(1, wipeMs)));
          t.event('vsWipeFps', `${Math.round((wipeFrames * 1000) / Math.max(1, wipeMs))} fps in the wipe into VS (${wipeFrames} frames, ${Math.round(wipeMs)} ms)`);
        }
        wipeMs = 0;
        wipeFrames = 0;
      }
      wasSwitching = covered;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { stop = true; };
  }

  async smoke(): Promise<void> {
    const t = this.t;
    const stopWatch = this.watchWipe();
    const stopBlank = this.watchBlank();
    this.vsHoldWanted = true;
    try {
      await this.smokeRun();
    } finally {
      stopBlank();
      stopWatch();
    }
    void t;
  }

  /**
   * Real viewport + touch as the game sees them. Phone scenarios (touch-match, smoke's phone leg) must log
   * 844x390 or 390x844 with touch; a phone run at desktop size is a bug so reviews are not "unclear".
   */
  private logViewport(expectPhone: boolean): void {
    const t = this.t;
    const touch = touchDevice();
    const phone = this.isPhone();
    const size = `${innerWidth}x${innerHeight}`;
    t.event('viewport', `${size}${touch ? ' touch' : ' no-touch'}${phone ? ' phone' : ''}`);
    t.metric('viewportW', innerWidth);
    t.metric('viewportH', innerHeight);
    if (!expectPhone) return;
    if (!phone) t.problem('bug', `phone scenario ran at desktop size ${size} (want 844x390 or 390x844 with touch)`);
    else if (!touch) t.problem('bug', `phone scenario has no touch support at ${size}`);
  }

  /** Studio's phone twin (and Gen mobile: true): coarse pointer / touch points, or an already phone-sized window. */
  private phoneScenario(): boolean {
    return this.isPhone() || touchDevice() || this.options.at === 'phone-turned' || this.options.at === 'phone';
  }

  /**
   * On a portrait phone window (the runner's 390x844) the Rotate prompt holds every match, and a page cannot turn its
   * own window. So the run does what a player does: it turns the phone. It opens a copy of the game in a frame sized
   * 844x390 (a real landscape viewport for the game inside: media queries, touch controls, no Rotate prompt) and
   * plays the whole smoke there, forwarding what the frame sees. The prompt itself is untouched (the rotate scenario
   * still checks it).
   */
  private async smokeTurned(): Promise<void> {
    const t = this.t;
    this.logViewport(true);
    type Inner = { events: Array<{ type: string; detail?: string }>; problems: Array<{ severity: string; message: string }>; metrics?: Record<string, number>; outcome: string; state?: { progress?: number } };
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:#1c0d06 radial-gradient(ellipse at 50% 45%,#8a3010 0%,#3a1608 45%,#100e0c 80%);z-index:2147483647;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.title = 'Phone window turned to landscape (playtest)';
    frame.allow = 'autoplay';
    const w = 844;
    const h = 390;
    const k = Math.min(innerWidth / w, innerHeight / h, 1);
    frame.style.cssText = `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;border:0;transform-origin:0 0;transform:translate(${-(w * k) / 2}px,${-(h * k) / 2}px) scale(${k});background:transparent`;
    back.appendChild(frame);
    const q = new URLSearchParams(location.search);
    q.set('playtest', 'smoke');
    q.set('at', 'phone-turned');
    if (!q.has('seed')) q.set('seed', String(this.options.seed ?? 1));
    frame.src = `${location.pathname}?${q.toString()}`;
    document.body.appendChild(back);
    const api = () => (frame.contentWindow as (Window & { hawkesPlaytest?: { report(): Inner | null; state(): { progress?: number } | null } }) | null)?.hawkesPlaytest;
    let seen = 0;
    const seenProblems = new Set<string>();
    let heart = 0;
    const forward = (): Inner | null => {
      const r = api()?.report() ?? null;
      if (!r) return null;
      for (const e of r.events.slice(seen)) if (e.type !== 'problem' && e.type !== 'start' && e.type !== 'start-at') t.event(e.type, `${e.detail ?? ''} [landscape frame]`);
      seen = r.events.length;
      for (const p of r.problems) {
        if (!seenProblems.has(p.message)) {
          seenProblems.add(p.message);
          t.problem('bug', `${p.message} [landscape frame]`);
        }
      }
      if (r.metrics) {
        for (const [k, v] of Object.entries(r.metrics)) {
          if (typeof v === 'number' && !k.startsWith('fps')) t.metric(k, v);
        }
      }
      const prog = api()?.state()?.progress;
      if (typeof prog === 'number') t.progress(Math.min(0.99, Math.max(0.05, prog)));
      return r;
    };
    try {
      t.event('phone-turned', `the portrait phone window (${innerWidth}x${innerHeight}) turned to ${w}x${h} (landscape) for the match`);
      t.progress(0.05);
      await t.until(() => {
        // Heartbeat while the nested Game boots: without it the outer run softlocks (~30–60 s) before the frame reports.
        // until() polls every 50 ms: every 100 ticks ≈ 5 s.
        heart += 1;
        if (heart === 1 || heart % 100 === 0) t.event('phone-turn-wait', `waiting for the landscape smoke (${Math.round(heart / 20)} s)`);
        const r = forward();
        return !!r && (r.outcome === 'done' || r.outcome === 'error' || r.outcome === 'stuck' || r.outcome === 'won' || r.outcome === 'lost');
      }, 240000, 'the turned phone to play the smoke match');
      const r = forward();
      const out = r?.outcome;
      if (out !== 'done' && out !== 'won' && out !== 'lost') {
        t.problem('bug', `the smoke match in the turned phone ended ${out ?? 'without a report'}`);
        t.progress(1);
        t.finish(out === 'stuck' || out === 'error' ? out : 'stuck');
        return;
      }
    } finally {
      back.remove();
    }
    t.progress(1);
    t.finish('done');
  }

  private async smokeRun(): Promise<void> {
    const t = this.t;
    // Always log what the game sees first (desktop or phone), so a review can tell 1280x720 from 390x844.
    // A portrait phone shows the Rotate prompt: do not drive menus under it — turn to landscape in a frame first.
    // (Earlier: toMainMenu first, then turn; the nested Game boot then sat silent and the outer run softlocked ~30–60 s.)
    if (this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      return this.smokeTurned();
    }
    this.logViewport(this.phoneScenario());
    // The load: the branded loader (orange glow, wordmark in HTML) is what shows first, and the canvas fades in after its first frame.
    {
      const bg = getComputedStyle(document.body).backgroundImage + getComputedStyle(document.body).backgroundColor;
      const logo = this.q('#tap-to-play .logo')?.textContent ?? '';
      if (/gradient/.test(bg) && /Destruction/i.test(logo)) t.event('loader-branded', 'brand background and wordmark in the HTML from first paint');
      else if (promptShowing()) t.problem('bug', 'the loader has no brand background or wordmark in plain HTML');
      const stage = document.getElementById('stage');
      await t.until(() => Boolean(stage?.classList.contains('ready')), 15000, 'the canvas to fade in after its first rendered frame');
      t.event('canvas-fade-in', 'canvas revealed after the first rendered frame');
    }
    await this.toMainMenu();
    // The release notes (/releases.json via /site/hawkes-release.js) must load: the version on the menu reads them.
    const release = await ((window as unknown as { hawkesRelease?: Promise<{ current?: string } | null> }).hawkesRelease ?? Promise.resolve(null));
    if (release?.current) t.event('release', `releases.json loaded: v${release.current}`);
    else t.problem('bug', 'releases.json did not load (404 or invalid): no version or release notes');
    t.progress(0.15);
    await this.startVersus(1);
    t.progress(0.4);
    // Upright on a phone the Rotate prompt holds the match (frame 0 forever): that is the game working, not stuck.
    // Check the prompt covers the game, then leave from Pause instead of waiting for a fight that cannot start.
    if (rotateShowing()) {
      t.event('smoke-rotate', `the Rotate prompt holds the match at ${innerWidth}x${innerHeight}; leaving from Pause`);
      await this.quitFromPause('main');
      t.progress(1);
      t.finish('done');
      return;
    }
    const start = () => this.game.match()?.state.frame ?? 0;
    this.progressNow = () => 0.4 + 0.5 * Math.min(1, start() / 1200);
    // Plays to the Results screen (1 stock, so it ends); blankFrames, vsHoldMs and wipe fps are reported there.
    await this.fight(() => false, 4 * 60 * 1000);
    this.progressNow = () => 0.9;
    await this.results();
    t.event('smoke-results', 'the smoke match reached the Results screen');
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish('done');
  }

  async match(): Promise<void> {
    const t = this.t;
    // The feedback card shows once per session and sleeps 7 days once closed: this browser may have closed it before.
    resetAsk(MATCH_ASK);
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
    await this.feedbackCard(MATCH_ASK, 'How was that fight?');
    await this.analyticsSent(['screen', 'fighter_pick', 'stage_pick', 'level_start', 'death', 'level_end']);
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish(won ? 'won' : 'lost');
  }

  /** Set by the presentation scenario: runs on the VS screen, before the match loads. */
  private onVersus: (() => Promise<void>) | null = null;

  /** Text that is cut off or pushed off the screen inside `root` (the viewport's own aspect is whatever the run has). */
  private clippedText(root: HTMLElement): string[] {
    const bad: string[] = [];
    const vw = innerWidth;
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (!el.getClientRects().length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      if (!own) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || r.width === 0) continue;
      const what = `"${(el.textContent ?? '').trim().slice(0, 30)}" (${el.tagName.toLowerCase()}.${el.className})`;
      if (r.right > vw + 1 || r.left < -1) bad.push(`${what} runs off the side (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
      else if (cs.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1) bad.push(`${what} is cut off (${el.scrollWidth} in ${el.clientWidth})`);
      // Headings only: overflow:hidden + tight line-height clips Oswald caps (results winner). Ellipsis rows stay out.
      else if (/^H[12]$/.test(el.tagName) && cs.overflow !== 'visible' && el.scrollHeight > el.clientHeight + 1) {
        bad.push(`${what} is cut off vertically (${el.scrollHeight} in ${el.clientHeight})`);
      }
    }
    return bad;
  }

  /** A phone-sized window: upright (<=560 wide) or on its side (<=520 tall) — the sizes the phone layout in game.css serves. */
  private isPhone(): boolean {
    return innerWidth <= 560 || innerHeight <= 520;
  }

  /** On a phone: every visible button is at least 44 px tall, and no two buttons overlap (room between them). */
  private phoneTargets(root: HTMLElement): string[] {
    const bad: string[] = [];
    const items = [...root.querySelectorAll<HTMLElement>('button, a.menu-item, [role="button"]')].filter((el) => {
      if (!el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && el.getBoundingClientRect().width > 0;
    });
    const rects = items.map((el) => el.getBoundingClientRect());
    const name = (el: HTMLElement) => `"${(el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label') || el.id}" (${el.tagName.toLowerCase()}.${el.className})`;
    items.forEach((el, i) => {
      if (rects[i].height < 43.5) bad.push(`${name(el)} is ${Math.round(rects[i].height)} px tall (needs 44)`);
    });
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
        const a = rects[i];
        const b = rects[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) bad.push(`${name(items[i])} overlaps ${name(items[j])}`);
      }
    }
    return bad;
  }

  private checkClipping(where: string, root: HTMLElement | null): void {
    const t = this.t;
    const ratio = innerWidth / innerHeight;
    const phone = this.isPhone();
    const shape = phone ? (ratio < 1 ? 'phone portrait' : 'phone landscape') : ratio >= 2.1 ? '20:9' : ratio >= 1.7 ? '16:9' : ratio >= 1.5 ? '16:10' : 'other';
    if (!root) return;
    const bad = this.clippedText(root);
    if (bad.length) for (const b of bad.slice(0, 5)) t.problem('bug', `${where}: text clipped at ${innerWidth}x${innerHeight} (${shape}): ${b}`);
    else t.event('no-clipping', `${where}: no text clipped at ${innerWidth}x${innerHeight} (${shape})`);
    // A heading pushed above the top of the window (a scrolled screen) is clipped too, whatever its text width.
    const head = root.querySelector<HTMLElement>('h1, h2');
    if (head && head.getClientRects().length && head.getBoundingClientRect().top < -1) {
      t.problem('bug', `${where}: heading "${(head.textContent ?? '').trim().slice(0, 30)}" is above the top of the window (top ${Math.round(head.getBoundingClientRect().top)}) at ${innerWidth}x${innerHeight} (${shape})`);
    }
    if (!phone) return;
    const small = this.phoneTargets(root);
    if (small.length) for (const b of small.slice(0, 5)) t.problem('bug', `${where}: touch target at ${innerWidth}x${innerHeight} (${shape}): ${b}`);
    else t.event('phone-targets', `${where}: every button at least 44 px tall, none overlapping, at ${innerWidth}x${innerHeight} (${shape})`);
  }

  /** Menu, VS screen and results presentation: the broadcast menu, a name card animating in for each fighter, results with winner, time and damage. */
  /**
   * Rotate your phone: upright on a touch device a full-screen prompt covers the game and the match waits; turning to
   * landscape hides it and play goes on. The run judges the window as it is (390x844 upright, 844x390 on its side) and,
   * started upright, waits for the runner to turn the window to landscape. It asks to be treated as a touch device.
   */
  /**
   * First visit (docs/story.md "The pilot"): storage cleared, Tap to play, and the clock runs. The fight must open on Open
   * Mic with no main menu (`first-visit-no-menu`), the player must have control within 30 s (`secondsToControl`), land a hit
   * within 45 s (`secondsToFirstHit`) and a KO within 90 s (`secondsToFirstKO`) of the tap. One teaching prompt at most is
   * on screen (`teach-one`), each fades once its move is used (`teach-gone`), and on a phone they show touch icons
   * (`teach-device`). On a portrait phone the Rotate prompt is the only screen until the window is turned to landscape
   * (`first-visit-rotate`), then the same route plays in an 844x390 frame. After the result the main menu shows Campaign as
   * "Next episode" (`next-episode`). On a touch device the prompted move is pressed on the real on-screen control.
   */
  async firstVisit(): Promise<void> {
    const t = this.t;
    const KEYS = ['dod-campaign', 'dod-versus', 'dod-pilot', 'dod-unlocks'];
    const saved = KEYS.map((k) => [k, localStorage.getItem(k)] as const);
    const wipe = () => KEYS.forEach((k) => localStorage.removeItem(k));
    const portraitPhone = this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560;
    this.logViewport(this.phoneScenario());
    try {
      wipe();
      if (portraitPhone) {
        this.useTap = true;
        forceTouchUi(true);
        forceTouchPrompt(true);
        await this.screen('title', 30000);
        await this.tapToPlay();
        // Upright: the Rotate prompt covers everything, and nothing else (no menu) shows through to a tap.
        await t.until(() => rotateShowing(), 60000, 'the Rotate prompt on the upright phone');
        const p = document.getElementById('rotate-prompt');
        const covered = !!p && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#rotate-prompt') === p;
        const r = p?.getBoundingClientRect();
        if (!covered || !r || r.width < innerWidth - 1 || r.height < innerHeight - 1) t.problem('bug', `the Rotate prompt does not cover the first-visit fight at ${innerWidth}x${innerHeight}`);
        else t.event('first-visit-rotate', `the Rotate prompt is the only screen at ${innerWidth}x${innerHeight} after Tap to play (screen: ${currentScreen()})`);
        if (currentScreen() === 'main') t.problem('bug', 'the main menu showed on a first visit');
        await t.wait(1500);
        forceTouchPrompt(false);
        // Turn the phone: the first-visit route again, in a landscape frame. This window's own pilot is dropped.
        await this.game.quitMatch();
        wipe();
        this.useTap = false;
        forceTouchUi(false);
        return await this.touchMatchTurned('first-visit');
      }

      const touch = touchDevice() || this.phoneScenario();
      if (touch) {
        this.useTap = true;
        forceTouchUi(true);
      }
      await this.screen('title', 30000);
      await t.until(() => Boolean(document.getElementById('stage')?.classList.contains('ready')), 15000, 'the canvas to fade in');
      const logoHeld = !!this.q('#pilot-logo') && getComputedStyle(this.q('#pilot-logo')!).display !== 'none';
      t.event('first-visit-start', `storage cleared; Tap to play next (pilot backdrop up: ${logoHeld})`);
      let tries = 0;
      let control = -1;
      let firstHit = -1;
      let firstKo = -1;
      let sawMain = false;
      let skipped = false;
      let t0 = 0;
      const shown: string[] = [];
      const gone = new Set<string>();
      const onTeach = (ev: Event) => {
        const d = (ev as CustomEvent<{ step: TeachStep; state: string }>).detail;
        const when = Math.round((performance.now() - t0) / 100) / 10;
        if (d.state === 'shown') {
          const el = document.querySelector<HTMLElement>('.teach-prompt');
          const dev = el?.dataset.device ?? '?';
          shown.push(d.step);
          t.event('teach-shown', `${d.step} prompt at ${when}s: ${PROMPTS[d.step].word} (${dev}: ${el?.dataset.glyphs ?? ''})`);
          if (touch && dev !== 'touch') t.problem('bug', `the ${d.step} prompt shows ${dev} glyphs on a touch device (${el?.dataset.glyphs ?? ''})`);
          if (touch) void this.touchPress(d.step);
        } else if (d.state === 'used') {
          t.event('teach-used', `${d.step} used at ${when}s`);
          window.setTimeout(() => {
            if (document.querySelector(`.teach-prompt[data-step="${d.step}"]`)) t.problem('bug', `the ${d.step} prompt is still on screen after the move was used`);
            else if (!gone.has(d.step)) {
              gone.add(d.step);
              t.event('teach-gone', `${d.step} prompt gone after use`);
            }
          }, 1200);
        }
      };
      window.addEventListener('dod:teach', onTeach);
      const stopWatch = this.game.watch((m, events) => {
        for (const e of events) {
          if (e.type === 'hit' && e.attacker === m.player && !e.shield && firstHit < 0) firstHit = (performance.now() - t0) / 1000;
          if (e.type === 'ko' && e.by === m.player && e.victim !== m.player && firstKo < 0) firstKo = (performance.now() - t0) / 1000;
        }
      });
      const poll = window.setInterval(() => {
        if (currentScreen() === 'main' && t0 > 0 && control < 0) sawMain = true;
        const n = document.querySelectorAll('.teach-prompt:not(.used):not(.gone)').length;
        if (n > 1) t.problem('bug', `${n} teaching prompts are on screen at once`);
        const m = this.game.match();
        if (control < 0 && this.game.phase() === 'play' && m && m.state.frame > 0 && t0 > 0) {
          control = (performance.now() - t0) / 1000;
        }
      }, 50);
      try {
        t0 = performance.now();
        await this.tapToPlay();
        // The route: Open Mic's cold open over the arena, no title, no main menu.
        await t.until(() => sceneShowing() || this.game.phase() === 'play', 40000, "Open Mic's cold open");
        if (sceneShowing()) {
          const logo = this.q('#pilot-logo');
          t.event('first-visit-cold-open', `Open Mic's cold open is playing ${(Math.round(performance.now() - t0) / 1000).toFixed(1)} s after the tap, with the title logo ${logo && !logo.hidden ? 'over it' : 'gone'}, no menu: ${currentScreen()}`);
          await t.wait(2500);
          skipped = true;
          await this.click(() => this.q('#scene-skip'), 'Skip the cold open');
        }
        t.progress(0.2);
        for (let attempt = 0; attempt < 2; attempt++) {
          tries++;
          await t.until(() => this.game.phase() === 'play' || currentScreen() === 'results', 60000, 'the fight to open');
          this.progressNow = () => {
            const m = this.game.match();
            return m ? 0.2 + 0.6 * Math.min(1, m.state.frame / 5400) : 0.85;
          };
          await this.fight(() => false, 5 * 60 * 1000);
          const won = await this.results();
          if (won) break;
          t.event('first-visit-lost', `the pilot was lost (try ${tries}); retrying`);
          if (attempt === 0) await this.click(() => this.button('#results-actions', 'Retry'), 'Retry');
        }
        const result = this.game.match() ?? this.seen;
        await this.click(() => this.button('#results-actions', 'Continue') ?? this.button('#results-actions', 'Main menu'), 'Continue');
        await this.screen('main', 20000);
        const tag = this.q('.menu-item[data-go="campaign"] .next-tag');
        if (tag && !tag.hidden && /Next episode/i.test(tag.textContent ?? '')) t.event('next-episode', `the main menu marks Campaign "${tag.textContent}" after the pilot (${this.q('.menu-item[data-go="campaign"] span')?.textContent ?? ''})`);
        else t.problem('bug', 'after the pilot the main menu does not mark Campaign "Next episode"');
        void result;
      } finally {
        clearInterval(poll);
        stopWatch();
        window.removeEventListener('dod:teach', onTeach);
      }
      if (sawMain) t.problem('bug', 'the main menu showed between Tap to play and the first fight');
      else t.event('first-visit-no-menu', 'no title or main menu between Tap to play and the fight');
      const rep = (name: string, v: number, limit: number) => {
        if (v < 0) {
          t.problem('bug', `${name}: never happened`);
          return;
        }
        t.metric(name, Math.round(v * 10) / 10);
        t.event(name, `${v.toFixed(1)} s after Tap to play${skipped ? ' (cold open skipped at 2.5 s)' : ''}`);
        if (v > limit) t.problem('bug', `${name} was ${v.toFixed(1)} s, over the ${limit} s limit`);
      };
      rep('secondsToControl', control, 30);
      rep('secondsToFirstHit', firstHit, 45);
      rep('secondsToFirstKO', firstKo, 90);
      t.metric('teachPromptsShown', new Set(shown).size);
      if (!shown.length) t.problem('bug', 'no teaching prompt ever showed in the first fight');
      t.progress(1);
      t.finish('done');
    } finally {
      for (const [k, v] of saved) {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
      this.useTap = false;
      forceTouchUi(false);
    }
  }

  /** On a touch device: presses the real on-screen control the prompt is about (pointer events, like a finger). */
  private async touchPress(step: TeachStep): Promise<void> {
    const root = touchOverlay();
    if (!root) return;
    await this.t.wait(400);
    const fire = (el: Element, type: string, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 77, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    if (step === 'move') {
      const stick = root.querySelector('.touch-stick');
      if (!stick) return;
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      fire(stick, 'pointerdown', cx, cy);
      fire(stick, 'pointermove', cx + r.width * 0.3, cy);
      await this.t.wait(500);
      fire(stick, 'pointerup', cx, cy);
      return;
    }
    const cls = PROMPTS[step].touch;
    const btn = cls ? root.querySelector(`.touch-btn.${cls}`) : null;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    fire(btn, 'pointerdown', r.left + r.width / 2, r.top + r.height / 2);
    await this.t.wait(120);
    fire(btn, 'pointerup', r.left + r.width / 2, r.top + r.height / 2);
  }

  async rotate(): Promise<void> {
    // On a window that is not phone-shaped (the runner's 1280x720) the run makes its own phone: a framed copy of the game
    // at 390x844 that the run then turns to 844x390 (a real resize and orientation media-query change inside the frame).
    // `at: "phone"` is that copy: it judges the window it has.
    if (this.options.at !== 'phone' && Math.min(innerWidth, innerHeight) > 500) return this.rotateFramed();
    return this.rotateWindow();
  }

  /** Plays "rotate" in a frame sized like a phone, upright and then on its side, and reports what the frame saw. */
  private async rotateFramed(): Promise<void> {
    const t = this.t;
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:#1c0d06 radial-gradient(ellipse at 50% 45%,#8a3010 0%,#3a1608 45%,#100e0c 80%);z-index:2147483647;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.title = 'Phone window (playtest)';
    frame.allow = 'autoplay';
    back.appendChild(frame);
    // The frame keeps its CSS size (so the game inside sees a phone) and is scaled to sit inside the screen.
    const turn = (w: number, h: number) => {
      const k = Math.min(innerWidth / w, innerHeight / h, 1);
      frame.style.cssText = `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;border:2px solid #444;transform-origin:0 0;transform:translate(${-(w * k) / 2}px,${-(h * k) / 2}px) scale(${k});background:transparent`;
    };
    turn(390, 844);
    frame.src = `${location.pathname}?playtest=rotate&at=phone&seed=${this.options.seed ?? 1}`;
    document.body.appendChild(back);
    const inner = () => (frame.contentWindow as (Window & { hawkesPlaytest?: { report(): { events: Array<{ type: string; detail?: string }>; problems: Array<{ severity: string; message: string }>; outcome: string } | null } }) | null)?.hawkesPlaytest?.report() ?? null;
    let seenEvents = 0;
    const seenProblems = new Set<string>();
    const forward = () => {
      const r = inner();
      if (!r) return null;
      for (const e of r.events.slice(seenEvents)) {
        if (e.type !== 'problem' && e.type !== 'start' && e.type !== 'start-at' && e.type !== 'rotate-not-turned') t.event(e.type, `${e.detail ?? ''} [phone frame]`);
      }
      seenEvents = r.events.length;
      for (const p of r.problems) {
        if (!seenProblems.has(p.message)) {
          seenProblems.add(p.message);
          t.problem('bug', `${p.message} [phone frame]`);
        }
      }
      return r;
    };
    const has = (type: string) => !!inner()?.events.some((e) => e.type === type);
    try {
      t.event('phone-upright', 'a phone-sized window, 390x844 (portrait), opened over the game');
      await t.until(() => {
        forward();
        return has('rotate-paused') || (inner()?.problems.length ?? 0) > 0 || inner()?.outcome === 'error';
      }, 120000, 'the upright phone to show the Rotate prompt');
      forward();
      await t.wait(1500);
      turn(844, 390);
      t.event('phone-turned', 'the phone window turned to 844x390 (landscape)');
      await t.until(() => {
        const r = forward();
        return !!r && r.outcome !== 'stuck' && has('landscape-lock-safe');
      }, 120000, 'the turned phone to hide the prompt and resume');
      forward();
      if (!has('rotate-prompt')) t.problem('bug', 'the Rotate prompt was never seen at 390x844');
      if (!has('rotate-hidden') || !has('rotate-resumed')) t.problem('bug', 'the prompt did not hide and play resume at 844x390');
    } finally {
      back.remove();
    }
    t.finish('done');
  }

  private async rotateWindow(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    await this.startVersus(2);
    forceTouchPrompt(true);
    try {
      const frame = () => this.game.match()?.state.frame ?? 0;
      const prompt = () => document.getElementById('rotate-prompt');
      const upright = () => innerHeight > innerWidth;
      const size = () => `${innerWidth}x${innerHeight}`;
      await this.fight(() => frame() >= 90, 30000);
      if (upright()) {
        const p = prompt();
        const r = p?.getBoundingClientRect();
        const covered = !!p && !p.hidden && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#rotate-prompt') === p;
        if (!p || !rotateShowing() || !r || r.width < innerWidth - 1 || r.height < innerHeight - 1 || !covered || !/Rotate your phone/i.test(p.textContent ?? '')) {
          t.problem('bug', `no full-screen "Rotate your phone" prompt over the game at ${size()}`);
        } else t.event('rotate-prompt', `"Rotate your phone" covers the game at ${size()}`);
        const before = frame();
        await t.wait(2000);
        if (frame() !== before) t.problem('bug', `the match kept running under the Rotate prompt at ${size()} (frame ${before} -> ${frame()})`);
        else t.event('rotate-paused', `the match is paused under the prompt at ${size()} (frame ${before})`);
        try {
          await t.until(() => !upright(), 30000, 'the window to turn to landscape');
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.event('rotate-not-turned', `the window stayed upright at ${size()}: run it at 844x390 (or turn it) to see the prompt go`);
        }
      }
      if (!upright()) {
        await t.wait(300);
        if (prompt() && !prompt()!.hidden) t.problem('bug', `the Rotate prompt is still up at ${size()}`);
        else t.event('rotate-hidden', `no Rotate prompt at ${size()}`);
        const before = frame();
        await this.fight(() => frame() >= before + 60, 40000);
        if (frame() > before) t.event('rotate-resumed', `play goes on at ${size()} (frame ${before} -> ${frame()})`);
        else t.problem('bug', `the match did not resume at ${size()}`);
      }
      // Fullscreen's landscape lock: asked for where the browser has it, harmless where it has not.
      const o = screen.orientation as unknown as { lock?: (o: string) => Promise<void> };
      const had = Object.getOwnPropertyDescriptor(o, 'lock');
      const asked: string[] = [];
      try {
        o.lock = async (v: string) => void asked.push(v);
        const ok = await lockLandscape();
        if (ok && asked[0] === 'landscape') t.event('landscape-lock', 'a landscape lock is requested');
        else t.problem('bug', `no landscape lock requested (${asked.join(',') || 'none'})`);
        o.lock = async () => {
          throw new Error('NotSupportedError');
        };
        const failed = await lockLandscape();
        o.lock = undefined;
        const none = await lockLandscape();
        if (!failed && !none) t.event('landscape-lock-safe', 'a rejected or missing orientation lock breaks nothing');
        else t.problem('bug', 'a failed or missing orientation lock was reported as success');
      } finally {
        if (had) Object.defineProperty(o, 'lock', had);
        else delete o.lock;
      }
      await this.quitFromPause('main');
    } finally {
      forceTouchPrompt(false);
    }
    t.finish('done');
  }

  async presentation(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    // 1. The broadcast menu: ON AIR bug and the Tonight ticker, shown.
    await this.wait(500);
    const bug = this.q('#on-air-bug');
    const tick = this.q('#ticker');
    const showing = (el: HTMLElement | null) => !!el && el.getClientRects().length > 0;
    if (showing(bug) && showing(tick)) t.event('menu-broadcast', `ON AIR bug "${bug!.textContent}" and ticker "${tick!.querySelector('.ticker-tag')?.textContent}" shown`);
    else if (innerWidth > 900) t.problem('bug', 'the main menu shows no ON AIR bug or Tonight ticker');
    this.checkClipping('main menu', this.q('#main'));
    t.progress(0.1);

    // 2. The VS screen: every fighter in, each with a name card that animates in after it.
    this.onVersus = async () => {
      await this.screen('versus', 15000);
      await this.t.until(() => document.querySelectorAll('#versus-body .vs-fighter').length > 0, 3000, 'the VS fighters');
      const figs = [...document.querySelectorAll<HTMLElement>('#versus-body .vs-fighter')];
      const cards = figs.map((f) => f.querySelector<HTMLElement>('.vs-card'));
      const early = cards.map((c) => (c ? Number(getComputedStyle(c).opacity) : 1));
      t.event('vs-start', `${figs.length} fighters, name cards at opacity ${early.map((o) => o.toFixed(2)).join(', ')} (animating in)`);
      await this.wait(1800);
      figs.forEach((f, i) => {
        const card = cards[i];
        const name = card?.querySelector('strong')?.textContent?.trim() ?? '';
        const who = card?.querySelector('span')?.textContent?.trim() ?? '';
        const img = f.querySelector('img');
        const op = card ? Number(getComputedStyle(card).opacity) : 0;
        if (!card || !name) t.problem('bug', `VS fighter ${f.dataset.fighter} has no name card`);
        else if (op < 0.99 || !showing(card)) t.problem('bug', `the VS name card for ${name} is not fully shown after the intro (opacity ${op})`);
        else if (!f.querySelector('.vs-sprite') && (!img || !(img.complete && img.naturalWidth > 0))) t.problem('bug', `the VS fighter picture for ${name} did not load`);
        else t.event('vs-name-card', `${name} (${who}) animated in with a name card`);
      });
      if (new Set(figs.map((f) => f.dataset.fighter)).size < 1) t.problem('bug', 'no fighters on the VS screen');
      t.event('vs-animating', `${document.querySelectorAll('#versus-body .vs-sprite').length} idle clips, progress bar ${document.querySelector('#versus-body .vs-progress') ? 'shown' : 'done'}`);
      this.checkClipping('VS screen', this.q('#versus'));
    };
    await this.startVersus(1);
    this.onVersus = null;
    t.progress(0.3);
    await this.fight(() => false, 6 * 60 * 1000);

    // 3. The results: winner, time, damage dealt, highlights.
    const m = this.game.match() ?? this.seen;
    await this.screen('results', 30000);
    await this.wait(900);
    const stat = (k: string) => this.q(`#results-body .stat[data-stat="${k}"] strong`)?.textContent?.trim() ?? '';
    const [winner, time, damage] = [stat('winner'), stat('time'), stat('damage')];
    if (!winner) t.problem('bug', 'the results show no winner');
    if (!/^\d+:\d\d$/.test(time)) t.problem('bug', `the results show no match time ("${time}")`);
    if (!/\d/.test(damage)) t.problem('bug', `the results show no damage dealt ("${damage}")`);
    t.event('results-summary', `winner ${winner}, time ${time}, damage dealt ${damage}`);
    if (m) {
      const expected = m.state.winner >= 0 ? CHARACTERS[m.state.fighters[m.state.winner].char].name : '';
      if (expected && winner.toLowerCase() !== expected.toLowerCase()) t.problem('bug', `the results name "${winner}" the winner, the match was won by ${expected}`);
    }
    const reel = document.querySelectorAll('#results-body .reel-item').length;
    t.event('results-highlights', `${reel} knockout highlight(s) listed`);
    if (m && m.kos.length > 0 && reel === 0) t.problem('bug', 'the match had knockouts but the results list no highlights');
    this.checkClipping('results', this.q('#results'));
    t.metric('highlights', reel);
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish('done');
  }

  async campaign(): Promise<void> {
    const t = this.t;
    const t0 = performance.now();
    const late = () => performance.now() - t0 > CAMPAIGN_BUDGET_MS;
    // options.chapter (or the contract's options.at) starts at that chapter, picked by id; options.season
    // (or at: "season-N") starts at the first chapter of that season.
    let asked = this.options.chapter ?? this.options.at;
    const seasonAsk = this.options.season ?? (typeof asked === 'string' ? /^season-(\d+)$/.exec(asked)?.[1] : undefined);
    let from = 0;
    let before: string[] | null = null;
    if (seasonAsk != null && seasonAsk !== '') {
      const n = Number(seasonAsk);
      const first = CHAPTERS.find((c) => c.season === n);
      if (!first) {
        t.problem('bug', `season ${String(seasonAsk)} has no chapters in the campaign yet (seasons with chapters: ${SEASONS.map((s) => s.number).join(', ')})`);
        t.finish('error');
        return;
      }
      asked = first.id;
    }
    if (asked != null && asked !== '') {
      from = CHAPTERS.findIndex((c) => c.id === asked);
      if (from < 0) {
        t.problem('bug', `chapter "${String(asked)}" is not in the campaign (content/campaign.json ids: ${CHAPTERS.map((c) => c.id).join(', ')})`);
        t.finish('error');
        return;
      }
      before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
      t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    }
    try {
      await this.campaignFrom(from, late);
    } finally {
      if (before) this.game.setCampaignProgress(before);
    }
  }

  private async campaignFrom(from: number, late: () => boolean, last = CHAPTERS.length - 1): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
    await this.screen('campaign');
    this.checkCampaignMap(CHAPTERS[from]?.season ?? 1);
    let cleared = 0;
    let outcome: Outcome = 'won';
    t.metric('chaptersCleared', 0);
    chapters: for (let i = from; i <= last; i++) {
      const c = CHAPTERS[i];
      const label = `Chapter ${i + 1} · ${c.title}`;
      this.progressNow = () => (i + 0.5) / CHAPTERS.length;
      t.event('chapter', label);
      t.metric('chapter', i + 1);
      await this.click(() => this.q(`#chapter-path .chapter[data-chapter="${c.id}"]`), label);
      await this.playDialogue();
      await this.matchLive();
      for (let attempt = 1; ; attempt++) {
        const watch = this.watchQuota(c);
        const watchS = this.watchStreak(c);
        const ended = await this.fight(() => (watch(), watchS(), late()), 8 * 60 * 1000);
        if (ended === 'stopped') {
          t.note(`out of time in ${label}`);
          t.log(`stopped at the 10-minute budget in ${label}`);
          await this.quitFromPause('campaign');
          outcome = 'done';
          break chapters;
        }
        const won = await this.results();
        await this.checkQuotaResult(c);
        await this.checkStreakResult(c);
        if (won) {
          await this.click(() => this.button('#results-actions', 'Continue'), 'Continue');
          await this.playDialogue();
          await this.screen('campaign');
          cleared++;
          t.metric('chaptersCleared', cleared);
          t.event('chapter-cleared', label);
          this.checkSeasonEnd(c.season, c.id);
          this.checkUnlockNote(c.unlock);
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

  /** Story cards: every campaign match has a card with the episode title and a line from content/campaign.json, and it can be skipped. */
  async storyCards(): Promise<void> {
    const t = this.t;
    const asked = this.options.chapter ?? 'open-mic';
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    if (from < 0) {
      t.problem('bug', `chapter "${String(asked)}" is not in the campaign (content/campaign.json ids: ${CHAPTERS.map((c) => c.id).join(', ')})`);
      t.finish('error');
      return;
    }
    const missing = CHAPTERS.filter((c) => !c.card?.before || !c.card?.after);
    for (const c of missing) t.problem('bug', `${c.id} has no card.before / card.after in content/campaign.json`);
    t.event('cards-data', `${CHAPTERS.length - missing.length} of ${CHAPTERS.length} episodes have a before and after card line`);
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
    t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    this.cardAuto = true;
    this.cardsSeen = 0;
    try {
      await this.campaignFrom(from, () => false, from);
    } finally {
      this.game.setCampaignProgress(before);
    }
    t.metric('cardsSeen', this.cardsSeen);
    if (this.cardsSeen < 2) t.problem('bug', `only ${this.cardsSeen} story card(s) shown for the episode (a before and an after card are expected)`);
  }

  /** The 'quota' objective's chapter alone (`chapter` option, default the first one that uses it), played from the map. */
  async quotaObjective(): Promise<void> {
    const t = this.t;
    const asked = this.options.chapter ?? CHAPTERS.find((c) => c.fight.objective === 'quota')?.id;
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    if (from < 0 || CHAPTERS[from].fight.objective !== 'quota') {
      t.problem('bug', `chapter "${String(asked)}" is not a quota chapter (content/campaign.json: objective "quota")`);
      t.finish('error');
      return;
    }
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
    t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    const t0 = performance.now();
    try {
      await this.campaignFrom(from, () => performance.now() - t0 > CAMPAIGN_BUDGET_MS, from);
    } finally {
      this.game.setCampaignProgress(before);
    }
  }

  /** A chapter with a quota: the HUD chip must show it from the start and follow the damage dealt. Call it every poll. */
  private watchQuota(c: (typeof CHAPTERS)[number]): () => void {
    if (c.fight.objective !== 'quota') return () => {};
    const t = this.t;
    const need = c.fight.quota ?? 250;
    const chip = () => this.q('#objective');
    const shown = (el: HTMLElement | null) => !!el && !el.hidden && el.getClientRects().length > 0;
    let last = '';
    let marks = 0;
    return () => {
      const m = this.game.match();
      const now = chip()?.textContent ?? '';
      if (!m || now === last) return;
      const first = last === '';
      last = now;
      const got = Number(/(\d+)\//.exec(now)?.[1] ?? 0);
      const dealt = Math.floor(Math.min(m.quotaDealt(), m.quotaTarget) / 10);
      if (!shown(chip())) t.problem('bug', 'the quota chapter shows no objective chip on the HUD');
      else if (first && now !== `Quota 0/${need}%`) t.problem('bug', `the quota chip starts at "${now}", not "Quota 0/${need}%"`);
      else if (first) t.event('quota-chip', `${now} with ${this.q('#timer')?.textContent ?? '?'} on the clock`);
      // The chip is read a moment after the frame it shows, so it may trail the damage by a hit or two but never lead it.
      else if (got > dealt || dealt - got > 30) t.problem('bug', `the quota chip says "${now}" but ${dealt}% was dealt`);
      // One event per 100% crossed, so the timeline shows it counting up without flooding it.
      if (!first && Math.floor(got / 100) > marks) {
        marks = Math.floor(got / 100);
        t.event('quota-count', `${now} with ${this.q('#timer')?.textContent ?? '?'} on the clock`);
      }
    };
  }

  /** On the results of a quota chapter: the line says which way it went (the number dealt, or why it fell short). */
  private async checkQuotaResult(c: (typeof CHAPTERS)[number]): Promise<void> {
    if (c.fight.objective !== 'quota') return;
    const m = this.game.match() ?? this.seen;
    const line = () => this.q('#results-body .results-objective');
    await this.t.until(() => !!line()?.textContent, 10000, 'the quota results line').catch((e) => {
      if (String(e).includes('stopped')) throw e;
    });
    const says = line()?.textContent ?? '';
    const need = c.fight.quota ?? 250;
    const met = !!m && m.quotaDealt() >= m.quotaTarget;
    const right = met ? says.startsWith(`${need}%`) : m?.state.timedOut ? says.startsWith('Time ran out') : !!says;
    if (!right) this.t.problem('bug', `the results line "${says}" doesn't match how the quota fight ended (${met ? 'quota met' : m?.state.timedOut ? 'on time' : 'out of stocks'})`);
    else this.t.event('quota-result', `${met ? 'quota met' : m?.state.timedOut ? 'ended on time' : 'out of stocks'} at ${m ? Math.round(m.state.frame / 60) : '?'} s: "${says}"`);
  }

  /** The 'streak' objective's chapter alone (`chapter` option, default the first one that uses it), played from the map. */
  async streakObjective(): Promise<void> {
    const t = this.t;
    const asked = this.options.chapter ?? CHAPTERS.find((c) => c.fight.objective === 'streak')?.id;
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    if (from < 0 || CHAPTERS[from].fight.objective !== 'streak') {
      t.problem('bug', `chapter "${String(asked)}" is not a streak chapter (content/campaign.json: objective "streak")`);
      t.finish('error');
      return;
    }
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
    t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    const t0 = performance.now();
    try {
      await this.campaignFrom(from, () => performance.now() - t0 > CAMPAIGN_BUDGET_MS, from);
    } finally {
      this.game.setCampaignProgress(before);
    }
  }

  /** A chapter with a clean streak: the HUD chip must show it from the start and follow the sim's streak (up on a hit landed, back to 0 on a hit taken). Call it every poll. */
  private watchStreak(c: (typeof CHAPTERS)[number]): () => void {
    if (c.fight.objective !== 'streak') return () => {};
    const t = this.t;
    const need = c.fight.streak ?? 4;
    const chip = () => this.q('#objective');
    const shown = (el: HTMLElement | null) => !!el && !el.hidden && el.getClientRects().length > 0;
    let last = '';
    let top = 0;
    let resets = 0;
    return () => {
      const m = this.game.match();
      const now = chip()?.textContent ?? '';
      if (!m || now === last) return;
      const first = last === '';
      const prev = Number(/(\d+)\//.exec(last)?.[1] ?? 0);
      last = now;
      const got = Number(/(\d+)\//.exec(now)?.[1] ?? -1);
      if (!shown(chip())) t.problem('bug', 'the streak chapter shows no objective chip on the HUD');
      else if (first && now !== `Clean streak 0/${need}`) t.problem('bug', `the streak chip starts at "${now}", not "Clean streak 0/${need}"`);
      else if (first) t.event('streak-chip', `${now} with ${this.q('#timer')?.textContent ?? '?'} on the clock`);
      else if (got < 0 || got > need) t.problem('bug', `the streak chip says "${now}"`);
      else if (got > top) {
        top = got;
        t.event('streak-count', `${now} with ${this.q('#timer')?.textContent ?? '?'} on the clock`);
      } else if (got < prev) {
        resets++;
        if (resets <= 3) t.event('streak-reset', `${now}: a hit taken started the count over (best ${m.streakBest()})`);
      }
    };
  }

  /** On the results of a streak chapter: the line says which way it went (the best streak, or why it fell short). */
  private async checkStreakResult(c: (typeof CHAPTERS)[number]): Promise<void> {
    if (c.fight.objective !== 'streak') return;
    const m = this.game.match() ?? this.seen;
    const line = () => this.q('#results-body .results-objective');
    await this.t.until(() => !!line()?.textContent, 10000, 'the streak results line').catch((e) => {
      if (String(e).includes('stopped')) throw e;
    });
    const says = line()?.textContent ?? '';
    const need = c.fight.streak ?? 4;
    const met = !!m && m.streakBest() >= m.streakTarget;
    const right = met ? says.startsWith(`${need} clean hits`) : m?.state.timedOut ? says.startsWith('Time ran out') : !!says;
    if (!right) this.t.problem('bug', `the results line "${says}" doesn't match how the streak fight ended (${met ? 'streak met' : m?.state.timedOut ? 'on time' : 'out of stocks'})`);
    else this.t.event('streak-result', `${met ? 'streak met' : m?.state.timedOut ? 'ended on time' : 'out of stocks'} at ${m ? Math.round(m.state.frame / 60) : '?'} s, best streak ${m?.streakBest() ?? '?'}: "${says}"`);
  }

  /** A chapter that names a fighter shows the unlock message on the map once it is cleared (campaign/story.ts `unlock`). */
  private checkUnlockNote(fighter: string | undefined): void {
    if (!fighter) return;
    const note = this.q('#chapter-path .unlock-note');
    const name = CHARACTERS.find((c) => c.id === fighter)?.name ?? fighter;
    this.t.event('unlock-message', `${note?.textContent?.trim() || 'no unlock message'} (${fighter} ${isUnlocked(fighter) ? 'unlocked' : 'STILL LOCKED'})`);
    if (note?.getAttribute('data-unlocked') !== fighter) this.t.problem('bug', `clearing the chapter that unlocks ${name} showed no unlock message on the Campaign map`);
    if (!isUnlocked(fighter)) this.t.problem('bug', `${name} is still locked after clearing the chapter that unlocks them`);
  }

  /** Main menu → Versus → the Character Select grid (no fight); returns the tiles. */
  private async openSelect(): Promise<void> {
    await this.click(() => this.q('[data-go="versus"]'), 'Versus');
    await this.screen('select');
  }

  private async closeSelect(): Promise<void> {
    await this.click(() => this.q('#select [data-back]'), 'Back');
    await this.screen('main');
  }

  /**
   * Heroes unlock as the campaign clears them. Setup shortcut: a fresh save (no cleared chapters, no unlocks).
   * 1. Versus select shows the locked fighters as "Locked" tiles, and a click on one picks nothing.
   * 2. Chapter 1 is played through the real campaign (bot); the map shows the unlock message.
   * 3. Versus select again: that fighter's tile is open and a click picks them.
   * The player's own saves are put back.
   */
  async unlocksRun(): Promise<void> {
    const t = this.t;
    const first = CHAPTERS.find((c) => c.unlock);
    if (!first?.unlock) {
      t.problem('bug', 'no chapter in content/campaign.json names a fighter to unlock');
      t.finish('error');
      return;
    }
    const target = first.unlock;
    const tileOf = (id: string) => document.querySelector<HTMLElement>(`#select-grid .tile[data-fighter="${id}"]`);
    const name = CHARACTERS.find((c) => c.id === target)?.name ?? target;
    const savedUnlocks = [...unlocks()];
    const before = this.game.setCampaignProgress([]);
    unlocks().clear();
    saveUnlocks(unlocks());
    t.log('setup shortcut: a fresh save (no chapters cleared, nothing unlocked)');
    try {
      await this.toMainMenu();
      t.progress(0.05);
      // 1. A fresh save: locked tiles.
      await this.openSelect();
      await this.t.until(() => document.querySelectorAll('#select-grid .tile').length > 0, 5000, 'fighter tiles');
      const locked = document.querySelectorAll('#select-grid .tile.locked').length;
      t.event('locked-tiles', `fresh save: ${locked} of ${CHARACTERS.length} fighter tiles locked (expected ${LOCKABLE.size}); ${name}: ${tileOf(target)?.classList.contains('locked') ? 'locked' : 'open'}`);
      t.metric('lockedTiles', locked);
      if (locked !== LOCKABLE.size || !tileOf(target)?.classList.contains('locked')) t.problem('bug', `a fresh save should show ${LOCKABLE.size} locked tiles including ${name}, not ${locked}`);
      const slotName = () => this.q('#select-slots .slot-pick strong')?.textContent ?? '';
      const mine = slotName();
      tileOf(target)?.scrollIntoView({ block: 'center' });
      await this.click(() => tileOf(target), `locked tile ${name}`);
      if (slotName() !== mine) t.problem('bug', `a locked tile (${name}) could be picked in Versus select`);
      else t.event('locked-click', `clicking the locked ${name} tile picks nothing (still ${mine})`);
      await this.closeSelect();
      t.progress(0.1);
      // 2. Clear the chapter that unlocks them, by playing it.
      await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
      await this.screen('campaign');
      this.progressNow = () => 0.1 + 0.8 * Math.min(1, (this.game.match()?.state.fighters.reduce((n, f) => n + (this.game.match()!.setup.stocks - Math.max(0, f.stocks)), 0) ?? 0) / 2);
      const late = () => false;
      // Chapter 1 only; campaignFrom ends the run itself when it is done, so mirror it here.
      await this.playOneChapter(first, late);
      if (!isUnlocked(target)) {
        t.finish('lost');
        return;
      }
      // 3. Versus select: pickable now.
      await this.click(() => this.q('#campaign [data-back]'), 'Back');
      await this.screen('main');
      await this.openSelect();
      await this.t.until(() => !!tileOf(target), 5000, 'fighter tiles');
      const stillLocked = tileOf(target)?.classList.contains('locked');
      tileOf(target)?.scrollIntoView({ block: 'center' });
      await this.click(() => tileOf(target), `tile ${name}`);
      const picked = slotName();
      t.event('unlocked-pick', `${name} is ${stillLocked ? 'STILL LOCKED' : 'open'} in Versus select; your slot after the click: ${picked}`);
      if (stillLocked || picked !== name) t.problem('bug', `${name} is not pickable in Versus select after clearing ${first.title}`);
      await this.closeSelect();
      t.progress(1);
      t.finish(stillLocked || picked !== name ? 'lost' : 'won');
    } finally {
      this.game.setCampaignProgress(before);
      unlocks().clear();
      for (const id of savedUnlocks) unlocks().add(id);
      saveUnlocks(unlocks());
    }
  }

  /** One chapter from the open Campaign map to its cleared outro, two tries; the unlock message is checked. */
  private async playOneChapter(c: (typeof CHAPTERS)[number], late: () => boolean): Promise<void> {
    const t = this.t;
    const label = `Chapter ${CHAPTERS.indexOf(c) + 1} · ${c.title}`;
    t.event('chapter', label);
    await this.click(() => this.q(`#chapter-path .chapter[data-chapter="${c.id}"]`), label);
    await this.playDialogue();
    await this.matchLive();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ended = await this.fight(late, 8 * 60 * 1000);
      if (ended === 'stopped') return;
      if (await this.results()) {
        await this.click(() => this.button('#results-actions', 'Continue'), 'Continue');
        await this.playDialogue();
        await this.screen('campaign');
        t.event('chapter-cleared', label);
        this.checkUnlockNote(c.unlock);
        return;
      }
      if (attempt === 2) break;
      t.add('retries');
      await this.click(() => this.button('#results-actions', 'Retry'), 'Retry');
      await this.matchLive();
    }
    t.event('chapter-failed', label);
  }

  /** After a season's last chapter is cleared, the map shows that season's end line under it (story.ts SEASON_TEXT). */
  private checkSeasonEnd(season: number, chapterId: string): void {
    const s = SEASONS.find((x) => x.number === season);
    if (!s || s.chapters[s.chapters.length - 1]?.id !== chapterId) return;
    const shown = this.q(`#chapter-path .season[data-season="${season}"] .season-end`)?.textContent?.trim() ?? '';
    this.t.event('season-end', `Season ${season}: ${shown || 'no end line'}`);
    if (shown !== s.end) this.t.problem('bug', `campaign map: Season ${season} is cleared but shows "${shown}" under it, not "${s.end}"`);
  }

  /**
   * The campaign map: a "Season N" heading over each season's chapters (as content/campaign.json
   * places them), nothing wider than the window, and on a 720p-or-taller window Season 1 fits on screen.
   */
  private checkCampaignMap(startSeason = 1): void {
    const t = this.t;
    const screen = this.q('#campaign');
    const sections = [...document.querySelectorAll<HTMLElement>('#chapter-path .season')];
    for (const n of new Set(CHAPTERS.map((c) => c.season))) {
      const sec = sections.find((e) => e.dataset.season === String(n));
      const heading = sec?.querySelector('.season-head h3')?.textContent ?? '';
      const shown = [...(sec?.querySelectorAll<HTMLElement>('.chapter') ?? [])].map((e) => e.dataset.chapter);
      const want = CHAPTERS.filter((c) => c.season === n).map((c) => c.id);
      t.event('season', `${heading || `no heading for season ${n}`}: ${shown.length} chapters (${shown.join(', ')})${sec?.classList.contains('locked') ? ', locked' : ''}`);
      const sub = SEASONS.find((x) => x.number === n)?.subtitle ?? '';
      const headShown = sec?.querySelector('.season-head .season-sub')?.textContent ?? '';
      if (n <= startSeason && sub && headShown !== sub) t.problem('bug', `campaign map: Season ${n} is named "${headShown}", not "${sub}"`);
      if (/finale/i.test(headShown)) t.problem('bug', `campaign map: Season ${n} still says "${headShown}"`);
      if (n > startSeason && sec && !sec.classList.contains('locked')) t.problem('bug', `campaign map: Season ${n} is open though Season ${n - 1} is not cleared`);
      if (heading !== `Season ${n}`) t.problem('bug', `campaign map: season ${n} has the heading "${heading}", not "Season ${n}"`);
      if (shown.join() !== want.join()) t.problem('bug', `campaign map: Season ${n} shows ${shown.join(', ') || 'nothing'}, not ${want.join(', ')}`);
    }
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const wide = [...document.querySelectorAll<HTMLElement>('#campaign .season-head, #campaign .chapter, #campaign .season-end')]
      .filter((e) => e.getBoundingClientRect().right > vw + 1 || e.getBoundingClientRect().left < -1);
    const sideways = screen ? screen.scrollWidth > screen.clientWidth + 1 : false;
    const firstSeason = sections[0]?.querySelectorAll<HTMLElement>('.chapter');
    const bottom = firstSeason?.length ? Math.max(...[...firstSeason].map((e) => e.getBoundingClientRect().bottom)) : 0;
    t.event('map-fit', `${vw}x${vh}: ${sideways || wide.length ? 'overflows sideways' : 'no sideways overflow'}; Season 1 ends at ${Math.round(bottom)}px`);
    if (sideways || wide.length) t.problem('bug', `campaign map overflows a ${vw}x${vh} window sideways (${wide.length} cards or headings past the edge)`);
    if (vh >= 720 && vw >= 1200 && bottom > vh) t.problem('polish', `campaign map: Season 1 runs past the bottom of a ${vw}x${vh} window (${Math.round(bottom)}px)`);
  }

  // ---------------------------------------------------------- analytics (Hawkes Analytics, analytics.ts)

  /** The feedback card after a match: it appears (not mid-match), and its close button dismisses it. */
  private async feedbackCard(id: string, question: string): Promise<void> {
    const t = this.t;
    const host = () => document.querySelector<HTMLElement>(`[data-hawkes-ask="${id}"]`);
    try {
      await t.until(() => host()?.shadowRoot?.querySelector('.ha-c'), 6000, `the "${question}" card`);
    } catch {
      t.problem('bug', `the "${question}" feedback card did not appear on the results screen`);
      return;
    }
    const root = host()!.shadowRoot!;
    const asked = root.querySelector('.ha-q')?.textContent ?? '';
    if (asked !== question) t.problem('bug', `the feedback card asks "${asked}", not "${question}"`);
    t.event('feedback-prompt', `"${asked}" (${root.querySelectorAll('.ha-r button').length} choices) on the results screen`);
    // Seen for a moment, then closed with its × like a player who doesn't want to answer.
    await t.wait(1500);
    t.log('click the feedback card\'s close button');
    root.querySelector<HTMLElement>('.ha-x')?.click();
    try {
      await t.until(() => !host(), 3000, 'the feedback card to close');
      t.event('feedback-dismissed', `"${asked}" closed with ×`);
    } catch {
      t.problem('bug', 'the feedback card did not close when its × was pressed');
    }
  }

  /** The analytics events of this run, as they went out: each name in `need`, with the build and env they carry. */
  private async analyticsSent(need: string[]): Promise<void> {
    const t = this.t;
    const a = window.hawkesAnalytics as typeof window.hawkesAnalytics | undefined;
    if (!a?.version) {
      t.problem('bug', 'Hawkes Analytics did not load on the game page (hawkesgen.ai/sdk/analytics@1.js)');
      return;
    }
    const cfg = a.config();
    const key = (e: { name: string; props?: Record<string, unknown> }) => (e.name === 'feature' ? String(e.props?.name ?? '') : e.name);
    const mine = () => a.debugLog.filter((e) => need.includes(key(e)));
    // Batches go every 5 s: send now, then wait for each one's `sent` mark.
    a.flush();
    await t.until(() => need.every((n) => mine().some((e) => key(e) === n && e.sent)), 12000, 'the analytics events to go out').catch(() => undefined);
    const build = cfg.build ? `${cfg.build.version ?? '?'} (commit ${cfg.build.commit ?? 'none'}, ${cfg.build.date ?? 'no date'})` : 'no build';
    t.event('analytics', `product ${cfg.product} · build ${build} · env ${cfg.env} · ${a.debugLog.length} events so far`);
    if (!cfg.build?.commit || !cfg.build?.date) t.problem('bug', `analytics events carry no build commit or date (${build})`);
    for (const n of need) {
      const list = a.debugLog.filter((e) => key(e) === n);
      const last = list[list.length - 1];
      if (!last) {
        t.problem('bug', `no "${n}" analytics event was made in this run`);
        continue;
      }
      const props = Object.entries(last.props ?? {})
        .filter(([k, v]) => k !== 'name' && v !== undefined)
        .slice(0, 6)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      const sent = list.filter((e) => e.sent).length;
      t.event('analytics-event', `${n} ×${list.length} (${sent} sent) · screen ${last.screen ?? '-'} · ${props}`);
      if (!sent) t.problem('bug', `the "${n}" analytics event was made but its batch never went out`);
    }
    t.metric('analyticsEvents', a.debugLog.length);
  }

  // ---------------------------------------------------------- online

  /** Two tabs (peers: 2) in one private test lobby: see each other, rename, queue, get matched, fight, results. */
  async online(): Promise<void> {
    const t = this.t;
    // Online loads after boot (net/loader.ts): wait for it rather than race it.
    const net = await Promise.race([onlineReady(), new Promise<null>((r) => setTimeout(() => r(null), 60000))]);
    const parts = net?.onlineParts() ?? null;
    if (!net || !parts) {
      t.problem('bug', 'online play did not start on this page (see the console)');
      t.finish('error');
      return;
    }
    const { PLAYTEST_PEER, TEST_LOBBY, sharedBoard, profileId } = net;
    const peer = Math.max(0, PLAYTEST_PEER);
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
    const openIds = CHARACTERS.filter((c) => isUnlocked(c.id)).map((c) => c.id);
    const avatar = openIds[Math.abs(this.options.seed * 13 + 5) % openIds.length];
    if (peer === 1) {
      await this.click(() => this.q('#btn-profile'), 'Profile');
      const input = this.q('#profile-name') as HTMLInputElement;
      input.focus();
      input.value = NEW_NAME;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await this.click(() => this.q(`#profile-grid [data-avatar="${avatar}"]`), `picture ${avatar}`);
      await this.click(() => this.q('#profile-save'), 'Save');
      t.event('profile', `renamed to ${NEW_NAME}, picture ${avatar}`);
      await this.avatarFace(this.q('#profile-img') as HTMLImageElement, 'the Profile button');
    } else {
      const seen = () => [...document.querySelectorAll<HTMLElement>('#lobby-list .lobby-player')].find((li) => li.textContent?.includes(NEW_NAME));
      await t.until(() => !!seen(), 60000, `the other player's new name "${NEW_NAME}" on the menu`);
      const img = seen()!.querySelector('img');
      if (!img?.getAttribute('src')?.includes(avatar)) t.problem('bug', `the other player's new picture (${avatar}) isn't shown with their name`);
      t.event('profile-seen', `the menu shows ${NEW_NAME} with ${avatar}`);
      await this.avatarFace(img, 'the online list');
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
      // For its first 5 s the chip says "Searching. Play anything while you wait.", then "Searching for opponent…".
      await t.until(() => !this.q('#mm-chip')?.hidden && /Searching( for opponent)?\b/.test(this.q('#mm-chip')?.textContent ?? ''), 10000, 'the "Searching for opponent…" chip');
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
    if (banner() && !banner()!.hidden) await this.avatarFace(this.q('#mm-found-img') as HTMLImageElement, 'the match-found banner');
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

    // 7. The rating change on the result: both signatures in, "+16" / "−16" for two new players.
    const rating = () => this.q('#results-rating');
    await t.until(() => /confirmed|expected|void|same/.test(rating()?.dataset.state ?? ''), 20000, 'the rating change on the result');
    const ratingText = rating()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    t.event('rating-change', ratingText);
    if (rating()?.dataset.state !== 'confirmed') t.problem('bug', `the rating change isn't confirmed by both players: "${ratingText}"`);
    const delta = Number(/([+\u2212])(\d+)/.exec(ratingText)?.slice(1).join('').replace('\u2212', '-') ?? NaN);
    if (!Number.isFinite(delta) || (won ? delta <= 0 : delta >= 0)) t.problem('bug', `the rating change "${ratingText}" doesn't fit "${headline}"`);
    t.metric('ratingChange', delta);
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(0.97);

    // 8. The Leaderboard: both players, the same ranks on both tabs (each peer checks the table it must be: the
    // winner first at 1000 + d, the loser second at 1000 - d), and the other player's own result from Hawkes Net's records.
    await this.click(() => this.q('#btn-board'), 'Leaderboard');
    await this.screen('leaderboard');
    const me = profileId();
    const rows = () => [...document.querySelectorAll<HTMLElement>('#board-list .board-row')].map((li) => ({
      id: li.dataset.player ?? '',
      rank: Number(li.dataset.rank),
      name: li.querySelector('.board-name strong')?.textContent ?? '',
      rating: Number(li.querySelector('.board-rating')?.textContent),
      wl: li.querySelector('.board-wl')?.textContent ?? '',
    }));
    const other0 = () => rows().find((r) => r.id !== me)?.id ?? '';
    for (const tab of ['all', 'week']) {
      await this.click(() => this.q(`#board-tabs [data-tab="${tab}"]`), tab === 'all' ? 'All time' : 'This week');
      await t.until(() => rows().length >= 2 && rows().some((r) => r.id === me) && rows().some((r) => r.name === opp), 30000, `both players on the ${tab === 'all' ? 'all-time' : 'weekly'} leaderboard`);
      const list = rows();
      t.event('leaderboard', `${tab}: ${list.map((r) => `#${r.rank} ${r.name} ${r.rating} ${r.wl}`).join(' | ')}`);
      const mine = list.find((r) => r.id === me)!;
      const theirs = list.find((r) => r.id !== me)!;
      const d = Math.abs(delta);
      const want = won ? { mine: [1, 1000 + d], theirs: [2, 1000 - d] } : { mine: [2, 1000 - d], theirs: [1, 1000 + d] };
      if (mine.rank !== want.mine[0] || mine.rating !== want.mine[1] || theirs.rank !== want.theirs[0] || theirs.rating !== want.theirs[1]) {
        t.problem('bug', `the ${tab} leaderboard shows #${mine.rank} ${mine.rating} (me) and #${theirs.rank} ${theirs.rating} (${theirs.name}); expected #${want.mine.join(' ')} and #${want.theirs.join(' ')}`);
      }
      if (!this.q('#board-list .board-row.you')) t.problem('bug', 'no "You" row on the leaderboard');
      if (this.q('#board-you .board-row')) t.problem('bug', 'your row is on the leaderboard twice (listed and pinned)');
      if (tab === 'all') await this.avatarFace(document.querySelector<HTMLImageElement>(`#board-list .board-row[data-player="${other0()}"] img`), 'the leaderboard');
    }
    const other = rows().find((r) => r.id !== me)?.id ?? '';
    const heard = await t.until(() => !!sharedBoard()?.heardFrom.has(other), 60000, "the other player's own result from Hawkes Net's records").then(() => true, () => false);
    if (heard) t.event('leaderboard-relay', `${opp}'s signed result arrived from Hawkes Net's records`);
    else t.problem('warning', `${opp}'s own copy of the result never arrived from Hawkes Net's records (our local copy is what the table shows)`);
    await this.click(() => this.q('#leaderboard [data-back]'), 'Back');
    await this.screen('main');
    t.progress(1);
    t.finish(won ? 'won' : 'lost');
  }

  /** The 'ko' objective, both ways it ends: on the third KO, and on time. */
  async koObjective(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    const id = (list: { id: string }[], want: string) => Math.max(0, list.findIndex((x) => x.id === want));
    const rounds: { name: string; foe: MatchSetup['slots'][number]; secs: number; expect: 'kos' | 'time' }[] = [
      { name: 'Round 1 (3 KOs)', foe: { char: id(CHARACTERS, 'kaelen'), cpu: 1, team: 1, stocks: 9, startPercent: 1200 }, secs: 120, expect: 'kos' },
      { name: 'Round 2 (time)', foe: { char: id(CHARACTERS, 'break'), cpu: 9, team: 1, stocks: 9, scale: 135 }, secs: 20, expect: 'time' },
    ];
    for (const [i, r] of rounds.entries()) {
      t.progress(0.05 + i * 0.45);
      t.event('round', r.name);
      // Setup shortcut: straight into the match, no menus.
      void this.game.startMatch({
        // A campaign fight (the objective's home), so the results read Cleared / Knocked out.
        mode: 'campaign', stage: id(STAGES, 'yo-house'), stocks: 9, rules: { timeLimit: r.secs * 60 },
        objective: 'ko', kos: 3, title: r.name,
        slots: [{ char: id(CHARACTERS, 'exit-punk'), cpu: null, team: 0, stocks: 9 }, r.foe],
      });
      await this.matchLive();
      const m = this.game.match()!;
      const chip = () => this.q('#objective');
      const timer = () => this.q('#timer');
      const shown = (el: HTMLElement | null) => !!el && !el.hidden && el.getClientRects().length > 0;
      let last = chip()?.textContent ?? '';
      if (!shown(chip()) || last !== 'KOs 0/3') { t.problem('bug', `the ko objective chip shows "${last}" (${shown(chip()) ? 'shown' : 'hidden'}), not "KOs 0/3"`); }
      else t.event('ko-chip', last);
      if (!shown(timer()) || !timer()!.textContent) { t.problem('bug', 'the ko objective match shows no clock'); }
      else t.event('ko-clock', timer()!.textContent!);
      this.progressNow = () => 0.1 + i * 0.45 + 0.35 * Math.min(1, m.state.frame / (r.secs * 60));
      await this.fight(() => {
        const now = chip()?.textContent ?? '';
        if (now !== last) {
          last = now;
          const want = `KOs ${Math.min(3, m.koCount())}/3`;
          if (now === want) t.event('ko-count', `${now} with ${timer()?.textContent ?? '?'} on the clock`);
          else { t.problem('bug', `the ko chip says "${now}" after ${m.koCount()} KOs (want "${want}")`); }
        }
        return false;
      }, (r.secs + 90) * 1000 * 4);
      const ended = m.koCount() >= 3 && !m.state.timedOut ? 'kos' : m.state.timedOut ? 'time' : 'stocks';
      await this.results();
      const lineEl = () => this.q('#results-body .results-objective');
      await this.t.until(() => !!lineEl()?.textContent, 10000, 'the ko objective results line').catch((e) => {
        if (String(e).includes('stopped')) throw e;
      });
      const says = lineEl()?.textContent ?? '';
      const right = ended === 'kos' ? says.startsWith('3 KOs') : ended === 'time' ? says.startsWith('Time ran out') : says.startsWith('Out of stocks');
      if (!right) { t.problem('bug', `the results line "${says}" doesn't say the match ended ${ended === 'kos' ? 'on 3 KOs' : ended === 'time' ? 'on time' : 'out of stocks'}`); }
      else t.event('ko-result', `${ended === 'kos' ? 'ended on 3 KOs' : ended === 'time' ? 'ended on time' : 'ended out of stocks'} at ${Math.round(m.state.frame / 60)} s: "${says}"`);
      if (ended !== r.expect) t.problem('warning', `${r.name} was meant to end ${r.expect === 'kos' ? 'on 3 KOs' : 'on time'} but ended ${ended === 'kos' ? 'on 3 KOs' : ended === 'time' ? 'on time' : 'out of stocks'}`);
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * Every fighter spawns in Training and does each move from its input, and every one of the four specials is logged
   * (`special`: slot, name, archetype, whether it came out). The report lists each fighter's four archetypes (`kit`)
   * and fails when two fighters share them (`kits-distinct`). On a phone (touch, 390x844 turned to 844x390) the 20
   * fighters outside Season 1 fire all four specials and the command grab through the on-screen stick and Special
   * button only (`touch-special`, `touch-grab`), and the run counts any special that needed a button the touch layout
   * doesn't have (`specialsOutsideTouch`, must stay 0). Options: `fighter` (one id), `input: "touch"`, `at`.
   */
  async roster(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('roster');
    }
    if (touch) {
      this.logViewport(this.isPhone());
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      await this.toMainMenu();
      const stage = stagesFor('training')[0]?.index ?? 0;
      // Each fighter's four specials as archetypes (neutral/side/up/down); no two fighters may share them.
      const kits = new Map<string, string>();
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : touch ? CHARACTERS.map((c) => c.id).filter((id) => !SEASON_ONE.includes(id)) : CHARACTERS.map((c) => c.id);
      let outside = 0;
      for (const [n, id] of ids.entries()) {
        const i = CHARACTERS.findIndex((c) => c.id === id);
        if (i < 0) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        const c = CHARACTERS[i];
        this.progressNow = () => n / ids.length;
        t.progress(n / ids.length);
        t.event('fighter', c.name);
        // Setup shortcut: straight into training, no menus.
        void this.game.startMatch({
          mode: 'training', stage, stocks: 1, rules: {},
          slots: [{ char: i, cpu: null }, { char: (i + 1) % CHARACTERS.length, cpu: 0 }],
        });
        await this.matchLive();
        // Hitbox view (H) on from the first fighter, so the footage shows the boxes on the drawn limbs.
        if (n === 0 && !touch) pressAction('KeyH', true);
        await this.checkFighter(c.id);
        const kit = SPECIAL_MOVES.map((m) => kindOf(c.moves[m])).join('/');
        if (c.specials) {
          kits.set(c.id, kit);
          t.event('kit', `${c.name}: ${SPECIAL_MOVES.map((m) => c.moves[m].name).join(' / ')} (${kit})`);
        }
        if (touch) outside += await this.touchKit(c.name, c);
        else await this.everyMove(c.name);
        // Every fighter grabs the dummy and throws it all four ways (keyboard or the touch buttons and stick).
        const gpad = touch ? makeTouchPad() : makeKeyboardPad();
        if (gpad) {
          this.manual = NO_INPUT;
          const got = await this.grabThrows(c.name, gpad, touch ? 'touch' : 'keyboard');
          if (got.size === 4) t.add('fightersThrowAll');
        }
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
        t.add('fightersTested');
      }
      const byKit = new Map<string, string[]>();
      for (const [id, kit] of kits) byKit.set(kit, [...(byKit.get(kit) ?? []), id]);
      const same = [...byKit].filter(([, kitIds]) => kitIds.length > 1);
      if (same.length) t.problem('bug', `Fighters share the same four specials: ${same.map(([k, kitIds]) => `${kitIds.join(' + ')} (${k})`).join('; ')}`);
      else if (kits.size) t.event('kits-distinct', `${kits.size} fighters, ${kits.size} different kits of four specials`);
      if (typeof this.options.fighter !== 'string' && kits.size !== ids.length) t.problem('bug', `only ${kits.size} of ${ids.length} fighters have their own four specials`);
      if (touch) {
        t.metric('specialsOutsideTouch', outside);
        t.event('touch-layout', outside === 0 ? 'every special was fired from the existing touch controls (stick + Special): none needed another button' : `${outside} specials did not come out from the touch controls`);
      }
    } finally {
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * One fighter's four specials from the touch controls only: the stick pushed a direction, then the Special button
   * (touch pointer events). Returns how many did not come out (those would need a button the layout does not have).
   */
  private async touchKit(who: string, c: (typeof CHARACTERS)[number]): Promise<number> {
    const t = this.t;
    const pad = makeTouchPad();
    if (!pad) {
      t.problem('bug', `${who}: the touch controls (stick and Special button) were not built`);
      return SPECIAL_MOVES.length;
    }
    const match = () => this.game.match()!;
    const me = () => match().state.fighters[match().player];
    const frame = () => this.game.match()?.state.frame ?? 0;
    const frames = async (n: number) => {
      const end = frame() + n;
      await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
    };
    this.manual = NO_INPUT;
    const standing = () => {
      const f = me();
      return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
    };
    const settle = async () => {
      pad.release();
      try {
        await t.until(standing, 10000, 'the fighter to stand');
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      await frames(8);
    };
    const dummyAt = () => match().state.fighters.find((f) => f.id !== match().player)!;
    const slots: { slot: string; label: string; sx: number; sy: number; move: number }[] = [
      { slot: 'neutral', label: 'Special', sx: 0, sy: 0, move: MOVE.NSPECIAL },
      { slot: 'side', label: 'stick right + Special', sx: 100, sy: 0, move: MOVE.SSPECIAL },
      { slot: 'up', label: 'stick up + Special', sx: 0, sy: 100, move: MOVE.UPB },
      { slot: 'down', label: 'stick down + Special', sx: 0, sy: -100, move: MOVE.DSPECIAL },
    ];
    let missing = 0;
    for (const sl of slots) {
      await settle();
      // Face the dummy, so side and neutral specials point at it.
      pad.stick(dummyAt().x >= me().x ? 100 : -100, 0);
      await frames(2);
      pad.stick(0, 0);
      await frames(2);
      this.movesSeen.clear();
      pad.stick(sl.sx, sl.sy);
      await frames(3);
      pad.special(true);
      await frames(4);
      pad.special(false);
      try {
        await t.until(() => this.movesSeen.has(sl.move), 4000, `${who}'s ${sl.slot} special to come out`);
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      const mv = c.moves[sl.move];
      if (!this.movesSeen.has(sl.move)) {
        missing++;
        t.problem('bug', `${who}: ${sl.label} did not do the ${sl.slot} special "${mv.name}" from the touch controls (did ${[...this.movesSeen].map((x) => MOVE_NAMES[x]).join(', ') || 'nothing'})`);
      } else {
        t.event('touch-special', `${who}: ${sl.label} -> ${sl.slot} special "${mv.name}" (${kindOf(mv)}), no extra button`);
        t.add('touchSpecials');
        if (mv.kind === 'grab') {
          t.event('touch-grab', `${who}: "${mv.name}", the command grab, came out of ${sl.label}`);
          t.add('touchGrabs');
        }
      }
      pad.stick(0, 0);
    }
    pad.release();
    if (!SPECIAL_MOVES.some((m) => c.moves[m].kind === 'grab')) t.event('touch-grab', `${who}: no command grab in this kit (${SPECIAL_MOVES.map((m) => kindOf(c.moves[m])).join('/')})`);
    await settle();
    return missing;
  }


  // ---------------------------------------------------------- grab and throws

  /** Every grab, whoever made it: logged with the frames the hold lasts (hold grows with the victim's damage). */
  private grabSeen(m: Match, e: Extract<SimEvent, { type: 'grab' }>): void {
    const pct = Math.round((m.state.fighters[e.victim]?.percent ?? 0) / 10);
    this.t.event('grab', `${name(m, e.attacker)} grabbed ${name(m, e.victim)}${e.shield ? ' through their shield' : ''} at ${pct}%: held ${e.hold} frames`);
    this.t.add('grabs');
    if (e.shield) this.t.add('shieldGrabs');
    this.t.event('grab-hold-frames', `${pct}% -> ${e.hold} frames`);
    this.holds.set(Math.round(pct / 100) * 100, e.hold);
    this.t.metric(`holdFrames${Math.round(pct / 100) * 100}`, e.hold);
  }

  private throwSeen(m: Match, e: Extract<SimEvent, { type: 'throw' }>): void {
    const kind = ['forward', 'back', 'up', 'down'][e.kind] ?? String(e.kind);
    this.t.event('throw', `${name(m, e.attacker)} threw ${name(m, e.victim)}: ${kind} throw`);
    this.t.add('throws');
    this.throwsSeen.add(e.kind);
  }

  private readonly holds = new Map<number, number>();
  private readonly throwsSeen = new Set<number>();

  /**
   * Grab and the four throws on the dummy, from real input: Shield + Attack together (keyboard L + J, or both touch
   * buttons), then the stick forward, back, up or down. The fighter first walks up to the dummy. Returns the throws
   * (0 forward .. 3 down) that came out.
   */
  private async grabThrows(who: string, pad: Pad, how: string): Promise<Set<number>> {
    const t = this.t;
    const match = () => this.game.match()!;
    const me = () => match().state.fighters[match().player];
    const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
    const frame = () => this.game.match()?.state.frame ?? 0;
    const frames = async (n: number) => {
      const end = frame() + n;
      await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
    };
    const standing = () => {
      const f = me();
      return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
    };
    const got = new Set<number>();
    const dirs: { kind: number; label: string; sx: number; sy: number }[] = [
      { kind: 0, label: 'forward', sx: 100, sy: 0 },
      { kind: 1, label: 'back', sx: -100, sy: 0 },
      { kind: 2, label: 'up', sx: 0, sy: 100 },
      { kind: 3, label: 'down', sx: 0, sy: -100 },
    ];
    for (const d of dirs) {
      pad.release();
      try {
        await t.until(standing, 10000, 'the fighter to stand');
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      await frames(10);
      // Walk to the dummy until it is inside the grab's reach, facing it.
      const toward = () => (dummy().x >= me().x ? 1 : -1);
      const reach = CHARACTERS[me().char].grabReach * 0.7;
      const gap = () => Math.abs(dummy().x - me().x) / FX;
      if (gap() > reach || me().facing !== toward()) {
        const dir = toward();
        pad.stick(dir * 100, 0);
        try {
          await t.until(() => gap() < reach && me().facing === toward(), 8000, `${who} to walk up to the dummy`);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        } finally {
          pad.stick(0, 0);
        }
        await frames(6);
      }
      // Shield and Attack together: the grab.
      this.throwsSeen.delete(d.kind);
      pad.button('shield', true);
      pad.button('attack', true);
      await frames(3);
      pad.button('attack', false);
      pad.button('shield', false);
      try {
        await t.until(() => me().action === ACT.GRAB_HOLD, 3000, `${who}'s grab to catch the dummy`);
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      if (me().action !== ACT.GRAB_HOLD) {
        t.problem('bug', `${how}: ${who}'s Shield + Attack did not grab the dummy (${ACT_NAMES[me().action]}, ${Math.round(gap())} units away)`);
        continue;
      }
      await frames(10);
      // The stick picks the throw.
      pad.stick(d.kind === 0 ? me().facing * 100 : d.kind === 1 ? -me().facing * 100 : 0, d.sy);
      try {
        await t.until(() => this.throwsSeen.has(d.kind), 3000, `${who}'s ${d.label} throw`);
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      pad.stick(0, 0);
      if (this.throwsSeen.has(d.kind)) got.add(d.kind);
      else t.problem('bug', `${how}: ${who}: the stick ${d.label} after a grab did not do the ${d.label} throw`);
      // Let the dummy land and recover before the next one.
      await frames(70);
    }
    pad.release();
    if (got.size === 4) t.event('grab-throws', `${how}: ${who} grabbed the dummy and threw it all four ways (forward, back, up, down)`);
    else t.problem('bug', `${how}: ${who} threw the dummy only ${got.size} of 4 ways`);
    return got;
  }

  /**
   * Grab: Exit Punk in Training grabs the dummy with Shield + Attack and throws it forward, back, up and down by the
   * stick (touch: both buttons pressed together and the on-screen stick, at 390x844 turned to landscape), then
   * again on a dummy at 100% to show the hold lasts longer than at 0% (`grab-hold-frames`, `holds-longer`).
   * Setup shortcut: straight into Training; the second dummy starts at 100%.
   */
  async grabRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('grab');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const stage = stagesFor('training')[0]?.index ?? 0;
      let thrown = 0;
      for (const [n, percent] of [0, 1000].entries()) {
        void this.game.startMatch({
          mode: 'training', stage, stocks: 1, rules: {},
          slots: [{ char: punk, cpu: null }, { char: (punk + 1) % CHARACTERS.length, cpu: 0, startPercent: percent }],
        });
        await this.matchLive();
        this.manual = NO_INPUT;
        const pad = touch ? makeTouchPad() : makeKeyboardPad();
        if (!pad) {
          t.problem('bug', 'the touch controls (stick, Attack and Shield) were not built');
          t.finish('error');
          return;
        }
        if (touch && n === 0) t.event('phone-shot', `training with the touch overlay: Shield + Attack together grab, the stick picks the throw (${innerWidth}x${innerHeight})`);
        const got = await this.grabThrows('Exit Punk', pad, how);
        thrown += got.size;
        if (touch && got.size > 0) t.event('touch-grab', `Shield + Attack touched together grabbed the dummy and the stick threw it (${[...got].map((k) => ['forward', 'back', 'up', 'down'][k]).join(', ')})`);
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
        t.progress(0.2 + 0.4 * (n + 1));
      }
      const low = this.holds.get(0);
      const high = this.holds.get(1000);
      if (low !== undefined && high !== undefined && high > low) t.event('holds-longer', `a dummy at 100% was held ${high} frames, at 0% only ${low} frames`);
      else t.problem('bug', `the hold did not grow with damage (0%: ${low ?? 'no grab'} frames, 100%: ${high ?? 'no grab'} frames)`);
      t.metric('throwsLanded', thrown);
    } finally {
      this.useTap = false;
      forceTouchUi(false);
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- character select: the specials preview

  /**
   * Character select shows how each fighter plays: tapping (or hovering) a fighter lists its four specials by name
   * and loops a clip of one of them. Played through real input (a phone: touch taps; a desktop: mouse clicks),
   * Training's select (every fighter open), all 33 fighters in turn (option `fighter`: just that one).
   * Per fighter: the four rows read the move names the sim plays (`select-specials`), nothing is clipped by the
   * screen edge or the preview's own edge (`select-fit`), and the clip moves between two looks (`select-clip`).
   * On a portrait phone window the run turns the phone, like specials does.
   */
  async selectSpecials(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('select-specials');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      await this.click(() => this.q('[data-go="training"]'), 'Training');
      await this.screen('select');
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : CHARACTERS.filter((c) => c.specials).map((c) => c.id);
      let shown = 0;
      for (const [k, id] of ids.entries()) {
        t.progress(0.05 + (0.9 * k) / ids.length);
        const ci = CHARACTERS.findIndex((c) => c.id === id);
        if (ci < 0) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        const c = CHARACTERS[ci];
        // A tap on the fighter's tile (its picture): the preview follows the finger.
        await this.click(() => this.q(`#select-grid .tile[data-fighter="${id}"]`), c.name);
        const panel = () => this.q(`#select-preview .specials[data-fighter="${id}"]`);
        await t.until(() => !!panel() && panel()!.querySelectorAll('.sp-row').length === 4, 6000, `${c.name}'s four specials on the preview`);
        const rows = [...panel()!.querySelectorAll<HTMLElement>('.sp-row')];
        const want = [MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL].map((m) => c.moves[m].name);
        const have = rows.map((r) => r.querySelector('.sp-name')?.textContent?.trim() ?? '');
        if (want.join('|') !== have.join('|')) t.problem('bug', `${c.name}: character select lists ${have.join(', ')} but the fighter plays ${want.join(', ')}`);
        else t.event('select-specials', `${c.name}: ${have.join(' / ')}`);
        // Nothing clipped: the clip and every row sit inside the screen and inside the preview card.
        const card = this.q('#select-preview')!.getBoundingClientRect();
        const clipped: string[] = [];
        for (const el of [panel()!.querySelector<HTMLElement>('.sp-clip')!, ...rows]) {
          const r = el.getBoundingClientRect();
          const name = el.classList.contains('sp-clip') ? 'clip' : (el.querySelector('.sp-name')?.textContent ?? 'row');
          const out = r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5;
          const outCard = r.left < card.left - 0.5 || r.right > card.right + 0.5 || r.bottom > card.bottom + 0.5;
          const text = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
          if (out) clipped.push(`${name} past the screen edge`);
          else if (outCard) clipped.push(`${name} past the preview's edge`);
          else if (text && !el.classList.contains('sp-clip')) clipped.push(`${name} text cut off`);
        }
        if (clipped.length) t.problem('bug', `${c.name}: specials preview clipped at ${innerWidth}x${innerHeight}: ${clipped.join('; ')}`);
        else {
          t.event('select-fit', `${c.name}: four specials and the clip fit at ${innerWidth}x${innerHeight}`);
          shown++;
        }
        // The clip plays: what is drawn changes over the next second and a half.
        const canvas = panel()!.querySelector<HTMLCanvasElement>('.sp-clip')!;
        const look = () => {
          const g = canvas.getContext('2d');
          if (!g) return '';
          const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
          let a = 0;
          let hsh = 0;
          for (let i = 0; i < d.length; i += 16) {
            a += d[i + 3] > 200 ? 1 : 0;
            hsh = (hsh * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
          }
          return `${a}:${hsh}`;
        };
        const looks = new Set<string>();
        for (let i = 0; i < 12 && looks.size < 3; i++) {
          looks.add(look());
          await t.wait(130);
        }
        if (looks.size >= 2 && ![...looks].every((l) => l.startsWith('0:'))) t.event('select-clip', `${c.name}: the clip preview is moving (${looks.size} different frames in 1.5 s)`);
        else t.problem('bug', `${c.name}: the clip preview on character select is not playing (${looks.size} distinct frames)`);
        // Tapping a special's row pins it: it highlights and the clip changes to that move.
        const down = rows[3];
        await this.click(() => this.q(`#select-preview .specials[data-fighter="${id}"] .sp-row[data-slot="down"]`) ?? down, `${c.name}: ${have[3]}`);
        if (!panel()?.querySelector('.sp-row[data-slot="down"].on')) t.problem('bug', `${c.name}: tapping the down special did not select it`);
        t.add('fightersShown');
      }
      t.metric('selectFits', shown);
      t.progress(1);
    } finally {
      this.useTap = false;
      forceTouchUi(false);
    }
    t.finish('done');
  }

  // ---------------------------------------------------------- specials


  /**
   * Specials: Exit Punk in Training does a different special from each direction (K, K+side, K+down, K+up), and
   * the thrown board crosses the stage, hits the dummy and is gone (and, thrown away from it, runs out its
   * lifetime). Played through real input: the keyboard on a desktop, the on-screen stick and Special button on a
   * phone (touch pointer events, nothing else; no extra button on the overlay). Setup shortcut: straight into
   * training (no menus). Options: input (touch forces the overlay on a desktop window), at (phone).
   */
  async specialsRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    // A portrait phone window can't hold a match (the Rotate prompt): turn the phone, like touch-match does.
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('specials');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      if (punk < 0) {
        t.problem('bug', 'Exit Punk is not on the roster');
        t.finish('error');
        return;
      }
      const stage = stagesFor('training')[0]?.index ?? 0;
      void this.game.startMatch({
        mode: 'training', stage, stocks: 1, rules: {},
        slots: [{ char: punk, cpu: null }, { char: (punk + 1) % CHARACTERS.length, cpu: 0 }],
      });
      await this.matchLive();
      // The virtual pad adds nothing: only the keyboard or the on-screen controls move the fighter.
      this.manual = NO_INPUT;
      t.progress(0.1);

      const match = () => this.game.match()!;
      const me = () => match().state.fighters[match().player];
      const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
      };

      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls (stick and Special button) were not built');
        t.finish('error');
        return;
      }
      if (touch) t.event('phone-shot', `training with the touch overlay (stick + Special, no extra button) at ${innerWidth}x${innerHeight}`);

      const standing = () => {
        const f = me();
        return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      };
      const settle = async () => {
        pad.release();
        await t.until(standing, 10000, 'the fighter to stand');
        await frames(8);
      };
      /** Walks (the stick) until `done`, then lets go. */
      const walk = async (dir: number, done: () => boolean, what: string) => {
        pad.stick(dir * 100, 0);
        try {
          await t.until(done, 12000, what);
        } finally {
          pad.stick(0, 0);
        }
      };

      // Face the dummy and walk into the board's range.
      const toward = () => (dummy().x >= me().x ? 1 : -1);
      const gap = () => Math.abs(dummy().x - me().x) / FX;
      await walk(toward(), () => gap() < 460, 'Exit Punk to walk toward the dummy');
      await settle();
      t.progress(0.25);

      // Neutral: the thrown board. Thrown at the dummy it crosses the stage and hits; thrown away it runs out its lifetime.
      const owner = () => match().player;
      const board = () => match().state.shots.filter((o) => o.owner === owner() && o.kind === 0);
      const throwBoard = async (): Promise<{ shot: boolean; travelled: number; frames: number; dmg: number; gone: boolean }> => {
        await settle();
        const d0 = dummy().percent;
        const startX = me().x;
        let shot = false;
        let travelled = 0;
        let life = 0;
        pad.stick(0, 0);
        pad.special(true);
        await frames(3);
        pad.special(false);
        try {
          await t.until(() => {
            const b = board();
            if (b.length) {
              shot = true;
              life++;
              travelled = Math.max(travelled, ...b.map((o) => Math.abs(o.x - startX) / FX));
            }
            return shot && b.length === 0;
          }, 15000, 'the board to hit or run out');
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        }
        return { shot, travelled: Math.round(travelled), frames: life, dmg: dummy().percent - d0, gone: board().length === 0 };
      };
      this.movesSeen.clear();
      const hit = await throwBoard();
      if (!hit.shot) t.problem('bug', `${how}: pressing Special (neutral) with Exit Punk threw no board`);
      else if (hit.dmg <= 0) t.problem('bug', `${how}: the thrown board went ${hit.travelled} units and never hurt the dummy`);
      else if (!hit.gone) t.problem('bug', `${how}: the board is still in play after it hit the dummy`);
      else t.event('projectile-hit', `${how}: the board crossed ${hit.travelled} units in ${hit.frames} frames, hit the dummy (+${(hit.dmg / 10).toFixed(1)}%) and disappeared`);
      const neutralSeen = this.movesSeen.has(MOVE.NSPECIAL);
      t.progress(0.4);

      // Thrown the other way it hits nobody and goes at the end of its lifetime.
      await settle();
      await walk(-toward(), () => me().facing === -toward(), 'Exit Punk to turn away');
      const away = await throwBoard();
      if (!away.shot) t.problem('bug', `${how}: the second board never appeared`);
      else if (!away.gone) t.problem('bug', `${how}: a board that missed is still in play`);
      else if (away.dmg > 0) t.problem('bug', `${how}: a board thrown away from the dummy hurt it`);
      else t.event('projectile-lifetime', `${how}: a board thrown away from the dummy flew ${away.travelled} units for ${away.frames} frames and disappeared (lifetime ${CHARACTERS[punk].moves[MOVE.NSPECIAL].shot?.life} frames)`);
      t.progress(0.55);

      // The other three, each from its own stick direction with Special held.
      interface Try { slot: string; label: string; sx: number; sy: number; move: number }
      const tries: Try[] = [
        { slot: 'side', label: touch ? 'stick right + Special' : 'K + right', sx: 100, sy: 0, move: MOVE.SSPECIAL },
        { slot: 'down', label: touch ? 'stick down + Special' : 'K + down', sx: 0, sy: -100, move: MOVE.DSPECIAL },
        { slot: 'up', label: touch ? 'stick up + Special' : 'K + up', sx: 0, sy: 100, move: MOVE.UPB },
      ];
      const moved = new Set<number>(neutralSeen ? [MOVE.NSPECIAL] : []);
      for (const [i, tr] of tries.entries()) {
        await settle();
        this.movesSeen.clear();
        const x0 = me().x;
        pad.stick(tr.sx, tr.sy);
        await frames(3);
        pad.special(true);
        await frames(4);
        pad.special(false);
        try {
          await t.until(() => this.movesSeen.has(tr.move), 4000, `the ${tr.slot} special to come out`);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        }
        const seen = [...this.movesSeen];
        const others = seen.filter((x) => x !== tr.move);
        if (!this.movesSeen.has(tr.move)) {
          t.problem('bug', `${how}: ${tr.label} did not do Exit Punk's ${tr.slot} special (did ${seen.map((x) => MOVE_NAMES[x]).join(', ') || 'nothing'})`);
        } else {
          moved.add(tr.move);
          const trap = match().state.shots.some((o) => o.owner === owner() && o.kind === 1);
          const dx = Math.round(Math.abs(me().x - x0) / FX);
          const shown = tr.slot === 'side' ? `skate dash, moved ${dx} units` : tr.slot === 'down' ? `kickflip trap ${trap ? 'placed on the floor' : 'thrown'}` : `ollie, climbed to ${Math.round(me().y / FX)} units`;
          t.event(`special-${tr.slot}`, `${how}: ${tr.label} -> ${MOVE_NAMES[tr.move]} (${shown})${others.length ? `; also saw ${others.map((x) => MOVE_NAMES[x]).join(', ')}` : ''}`);
          if (touch && tr.slot !== 'up') t.event(`touch-${tr.slot}-special`, `${tr.label} fired the ${tr.slot} special (${MOVE_NAMES[tr.move]}) with no extra button on the overlay`);
        }
        pad.stick(0, 0);
        if (touch && i === 1) t.event('phone-shot', `down special placed the kickflip trap at ${innerWidth}x${innerHeight}`);
        t.progress(0.55 + (i + 1) * 0.12);
      }
      pad.release();
      await settle();
      if (moved.size === 4) t.event('specials-distinct', `${how}: four different specials from four inputs (${[...moved].map((x) => MOVE_NAMES[x]).join(', ')})`);
      else t.problem('bug', `${how}: only ${moved.size} different specials came out of the four inputs (${[...moved].map((x) => MOVE_NAMES[x]).join(', ')})`);
      t.add('specialsSeen', moved.size);
      this.manual = null;
      await this.game.quitMatch();
      await this.screen('main');
    } finally {
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- sound-settings

  /** The studio standard: the Tap to play prompt, sound running, Settings from the menu and Pause, kept across a reload. */
  // ---------------------------------------------------------- hit-feel

  /**
   * Input buffer (~0.1 s / 6 frames) and coyote time (~0.1 s / 6 frames): drills in training through the virtual pad
   * (same path as keyboard, gamepad and touch), then a short versus fight so median input-to-action latency is measured.
   */
  async inputFeel(): Promise<void> {
    const t = this.t;
    t.metric('feel.coyoteMs', Math.round((COYOTE_FRAMES * 1000) / 60));
    t.metric('feel.jumpBufferMs', Math.round((BUFFER_FRAMES * 1000) / 60));

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
      await this.t.until(() => {
        const f = me();
        return !!f && f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      }, 10000, 'the fighter to stand');
      await hold(NO_INPUT, 4);
    };

    await this.toMainMenu();
    t.progress(0.05);
    const stage = stagesFor('training')[0]?.index ?? 0;
    // Setup shortcut: straight into training for the buffer and coyote drills (no menus).
    void this.game.startMatch({
      mode: 'training',
      stage,
      stocks: 1,
      rules: {},
      slots: [{ char: 0, cpu: null }, { char: 1, cpu: 0 }],
    });
    await this.matchLive();
    t.progress(0.15);

    // --- Buffer: press jump / attack / special / shield in the last frames of a jab; each must come out.
    const bufferButtons: { name: string; btn: number; want: number }[] = [
      { name: 'jump', btn: BTN.JUMP, want: ACT.JUMPSQUAT },
      { name: 'attack', btn: BTN.ATTACK, want: ACT.ATTACK },
      { name: 'special', btn: BTN.SPECIAL, want: ACT.ATTACK },
      { name: 'shield', btn: BTN.SHIELD, want: ACT.SHIELD },
    ];
    let bufferedOk = 0;
    for (const b of bufferButtons) {
      await settle();
      const before = this.game.match()?.bufferedActions ?? 0;
      await hold(packInput(0, 0, BTN.ATTACK), 2);
      await this.t.until(() => me()?.action === ACT.ATTACK, 2000, 'jab to start');
      const f0 = me();
      if (!f0) continue;
      const pressAt = Math.max(1, f0.length - Math.min(BUFFER_FRAMES, 3));
      const wait = Math.max(0, pressAt - f0.frame);
      if (wait > 0) await hold(NO_INPUT, wait);
      await hold(packInput(0, 0, b.btn), 1);
      await hold(NO_INPUT, BUFFER_FRAMES + 4);
      const f1 = me();
      const got = !!f1 && f1.action === b.want;
      const counted = (this.game.match()?.bufferedActions ?? 0) > before;
      if (got || counted) {
        bufferedOk++;
        t.event('input-buffer', `${b.name} pressed ${BUFFER_FRAMES}-frame window before recovery came out`);
      } else {
        t.problem('bug', `buffered ${b.name} did not come out (action ${f1?.action ?? 'none'}, want ${b.want})`);
      }
    }
    t.metric('bufferedInputs', this.game.match()?.bufferedActions ?? bufferedOk);
    t.progress(0.45);

    // --- Coyote: walk off the platform edge, jump within 6 frames, get a ground jump.
    await settle();
    const coyoteBefore = this.game.match()?.coyoteJumps ?? 0;
    let leftGround = false;
    for (let i = 0; i < 240 && !leftGround; i++) {
      await hold(packInput(100, 0, 0), 1);
      const f = me();
      if (f && !f.grounded) leftGround = true;
    }
    if (!leftGround) {
      t.problem('bug', 'could not walk off a ledge for the coyote drill');
    } else {
      const coyoteLeft = me()?.coyote ?? 0;
      await hold(packInput(100, 0, 0), Math.min(3, Math.max(0, coyoteLeft - 1)));
      await hold(packInput(100, 0, BTN.JUMP), 2);
      await hold(NO_INPUT, 8);
      const jumped = (this.game.match()?.coyoteJumps ?? 0) > coyoteBefore;
      if (jumped) {
        t.event('coyote-jump', `jump ${Math.min(3, coyoteLeft)} frames after leaving the ledge (${COYOTE_FRAMES}-frame / ~100 ms coyote)`);
      } else {
        t.problem('bug', `coyote jump did not come out (coyote was ${coyoteLeft} at the edge)`);
      }
    }
    t.metric('coyoteJumps', this.game.match()?.coyoteJumps ?? 0);
    this.manual = null;
    await this.game.quitMatch();
    await this.screen('main');
    t.progress(0.6);

    // --- Latency: a short versus match; the bot on the virtual pad feeds the same input path.
    await this.startVersus(2);
    t.progress(0.7);
    const m0 = () => this.game.match();
    this.progressNow = () => 0.7 + 0.25 * Math.min(1, (m0()?.state.frame ?? 0) / (45 * 60));
    await this.fight(() => (m0()?.inputLatencies.length ?? 0) >= 8 || (m0()?.state.frame ?? 0) > 45 * 60, 2 * 60 * 1000);
    const m = m0() ?? this.seen;
    if (m) {
      const lat = m.latencyStats();
      t.metric('inputLatencyMedianMs', lat.median);
      t.metric('inputLatencyWorstMs', lat.worst);
      t.metric('inputLatencyMs', lat.median);
      t.metric('inputLatencySamples', lat.samples);
      t.metric('feel.inputLatencyMs', lat.median);
      t.metric('feel.inputLatencyWorstMs', lat.worst);
      t.metric('feel.inputSamples', lat.samples);
      if (lat.samples < 5) t.problem('bug', `too few input-latency samples (${lat.samples})`);
      else if (lat.median >= 100) t.problem('bug', `median input-to-action latency ${lat.median} ms (want under 100)`);
      else t.event('input-latency', `median ${lat.median} ms, worst ${lat.worst} ms across ${lat.samples} inputs`);
    } else {
      t.problem('bug', 'no match to measure input latency');
    }
    if (currentScreen() === 'results') {
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
    } else if (this.game.phase() === 'play' || this.game.phase() === 'pause' || currentScreen() === 'match') {
      await this.quitFromPause('main');
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * Hit feedback: a versus match against the CPU (the bot on a virtual pad). Shows that heavier hits freeze longer
   * (hit-stop frames counted from the sim's own hitlag), that light and heavy hits get different impact effects, and
   * that Settings → Screen shake turns the camera shake off (reached from Pause, like a player).
   */
  async hitFeel(): Promise<void> {
    const t = this.t;
    const original = localStorage.getItem(SHAKE_STORAGE_KEY);
    try {
      localStorage.removeItem(SHAKE_STORAGE_KEY);
    } catch {
      // Storage blocked.
    }
    const seen: Record<HitTier, { lag: number; frozen: number; dmg: number; fx: string } | null> = { light: null, medium: null, heavy: null };
    const fxLine = (l: NonNullable<ReturnType<NonNullable<GameHooks['hitFxStats']>>['last']>) =>
      `${l.sparks} sparks, ${l.stars} impact stars, ${l.ring ? 'shockwave ring' : 'no ring'}, shake ${l.shake.toFixed(2)}, flash ${l.flash}`;
    let cuesPrev = 0;
    let killsCued = 0;
    let killsMissed = 0;
    let falseCues = 0;
    const lastHit = new Map<number, { ko: boolean; frame: number }>();
    const cuePending = new Map<number, number>();
    const pending: { victim: number; tier: HitTier; lag: number; dmg: number; frozen: number; fx: string }[] = [];
    // Launch trails and edge markers: one event per launch (trail kind and puffs) and per fighter that goes off screen.
    let trailSeq = 0;
    let markerSeen = 0;
    let markerProblems = 0;
    const touchUi = this.isPhone() || touchDevice() || this.options.input === 'touch';
    type R4 = { l: number; t: number; r: number; b: number };
    const overlap = (a: R4, b: R4) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const sampleScreen = () => {
      const ms = this.game.markerStats?.();
      if (!ms) return;
      if (ms.shown > markerSeen) {
        for (const e of ms.events.slice(-(ms.shown - markerSeen))) {
          t.event('marker', `fighter ${e.id} is off screen: edge marker with their portrait and an arrow, ${e.size}px${e.danger ? ', red (near the blast line)' : ''}`);
        }
        markerSeen = ms.shown;
      }
      // Safe area and touch controls: every bubble stays inside the window (minus the notch insets) and off the buttons.
      const blockers = [...document.querySelectorAll('.touch-stick, .touch-buttons, .touch-pause, .hud-card')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      for (const mk of ms.rects) {
        const r = mk.rect;
        const hit = blockers.find((b) => overlap(r, { l: b.left, t: b.top, r: b.right, b: b.bottom }));
        if (r.l < 0 || r.t < 0 || r.r > innerWidth || r.b > innerHeight || hit) {
          markerProblems++;
          if (markerProblems <= 3) t.problem('bug', `an edge marker (${Math.round(r.l)},${Math.round(r.t)} to ${Math.round(r.r)},${Math.round(r.b)}) ${hit ? 'sits under a control or damage card' : 'leaves the window'}${touchUi ? ' on the phone layout' : ''}`);
        }
      }
      // Damage numbers: inside the window and clear of the touch buttons.
      for (const el of document.querySelectorAll('.hud-pct')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const under = [...document.querySelectorAll('.touch-stick, .touch-buttons, .touch-pause')].some((b) => {
          const q = b.getBoundingClientRect();
          return q.width > 0 && overlap({ l: r.left, t: r.top, r: r.right, b: r.bottom }, { l: q.left, t: q.top, r: q.right, b: q.bottom });
        });
        if ((r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || under) && !this.checked.has('hud-pct-bad')) {
          this.checked.add('hud-pct-bad');
          t.problem('bug', `a damage number (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)}) ${under ? 'sits under a touch button' : 'leaves the window'}`);
        }
      }
    };
    const unwatch = this.game.watch((m, events) => {
      sampleScreen();
      for (const rec of this.game.trailStats?.()?.log ?? []) {
        if (rec.seq <= trailSeq) continue;
        trailSeq = rec.seq;
        t.event('trail', rec.kind === 'none' ? `launch of fighter ${rec.victim} (${rec.tier} hit, knockback ${rec.kb}): light hit, no smoke trail` : `launch of fighter ${rec.victim} (${rec.tier} hit, knockback ${rec.kb}): ${rec.kind === 'streak' ? 'coloured KO streak' : `${rec.kind} smoke trail`} behind them for the hit-stun`);
      }
      for (const p of pending.slice()) {
        if (m.state.fighters[p.victim].hitlag > 0) p.frozen++;
        else {
          pending.splice(pending.indexOf(p), 1);
          if (!seen[p.tier]) {
            seen[p.tier] = p;
            t.event(`hit-stop-${p.tier}`, `${p.tier} hit (${p.dmg / 10}%): frozen ${p.frozen + 1} frames (sim hit-stop ${p.lag})`);
          }
        }
      }
      // Kill cues: a cue on exactly the hits the sim flagged as stock-ending, and a KO only after such a hit.
      const cues = this.game.camFxStats?.()?.killCues ?? cuesPrev;
      const fresh = cues - cuesPrev;
      cuesPrev = cues;
      const flagged = events.filter((e) => e.type === 'launch' && e.ko).length;
      if (fresh !== flagged) t.problem('bug', `${fresh} kill cue(s) played for ${flagged} stock-ending hit(s) in one tick`);
      for (const e of events) {
        if (e.type === 'launch') {
          lastHit.set(e.victim, { ko: e.ko, frame: m.state.frame });
          if (e.ko) {
            cuePending.set(e.victim, m.state.frame);
            t.event('kill-cue', `launch of fighter ${e.victim} (hit by ${e.by}) carries out of the blast zone: red flash, punch-in, slow motion and whistle, 4 extra hit-stop frames`);
          }
        } else if (e.type === 'ko') {
          const h = lastHit.get(e.victim);
          if (cuePending.delete(e.victim)) killsCued++;
          else if (h && !h.ko && e.by >= 0 && e.by !== e.victim) {
            killsMissed++;
            t.event('kill-cue-missed', `fighter ${e.victim} was KO'd by a hit that was not predicted (${m.state.frame - h.frame} frames after it)`);
          }
        }
      }
      for (const [v, fr] of cuePending) {
        if (m.state.frame - fr > 300) {
          cuePending.delete(v);
          falseCues++;
          t.event('kill-cue-false', `a kill cue played on a hit that did not end the stock (fighter ${v} survived)`);
        }
      }
      for (const e of events) {
        if (e.type !== 'hit' || e.shield) continue;
        const tier = hitTier(e.dmg);
        const last = this.game.hitFxStats?.()?.last;
        pending.push({ victim: e.victim, tier, lag: e.lag, dmg: e.dmg, frozen: 0, fx: last ? fxLine(last) : '' });
        if (!this.checked.has(`impact-${tier}`) && last) {
          this.checked.add(`impact-${tier}`);
          t.event(`impact-${tier}`, `${tier} hit (${e.dmg / 10}%): ${fxLine(last)}`);
        }
      }
    });
    try {
      await this.toMainMenu();
      t.progress(0.05);
      // Screen shake is on by default, and Settings shows it.
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
      const sw = this.q('#shake-switch');
      if (!sw) t.problem('bug', 'Settings has no Screen shake switch');
      else if (sw.getAttribute('aria-checked') !== 'true' || !screenShake()) t.problem('bug', 'Screen shake is not on by default');
      else t.event('shake-default', 'Settings shows Screen shake: On');
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);

      await this.startVersus(3);
      t.progress(0.15);
      this.game.hitFxStats?.(true);
      this.game.camFxStats?.(true);
      cuesPrev = this.game.camFxStats?.()?.killCues ?? 0;
      const m0 = () => this.game.match();
      this.progressNow = () => 0.15 + 0.5 * Math.min(1, ((m0()?.state.frame ?? 0) / (75 * 60)));
      // Fight until a light and a heavy hit were both seen (and counted), or 75 s of game time.
      const ended = await this.fight(() => (!!seen.light && !!seen.heavy) || (m0()?.state.frame ?? 0) > 75 * 60, 4 * 60 * 1000);
      if (ended === 'over') t.problem('warning', 'the match ended before a light and a heavy hit were both seen');
      // Launch trails: a heavy launch left smoke (more puffs with more knockback), a light hit none.
      const tlog = this.game.trailStats?.()?.log ?? [];
      const heavyTrails = tlog.filter((r) => r.tier === 'heavy' && r.kind !== 'none');
      const lightTrails = tlog.filter((r) => r.tier === 'light' && !r.ko);
      t.metric('trailLaunches', tlog.length);
      t.metric('trailPuffsMax', Math.max(0, ...tlog.map((r) => r.puffs)));
      if (!heavyTrails.length) t.problem('warning', 'no heavy launch landed, so the smoke trail could not be checked');
      else if (heavyTrails.every((r) => r.puffs === 0)) t.problem('bug', 'a heavy launch threw no smoke puffs');
      else t.event('trail-heavy', `${heavyTrails.length} heavy launch(es) threw white smoke (most puffs: ${Math.max(...heavyTrails.map((r) => r.puffs))})`);
      if (lightTrails.some((r) => r.puffs > 0)) t.problem('bug', 'a light hit threw a smoke trail');
      else if (lightTrails.length) t.event('trail-light', `${lightTrails.length} light hit(s) launched with no smoke trail`);
      // Damage numbers: white at 0%, red past 120%, and they shake when hit.
      const pcts = [...document.querySelectorAll<HTMLElement>('.hud-pct')];
      for (const el of pcts) {
        if (el.dataset.hits) t.event('damage-shake', `a damage number shook on ${el.dataset.hits} hit(s)${el.dataset.pop === '1' ? ' and popped on a heavy one' : ''}`);
      }
      t.event('damage-color', `damage numbers now: ${pcts.map((e) => `${e.textContent} ${e.style.color}`).join(' | ')}`);
      for (const el of pcts) {
        const v = parseFloat(el.textContent ?? '');
        const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(el.style.color);
        if (!m || Number.isNaN(v)) continue;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (v === 0 && (r < 250 || g < 250 || b < 250)) t.problem('bug', `a damage number at 0% is not white (${el.style.color})`);
        if (v > 120 && !(r > 150 && g < 70 && b < 70)) t.problem('bug', `a damage number at ${v}% is not red (${el.style.color})`);
      }
      // Setup shortcut when nobody was knocked out of view in the fight: the CPU is put by the stage's side blast line (named, not a
      // hit), so the camera's edge shows the marker. The bubble must show a portrait and keep inside the window.
      if (!this.game.markerStats?.()?.shown && m0()) {
        const mm = m0()!;
        const foe = mm.state.fighters.find((f) => f.id !== mm.player);
        const b = STAGES[mm.state.stage].blast;
        if (foe) {
          foe.x = (b.right - 20) * FX;
          foe.y = Math.max(b.bottom + 200, foe.y / FX) * FX;
          foe.vx = foe.vy = foe.kbx = foe.kby = 0;
          t.event('marker-setup', `setup shortcut: fighter ${foe.id} placed 20 units inside the right blast line`);
          await t.wait(900);
        }
      }
      if (!this.game.markerStats?.()?.shown) t.problem('warning', 'no fighter went off screen, so no edge marker was seen (the kill cue usually shows one)');
      else t.metric('markersShown', this.game.markerStats!()!.shown);
      const stats = this.game.hitFxStats?.();
      t.metric('shakeMaxOn', Number((stats?.shakeMax ?? 0).toFixed(3)));
      for (const k of ['light', 'medium', 'heavy'] as const) if (seen[k]) t.metric(`hitStop${k[0].toUpperCase()}${k.slice(1)}Frames`, seen[k]!.frozen + 1);
      const heavy = seen.heavy;
      const light = seen.light;
      if (!heavy) t.problem('bug', 'no heavy hit landed, so heavy hit-stop could not be checked');
      else if (heavy.frozen + 1 < 3) t.problem('bug', `a heavy hit froze only ${heavy.frozen + 1} frames (want at least 3)`);
      else t.event('heavy-hit-stop', `a heavy hit froze both fighters ${heavy.frozen + 1} frames (at least 3)`);
      if (heavy && light) {
        if (heavy.frozen <= light.frozen) t.problem('bug', `a heavy hit froze ${heavy.frozen + 1} frames, no more than a light one (${light.frozen + 1})`);
        if (heavy.fx === light.fx) t.problem('bug', `light and heavy hits show the same impact effect (${heavy.fx})`);
        else t.event('impact-differs', `light: ${light.fx} | heavy: ${heavy.fx}`);
      } else if (!light) t.problem('warning', 'no light hit landed, so the light and heavy impact effects were not compared');
      if (stats && stats.shakeMax <= 0) t.problem('bug', 'hits landed with Screen shake on but the camera never shook');
      t.progress(0.7);

      // Pause → Settings → Screen shake off; the same fight goes on and the camera stays still.
      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      await t.until(settingsShowing, 3000, 'Settings to open from Pause');
      await t.wait(400);
      await this.tap(() => this.q('#shake-switch'), 'Screen shake off');
      if (screenShake() || this.q('#shake-switch')?.getAttribute('aria-checked') !== 'false' || localStorage.getItem(SHAKE_STORAGE_KEY) !== 'off') {
        t.problem('bug', 'Screen shake off did not apply and save');
      } else t.event('shake-off', 'Screen shake switched Off in Settings (saved as dod.shake=off)');
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
      await this.click(() => this.q('#btn-resume'), 'Resume');
      await t.until(() => this.game.phase() === 'play', 3000, 'the match to resume');
      this.game.hitFxStats?.(true);
      const f0 = m0()?.state.frame ?? 0;
      const cuedBefore = killsCued;
      // Four hits, and (up to 90 s of game time) a stock ended by a kill cue, so the cue is seen with shake off.
      await this.fight(() => ((this.game.hitFxStats?.()?.hits ?? 0) >= 4 && killsCued > cuedBefore) || (m0()?.state.frame ?? 0) - f0 > 90 * 60, 3 * 60 * 1000);
      const off = this.game.hitFxStats?.();
      t.metric('shakeMaxOff', Number((off?.shakeMax ?? 0).toFixed(3)));
      if (!off || off.hits === 0) t.problem('warning', 'no hit landed with Screen shake off, so the camera could not be checked');
      else if (off.shakeMax > 0) t.problem('bug', `the camera still shook (${off.shakeMax.toFixed(2)}) with Screen shake off`);
      else t.event('no-shake', `${off.hits} hits landed with Screen shake off and the camera stayed still (hit-stop and impact effects still play)`);
      const cam = this.game.camFxStats?.();
      if (cam) {
        t.metric('cameraJumps', cam.cameraJumps);
        t.metric('killCues', cam.killCues);
        t.metric('killsCued', killsCued);
        t.metric('framingMisses', cam.framingMisses);
        if (cam.slowFpsMin > 0) t.metric('killSlowMinFps', Math.round(cam.slowFpsMin));
        if (cam.cameraJumps > 0) t.problem('bug', `the camera jumped ${cam.cameraJumps} time(s) (moved or zoomed past the threshold in one frame)`);
        else t.event('camera-smooth', 'the match camera never jumped (cameraJumps 0)');
        if (cam.framingMisses > 0) t.problem('bug', `a fighter was outside the view ${cam.framingMisses} time(s) before reaching the blast zone`);
        else t.event('camera-framing', 'every fighter stayed on screen until the blast zone');
        if (cam.slowFpsMin > 0 && cam.slowFpsMin < 40) t.problem('warning', `frame rate dipped to ${Math.round(cam.slowFpsMin)} fps during the kill slow motion (want 40+ on a phone)`);
        if (cam.killCues === 0) t.problem('warning', 'no stock ended in this run, so the kill cue was not seen');
        else {
          if (falseCues > 0) t.problem('bug', `${falseCues} kill cue(s) played on a hit that did not end the stock`);
          if (killsMissed > 0) t.problem('warning', `${killsMissed} of ${killsMissed + killsCued} stocks ended with no kill cue (the victim was launched inside the zone and fell out, so the launch was not a KO)`);
          if (falseCues === 0) t.event('kill-cue-exact', `${killsCued} stock-ending hits played a kill cue, no other hit did (${killsMissed} falls out of a spent launch had none)`);
          const lc = cam.lastCue;
          if (lc && !(lc.zoom && lc.slow && lc.whistle)) t.problem('bug', 'a kill cue was missing its zoom, slow motion or whistle');
          if (lc && lc.punch <= 0.2) t.problem('bug', 'the kill cue did not punch the camera in');
          if (lc && cam.killCues > 0 && !screenShake() && lc.shake > 0) t.problem('bug', 'the kill cue shook the camera with Screen shake off');
          else if (lc && !screenShake()) t.event('kill-cue-no-shake', `with Screen shake off the kill cue still zoomed (punch ${lc.punch.toFixed(2)}) and the shake was ${lc.shake}`);
        }
      }
      t.progress(0.9);

      // Back on for the next visit, then out.
      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
    } finally {
      unwatch();
      try {
        if (original === null) localStorage.removeItem(SHAKE_STORAGE_KEY);
        else localStorage.setItem(SHAKE_STORAGE_KEY, original);
      } catch {
        // Storage blocked.
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- touch-match

  /** Portrait phone → 844x390 landscape frame that plays a touch scenario, touch-match or specials (mirrors smokeTurned). */
  private async touchMatchTurned(scenario = 'touch-match'): Promise<void> {
    const t = this.t;
    this.logViewport(true);
    type Inner = { events: Array<{ type: string; detail?: string }>; problems: Array<{ severity: string; message: string }>; metrics?: Record<string, number>; outcome: string; state?: { progress?: number } };
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:#1c0d06 radial-gradient(ellipse at 50% 45%,#8a3010 0%,#3a1608 45%,#100e0c 80%);z-index:2147483647;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.title = `Phone window turned to landscape (${scenario} playtest)`;
    frame.allow = 'autoplay';
    const w = 844;
    const h = 390;
    const k = Math.min(innerWidth / w, innerHeight / h, 1);
    frame.style.cssText = `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;border:0;transform-origin:0 0;transform:translate(${-(w * k) / 2}px,${-(h * k) / 2}px) scale(${k});background:transparent`;
    back.appendChild(frame);
    const q = new URLSearchParams(location.search);
    q.set('playtest', scenario);
    q.set('at', 'phone-turned');
    if (!q.has('seed')) q.set('seed', String(this.options.seed ?? 1));
    frame.src = `${location.pathname}?${q.toString()}`;
    document.body.appendChild(back);
    const api = () => (frame.contentWindow as (Window & { hawkesPlaytest?: { report(): Inner | null; state(): { progress?: number } | null } }) | null)?.hawkesPlaytest;
    let seen = 0;
    const seenProblems = new Set<string>();
    let heart = 0;
    const forward = (): Inner | null => {
      const r = api()?.report() ?? null;
      if (!r) return null;
      for (const e of r.events.slice(seen)) if (e.type !== 'problem' && e.type !== 'start' && e.type !== 'start-at') t.event(e.type, `${e.detail ?? ''} [landscape frame]`);
      seen = r.events.length;
      for (const p of r.problems) {
        if (!seenProblems.has(p.message)) {
          seenProblems.add(p.message);
          t.problem('bug', `${p.message} [landscape frame]`);
        }
      }
      if (r.metrics) {
        for (const [k, v] of Object.entries(r.metrics)) {
          if (typeof v === 'number' && !k.startsWith('fps')) t.metric(k, v);
        }
      }
      const prog = api()?.state()?.progress;
      if (typeof prog === 'number') t.progress(Math.min(0.99, Math.max(0.05, prog)));
      return r;
    };
    try {
      t.event('phone-turned', `the portrait phone window (${innerWidth}x${innerHeight}) turned to ${w}x${h} (landscape) for ${scenario}`);
      t.progress(0.05);
      await t.until(() => {
        heart += 1;
        if (heart === 1 || heart % 100 === 0) t.event('phone-turn-wait', `waiting for the landscape ${scenario} (${Math.round(heart / 20)} s)`);
        const r = forward();
        return !!r && (r.outcome === 'done' || r.outcome === 'error' || r.outcome === 'stuck' || r.outcome === 'won' || r.outcome === 'lost');
      }, 300000, `the turned phone to play ${scenario}`);
      const r = forward();
      const out = r?.outcome;
      if (out !== 'done' && out !== 'won' && out !== 'lost') {
        t.problem('bug', `${scenario} in the turned phone ended ${out ?? 'without a report'}`);
        t.progress(1);
        t.finish(out === 'stuck' || out === 'error' ? out : 'stuck');
        return;
      }
      t.progress(1);
      t.finish(out === 'won' || out === 'lost' ? out : 'done');
    } finally {
      back.remove();
    }
  }

  /** The safe-area insets in px (notch, home bar), read through a probe element that CSS env() fills in. */
  private safeInsets(): { top: number; right: number; bottom: number; left: number } {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(p);
    const cs = getComputedStyle(p);
    const v = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    p.remove();
    return v;
  }

  /**
   * Touch match: at phone size, menus to the results screen with only pointer events on the on-screen controls
   * (input/touch.ts: the Move stick and Jump, Attack, Special, Shield, Smash, plus Pause). The bot's decisions are
   * turned into touches (stick position, buttons held), nothing goes to the keyboard, the virtual pad or the sim.
   * First every control is checked (present, ≥44 px, inside the window and the safe area, above the canvas / not
   * covered), then a short drill presses each one and checks the game read it, then the bot plays on through touch
   * to the results. Portrait 390x844 first walks menu / Settings for clipping screenshots, then turns to 844x390
   * for the match (same pattern as smoke).
   */
  async touchMatch(): Promise<void> {
    const t = this.t;
    // Portrait phone: clip-check menus upright, then turn to an 844x390 frame so Rotate cannot hold the match.
    if (this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      this.useTap = true;
      forceTouchUi(true);
      try {
        await this.toMainMenu();
        await this.phoneUiClipTour('portrait');
        t.progress(0.08);
      } finally {
        this.useTap = false;
        forceTouchUi(false);
      }
      return this.touchMatchTurned();
    }
    this.logViewport(true);
    this.useTap = true;
    forceTouchUi(true);
    try {
      await this.toMainMenu();
      // Landscape (or already-turned) phone: clip-check every listed screen at this size before the fight.
      if (this.options.at === 'phone-turned' || this.isPhone()) await this.phoneUiClipTour(innerWidth > innerHeight ? 'landscape' : 'portrait');
      t.progress(0.05);
      // Clipping on select / stages / VS is hooked through startVersus.
      this.onVersus = async () => {
        await this.screen('versus', 15000);
        await this.wait(400);
        this.checkClipping('VS screen', this.q('#versus'));
        t.event('phone-shot', `VS screen at ${innerWidth > innerHeight ? 'landscape' : 'portrait'} ${innerWidth}x${innerHeight}`);
        await this.wait(2000);
      };
      await this.startVersus(2);
      this.onVersus = null;
      t.progress(0.15);
      // Upright on a phone the Rotate prompt holds the match: give a runner time to turn the window.
      if (rotateShowing()) {
        t.event('touch-rotate-wait', `the Rotate prompt is up at ${innerWidth}x${innerHeight}; waiting for landscape`);
        try {
          await t.until(() => !rotateShowing(), 30000, 'the window to turn to landscape');
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', `touch-match could not play: the Rotate prompt stayed up at ${innerWidth}x${innerHeight} (run it landscape, 844x390)`);
        }
      }

      const root = touchOverlay() ?? this.q('.touch');
      if (!root) {
        t.problem('bug', 'touch controls overlay (.touch) was not built');
        t.finish('error');
        return;
      }
      if (root.hidden) {
        // A desktop browser keeps the overlay hidden (no coarse pointer): show it as a phone does.
        t.event('touch-forced', 'not a touch device: the overlay was shown for the run');
        root.hidden = false;
      }
      t.event('touch-visible', `touch overlay shown (hidden=${root.hidden}) above canvas at z-index ${getComputedStyle(root).zIndex} in ${innerWidth}x${innerHeight}`);
      const CONTROLS: { key: string; sel: string; name: string }[] = [
        { key: 'stick', sel: '.touch-stick', name: 'Move stick' },
        { key: 'jump', sel: '.touch-btn.jump', name: 'Jump' },
        { key: 'attack', sel: '.touch-btn.attack', name: 'Attack' },
        { key: 'special', sel: '.touch-btn.special', name: 'Special' },
        { key: 'shield', sel: '.touch-btn.shield', name: 'Shield' },
        { key: 'smash', sel: '.touch-btn.smash', name: 'Smash' },
        { key: 'pause', sel: '.touch-pause', name: 'Pause' },
      ];
      // Option drop: hides a control first, to see the missing-control problem.
      const dropped = typeof this.options.drop === 'string' ? this.options.drop : '';
      const dropEl = dropped ? root.querySelector<HTMLElement>(CONTROLS.find((c) => c.key === dropped)?.sel ?? '.none') : null;
      if (dropEl) dropEl.style.display = 'none';
      const find = (key: string) => {
        const el = root.querySelector<HTMLElement>(CONTROLS.find((c) => c.key === key)!.sel);
        return el && el.getClientRects().length > 0 ? el : null;
      };

      // 1. Every control is there, ≥44 px, on screen, clear of the safe area and not covered (incl. by the canvas).
      const inset = this.safeInsets();
      const stage = document.getElementById('stage');
      const stageZ = stage ? Number(getComputedStyle(stage).zIndex) || 0 : 0;
      const touchZ = Number(getComputedStyle(root).zIndex) || 0;
      if (touchZ <= stageZ) {
        t.problem('bug', `touch overlay z-index ${touchZ} is not above the Babylon canvas z-index ${stageZ}`);
      } else {
        t.event('touch-z-order', `touch z-index ${touchZ} above canvas z-index ${stageZ}`);
      }
      let bad = 0;
      let minSide = Infinity;
      for (const c of CONTROLS) {
        const el = find(c.key);
        if (!el) {
          bad++;
          t.problem('bug', `touch control missing: ${c.name} (${c.sel}) is not on the screen`);
          continue;
        }
        const r = el.getBoundingClientRect();
        const side = Math.min(r.width, r.height);
        if (side < minSide) minSide = side;
        const where = `${c.name} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${innerWidth}x${innerHeight}`;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (r.width < 2 || r.height < 2) {
          bad++;
          t.problem('bug', `touch control has no size: ${where}`);
        } else if (side < 43.5) {
          bad++;
          t.problem('bug', `touch control under 44 px: ${where}`);
        } else if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) {
          bad++;
          t.problem('bug', `touch control outside the viewport: ${where}`);
        } else if (r.left < inset.left - 0.5 || r.top < inset.top - 0.5 || r.right > innerWidth - inset.right + 0.5 || r.bottom > innerHeight - inset.bottom + 0.5) {
          bad++;
          t.problem('bug', `touch control under the safe-area inset (top ${inset.top}, right ${inset.right}, bottom ${inset.bottom}, left ${inset.left}): ${where}`);
        } else if (!hit || !el.contains(hit)) {
          bad++;
          const tag = hit?.id ? '#' + hit.id : hit?.tagName.toLowerCase() ?? 'nothing';
          t.problem('bug', `touch control covered: a press on ${where} lands on ${tag}`);
        }
      }
      if (Number.isFinite(minSide)) t.metric('touchMinPx', Math.round(minSide));
      if (!bad) t.event('touch-controls-ok', `all ${CONTROLS.length} controls on screen, ≥44 px (min ${Math.round(minSide)}), clear of the safe area (top ${inset.top}, right ${inset.right}, bottom ${inset.bottom}, left ${inset.left}) and not covered, at ${innerWidth}x${innerHeight}`);
      // Hold a labeled match frame so Studio's screenshots show the stick and buttons (AC1).
      t.event('phone-shot', `match touch controls at landscape ${innerWidth}x${innerHeight}`);
      await this.wait(2200);

      // 2. Touches: a finger on the stick and on each button, as pointer events on the control itself.
      let pid = 100;
      const down = new Map<string, { id: number; el: HTMLElement }>();
      const send = (el: HTMLElement, type: string, x: number, y: number, id: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 100, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
      const stickAt = (sx: number, sy: number) => {
        const el = find('stick');
        if (!el) return;
        const r = el.getBoundingClientRect();
        // The knob's reach is 50/128 of the stick's width.
        const reach = r.width * (50 / 128);
        const x = r.left + r.width / 2 + (sx / 100) * reach;
        const y = r.top + r.height / 2 - (sy / 100) * reach;
        const cur = down.get('stick');
        if (sx === 0 && sy === 0) {
          if (cur) {
            send(el, 'pointerup', x, y, cur.id);
            down.delete('stick');
          }
          return;
        }
        if (!cur) {
          const id = ++pid;
          down.set('stick', { id, el });
          send(el, 'pointerdown', x, y, id);
        } else send(el, 'pointermove', x, y, cur.id);
      };
      const press = (key: string, on: boolean) => {
        const el = find(key);
        const cur = down.get(key);
        if (!el || on === !!cur) return;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (on) {
          const id = ++pid;
          down.set(key, { id, el });
          send(el, 'pointerdown', x, y, id);
        } else {
          send(el, 'pointerup', x, y, cur!.id);
          down.delete(key);
        }
      };
      const releaseAll = () => {
        stickAt(0, 0);
        for (const k of [...down.keys()]) press(k, false);
      };
      const KEYS: { bit: number; key: string }[] = [
        { bit: BTN.JUMP, key: 'jump' },
        { bit: BTN.ATTACK, key: 'attack' },
        { bit: BTN.SPECIAL, key: 'special' },
        { bit: BTN.SHIELD, key: 'shield' },
        { bit: BTN.C_NEUTRAL | BTN.C_UP | BTN.C_DOWN | BTN.C_LEFT | BTN.C_RIGHT, key: 'smash' },
      ];
      const counts: Record<string, number> = { move: 0, jump: 0, attack: 0, special: 0, shield: 0, smash: 0 };
      const frame = () => this.game.match()?.state.frame ?? 0;
      const me = () => {
        const m = this.game.match();
        return m && m.player >= 0 ? m.state.fighters[m.player] : null;
      };
      const logged = new Set<string>();
      /** Counts a touch and logs its event the first time, with what the game's input layer read from it. */
      const note = (what: string, detail: string) => {
        counts[what]++;
        t.add(`touch${what[0].toUpperCase()}${what.slice(1)}s`);
        if (!logged.has(what)) {
          logged.add(what);
          t.event(`touch-${what}`, detail);
        }
      };
      const held = (bit: number) => (readTouch()[2] & bit) !== 0;

      // The drill: each control pressed once, and the input layer must show it was read.
      const drill = async (key: string, bit: number, what: string, label: string) => {
        if (!find(key)) return;
        press(key, true);
        await t.wait(120);
        if (!held(bit)) t.problem('bug', `${label} was touched but the game's input did not read it`);
        else note(what, `${label} touched: read by the game's input (touch buttons ${(readTouch()[2] >> 16).toString(2)})`);
        press(key, false);
        await t.wait(150);
      };
      const x0 = me()?.x ?? 0;
      const fx0 = frame();
      stickAt(100, 0);
      await t.wait(500);
      const [rx, ry] = readTouch();
      if (rx < 50) t.problem('bug', `Move stick was dragged right but the game read x=${rx} y=${ry}`);
      else note('move', `Move stick dragged right: read by the game's input (x ${rx})`);
      await t.until(() => frame() > fx0 + 20, 8000, 'the fighter to move');
      if (me() && Math.abs(me()!.x - x0) < 1) t.event('touch-move-still', 'the stick was read but the fighter has not moved yet (blocked?)');
      stickAt(0, 0);
      await t.wait(100);
      await drill('jump', BTN.JUMP, 'jump', 'Jump');
      await drill('attack', BTN.ATTACK, 'attack', 'Attack');
      await drill('special', BTN.SPECIAL, 'special', 'Special');
      await drill('shield', BTN.SHIELD, 'shield', 'Shield');
      await drill('smash', BTN.C_NEUTRAL, 'smash', 'Smash');
      t.progress(0.25);

      // 3. The bot plays on, through touch only, until the results.
      const bot = () => {
        const m = this.game.match();
        if (!m || m.player < 0) return null;
        if (m !== this.botMatch) {
          this.botMatch = m;
          this.bot = new Bot(m.player, BOT_LEVEL, (this.options.seed * 7919 + this.matches) | 0);
        }
        return { m, b: this.bot! };
      };
      let lastFrame = -1;
      let lastIn = NO_INPUT;
      const prev = new Set<string>();
      this.progressNow = () => {
        const m = this.game.match();
        if (!m) return 0.95;
        const stocks = m.setup.stocks;
        const lost = m.state.fighters.reduce((n, f) => n + (stocks - Math.max(0, f.stocks)), 0);
        return 0.25 + 0.7 * Math.min(1, lost / Math.max(1, (m.state.fighters.length * stocks) / 2));
      };
      const drive = window.setInterval(() => {
        if (this.disposed) return;
        const x = bot();
        if (!x || x.m.state.over || this.game.phase() !== 'play') {
          releaseAll();
          return;
        }
        if (x.m.state.frame !== lastFrame) {
          lastFrame = x.m.state.frame;
          lastIn = x.b.think(x.m.state);
        }
        const sx = stickX(lastIn);
        const sy = stickY(lastIn);
        stickAt(sx, sy);
        if (sx !== 0 || sy !== 0) {
          counts.move++;
          if (!prev.has('stick')) t.add('touchMoves');
          prev.add('stick');
        } else prev.delete('stick');
        for (const k of KEYS) {
          const on = (lastIn & k.bit) !== 0;
          press(k.key, on);
          if (on && !prev.has(k.key)) {
            prev.add(k.key);
            if (k.key !== 'smash' && k.key !== 'shield') {
              counts[k.key]++;
              t.add(`touch${k.key[0].toUpperCase()}${k.key.slice(1)}s`);
            }
          } else if (!on) prev.delete(k.key);
        }
      }, 33);
      try {
        await this.fight(() => false, 6 * 60 * 1000);
      } finally {
        clearInterval(drive);
        releaseAll();
      }
      t.event('touch-summary', `moves ${counts.move}, jumps ${counts.jump}, attacks ${counts.attack}, specials ${counts.special}, shield drills ${counts.shield}, smash drills ${counts.smash} (all pointer events on the on-screen controls)`);
      for (const k of ['move', 'jump', 'attack', 'special'])
        if (!counts[k] && !(dropped && (dropped === k || (k === 'move' && dropped === 'stick')))) t.problem('bug', `no touch ${k} happened in the match`);
      const won = await this.results();
      await this.wait(500);
      this.checkClipping('results', this.q('#results'));
      t.event('phone-shot', `results at landscape ${innerWidth}x${innerHeight}`);
      await this.wait(2000);
      if (dropEl) dropEl.style.display = '';
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      t.progress(1);
      t.finish(won ? 'won' : 'lost');
    } finally {
      this.useTap = false;
      forceTouchUi(false);
      this.onVersus = null;
      setVirtualPad(null);
    }
  }

  /**
   * Walk menu, Settings, character select and stage select at the current phone size (no match start), logging
   * clipping / 44 px targets and phone-shot events so Studio captures a frame of each. Holds ~2 s after each
   * shot so the recorder does not catch the next screen. Used by touch-match at 390x844 (portrait) and again
   * at 844x390 (landscape) before the fight. VS and results need a started match, so those are checked on the
   * landscape path only (portrait Rotate would cover them).
   */
  private async phoneUiClipTour(shape: 'portrait' | 'landscape'): Promise<void> {
    const t = this.t;
    const tag = `${shape} ${innerWidth}x${innerHeight}`;
    const shot = async (where: string, root: HTMLElement | null) => {
      this.checkClipping(where, root);
      t.event('phone-shot', `${where} at ${tag}`);
      await this.wait(2000);
    };
    await this.wait(300);
    await shot('main menu', this.q('#main'));
    await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
    await t.until(settingsShowing, 3000, 'Settings to open');
    await this.wait(200);
    await shot('Settings', this.q('#settings'));
    await this.tap(() => this.q('#settings-done'), 'Done');
    await t.until(() => !settingsShowing(), 3000, 'Settings to close');
    // Character + stage select without starting a match (Back from stages), so portrait gets those shots too.
    await this.tap(() => this.q('[data-go="versus"]'), 'Versus');
    await this.screen('select');
    await this.wait(300);
    await shot('character select', this.q('#select'));
    await this.click(() => this.q('#select-slots .fight'), 'Fight');
    await this.screen('stages');
    await t.until(() => document.querySelectorAll('#stage-grid .stage-card').length > 0, 5000, 'stage cards');
    await this.wait(200);
    await shot('stage select', this.q('#stages'));
    await this.tap(() => this.q('#stages .back-btn'), 'Back');
    await this.screen('select');
    await this.tap(() => this.q('#select .back-btn'), 'Back');
    await this.screen('main');
  }

  // ---------------------------------------------------------- touch-settings

  /**
   * Touch size and Touch opacity (Settings, touch devices): the sliders show, move the stick, buttons and Pause button
   * live in a match (size and fade measured on the real elements, all kept inside the window), are saved in
   * localStorage "dod.touch", and are still set after a reload. The run treats the desktop browser as a touch device.
   */
  async touchSettingsRun(): Promise<void> {
    const t = this.t;
    const carried = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(TOUCH_RUN_KEY) ?? 'null') as { original: string | null } | null;
      } catch {
        return null;
      }
    })();
    const slide = (id: string, value: number, label: string) => {
      const input = this.q(id) as HTMLInputElement;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      t.add('interactions');
      t.log(`slide ${label} to ${value}%`);
    };
    const saved = () => {
      try {
        return JSON.parse(localStorage.getItem(TOUCH_KEY) ?? 'null') as { size: number; opacity: number } | null;
      } catch {
        return null;
      }
    };
    const root = () => touchOverlay() ?? this.q('.touch');
    // The overlay is shown in the match by the game on a phone; on this desktop it is shown here, as checkTouchControls does.
    const measure = () => {
      const r = root();
      if (!r) return null;
      if (r.hidden) r.hidden = false;
      const rect = (sel: string) => (r.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect();
      const stick = rect('.touch-stick');
      const btn = rect('.touch-btn.attack');
      const pause = rect('.touch-pause');
      const opacity = Number(getComputedStyle(r.querySelector('.touch-stick')!).opacity);
      const inside = [...r.querySelectorAll<HTMLElement>('.touch-stick, .touch-btn, .touch-pause')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < -0.5 || b.top < -0.5 || b.right > innerWidth + 0.5 || b.bottom > innerHeight + 0.5;
      });
      return { stick: stick?.width ?? 0, btn: btn?.width ?? 0, pause: pause?.width ?? 0, opacity, outside: inside.length };
    };
    const report = (where: string, want: { size: number; opacity: number }) => {
      const m = measure();
      if (!m) {
        t.problem('bug', `no touch overlay ${where}`);
        return null;
      }
      const sizeOk = Math.abs(m.stick - Math.min(128 * (want.size / 100), innerHeight * 0.36)) < 2;
      if (!sizeOk) t.problem('bug', `${where}: the stick is ${m.stick.toFixed(0)}px wide at Touch size ${want.size}%`);
      if (Math.abs(m.opacity - want.opacity / 100) > 0.02) t.problem('bug', `${where}: the controls' opacity is ${m.opacity} at Touch opacity ${want.opacity}%`);
      if (m.outside) t.problem('bug', `${where}: ${m.outside} touch control(s) leave the ${innerWidth}x${innerHeight} window at Touch size ${want.size}%`);
      t.event('touch-look', `${where}: size ${want.size}% → stick ${m.stick.toFixed(0)}px, Attack ${m.btn.toFixed(0)}px, Pause ${m.pause.toFixed(0)}px; opacity ${want.opacity}% → ${m.opacity}; ${m.outside ? m.outside + ' outside the window' : 'all inside the window'}`);
      return m;
    };
    const openSettings = async (from: 'menu' | 'pause') => {
      if (from === 'menu') await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      else {
        await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
        await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      }
      await t.until(settingsShowing, 3000, `Settings to open from ${from}`);
    };

    forceTouchUi(true);
    try {
      if (!carried) {
        const original = localStorage.getItem(TOUCH_KEY);
        try {
          localStorage.removeItem(TOUCH_KEY);
        } catch {
          // Storage blocked.
        }
        sessionStorage.setItem(TOUCH_RUN_KEY, JSON.stringify({ original }));
        await this.toMainMenu();
        await openSettings('menu');
        const sliders = ['#touch-size', '#touch-opacity'].map((id) => this.q(id) as HTMLInputElement | null);
        const shown = !!sliders[0] && !!sliders[1] && !!this.q('#settings-touch') && !this.q('#settings-touch')!.hidden && sliders[0]!.getBoundingClientRect().width > 0;
        if (!shown) t.problem('bug', 'Settings does not show the Touch size and Touch opacity sliders');
        else t.event('touch-sliders', `Settings shows Touch size ${sliders[0]!.min}-${sliders[0]!.max}% (${sliders[0]!.value}%) and Touch opacity ${sliders[1]!.min}-${sliders[1]!.max}% (${sliders[1]!.value}%)`);
        slide('#touch-size', 150, 'Touch size');
        slide('#touch-opacity', 50, 'Touch opacity');
        const s1 = saved();
        if (!s1 || s1.size !== 150 || s1.opacity !== 50) t.problem('bug', `dod.touch did not save 150% / 50%: ${JSON.stringify(s1)}`);
        else t.event('touch-saved', JSON.stringify(s1));
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.wait(300);
        t.progress(0.2);

        await this.startVersus(3);
        await t.wait(1500);
        const big = report('in a match at the largest size', { size: 150, opacity: 50 });
        t.progress(0.4);
        // Live, from Pause: smallest and nearly opaque, then back to the middle.
        await openSettings('pause');
        slide('#touch-size', 75, 'Touch size');
        slide('#touch-opacity', 100, 'Touch opacity');
        const small = report('after Touch size 75% from Pause', { size: 75, opacity: 100 });
        if (big && small && !(big.stick > small.stick && big.btn > small.btn)) t.problem('bug', `the controls did not shrink (stick ${big.stick}px → ${small.stick}px, Attack ${big.btn}px → ${small.btn}px)`);
        else if (big && small) t.event('touch-resized', `stick ${big.stick.toFixed(0)}px → ${small.stick.toFixed(0)}px, Attack ${big.btn.toFixed(0)}px → ${small.btn.toFixed(0)}px, opacity 0.5 → 1`);
        slide('#touch-size', 120, 'Touch size');
        slide('#touch-opacity', 60, 'Touch opacity');
        report('after Touch size 120% / opacity 60%', { size: 120, opacity: 60 });
        await t.wait(300);
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
        t.progress(0.7);
        await this.click(() => this.q('#btn-quit'), 'Quit');
        await this.screen('main');

        t.event('reload', 'the page reloads; the run carries on after it');
        const url = new URL(location.href);
        url.searchParams.set('playtest', 'touch-settings');
        url.searchParams.set('seed', String(this.options.seed ?? 1));
        url.searchParams.set('speed', String(this.options.speed ?? 1));
        await t.wait(300);
        location.replace(url.toString());
        await new Promise(() => {}); // the page is going away
        return;
      }

      sessionStorage.removeItem(TOUCH_RUN_KEY);
      await this.toMainMenu();
      await openSettings('menu');
      const size = (this.q('#touch-size') as HTMLInputElement).value;
      const op = (this.q('#touch-opacity') as HTMLInputElement).value;
      const s2 = touchSettings();
      if (size !== '120' || op !== '60' || s2.size !== 120 || s2.opacity !== 60) t.problem('bug', `after the reload Settings shows Touch size ${size}% / opacity ${op}% (want 120% / 60%)`);
      else t.event('touch-kept', `after the reload: Touch size ${size}%, Touch opacity ${op}% (${localStorage.getItem(TOUCH_KEY)})`);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);
      t.progress(0.6);
      await this.startVersus(3);
      await t.wait(1500);
      report('in a match after the reload', { size: 120, opacity: 60 });
      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
      // The player's own setting back as it was.
      try {
        if (carried.original === null) localStorage.removeItem(TOUCH_KEY);
        else localStorage.setItem(TOUCH_KEY, carried.original);
      } catch {
        // Storage blocked.
      }
    } finally {
      forceTouchUi(false);
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- graphics

  /**
   * Graphics settings: with nothing saved, Settings shows the device's defaults (touch: Low, glow off; desktop:
   * High, glow on, the old look). In a match, from Pause, Glow, Quality and Show FPS each take effect at once with
   * no reload (the page's load marker survives) and are saved. Logs the settings and render scale (`gfx-*`) and
   * the average frame rate of the fight (metric `fpsMatch`, split by quality). The player's dod.gfx is put back.
   */
  async stageLife(): Promise<void> {
    const t = this.t;
    await this.toMainMenu();
    await this.startVersus(1);
    const m0 = () => this.game.match();
    await this.fight(() => (m0()?.state.frame ?? 0) > 4 * 60, 90000);
    const a = this.game.aliveStats?.();
    if (!a) return t.problem('bug', 'the stage has no living background');
    await this.fight(() => (m0()?.state.frame ?? 0) > 6 * 60, 90000);
    const b = this.game.aliveStats?.();
    const moved = a.positions.filter((p, i) => b?.positions[i].slice(1).join() !== p.slice(1).join()).map((p) => p[0]);
    t.event('stage-life', `moving: ${moved.join(', ')} of ${a.pieces.join(', ')}`);
    if (!moved.length) t.problem('bug', 'nothing in the background moved');
    const g = this.game.gfxStats?.();
    t.event('stage-screen', `quality ${g?.quality}: the stage screen shows ${a.screen === 'live' ? 'the live match (render target)' : 'a looping graphic'}`);
    if (g && (g.quality === 'high') !== (a.screen === 'live')) t.problem('bug', `screen mode ${a.screen} does not match quality ${g.quality}`);
    if (new Set(a.depths).size !== a.depths.length) t.problem('bug', 'two life layers share a depth slot (coplanar)');
    if (a.depths.some((z) => z <= 0)) t.problem('bug', 'a life layer is not behind the fighters');
    t.event('stage-depths', `fixed slots ${a.depths.join(', ')}, all behind the fighters`);
    const fps = g?.fpsNow ?? 0;
    t.metric('fpsStageLife', Math.round(fps));
    if (g?.quality === 'low' && innerWidth <= 900 && fps > 0 && fps < 45) t.problem('warning', `phone-size Low ran at ${Math.round(fps)} fps (want 45)`);
  }

  /**
   * Layered stage bed: ambience under the theme at calm, lift to intense on last stock / ≥100%,
   * final-KO sting without cutting the music, and mute/volume still covering every layer.
   */
  async stageBed(): Promise<void> {
    const t = this.t;
    const original = localStorage.getItem(SOUND_KEY);
    const bed = () => this.game.musicBedStats?.() ?? null;
    let changes = 0;
    let sawCalm = false;
    let sawIntense = false;
    let lastState: string | null = null;
    const unwatch = this.game.watch(() => {
      const b = bed();
      if (!b?.state) return;
      if (b.state !== lastState) {
        lastState = b.state;
        changes++;
        if (b.state === 'calm' && !sawCalm) {
          sawCalm = true;
          t.event('music-calm', `${b.stageId}: theme ${b.music}, ambience ${b.ambience ?? 'procedural-only'} (${b.bed}), ambienceOn=${b.ambienceOn}`);
        }
        if (b.state === 'intense' && !sawIntense) {
          sawIntense = true;
          t.event('music-intense', `${b.stageId}: lifted (intense stem ${b.intense ?? 'filter/tempo'}, intenseOn=${b.intenseOn})`);
        }
      }
    });
    try {
      await this.toMainMenu();
      if (!soundSettings().on) {
        await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
        await t.until(settingsShowing, 3000, 'Settings');
        await this.tap(() => this.q('#sound-switch'), 'Sound on');
        await this.tap(() => this.q('#settings-done'), 'Done');
      }
      t.progress(0.05);
      await this.startVersus(2);
      t.progress(0.15);
      const m0 = () => this.game.match();
      await t.until(() => !!bed()?.state, 20000, 'the stage bed to start');
      const first = bed();
      if (!first?.ambienceOn) t.problem('bug', `stage bed has no ambience under the music (${JSON.stringify(first)})`);
      else t.event('stage-ambience', `${first.stageId}: procedural ${first.bed} + file ${first.ambience ?? 'none'} under ${first.music}`);
      if (first?.state === 'calm') {
        sawCalm = true;
        if (!this.checked.has('music-calm-ready')) {
          this.checked.add('music-calm-ready');
          t.event('music-calm', `${first.stageId}: calm at Ready`);
        }
      }
      this.progressNow = () => 0.15 + 0.4 * Math.min(1, ((m0()?.state.frame ?? 0) / (90 * 60)));
      // Fight until the bed lifts (last stock or ≥100%), then check mute while the bout is still live.
      await this.fight(() => sawIntense || !!m0()?.state.over, 3 * 60 * 1000);
      if (!sawCalm) t.problem('bug', 'the playtest never saw music state calm');
      if (!sawIntense) t.problem('bug', 'the music never lifted to intense (last stock or ≥100%)');
      t.progress(0.55);

      if (this.game.phase() !== 'play') {
        t.problem('bug', `expected to still be in play after the intense lift (phase ${this.game.phase()}), so mute could not be checked`);
      } else {
        await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause', 3000, 'pause for sound check');
        await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
        await t.until(settingsShowing, 3000, 'Settings from Pause');
        const before = bed();
        await this.tap(() => this.q('#sound-switch'), 'Sound off');
        if (soundSettings().on) t.problem('bug', 'Sound off did not apply');
        else if (!before?.state || !before.musicOn) t.problem('bug', 'turning Sound off tore down the stage bed');
        else t.event('bed-mute', `Sound off with bed still ${before.state} (layers ride the music bus)`);
        const music = this.q('#vol-music') as HTMLInputElement | null;
        if (music) {
          music.value = '25';
          music.dispatchEvent(new Event('input', { bubbles: true }));
          music.dispatchEvent(new Event('change', { bubbles: true }));
          if (Math.abs(soundSettings().music - 0.25) > 0.001) t.problem('bug', `Music 25% did not apply (${soundSettings().music})`);
          else t.event('bed-volume', `Music set to 25% while bed state ${bed()?.state ?? 'none'}`);
        } else t.problem('bug', 'Settings has no Music slider');
        await this.tap(() => this.q('#sound-switch'), 'Sound on');
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
        await tapKey('Escape');
        await t.until(() => this.game.phase() === 'play', 3000, 'resume the match');
      }

      t.progress(0.7);
      this.progressNow = () => 0.7 + 0.25 * Math.min(1, ((m0()?.state.frame ?? 0) / (120 * 60)));
      const ended = await this.fight(() => !!m0()?.state.over, 3 * 60 * 1000);
      if (ended !== 'over' && !m0()?.state.over) t.problem('bug', 'the match did not reach Game!');
      const timedOut = !!m0()?.state.timedOut;
      const after = bed();
      if (timedOut) t.problem('warning', 'match ended on time, so the final-KO sting was not the closer');
      else if (!after?.stung) t.problem('bug', 'Game! did not fire the final-KO sting');
      else if (!after.musicOn && !after.state) t.problem('bug', 'the stage music cut off on the final KO instead of crossfading');
      else t.event('music-sting', `final-KO sting fired; bed still ${after.state ?? 'holding'} (no hard cut)`);
      t.metric('bedStateChanges', changes);
      t.progress(1);
      t.finish('done');
    } finally {
      unwatch();
      try {
        if (original === null) localStorage.removeItem(SOUND_KEY);
        else localStorage.setItem(SOUND_KEY, original);
      } catch {
        // Storage blocked.
      }
    }
  }

  async graphicsRun(): Promise<void> {
    const t = this.t;
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const touch = isTouchDevice();
    const w = window as unknown as { __gfxLoad?: number };
    w.__gfxLoad = performance.timeOrigin;
    const stats = () => this.game.gfxStats?.();
    const label = () => {
      const g = stats();
      return g ? `Quality ${g.quality}, glow ${g.glowOn ? 'on' : 'off'}, FPS readout ${g.fpsShown ? 'shown' : 'hidden'}, render ${g.scale}x (device ${g.dpr}x), ${Math.round(g.fpsNow)} fps` : 'no renderer stats';
    };
    const state = (id: string) => this.q(id)?.getAttribute('aria-checked');
    const samples: { quality: string; fps: number }[] = [];
    const unwatch = this.game.watch((m) => {
      if (m.state.frame % 60 !== 0 || m.state.frame < 120) return;
      const g = stats();
      if (g && g.fpsNow > 0) samples.push({ quality: g.quality, fps: g.fpsNow });
    });
    const average = (q: string) => {
      const xs = samples.filter((x) => x.quality === q).map((x) => x.fps);
      return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    };
    try {
      localStorage.removeItem(GFX_KEY);
    } catch {
      // Storage blocked.
    }
    try {
      // A load with nothing saved. (The setting was read at load; read the default through Settings after a reset.)
      await this.toMainMenu();
      t.progress(0.05);
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
      for (const [id, name] of [['#quality-switch', 'Quality'], ['#glow-switch', 'Glow'], ['#fps-switch', 'Show FPS']] as const) {
        if (!this.q(id)) t.problem('bug', `Settings has no ${name} control`);
      }
      t.event('gfx-settings', `Settings shows Quality ${this.q('#quality-switch')?.textContent}, Glow ${this.q('#glow-switch')?.textContent}, Show FPS ${this.q('#fps-switch')?.textContent}`);
      t.event('gfx-device', `${touch ? 'Touch device' : 'Desktop'}: ${label()}; render cap ${renderScaleCap('high', touch)}x High, ${renderScaleCap('low', touch)}x Low`);
      // Defaults come from the device; with nothing saved at load they apply as they are, so check what is in force
      // when this run started with no saved choice (the usual playtest profile), else flip to the default first.
      const wantQuality = touch ? 'false' : 'true';
      const wantGlow = touch ? 'false' : 'true';
      if (original === null) {
        if (state('#quality-switch') !== wantQuality) t.problem('bug', `${touch ? 'Phones' : 'Desktop'} default to Quality ${this.q('#quality-switch')?.textContent}, want ${touch ? 'Low' : 'High'}`);
        else if (state('#glow-switch') !== wantGlow) t.problem('bug', `${touch ? 'Phones' : 'Desktop'} default to Glow ${this.q('#glow-switch')?.textContent}, want ${touch ? 'Off' : 'On'}`);
        else t.event('gfx-default', `${touch ? 'Touch device defaults to Low with glow off' : 'Desktop defaults to High with glow on'} (render ${stats()?.scale}x)`);
      } else t.event('gfx-default-skipped', 'a saved graphics choice was present at load, so the device default was not checked');
      if (state('#fps-switch') !== 'false' && original === null) t.problem('bug', 'Show FPS is not off by default');
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);

      await this.startVersus(3);
      t.progress(0.15);
      const m0 = () => this.game.match();
      this.progressNow = () => 0.15 + 0.4 * Math.min(1, ((m0()?.state.frame ?? 0) / (45 * 60)));
      await this.fight(() => (m0()?.state.frame ?? 0) > 20 * 60, 3 * 60 * 1000);
      t.event('gfx-before', label());

      const openFromPause = async () => {
        await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
        await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
        await t.until(settingsShowing, 3000, 'Settings to open from Pause');
        await t.wait(300);
      };
      const closeToMatch = async () => {
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
        await this.click(() => this.q('#btn-resume'), 'Resume');
        await t.until(() => this.game.phase() === 'play', 3000, 'the match to resume');
      };
      const saved = () => {
        try {
          return JSON.parse(localStorage.getItem(GFX_KEY) ?? 'null') as { quality: string; glow: boolean; fps: boolean } | null;
        } catch {
          return null;
        }
      };
      const noReload = () => w.__gfxLoad === performance.timeOrigin && !!this.game.match();

      // Glow: flip it, the glow layer follows at once and the choice is saved.
      await openFromPause();
      const glowBefore = stats()?.glowOn;
      await this.tap(() => this.q('#glow-switch'), 'Glow');
      if (stats()?.glowOn === glowBefore || saved()?.glow !== stats()?.glowOn || state('#glow-switch') !== String(stats()?.glowOn)) t.problem('bug', 'Glow did not apply and save');
      else t.event('gfx-glow', `Glow switched ${glowBefore ? 'off' : 'on'} in Settings: layer ${stats()?.glowOn ? 'on' : 'off'}, saved, match kept running`);
      // Show FPS: the corner readout appears with a number in it.
      await this.tap(() => this.q('#fps-switch'), 'Show FPS');
      await closeToMatch();
      await t.wait(1200);
      const meter = this.q('#fps-meter');
      const r = meter?.getBoundingClientRect();
      if (!meter || meter.hidden || !r || r.width === 0 || !/\d+ FPS/.test(meter.textContent ?? '')) t.problem('bug', `Show FPS did not show a readout (${meter?.textContent ?? 'no element'})`);
      else if (r.right > innerWidth || r.bottom > innerHeight || r.width > innerWidth * 0.3) t.problem('bug', 'the FPS readout is off screen or not small');
      else t.event('gfx-fps', `FPS readout in the corner: "${meter.textContent}" (${Math.round(r.width)}x${Math.round(r.height)} px)`);

      // Quality: flip it; the render scale changes at once, no reload.
      const f1 = m0()?.state.frame ?? 0;
      await this.fight(() => (m0()?.state.frame ?? 0) - f1 > 12 * 60, 2 * 60 * 1000);
      await openFromPause();
      const q0 = stats();
      await this.tap(() => this.q('#quality-switch'), 'Quality');
      const q1 = stats();
      const wantScale = q1 ? Math.min(q1.dpr, renderScaleCap(q1.quality, touch)) : 0;
      if (!q0 || !q1 || q1.quality === q0.quality || Math.abs(q1.scale - wantScale) > 0.01 || saved()?.quality !== q1.quality) t.problem('bug', `Quality did not apply (${label()})`);
      else t.event('gfx-quality', `Quality ${q0.quality} → ${q1.quality}: render scale ${q0.scale}x → ${q1.scale}x (cap ${renderScaleCap(q1.quality, touch)}x), saved`);
      await closeToMatch();
      if (!noReload()) t.problem('bug', 'the page reloaded when a graphics setting changed');
      else t.event('gfx-no-reload', 'the page and match carried on through all three changes');
      const f2 = m0()?.state.frame ?? 0;
      await this.fight(() => (m0()?.state.frame ?? 0) - f2 > 15 * 60, 2 * 60 * 1000);
      t.event('gfx-after', label());
      t.progress(0.85);

      for (const q of ['high', 'low']) {
        const a = average(q);
        if (a !== null) t.metric(`fpsMatch${q === 'high' ? 'High' : 'Low'}`, a);
      }
      const lowAvg = average('low');
      if (touch && lowAvg !== null && lowAvg < 45) t.problem('warning', `average ${lowAvg} fps in Low on a touch device (want at least 45)`);
      t.metric('renderScale', stats()?.scale ?? 0);

      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
    } finally {
      unwatch();
      setGraphics(initial);
      try {
        if (original === null) localStorage.removeItem(GFX_KEY);
        else localStorage.setItem(GFX_KEY, original);
      } catch {
        // Storage blocked.
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- commentary

  /**
   * The announcer and Blog Man (commentary.ts). Part 1: a versus match against the CPU (the bot on a virtual pad),
   * to its end, logging every call the announcer makes from the match's events (`call-<kind>`), checking no line
   * is said twice in a row and that the captions show. Part 2: Blog Man's intro per episode: setup shortcut marks
   * the campaign cleared so every season's map is open, then each season's first chapter (option `all`: every
   * chapter) is played from the map through its live intro scene and the match's first seconds, and left from Pause once
   * Blog Man has spoken. Events `call-<kind>`, `call-kinds`, `call-repeat`, `blog-intro`, `blog-intros`.
   */
  async commentary(): Promise<void> {
    const t = this.t;
    const calls: { kind: string; id: string; text: string; who: string }[] = [];
    const onCall = (e: Event) => {
      const c = (e as CustomEvent).detail as { kind: string; id: string; text: string; who: string };
      const caption = document.querySelector('.booth');
      const prev = calls[calls.length - 1];
      calls.push(c);
      if (c.who === 'announcer') {
        t.event(`call-${c.kind}`, `Announcer: "${c.text}" (${c.id})`);
        if (prev && prev.id === c.id) t.problem('bug', `the same line was said twice in a row: ${c.id}`);
      }
      if (!caption || caption.getAttribute('data-line') !== c.id) t.problem('bug', `no caption showed for ${c.id}`);
    };
    window.addEventListener('dod:commentary', onCall);
    try {
      await this.toMainMenu();
      t.progress(0.03);
      await this.startVersus(3);
      const m0 = () => this.game.match();
      this.progressNow = () => 0.05 + 0.4 * Math.min(1, (m0()?.state.frame ?? 0) / (150 * 60));
      const ended = await this.fight(() => (m0()?.state.frame ?? 0) > 150 * 60, 5 * 60 * 1000);
      const kinds = new Set(calls.filter((c) => c.who === 'announcer').map((c) => c.kind));
      t.metric('callKinds', kinds.size);
      t.metric('calls', calls.length);
      t.event('call-kinds', `${kinds.size} kinds of line from match events: ${[...kinds].join(', ')}`);
      if (kinds.size < 8) t.problem('warning', `only ${kinds.size} kinds of announcer call came up in this fight (${[...kinds].join(', ')}); the unit test covers all 14`);
      if (ended === 'over') await this.results();
      else await this.quitFromPause('main');
      if (currentScreen() === 'results') await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      t.progress(0.5);

      // Part 2: Blog Man's intros.
      const before = this.game.setCampaignProgress(CHAPTERS.map((c) => c.id));
      try {
        const picks = this.options.all
          ? CHAPTERS
          : [...new Set(CHAPTERS.map((c) => c.season))].map((n) => CHAPTERS.find((c) => c.season === n)!);
        let heard = 0;
        for (const [i, c] of picks.entries()) {
          this.progressNow = () => 0.5 + 0.5 * (i / picks.length);
          const from = calls.length;
          if (currentScreen() !== 'campaign') await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
          await this.screen('campaign');
          await this.click(() => this.q(`#chapter-path .chapter[data-chapter="${c.id}"]`), `${c.title} (Season ${c.season})`);
          await this.playDialogue();
          await this.matchLive();
          const spoke = await t.until(() => calls.slice(from).some((x) => x.who === 'blog-man'), 20000, 'Blog Man to introduce the episode').then(() => true, () => false);
          const intro = calls.slice(from).find((x) => x.who === 'blog-man');
          if (spoke && intro) {
            heard++;
            t.event('blog-intro', `Season ${c.season}, ${c.title}: Blog Man: "${intro.text}"`);
            if (intro.id !== `blog-man.intro.${c.id}`) t.problem('bug', `${c.title}: Blog Man said ${intro.id}, not his line for this episode`);
          } else t.problem('bug', `${c.title} (Season ${c.season}): Blog Man did not introduce the episode`);
          await this.t.wait(1500);
          await this.quitFromPause('campaign');
        }
        t.metric('blogIntros', heard);
        t.event('blog-intros', `Blog Man introduced ${heard} of ${picks.length} episodes (${[...new Set(picks.map((c) => c.season))].length} seasons)`);
        const ids = calls.filter((x) => x.who === 'blog-man').map((x) => x.id);
        if (new Set(ids).size !== ids.length) t.problem('warning', 'a Blog Man intro was said twice in this run');
      } finally {
        this.game.setCampaignProgress(before);
      }
    } finally {
      window.removeEventListener('dod:commentary', onCall);
    }
    t.progress(1);
    t.finish('done');
  }

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
      // A fighter with its own kit has a side and a down special on the stick; without one they are the neutral special.
      ...(CHARACTERS[me()?.char ?? 0]?.specials
        ? ([
            [MOVE.SSPECIAL, () => packInput(side(), 0, BTN.SPECIAL)],
            [MOVE.DSPECIAL, () => packInput(0, -100, BTN.SPECIAL)],
          ] as [number, () => number][])
        : []),
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
      // Every special is logged: slot, name, archetype, and whether it came out.
      if (SPECIAL_MOVES.includes(move)) {
        const mv = CHARACTERS[me()?.char ?? 0].moves[move];
        this.t.event('special', `${who}: ${MOVE_NAMES[move]} "${mv.name}" (${kindOf(mv)}) ${this.movesSeen.has(move) ? 'came out' : 'did NOT come out'}`);
        if (this.movesSeen.has(move)) this.t.add('specialsSeen');
      }
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

/** A way to drive a fighter's stick and Special button the way a player does: the keyboard, or the on-screen controls. */
export interface Pad { stick(sx: number, sy: number): void; special(on: boolean): void; button(name: 'attack' | 'shield', on: boolean): void; release(): void }
export function makeKeyboardPad(): Pad {
  const on = new Set<string>();
  const set = (a: string, v: boolean) => {
    if (v === on.has(a)) return;
    if (v) on.add(a);
    else on.delete(a);
    pressAction(a, v);
  };
  return {
    stick: (sx, sy) => {
      set('left', sx < 0);
      set('right', sx > 0);
      set('down', sy < 0);
      set('up', sy > 0);
    },
    special: (v) => set('special', v),
    button: (name, v) => set(name, v),
    release: () => {
      for (const a of [...on]) set(a, false);
    },
  };
}

export function makeTouchPad(): Pad | null {
  const root = touchOverlay() ?? document.querySelector<HTMLElement>('.touch');
  if (!root) return null;
  if (root.hidden) root.hidden = false;
  const stickEl = root.querySelector<HTMLElement>('.touch-stick');
  const specialEl = root.querySelector<HTMLElement>('.touch-btn.special');
  if (!stickEl || !specialEl) return null;
  let stickId = -1;
  let specialId = -1;
  const btnIds: Record<string, number> = {};
  let pid = 200;
  const send = (el: HTMLElement, type: string, x: number, y: number, id: number) =>
    el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 201, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
  return {
    stick: (sx, sy) => {
      const r = stickEl.getBoundingClientRect();
      // The knob's reach is 50/128 of the stick's width: a push of 100 is all the way over.
      const reach = r.width * (50 / 128);
      const x = r.left + r.width / 2 + (sx / 100) * reach;
      const y = r.top + r.height / 2 - (sy / 100) * reach;
      if (sx === 0 && sy === 0) {
        if (stickId >= 0) send(stickEl, 'pointerup', x, y, stickId);
        stickId = -1;
      } else if (stickId < 0) {
        stickId = ++pid;
        send(stickEl, 'pointerdown', x, y, stickId);
      } else send(stickEl, 'pointermove', x, y, stickId);
    },
    special: (v) => {
      const r = specialEl.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (v && specialId < 0) {
        specialId = ++pid;
        send(specialEl, 'pointerdown', x, y, specialId);
      } else if (!v && specialId >= 0) {
        send(specialEl, 'pointerup', x, y, specialId);
        specialId = -1;
      }
    },
    // Attack and Shield are touched at the same moment with two fingers: the grab.
    button: (name, v) => {
      const el = root.querySelector<HTMLElement>(`.touch-btn.${name}`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (v && !(name in btnIds)) {
        btnIds[name] = ++pid;
        send(el, 'pointerdown', x, y, btnIds[name]);
      } else if (!v && name in btnIds) {
        send(el, 'pointerup', x, y, btnIds[name]);
        delete btnIds[name];
      }
    },
    release: () => {
      for (const [name, id] of Object.entries(btnIds)) {
        const el = root.querySelector<HTMLElement>(`.touch-btn.${name}`);
        if (el) send(el, 'pointerup', 0, 0, id);
      }
      for (const k of Object.keys(btnIds)) delete btnIds[k];
      if (specialId >= 0) send(specialEl, 'pointerup', 0, 0, specialId);
      specialId = -1;
      if (stickId >= 0) send(stickEl, 'pointerup', 0, 0, stickId);
      stickId = -1;
    },
  };
}


const HAWKES_GEN = 'https://hawkesgen.ai';
const HAWKES_BIOMEDICAL = 'https://hawkesbiomedical.com';

/** Carries the sound-settings run across its reload. */
/** Carries the touch-settings run across its reload. */
const TOUCH_RUN_KEY = 'hawkes.playtest.touch-settings';
const SOUND_RUN_KEY = 'hawkes.playtest.sound-settings';
/** The feedback card after a versus match (analytics.ts askAfterMatch). */
const MATCH_ASK = 'after-match';

/** Lets the feedback card `id` show again in this browser (the SDK's once-per-session and 7-day snooze marks). */
function resetAsk(id: string): void {
  try {
    const shown = JSON.parse(sessionStorage.getItem('hawkes.asked') ?? '[]');
    if (Array.isArray(shown)) sessionStorage.setItem('hawkes.asked', JSON.stringify(shown.filter((x) => x !== id)));
    const snoozed = JSON.parse(localStorage.getItem('hawkes.askSnoozed') ?? '{}');
    if (snoozed && typeof snoozed === 'object') {
      delete snoozed[id];
      localStorage.setItem('hawkes.askSnoozed', JSON.stringify(snoozed));
    }
  } catch {
    // Storage blocked: the card shows anyway in a fresh browser.
  }
}

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
