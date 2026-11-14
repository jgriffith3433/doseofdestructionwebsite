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
import { styleId } from '../ai/profiles.ts';
import { emulatePad, padFamilyOf, setVirtualPad } from '../input/devices.ts';
import { bindings as currentBindings } from '../input/bindings.ts';
import { readTouch, touchDevice, touchOverlay } from '../input/touch.ts';
import { TOUCH_KEY, forceTouchUi, touchSettings } from '../touchSettings.ts';
import { SHIELD_KEY_NAME, shieldLatched, shieldMode } from '../input/shieldMode.ts';
import { rumbleLog, rumbleStats, type RumbleSent } from '../rumble.ts';
import { forceTouchPrompt, lockLandscape, rotateShowing, suppressRotate } from '../ui/rotate.ts';
import { currentScreen, switching, type ScreenId } from '../ui/screens.ts';
import { CHARACTERS, FIGHTERS as FIGHTERS_DATA, MOVE, MOVE_KEYS } from '../sim/characters.ts';
import { BTN, NO_INPUT, packInput, stickX, stickY } from '../sim/input.ts';
import { STAGES, EV_IDLE, EV_RUN, EV_WARN, ledges } from '../sim/stage.ts';
import { bodyOf, clearance, readDangers } from '../ai/hazardRead.ts';
import { FX } from '../sim/fixed.ts';
import { SHADOW_RANGE, hexRgb } from '../render/fighterLight.ts';
import { analyzeCameraTrace, TRACE_LIMITS, type CamSample, type ScreenRect } from '../render/cameraRig.ts';
import { ART, outlineWidthPx, outsideRanges } from '../artStyle.ts';
import { MAX_COVER, MIN_CONTRAST, MIN_SHOWN, coverRead, edgeContrast, ringContrast, type Frame } from '../readability.ts';
import { ACT, ACT_NAMES, bodySize } from '../sim/state.ts';
import { AnimTrace } from '../sim/trace.ts';
import { SCENE_CARD_MS, sceneShowing } from '../ui/scene.ts';
import { MAX_WORDS } from '../campaign/sceneText.ts';
import { CHAPTERS, LOCKABLE, SEASONS, isUnlocked, saveUnlocks, unlocks } from '../campaign/story.ts';
import { SCENARIOS } from './scenarios.ts';
import { DAILY_POOL, dailyEpisode, msToNext, objectiveLine, twistLine } from '../campaign/daily.ts';
import { DAILY_KEY, dailyDate } from '../campaign/dailyStore.ts';
import { castLine } from '../ui/daily.ts';
import { TOURS, TOURS_KEY, TOUR_LENGTH, tourEnding, tourFor, tourIntro } from '../campaign/tour.ts';
import { ENDINGS, ENDING_BEATS, endingFor, endingUnlocked } from '../campaign/endings.ts';
import { endingShowing } from '../ui/ending.ts';
import { OPENING_CAST, OPENING_KEY, OPENING_SKIP_AFTER, openingShowing } from '../ui/opening.ts';
import { suppressFirstVisit } from '../campaign/firstVisit.ts';
import { PAIRS, pairFor } from '../campaign/intros.ts';
import { SEASON_ONE_ENTRANCES, entranceKind } from '../campaign/intro.ts';
import { DEFENCE_STEPS, PROMPTS, RECOVERY_STEPS, hintText, padGlyphs, type DefenceStep, type RecoveryStep, type TeachStep } from '../ui/teach.ts';
import { stagesFor } from '../modes.ts';
import { SOUNDS, VOICE, audio } from '../audio.ts';
import { VoiceWatch } from './voiceWatch.ts';
import { walkMenus, type Mode } from './menuWalk.ts';
import { SOUND_KEY, readSoundSettings, soundSettings } from '../soundSettings.ts';
import { GFX_KEY, HAND_KEY, AUTO_KEY, AUTO_TOAST_KEY, graphics, setGraphics, isTouchDevice, renderScaleCap } from '../graphics.ts';
import { colourVision } from '../colourVision.ts';
import { SHAKE_STORAGE_KEY, FLASH_STORAGE_KEY, MOTION_STORAGE_KEY, flashMode, reduceMotion, shakeLevel, screenShake, hitTier, inWindupTell, isSmashMove, isSpecialMove, moveStartFrame, tellFrames, windupPose, type HitTier } from '../hitFeel.ts';
import { clipFrame, feetLift, loadAnimSet, pickClip, type AnimSet } from '../render/anims.ts';
import type { Match, MatchSetup } from '../match.ts';
import { BUFFER_FRAMES, COYOTE_FRAMES, LEDGE_CHOOSE, LEDGE_HANG_MAX, type SimEvent } from '../sim/step.ts';
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
  /** The replay on screen: its current tick, or -1 (Watch replay). */
  replayTick(): number;
  /** Setup shortcut (tour only): after `after` fights are won the run jumps to the fight at index `to` (the last one). */
  tourSkipTo(after: number, to: number): void;
  /** Setup shortcut (tour only): shows the Continue or Quit panel on the results screen without losing a fight, to measure it. */
  tourChoicePreview(fighter: string): Promise<void>;
  /** Setup shortcut (campaign `chapter` only): the cleared chapter ids (localStorage dod-campaign); returns the ones before. */
  setCampaignProgress(ids: string[]): string[];
  /** Renderer particle and warm-up diagnostics. */
  /** What the renderer did for the last hits (hit effect tier, shake applied); reset clears the counters. */
  /** The per-frame camera trace (renderer.camTrace): samples, the lens' tangent and the touch controls' rectangles as screen shares. */
  camTrace?(reset?: boolean): { samples: CamSample[]; tan: number; touch: ScreenRect[] };
  flashFxStats?(reset?: boolean): { flashes: number; maxAlpha: number; accepted: number; refused: number; maxPerSecond: number; mode: string; scale: number };
  camFxStats?(reset?: boolean): { cameraJumps: number; framingMisses: number; killCues: number; slowFpsMin: number; killActive: boolean; lastCue: { zoom: boolean; slow: boolean; whistle: boolean; shake: number; punch: number } | null };
  /** The special-effect flipbooks: plays per archetype, the tint used, pool, atlas size (render/flipbook.ts). */
  flipStats?(reset?: boolean): { played: Record<string, number>; tint: Record<string, [number, number, number] | null>; dropped: number; pool: number; free: number; quality: 'high' | 'low'; frames: number; cell: number; standIn: boolean };
  reactFxStats?(reset?: boolean): { squashes: number; maxSquash: number; squashFrames: number; tumbleFrames: number; bounces: number; dustBursts: number; smears: number; smearFrames: number; smashSmears: number; charges: number; quality: string; tells: number; tellFrames: number; tellWhooshes: number; tellMisses: number; tellStarts: number; trails: number; trailFrames: number; normalActives: number; contacts: number; maxContactDist: number; maxHurtGap: number; coreFrames: number; coreMinPx: number; coreHeavyMinPx: number; coreUnderControl: number; shieldRipples: number; parryFlashes: number; clashSparks: number };
  trailStats?(reset?: boolean): { log: { seq: number; victim: number; tier: HitTier; kb: number; kind: 'none' | 'grey' | 'white' | 'streak'; ko: boolean; puffs: number }[]; active: number; puffs: number };
  tagStats?(): { frames: number; unclear: number; minHeight: number; texts: Record<number, string>; rects: { id: number; text: string; fontPx: number; rect: { l: number; t: number; r: number; b: number } }[] };
  markerStats?(): { shown: number; frames: number; unclear: number; last: { id: number; size: number; danger: boolean; clear: boolean; rect: { l: number; t: number; r: number; b: number } } | null; events: { id: number; size: number; danger: boolean }[]; rects: { id: number; rect: { l: number; t: number; r: number; b: number }; danger: boolean; tag?: string }[] };
  hitFxStats?(reset?: boolean): { hits: number; last: { tier: HitTier; lag: number; sparks: number; stars: number; ring: boolean; shake: number; flash: number } | null; tiers: Record<HitTier, number>; shakeApplied: number; shakeMax: number; shakeOn: boolean };
  /** The colour look each built fighter wears and whether its material runs the palette shader (renderer.lookStats). */
  lookStats?(): { slot: number; char: number; look: number; shader: boolean }[];
  /** The shape and colour each fighter's ring was built with (renderer.ringShapes). */
  ringShapes?(): { slot: number; shape: string; color: string }[];
  /** The graphics settings in force and what the renderer is doing with them (render scale, glow layer, readout, fps). */
  aliveStats?(): { pieces: string[]; positions: (readonly [string, number, number, number])[]; screen: 'live' | 'loop'; screenRefresh: number; depths: number[] } | null;
  depthStats?(): { quality: string; camX: number; camDist: number; layers: { id: string; z: number; kind: 'far' | 'foreground' | 'haze' | 'stage'; screenX: number; alpha: number; fade: number | null; behind: boolean }[] };
  readabilityProbe?(sets: { id: string; fighters: number[]; fg: boolean }[]): { w: number; h: number; quality: string; shots: Record<string, Uint8ClampedArray>; fighters: { slot: number; box: { x1: number; y1: number; x2: number; y2: number } }[]; platforms: { index: number; x1: number; x2: number; y: number; lipPx: number }[] } | null;
  styleStats?(): { quality: 'high' | 'low'; renderHeight: number; fighters: { slot: number; char: number; look: number; outline: { color: number[]; px: number; perPx: number[]; on: number }; remap: boolean; outlinePass: boolean }[] };
  lightStats?(): { stage: string; quality: 'high' | 'low'; glossy: boolean; fighters: { slot: number; plugin: { full: boolean; key: number[]; keyColor: number[]; rim: number[]; ambient: number[] }; height: number; scale: number; alpha: number; shadow: boolean; reflection: boolean }[] };
  postStats?(): { quality: 'high' | 'low'; lut: string | null; lutReady: boolean; vignette: number; grain: number; punchFrames: number; punches: number; lastPunchDrawn: number; glitches: number; glitchDrawn: number };
  /** The mix: the stage's room, the wet send, the measured loudness (LUFS), makeup gain and the sample peak (audio.mixStats). */
  mixStats?(): { stage: string | null; room: string; seconds: number; wet: number; low: boolean; lufs: number; makeupDb: number; peakDbfs: number; chain: boolean };
  /** Plays a heavy hit panned to `pan` (-0.8 left edge .. 0.8 right edge) so a capture can measure the channels. */
  probeHit?(pan: number): void;
  /** The match intro (campaign/intro.ts): its clock, the camera's distance, the fastest camera move (units per second) and the beats fired. */
  introStats?(): { active: boolean; ms: number; camDist: number; camX: number; maxSpeed: number; beats: number; kinds: string[] };
  /** Automatic quality (render/autoQuality.ts): its level, changes, the one toast and where it sits; autoSetup switches it and a simulated slow device. */
  autoStats?(): { enabled: boolean; hand: boolean; level: number; changes: { from: number; to: number; medianMs: number; atMs: number; dir: string }[]; settled: boolean; settledAtMs: number; fps: number; toasts: number; toastRect: { x: number; y: number; w: number; h: number } | null; slowMs: number };
  autoSetup?(o: { enabled?: boolean; slowMs?: number; reset?: boolean }): void;
  gfxStats?(): { quality: 'high' | 'low'; glow: boolean; showFps: boolean; dpr: number; scale: number; glowOn: boolean; fpsShown: boolean; fpsNow: number };
  /** What the player saw of the stage: presented frames, with stage art still loading, and sampled near-black (reset clears). */
  stageSeen?(reset?: boolean): { frames: number; pending: number; black: number; darkest: number };
  fxStats?(): { active: number; dustBehind: number; dustInFront: number; maxCap: number; sparkPool: number; readyLayers: number; totalLayers: number; readyClips: number; totalClips: number };
  /** Decoded-audio cache (audio.ts): bytes held, its ceiling, peak, evictions. */
  audioCacheStats?(): { decodedBytes: number; decodedMB: number; peakMB: number; budgetMB: number; entries: number; pinned: number; evictions: number; rawMB: number };
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
  campaign: 'Campaign Map', tour: 'Tour Select', extras: 'Extras', howto: 'How To Play', results: 'Results', match: 'Match', leaderboard: 'Leaderboard',
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
      // Automatic quality would change the picture under every other scenario's own checks; only its own scenario runs it.
      game.autoSetup?.({ enabled: id === 'auto-quality', slowMs: 0 });
      const r = new Run(game, t, options, t.spot);
      r.judgeCamera = id === 'match' || id === 'hit-feel' || id === 'touch-match';
      run = r;
      try {
        if (id === 'smoke') await r.smoke();
        else if (id === 'match') await r.match();
        else if (id === 'match-intro') await r.matchIntro();
        else if (id === 'campaign') await r.campaign();
        else if (id === 'unlocks') await r.unlocksRun();
        else if (id === 'daily') await r.dailyRun();
        else if (id === 'tour') await r.tourScenario();
        else if (id === 'endings') await r.endingsScenario();
        else if (id === 'opening') await r.openingScenario();
        else if (id === 'ko-objective') await r.koObjective();
        else if (id === 'sudden-death') await r.suddenDeath();
        else if (id === 'hazard-dodge') await r.hazardDodge();
        else if (id === 'cpu-level') await r.cpuLevel();
        else if (id === 'auto-quality') await r.autoQuality();
        else if (id === 'quota') await r.quotaObjective();
        else if (id === 'grades') await r.gradesRun();
        else if (id === 'streak') await r.streakObjective();
        else if (id === 'finale-hijack') await r.finaleHijack();
        else if (id === 'story-cards') await r.storyCards();
        else if (id === 'bookends') await r.bookends();
        else if (id === 'rotate') await r.rotate();
        else if (id === 'first-visit') await r.firstVisit();
        else if (id === 'presentation') await r.presentation();
        else if (id === 'replay') await r.replayScenario();
        else if (id === 'roster') await r.roster();
        else if (id === 'feet') await r.feetRun();
        else if (id === 'smooth-clips') await r.smoothClips();
        else if (id === 'specials') await r.specialsRun();
        else if (id === 'hurtbox-fit') await r.hurtboxFitRun();
        else if (id === 'extra-jumps') await r.extraJumpsRun();
        else if (id === 'cpu-styles') await r.cpuStylesRun();
        else if (id === 'special-sounds') await r.specialSounds();
        else if (id === 'grab') await r.grabRun();
        else if (id === 'lesson-2') await r.lessonTwo();
        else if (id === 'lesson-3') await r.lessonThree();
        else if (id === 'ledge-options') await r.ledgeOptions();
        else if (id === 'training-combo') await r.trainingCombo();
        else if (id === 'archetype-normals') await r.archetypeNormals();
        else if (id === 'special-fx') await r.specialFx();
        else if (id === 'menu-walk') await r.menuWalk();
        else if (id === 'select-specials') await r.selectSpecials();
        else if (id === 'select-set') await r.selectSet();
        else if (id === 'portraits') await r.portraitsRun();
        else if (id === 'colours') await r.coloursRun();
        else if (id === 'sound-settings') await r.soundSettings();
        else if (id === 'voice-captions') await r.voiceCaptions();
        else if (id === 'fast-start') await r.fastStart();
        else if (id === 'hit-feel') await r.hitFeel();
        else if (id === 'rumble') await r.rumbleRun();
        else if (id === 'auto-level') await r.autoLevelRun();
        else if (id === 'input-feel') await r.inputFeel();
        else if (id === 'touch-match') await r.touchMatch();
        else if (id === 'touch-settings') await r.touchSettingsRun();
        else if (id === 'shield-toggle') await r.shieldToggleRun();
        else if (id === 'rebind') await r.rebindRun();
        else if (id === 'text-size') await r.textSizeRun();
        else if (id === 'colour-vision') await r.colourVisionRun();
        else if (id === 'motion-comfort') await r.motionComfort();
        else if (id === 'graphics') await r.graphicsRun();
        else if (id === 'post-chain') await r.postChain();
        else if (id === 'lighting') await r.lighting();
        else if (id === 'stage-depth') await r.stageDepth();
        else if (id === 'readability') await r.readability();
        else if (id === 'mix-room') await r.mixRoom();
        else if (id === 'art-style') await r.artStyle();
        else if (id === 'stage-life') await r.stageLife();
        else if (id === 'stage-bed') await r.stageBed();
        else if (id === 'audio-cache') await r.audioCache();
        else if (id === 'commentary') await r.commentary();
        else if (id === 'fighter-voice') await r.fighterVoice();
        else if (id === 'announcer') await r.announcerRun();
        else if (id === 'win-quote') await r.winQuoteRun();
        else if (id === 'victory') await r.victoryRun();
        else if (id === 'intro-exchange') await r.introExchange();
        else if (id === 'site-links') await r.siteLinks();
        else if (id === 'online') await r.online();
        else if (id === 'reconnect') {
          r.cutMode = true;
          await r.online();
        } else if (id === 'rematch') {
          r.rematchMode = true;
          await r.online();
        }
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
  /** When (performance.now) each special move was first seen playing, for the release-sound latency check. */
  readonly moveStartMs = new Map<number, number>();
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
    // The show's reaction to the first KO (main.ts airFlash): the ON AIR flash must be on screen, inside the window, and never a tap target.
    window.addEventListener('dod:air-flash', () => {
      const el = document.querySelector('.air-flash');
      if (!el) return t.problem('bug', 'the first-KO ON AIR flash fired but no .air-flash element is on screen');
      const r = el.getBoundingClientRect();
      const inside = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      t.event('air-flash', `First blood: ON AIR flash shown at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${innerWidth}x${innerHeight}`);
      if (!inside) t.problem('bug', 'the ON AIR first-blood flash runs off the screen');
      if (getComputedStyle(el).pointerEvents !== 'none') t.problem('bug', 'the ON AIR flash would block touches');
      if (document.documentElement.scrollWidth > innerWidth + 1) t.problem('bug', 'the ON AIR flash caused sideways scrolling');
    });
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
  /** Clip sets of the fighters seen (filled by checkFighter), for the feet check. */
  private readonly feetSets = new Map<string, AnimSet>();
  /** Per fighter this match: the worst sole-to-floor gap in sheet pixels as drawn (after the lift), and without it. */
  private feetGap = new Map<string, { worst: number; idle: number; raw: number; clip: string }>();

  /** Feet on the floor (studio rule 4): each grounded fighter's sole gap in the frame the renderer draws. */
  private sampleFeet(m: Match): void {
    for (const f of m.state.fighters) {
      if (!f.grounded || f.hitlag > 0) continue;
      const id = CHARACTERS[f.char].id;
      const set = this.feetSets.get(id);
      if (!set) continue;
      const pick = pickClip(f, set);
      if (!pick || !pick.exact || !pick.clip.feet) continue;
      const i = clipFrame(f, pick);
      const raw = pick.clip.feet[i];
      if (raw == null) continue;
      const lift = feetLift(f, pick, i);
      // Only floor clips are corrected; a grounded attack or hurt frame has its own pose.
      if (lift === 0 && raw !== 0 && pick.key !== 'idle' && pick.key !== 'walk' && pick.key !== 'land' && pick.key !== 'crouch') continue;
      const gap = Math.abs(raw - lift);
      const g = this.feetGap.get(id) ?? { worst: 0, idle: 0, raw: 0, clip: '' };
      g.raw = Math.max(g.raw, Math.abs(raw));
      if (gap > g.worst) { g.worst = gap; g.clip = pick.key; }
      if (pick.key === 'idle') g.idle = Math.max(g.idle, gap);
      this.feetGap.set(id, g);
    }
  }

  private reportFeet(): void {
    if (!this.feetGap.size) return;
    for (const [id, g] of this.feetGap) {
      const detail = { fighter: id, worst: g.worst, idle: g.idle, withoutFit: g.raw, clip: g.clip };
      this.t.event('feet-gap', `${id}: worst ${g.worst}px (idle ${g.idle}px, ${g.raw}px before the fit) in ${g.clip || 'no floor clip'}`);
      window.dispatchEvent(new CustomEvent('dod:feet-gap', { detail }));
      if (g.idle > 2) this.t.problem('bug', `${id}: idle feet ${g.idle}px off the floor (over 2px)`);
      if (g.worst > 6) this.t.problem('polish', `${id}: feet ${g.worst}px off the floor in ${g.clip}`);
    }
    this.feetGap.clear();
  }

  private onTick(m: Match, events: SimEvent[]): void {
    const s = m.state;
    const me = m.player;
    // Training matches are quit without `over`, so report the previous bout's feet before the next starts.
    if (m !== this.seen) {
      this.reportFeet();
      this.onMatchStart(m);
    }
    this.traceFrames++;
    this.sampleFeet(m);
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
        if (SPECIAL_MOVES.includes(f.move) && !this.moveStartMs.has(f.move)) this.moveStartMs.set(f.move, performance.now());
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
      this.reportFeet();
      this.judgeCameraTrace(m);
      this.t.event('anim-trace', `${this.traceFrames} frames traced, ${this.trace.problems.length} state/motion mismatches`);
    }
    this.t.progress(this.progressNow());
  }

  /**
   * The camera trace of the match that just ended (renderer camTrace) against the limits: under 2 direction flips a second
   * on either axis outside shake, zoom-out under 40% a second outside the KO zoom, fighters inside a 5% screen margin
   * (launched ones are the offscreen bubble's), and on a phone nobody under the stick or buttons for more than 0.5 s.
   */
  private judgeCameraTrace(m: Match): void {
    const tr = this.game.camTrace?.();
    if (!this.judgeCamera || !tr || tr.samples.length < 60) return;
    const touch = tr.touch;
    const r = analyzeCameraTrace(tr.samples, touch, tr.tan);
    this.camReports.push(r);
    const t = this.t;
    t.metric('camFlipsX', r.flipsX);
    t.metric('camFlipsY', r.flipsY);
    t.metric('camZoomOutPerSec', Number(r.zoomOutMax.toFixed(2)));
    t.metric('camMarginShare', Number((r.marginShare * 100).toFixed(2)));
    t.metric('camMarginLongestS', Number(r.marginLongest.toFixed(2)));
    t.metric('camAccelMax', Number(r.accelMax.toFixed(1)));
    if (touch.length) t.metric('camTouchLongestS', Number(r.touchLongest.toFixed(2)));
    const where = `${STAGES[m.state.stage].name}, ${r.frames} frames over ${r.seconds.toFixed(0)} s${touch.length ? ', touch controls up' : ''}`;
    const flips = Math.max(r.flipsX, r.flipsY);
    if (flips >= TRACE_LIMITS.flipsPerSecond) t.problem('bug', `camera jitter on ${where}: ${r.flipsX} horizontal / ${r.flipsY} vertical direction flips in one second (under ${TRACE_LIMITS.flipsPerSecond} wanted)`);
    else t.event('camera-jitter', `${where}: at most ${r.flipsX} horizontal / ${r.flipsY} vertical direction flips in any second (limit under ${TRACE_LIMITS.flipsPerSecond})`);
    if (r.zoomOutMax > TRACE_LIMITS.zoomOutPerSecond) t.problem('bug', `camera zoom-out reached ${(r.zoomOutMax * 100).toFixed(0)}% a second at ${r.zoomOutAt.toFixed(1)} s on ${where} (limit ${TRACE_LIMITS.zoomOutPerSecond * 100}% outside the KO zoom)`);
    else t.event('camera-zoom-out', `${where}: the fastest zoom-out was ${(r.zoomOutMax * 100).toFixed(0)}% a second outside the KO zoom (limit ${TRACE_LIMITS.zoomOutPerSecond * 100}%)`);
    if (r.marginShare > TRACE_LIMITS.marginFrames || r.marginLongest > TRACE_LIMITS.marginSeconds) t.problem('bug', `a fighter sat outside the ${TRACE_LIMITS.margin * 100}% screen margin in ${(r.marginShare * 100).toFixed(1)}% of frames, longest ${r.marginLongest.toFixed(2)} s on ${where}`);
    else t.event('camera-margin', `${where}: fighters inside the ${TRACE_LIMITS.margin * 100}% margin in ${(100 - r.marginShare * 100).toFixed(2)}% of frames (longest miss ${r.marginLongest.toFixed(2)} s)`);
    if (touch.length) {
      if (r.touchLongest > TRACE_LIMITS.touchSeconds) t.problem('bug', `a fighter sat under the touch stick or buttons for ${r.touchLongest.toFixed(2)} s on ${where} (limit ${TRACE_LIMITS.touchSeconds} s)`);
      else t.event('camera-touch-clear', `${where}: no fighter under the stick or buttons for more than ${TRACE_LIMITS.touchSeconds} s (longest ${r.touchLongest.toFixed(2)} s)`);
    }
    this.game.camTrace?.(true);
  }

  /** Damage totals in percent; the sim counts tenths. */
  private readonly totals: Record<string, number> = {};
  private damage(metric: string, tenths: number): void {
    this.totals[metric] = (this.totals[metric] ?? 0) + tenths;
    this.t.metric(metric, this.totals[metric] / 10);
  }

  /** Match, hit-feel and touch-match judge the camera trace of every match they play (cameraRig.ts analyzeCameraTrace). */
  judgeCamera = false;
  private camReports: ReturnType<typeof analyzeCameraTrace>[] = [];

  private onMatchStart(m: Match): void {
    this.seen = m;
    this.game.camTrace?.(true);
    this.trace = new AnimTrace();
    this.traceFrames = 0;
    this.feetGap = new Map();
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
    if (set) this.feetSets.set(id, set);
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
    const lines = SEASON_ONE.includes(id)
      ? [
          `announcer.name.${id}`,
          `fighter.${id}.ko`,
          `fighter.${id}.win`,
          `fighter.${id}.taunt`,
          ...[0, 1, 2].map((i) => `fighter.${id}.effort.${i}`),
          ...[0, 1].map((i) => `fighter.${id}.hurt.${i}`),
        ]
      : [`announcer.name.${id}`, `fighter.${id}.ko`, `fighter.${id}.win`];
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
    const pausePx = parseFloat(ps.fontSize);
    const rgba = bs.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    const alpha = rgba.length >= 4 ? rgba[3] : 1;
    const lum = rgba.length >= 3 ? (rgba[0] + rgba[1] + rgba[2]) / 3 : 255;
    const icons = root.querySelectorAll('.touch-btn svg').length;
    const labels = [...root.querySelectorAll('.touch-btn')].map((el) => el.getAttribute('aria-label') || '').filter(Boolean);
    if (pausePx < 13) {
      this.t.problem('bug', `Pause label is too small (${pausePx}px, expected >= 13px)`);
    }
    if (alpha < 0.45 || lum > 40) {
      this.t.problem('bug', `touch button fill is not dark semi-opaque (${bs.backgroundColor})`);
    }
    if (icons < 5 || labels.length < 5) {
      this.t.problem('bug', `touch buttons need icons + aria-labels (icons ${icons}, labels ${labels.join(',')})`);
    }
    if (!ps.textShadow || ps.textShadow === 'none') {
      this.t.problem('bug', 'Pause label has no text-shadow for readability over bright stages');
    }
    this.t.event('touch-controls', `fill ${bs.backgroundColor}, ${icons} icons (${labels.join('/')}), Pause ${pausePx}px`);
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
  private async startVersus(stocks: number, opened = false): Promise<void> {
    if (!opened) {
      await this.click(() => this.q('[data-go="versus"]'), 'Versus');
      await this.screen('select');
    }
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
    const askedFoe = typeof this.options.foe === 'string' ? CHARACTERS.findIndex((c) => c.id === this.options.foe) : -1;
    if (typeof this.options.foe === 'string' && askedFoe < 0) this.t.problem('bug', `foe "${this.options.foe}" is not in the roster`);
    if (askedFoe >= 0 && !pool.includes(askedFoe)) this.t.problem('bug', `foe "${this.options.foe}" is locked in Versus (clear its chapter first)`);
    const mePos = asked >= 0 ? pool.indexOf(asked) : Math.abs(this.options.seed * 11) % n;
    const meIdx = pool[Math.max(0, mePos)];
    const foeIdx =
      askedFoe >= 0 && askedFoe !== meIdx
        ? askedFoe
        : pool.filter((i) => i !== meIdx)[(Math.abs(this.options.seed * 17) % Math.max(1, n - 1))];
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
    if (this.onStages) await this.onStages([...cards()]);
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
    // The match intro (3 s) sits between the VS card and the first frame: the hold limits below are for the rest.
    let introMs = 0;
    const onIntro = (e: Event) => { const d = (e as CustomEvent).detail as { phase: string; ms: number }; if (d.phase === 'end') introMs = d.ms; };
    window.addEventListener('dod:match-intro', onIntro);
    // Longest frame from the stage tap to GO (the ROUND START slam): every rAF gap, no timers. Shader compiles,
    // texture uploads and pool fills show up here as one long frame.
    let goSeen = false;
    let longestFrameMs = 0;
    let watchFrames = true;
    let prevFrame = performance.now();
    const onGo = (e: Event) => { if (!(e as CustomEvent<{ over: boolean }>).detail.over) goSeen = true; };
    window.addEventListener('dod:slam', onGo);
    const frameTick = (now: number) => {
      if (!watchFrames) return;
      longestFrameMs = Math.max(longestFrameMs, now - prevFrame);
      prevFrame = now;
      if (goSeen) return;
      requestAnimationFrame(frameTick);
    };
    prevFrame = performance.now();
    requestAnimationFrame(frameTick);
    await this.click(() => cards()[pick], `stage ${want && byId >= 0 ? want : pick + 1}`);
    const confirmAt = performance.now();
    this.vsWipePending = this.vsHoldWanted;
    if (this.onVersus) await this.onVersus();
    await this.matchLive();
    window.removeEventListener('dod:scene-timing', onTiming);
    window.removeEventListener('dod:match-intro', onIntro);
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
      // The announcer calls the stage, then both fighters, before the match (about 1.5 s + 3 s): limit 6 s.
      if (tm.selectToMatch !== null && tm.selectToMatch > 6000) this.t.problem('bug', `the VS card took ${sec(tm.selectToMatch)} after the stage pick (limit 6 s)`);
    } else this.t.problem('bug', 'no scene timing reported for the match start');
    if (this.vsHoldWanted) {
      await this.t.until(() => (this.game.match()?.state.frame ?? 0) > 0, 10000, 'the first match frame');
      const ms = Math.round(performance.now() - confirmAt) - introMs;
      this.t.metric('vsHoldMs', ms);
      this.t.event('vsHoldMs', `${ms} ms from the stage confirm to the first match frame`);
      if (ms > 6000) this.t.problem('bug', `The VS card held ${ms} ms from the stage confirm to the first match frame (limit 6000 ms: the stage and both names are called)`);
    }
    await this.t.until(() => goSeen, 15000, 'ROUND START after the intro').catch(() => undefined);
    watchFrames = false;
    window.removeEventListener('dod:slam', onGo);
    if (goSeen) {
      const worst = Math.round(longestFrameMs);
      const phone = this.phoneScenario();
      const limit = phone ? 150 : 100;
      this.t.metric('longestFrameMs', worst);
      this.t.event('longestFrameMs', `longest frame from Stage Select to GO: ${worst} ms (${phone ? 'phone' : 'desktop'} limit ${limit} ms)`);
      // Hard check in the smoke run only (the other scenarios share this walk but report the number).
      if (this.vsHoldWanted && worst > limit) this.t.problem('bug', `A frame took ${worst} ms between Stage Select and GO (limit ${limit} ms): warm-up work must be spread across frames`);
    } else this.t.problem('bug', 'no ROUND START after the stage pick, so the longest frame to GO could not be measured');
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
    await this.t.until(() => this.game.phase() === 'play', 16000, 'the match to start');
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
    // The episode's ending is a chain: the replay of the final KO, the outro scene, the "Next time" tease (ui/segment.ts).
    const t0 = performance.now();
    while (currentScreen() !== 'results' && performance.now() - t0 < 90000) {
      if (sceneShowing()) await this.passScene();
      else await this.t.wait(200);
    }
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

  /**
   * `feel.autoQualityStepMs`: the longest frame within 3 frames either side of every auto-quality step (the decision's
   * `dod:auto-quality` and each part that lands after it, `dod:auto-quality-part`), so the playtest confirms or clears the
   * governor as the cause of a hitch. A step frame over 100 ms is a bug.
   */
  private watchAutoStep(): () => void {
    const t = this.t;
    const dts: number[] = [];
    const marks: { at: number; what: string }[] = [];
    let last = 0;
    let on = true;
    const tick = (now: number) => {
      if (!on) return;
      if (last) dts.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const mark = (e: Event) => marks.push({ at: dts.length, what: e.type === 'dod:auto-quality' ? 'step' : `part ${(e as CustomEvent).detail?.part}` });
    window.addEventListener('dod:auto-quality', mark);
    window.addEventListener('dod:auto-quality-part', mark);
    return () => {
      on = false;
      window.removeEventListener('dod:auto-quality', mark);
      window.removeEventListener('dod:auto-quality-part', mark);
      let worst = 0;
      for (const m of marks) {
        const w = Math.max(0, ...dts.slice(Math.max(0, m.at - 3), m.at + 4));
        worst = Math.max(worst, w);
        t.event('auto-quality-step', `${m.what}: longest frame within 3 frames ${Math.round(w)} ms`);
      }
      t.metric('feel.autoQualityStepMs', Math.round(worst));
      if (worst > 100) t.problem('bug', `a frame next to an auto-quality step took ${Math.round(worst)} ms (want 100 or less)`);
    };
  }

  async smoke(): Promise<void> {
    const t = this.t;
    const stopWatch = this.watchWipe();
    const stopBlank = this.watchBlank();
    this.vsHoldWanted = true;
    const stopStinger = this.watchStingers();
    const stopAutoStep = this.watchAutoStep();
    try {
      await this.smokeRun();
    } finally {
      stopAutoStep();
      stopStinger();
      stopBlank();
      stopWatch();
    }
    void t;
  }

  /**
   * The show's stinger (ui/stinger.ts) on every screen change and the slams (main.ts): each `dod:stinger` is one
   * event with its length (150-300 ms, the one shared screen transition, unless the next screen was still loading: loadMs), ROUND START and GAME! come
   * with `dod:slam` (GAME! with its 0.5 s freeze offline). A screen switch with no stinger is a problem.
   */
  private watchStingers(): () => void {
    const t = this.t;
    let stingers = 0;
    let slams = 0;
    let switches = 0;
    let lastShown: string | null = null;
    const onStinger = (e: Event) => {
      const d = (e as CustomEvent<{ from: string; to: string; ms: number; loadMs: number; reduced: boolean }>).detail;
      stingers++;
      t.event('stinger', `${d.from} -> ${d.to}: ${d.ms} ms (loading held ${d.loadMs} ms)${d.reduced ? ' reduced-motion crossfade' : ''}`);
      t.metric('stingers', stingers);
      const loading = d.loadMs > 150;
      if (!d.reduced && !loading && (d.ms < 150 || d.ms > 300)) t.problem('bug', `Stinger ${d.from} -> ${d.to} lasted ${d.ms} ms (want 150-300 ms unless loading runs longer)`);
    };
    const onSlam = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; over: boolean; freezeMs: number }>).detail;
      slams++;
      t.event(d.over ? 'slam-game' : 'slam-round-start', `${d.text}${d.freezeMs ? `, ${d.freezeMs} ms freeze` : ''}`);
      t.metric('slams', slams);
    };
    const poll = window.setInterval(() => {
      const now = currentScreen();
      if (now && now !== lastShown) {
        if (lastShown !== null) switches++;
        lastShown = now;
      }
    }, 50);
    window.addEventListener('dod:stinger', onStinger);
    window.addEventListener('dod:slam', onSlam);
    return () => {
      window.removeEventListener('dod:stinger', onStinger);
      window.removeEventListener('dod:slam', onSlam);
      window.clearInterval(poll);
      t.metric('screenSwitches', switches);
      if (switches > stingers) t.problem('bug', `${switches} screen changes but only ${stingers} stingers: a hard cut`);
    };
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
    this.game.stageSeen?.(true);
    // Plays to the Results screen (1 stock, so it ends); blankFrames, vsHoldMs and wipe fps are reported there.
    await this.fight(() => false, 4 * 60 * 1000);
    this.reportStageSeen();
    this.progressNow = () => 0.9;
    await this.results();
    t.event('smoke-results', 'the smoke match reached the Results screen');
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(1);
    t.finish('done');
  }

  /**
   * `stage.blackFrames`: frames the player saw of the arena (after the loading veil, from the first presented frame) whose
   * stage pictures were still loading or whose pixels were near-black. The match holds a veil until the art is in, so it is 0.
   */
  private reportStageSeen(): void {
    const seen = this.game.stageSeen?.(true);
    if (!seen) return;
    const bad = Math.max(seen.pending, seen.black);
    this.t.metric('stage.blackFrames', bad);
    this.t.event('stage-seen', `${seen.frames} arena frames presented: ${seen.pending} with stage art still loading, ${seen.black} near-black (darkest mean ${Math.round(seen.darkest)}/255)`);
    if (seen.frames > 0 && bad > 0) this.t.problem('bug', `The stage showed as a near-black void or unloaded art for ${bad} of ${seen.frames} presented match frames (limit 0)`);
  }

  async match(): Promise<void> {
    const t = this.t;
    // The feedback card shows once per session and sleeps 7 days once closed: this browser may have closed it before.
    resetAsk(MATCH_ASK);
    const voices: { who: string; kind: string; id: string; at: number }[] = [];
    const onVoice = (e: Event) => {
      const d = (e as CustomEvent).detail as { who: string; kind: string; id: string; text: string; audio: string; at: number };
      voices.push(d);
      t.event(`voice-${d.kind}`, `${d.who}: "${d.text}" (${d.id})`);
    };
    // Live-show mix logs: take ids (no back-to-back repeats), music calm/intense, crowd, duck under voice.
    const takeLog: { id: string; takeId: string }[] = [];
    const lastTakeById = new Map<string, string>();
    let takeRepeats = 0;
    const onTake = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; takeId: string; file: string; rate: number };
      takeLog.push({ id: d.id, takeId: d.takeId });
      const prev = lastTakeById.get(d.id);
      if (prev && prev === d.takeId) {
        takeRepeats++;
        t.problem('bug', `sound take ${d.takeId} played twice in a row for ${d.id}`);
      }
      lastTakeById.set(d.id, d.takeId);
      if (/^(hit-|swing-|jump|land|dodge|special-)/.test(d.id)) {
        t.event('sound-take', `${d.id} → ${d.takeId} (rate ${d.rate.toFixed(3)})`);
      }
    };
    let sawIntense = false;
    let roarCount = 0;
    let duckDown = 0;
    let duckUp = 0;
    const onMusic = (e: Event) => {
      const d = (e as CustomEvent).detail as { state: string; stageId: string | null };
      t.event(d.state === 'intense' ? 'music-intense' : 'music-calm', `${d.stageId ?? '?'}: ${d.state}`);
      if (d.state === 'intense') sawIntense = true;
    };
    const onCrowd = (e: Event) => {
      const d = (e as CustomEvent).detail as { kind: string; takeId: string };
      t.event(`crowd-${d.kind}`, d.takeId);
      if (d.kind === 'roar') roarCount++;
    };
    const onDuck = (e: Event) => {
      const d = (e as CustomEvent).detail as { on: boolean; db: number; restoreMs: number };
      if (d.on) {
        duckDown++;
        t.event('music-duck', `down ${d.db} dB`);
      } else {
        duckUp++;
        t.event('music-unduck', `restore ${d.restoreMs} ms`);
      }
    };
    window.addEventListener('dod:fighter-voice', onVoice);
    window.addEventListener('dod:sound-take', onTake);
    window.addEventListener('dod:music-state', onMusic);
    window.addEventListener('dod:crowd', onCrowd);
    window.addEventListener('dod:music-duck', onDuck);
    try {
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
      t.metric('voiceEvents', voices.length);
      t.metric('soundTakes', takeLog.length);
      t.metric('soundTakeRepeats', takeRepeats);
      t.metric('crowdRoars', roarCount);
      t.metric('musicDucks', duckDown);
      if (!sawIntense) t.problem('bug', 'music never lifted to intense (last stock or ≥100%)');
      if (roarCount < 1) t.problem('bug', 'no crowd roar logged on a KO');
      if (duckDown < 1) t.problem('bug', 'music never ducked under a voice line');
      if (duckUp < 1) t.problem('bug', 'music never restored after a voice duck');
      if (takeLog.length < 8) t.problem('warning', `only ${takeLog.length} sound takes logged in the match`);
      t.progress(1);
      t.finish(won ? 'won' : 'lost');
    } finally {
      window.removeEventListener('dod:fighter-voice', onVoice);
      window.removeEventListener('dod:sound-take', onTake);
      window.removeEventListener('dod:music-state', onMusic);
      window.removeEventListener('dod:crowd', onCrowd);
      window.removeEventListener('dod:music-duck', onDuck);
    }
  }

  /** Set by the presentation scenario: runs on the VS screen, before the match loads. */
  private onVersus: (() => Promise<void>) | null = null;
  /** Called on the stage select once its cards are up (match-intro checks the live previews there). */
  private onStages: ((cards: HTMLElement[]) => Promise<void>) | null = null;

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
    const KEYS = ['dod-campaign', 'dod-versus', 'dod-pilot', 'dod-unlocks', OPENING_KEY];
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
      // Hint tokens (ui/teach.ts hintText): the pilot's smash hint and the Training hitbox hint read per device.
      const pilotHint = CHAPTERS[0]?.hint ?? '';
      for (const dev of ['keyboard', 'gamepad', 'touch'] as const) {
        const smash = hintText(pilotHint, dev);
        const box = hintText('No stocks. Press {hitbox} in the match to see hitboxes.', dev);
        t.event('hint-device', `${dev}: "${smash}" | "${box}"`);
        if (/\{|\bI \+/.test(smash) && dev !== 'keyboard') t.problem('bug', `the pilot hint shows a keyboard letter for ${dev}: ${smash}`);
        if (dev !== 'keyboard' && /\bH\b/.test(box)) t.problem('bug', `the hitbox hint names the H key for ${dev}: ${box}`);
      }
      // Pad families (ui/teach.ts padGlyphs, input/devices.ts padFamilyOf): the glyphs each pad id shows in teach prompts.
      const famIds: [string, string][] = [
        ['Sony DualSense (054c)', 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'],
        ['Nintendo Pro Controller (057e)', 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'],
        ['Xbox (045e)', 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)'],
      ];
      for (const [label, id] of famIds) {
        const f = padFamilyOf(id);
        const names = (['attack', 'jump', 'shield', 'recover'] as TeachStep[]).map((st) => padGlyphs(st, f).map((g) => g.name).join(' ')).join(' | ');
        t.event('pad-family', `${label}: ${f}: ${names}`);
        const want = { playstation: ['Cross', 'Square', 'L1', 'Circle'], switch: ['B', 'Y', 'L', 'A'], xbox: ['A', 'X', 'LB', 'B'] }[f];
        const got = [padGlyphs('attack', f)[0]!.name, padGlyphs('jump', f)[0]!.name, padGlyphs('shield', f)[0]!.name, padGlyphs('recover', f)[2]!.name];
        if (got.join() !== want.join()) t.problem('bug', `${label} shows ${got.join('/')} instead of ${want.join('/')}`);
      }
      if (padFamilyOf('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)') !== 'playstation') t.problem('bug', 'a Sony pad id is not read as PlayStation');
      if (padFamilyOf('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)') !== 'switch') t.problem('bug', 'a Nintendo pad id is not read as Switch');
      if (touch) t.event('pad-family-touch', `touch only, no pad: prompts use touch glyphs (${PROMPTS.attack.glyphs.touch.join(' ')}), no pad glyphs`);
      let hintSeen = '';
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
        if (touch && document.querySelector('.teach-glyph.gamepad')) t.problem('bug', 'a pad glyph shows in a teach prompt on a touch-only phone');
        // Every hint on screen during the pilot: no keyboard letter on touch.
        const live = [...document.querySelectorAll('.vs-stage span, .scene-card, .hint')].filter((e) => (e as HTMLElement).offsetParent).map((e) => e.textContent ?? '').join(' | ');
        if (live && live !== hintSeen) {
          hintSeen = live;
          if (touch && /\bI \+|Press [A-Z]\b/.test(live)) t.problem('bug', `a hint shows a keyboard letter on touch: ${live}`);
        }
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
        const cont = this.button('#results-actions', 'Continue');
        const contAt = performance.now();
        await this.click(() => cont ?? this.button('#results-actions', 'Main menu'), 'Continue');
        // TV order: the opening titles play once right after the pilot, then the main menu.
        await this.watchOpening({ since: contAt, skipAt: 1300, tag: 'after-pilot' });
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
    const cls = [PROMPTS[step].touch ?? []].flat()[0];
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


  /**
   * Watch replay (`replay.ts`, `ui/replayBar.ts`, main.ts `watchReplay`): a versus match (1 stock) is played by the bot to
   * Results, which must offer Watch replay (`replay-button`). The replay opens with its control bar on screen and fitting
   * (`replay-fit`: every button at least 44 px, 8 px apart, inside the window; a bottom bar on a 390x844 phone), then plays
   * from the recorded inputs: Pause holds the tick (`replay-pause`), 0.5x / 1x / 2x change how fast the ticks come
   * (`replay-speed`), a tap on the arena hides and shows the bar (`replay-bar-tap`), Camera toggles Follow / Free
   * (`replay-camera`), and the replay's end has the same winner, stocks and final hash as the match (`replay-result`).
   * Back to results returns to the same results (`replay-exit`). On a phone every press is a pointer tap, and the
   * portrait window is kept (the replay shows in portrait; the match itself runs with the Rotate prompt set aside).
   */
  async replayScenario(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.phoneScenario();
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
      suppressRotate(true);
    }
    const log: { phase: string; tick: number; speed?: number; paused?: boolean; camera?: string; hash?: number; wantHash?: number; winner?: number; want?: number; stocks?: number[]; wantStocks?: number[]; hidden?: boolean }[] = [];
    const onReplay = (e: Event) => log.push((e as CustomEvent).detail);
    window.addEventListener('dod:replay', onReplay);
    try {
      await this.startVersus(1);
      t.progress(0.1);
      await this.fight(() => false, 6 * 60 * 1000);
      const m = this.game.match() ?? this.seen;
      await this.screen('results', 30000);
      await this.wait(900);
      const watch = () => this.button('#results-actions', 'Watch replay');
      if (!watch()) {
        t.problem('bug', 'the results have no Watch replay button');
        return t.finish('done');
      }
      const wantWinner = m?.state.winner ?? -1;
      const wantStocks = m?.state.fighters.map((f) => f.stocks) ?? [];
      t.event('replay-button', `Results offer Watch replay (match won by P${wantWinner + 1}, stocks ${wantStocks.join('/')})`);
      await this.click(watch, 'Watch replay');
      await t.until(() => log.some((l) => l.phase === 'start') && currentScreen() === 'match', 30000, 'the replay to start');
      await this.wait(600);
      t.progress(0.3);

      // The bar fits: every button 44 px or more, 8 px apart, inside the window (and along the bottom on a phone).
      const btns = [...document.querySelectorAll<HTMLElement>('#replay-bar button')];
      const rects = btns.map((b) => b.getBoundingClientRect());
      const small = btns.filter((_, i) => rects[i].width < 44 || rects[i].height < 44).map((b) => `${b.textContent} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
      const off = btns.filter((_, i) => rects[i].left < 0 || rects[i].right > innerWidth || rects[i].top < 0 || rects[i].bottom > innerHeight).map((b) => b.textContent);
      let tight = 0;
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const gapX = Math.max(b.left - a.right, a.left - b.right);
        const gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
        if (Math.max(gapX, gapY) < 7.5) tight++;
      }
      const bottom = Math.max(...rects.map((r) => r.bottom));
      if (btns.length < 6) t.problem('bug', `the replay bar has only ${btns.length} buttons`);
      if (small.length) t.problem('bug', `replay buttons under 44 px: ${small.join(', ')}`);
      if (off.length) t.problem('bug', `replay buttons off screen at ${innerWidth}x${innerHeight}: ${off.join(', ')}`);
      if (tight) t.problem('bug', `${tight} pairs of replay buttons are closer than 8 px`);
      if (innerHeight > innerWidth && bottom < innerHeight * 0.7) t.problem('bug', `the replay bar is not along the bottom (lowest button ends at ${Math.round(bottom)} of ${innerHeight})`);
      t.event('replay-fit', `${btns.length} buttons, smallest ${Math.round(Math.min(...rects.map((r) => Math.min(r.width, r.height))))} px, bar ends at ${Math.round(bottom)} of ${innerHeight} (${innerWidth}x${innerHeight})`);
      t.metric('replayButtonsMinPx', Math.round(Math.min(...rects.map((r) => Math.min(r.width, r.height)))));
      this.checkClipping('replay', this.q('#replay'));

      const tickNow = () => this.game.replayTick();
      // Speeds: ticks gained over the same wall time at 0.5x, 1x and 2x.
      const gained = async (speed: string, ms: number) => {
        await this.click(() => this.q(`#replay-bar [data-speed="${speed}"]`), `speed ${speed}x`);
        await this.wait(300);
        const a = tickNow();
        await this.wait(ms);
        return tickNow() - a;
      };
      // Pause holds the tick.
      await this.click(() => this.q('#replay-pause'), 'Pause');
      await this.wait(300);
      const p0 = tickNow();
      await this.wait(900);
      const p1 = tickNow();
      if (p1 !== p0) t.problem('bug', `the replay kept playing while paused (${p0} → ${p1})`);
      else t.event('replay-pause', `paused at tick ${p0}, held for 0.9 s; button now reads "${this.q('#replay-pause')?.textContent}"`);
      await this.click(() => this.q('#replay-pause'), 'Play');
      const g1 = await gained('1', 1500);
      const gHalf = await gained('0.5', 1500);
      const g2 = await gained('2', 1500);
      if (!(gHalf < g1 && g1 < g2)) t.problem('bug', `replay speed buttons do not change the pace (0.5x ${gHalf}, 1x ${g1}, 2x ${g2} ticks in 1.5 s)`);
      else t.event('replay-speed', `ticks in 1.5 s: 0.5x ${gHalf}, 1x ${g1}, 2x ${g2}`);
      t.metric('replayTicks1x', g1);
      t.progress(0.5);

      // Tap the arena: the bar hides, another tap brings it back.
      await this.tap(() => this.q('#stage'), 'tap the arena');
      const hidden = !!this.q('#replay')?.classList.contains('bar-hidden');
      await this.tap(() => this.q('#stage'), 'tap the arena again');
      const shown = !this.q('#replay')?.classList.contains('bar-hidden');
      if (!hidden || !shown) t.problem('bug', `a tap on the arena did not hide then show the replay bar (hidden ${hidden}, shown again ${shown})`);
      else t.event('replay-bar-tap', 'a tap hid the bar, another brought it back');

      // Camera: Follow → Free → Follow.
      const cam = () => this.q('#replay-camera')?.textContent ?? '';
      await this.click(() => this.q('#replay-camera'), 'Camera');
      const free = cam();
      await this.click(() => this.q('#replay-camera'), 'Camera');
      const follow = cam();
      if (!/Free/.test(free) || !/Follow/.test(follow)) t.problem('bug', `the camera button read "${free}" then "${follow}", wanted Free then Follow`);
      else t.event('replay-camera', `camera toggled ${free} → ${follow}`);

      // Back 5 s works, then run to the end at 2x.
      const b0 = tickNow();
      await this.click(() => this.q('#replay-back'), '-5 s');
      await this.wait(200);
      const b1 = tickNow();
      if (!(b1 < b0 || b0 < 300)) t.problem('bug', `-5 s did not go back (${b0} → ${b1})`);
      else t.event('replay-back', `tick ${b0} → ${b1}`);
      await this.click(() => this.q('#replay-bar [data-speed="2"]'), 'speed 2x');
      await t.until(() => log.some((l) => l.phase === 'end'), 6 * 60 * 1000, 'the replay to end');
      const end = log.find((l) => l.phase === 'end')!;
      const same = end.winner === wantWinner && (end.stocks ?? []).join() === wantStocks.join() && end.hash === end.wantHash;
      if (!same) t.problem('bug', `the replay ended differently from the match: winner P${(end.winner ?? -2) + 1} vs P${wantWinner + 1}, stocks ${(end.stocks ?? []).join('/')} vs ${wantStocks.join('/')}, hash ${end.hash} vs ${end.wantHash}`);
      else t.event('replay-result', `same winner P${wantWinner + 1}, stocks ${wantStocks.join('/')} and final hash ${end.hash}`);
      t.progress(0.85);

      await this.click(() => this.q('#replay-exit'), 'Back to results');
      await this.screen('results', 20000);
      if (!watch()) t.problem('bug', 'Back to results did not bring the results with Watch replay back');
      else t.event('replay-exit', 'Back to results shows the results again');
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      t.progress(1);
      t.finish('done');
    } finally {
      window.removeEventListener('dod:replay', onReplay);
      if (touch) suppressRotate(false);
    }
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
        if (won) await this.checkGradeCard(c);
        if (won) {
          await this.click(() => this.button('#results-actions', 'Continue'), 'Continue');
          await this.playDialogue();
          await this.screen('campaign');
          this.checkMapStars(c);
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

  /**
   * The episode's bookends (ui/segment.ts): a won episode replays its final KO within 1 s with the last hit slowed, then the
   * outro, then Blog Man's "Next time on" tease over the next episode's stage; the next episode opens on "Previously on" with
   * the saved highlight and a voiced recap. A press skips each segment within 0.3 s and the results still come. Option
   * `chapter` (default open-mic; the next chapter is played too). Touch: the skips are pointer taps, played in 844x390.
   */
  async bookends(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('bookends');
    }
    this.logViewport(touch && this.isPhone());
    const asked = this.options.chapter ?? 'open-mic';
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    if (from < 0 || from + 1 >= CHAPTERS.length) {
      t.problem('bug', `chapter "${String(asked)}" is not an episode with a next one (content/campaign.json ids: ${CHAPTERS.map((c) => c.id).join(', ')})`);
      t.finish('error');
      return;
    }
    const c = CHAPTERS[from];
    const next = CHAPTERS[from + 1];
    type Seg = { kind: string; phase: string; at: number; abs: number; [k: string]: unknown };
    const segs: Seg[] = [];
    const onSeg = (e: Event) => segs.push({ ...(e as CustomEvent).detail, abs: performance.now() });
    const voices: string[] = [];
    const onVoice = (e: Event) => voices.push(String((e as CustomEvent).detail?.url ?? ''));
    window.addEventListener('dod:segment', onSeg);
    window.addEventListener('dod:voice', onVoice);
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((x) => x.id));
    const savedHl = localStorage.getItem('dod-highlight');
    localStorage.removeItem('dod-highlight');
    t.log(`setup shortcut: chapters 1-${from} marked cleared, no saved highlight, starting at ${c.id}`);
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      await this.toMainMenu();
      await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
      await this.screen('campaign');
      await this.click(() => this.q(`#chapter-path .chapter[data-chapter="${c.id}"]`), `Chapter ${from + 1} · ${c.title}`);
      await this.playDialogue();
      await this.matchLive();
      if (segs.some((s) => s.kind === 'recap')) t.problem('bug', 'the first episode of a run opened on a recap with nothing to recap');
      // The match: the bot to the end; the moment of the KO is the moment the match is over.
      let tOver = 0;
      await this.fight(() => {
        const m = this.game.match();
        if (m?.state.over && !tOver) tOver = performance.now();
        return false;
      }, 8 * 60 * 1000);
      if (!(this.game.match() ?? this.seen)?.playerWon()) {
        t.problem('bug', 'the bot lost the episode, so there is no final KO to replay: try another seed');
        t.finish('lost');
        return;
      }
      // 1. The replay of the final KO.
      await t.until(() => segs.some((s) => s.kind === 'replay' && s.phase === 'start'), 8000, 'the replay of the final KO');
      const rs = segs.find((s) => s.kind === 'replay' && s.phase === 'start')!;
      const lag = tOver ? rs.abs - tOver : 0;
      t.event('replay-start', `the replay of ${c.title}'s final KO started ${Math.round(lag)} ms after the KO (${rs.inputs} ticks of inputs stored, final hit tick ${rs.hit}, KO tick ${rs.ko})`);
      if (lag > 1000) t.problem('bug', `the replay started ${Math.round(lag)} ms after the KO (more than 1 s)`);
      t.metric('replayStartMs', Math.round(lag));
      await t.until(() => this.q('#scene')?.getAttribute('data-scene') === 'highlight' && !!this.q('#scene-card-title')?.textContent, 3000, 'the lower third');
      const tag = this.q('#scene-card-tag')?.textContent ?? '';
      const title = this.q('#scene-card-title')?.textContent ?? '';
      const bugShown = !!this.q('#scene-bug') && !this.q('#scene-bug')!.hidden;
      if (title !== c.title) t.problem('bug', `the replay's lower third says "${title}", not the episode title "${c.title}"`);
      if (!bugShown) t.problem('bug', 'the show logo bug is not on the replay');
      t.event('replay-lower-third', `${tag} · ${title}, logo bug shown: ${bugShown}`);
      await t.until(() => segs.some((s) => s.kind === 'replay' && s.phase === 'slow'), 5000, 'the final hit in slow motion');
      t.event('replay-slow', 'the final hit plays at 25%');
      await this.fitCheck('replay');
      // A press ends it within 0.3 s; the outro and tease follow.
      await this.skipSegment('replay');
      // 2. The outro scene is the story's own; let it play through, then the tease.
      await t.until(() => segs.some((s) => s.kind === 'tease' && s.phase === 'start') || currentScreen() === 'results', 90000, 'the Next time tease');
      const ts = segs.find((s) => s.kind === 'tease' && s.phase === 'start');
      if (!ts) t.problem('bug', 'no "Next time on" tease played before the results');
      else {
        await this.t.wait(900);
        const tvoice = voices.some((u) => u.includes(`blog-man.tease.${c.id}`));
        if (!tvoice) t.problem('bug', `Blog Man's tease line (blog-man.tease.${c.id}) did not play`);
        if (ts.next !== next.id) t.problem('bug', `the tease is for ${String(ts.next)}, not the next episode ${next.id}`);
        t.event('tease', `"${this.q('#scene-card-tag')?.textContent ?? ''}" · ${this.q('#scene-card-title')?.textContent ?? ''}, stage ${String(ts.stage)}, voiced: ${tvoice}, caption "${this.q('#scene-text')?.textContent ?? ''}"`);
        await this.fitCheck('tease');
        await this.skipSegment('tease');
      }
      await this.screen('results', 30000);
      t.event('results-after-skips', 'the results still came after the skipped segments');
      await this.click(() => this.button('#results-actions', 'Continue'), 'Continue');
      await this.screen('campaign');
      // 3. The next episode opens on "Previously on".
      segs.length = 0;
      voices.length = 0;
      await this.click(() => this.q(`#chapter-path .chapter[data-chapter="${next.id}"]`), `Chapter ${from + 2} · ${next.title}`);
      await t.until(() => segs.some((s) => s.kind === 'recap' && s.phase === 'start'), 30000, 'the Previously on recap');
      await t.wait(900);
      const rc = segs.find((s) => s.kind === 'recap' && s.phase === 'start')!;
      const rvoice = voices.some((u) => u.includes(`blog-man.recap.${c.id}`));
      if (!rvoice) t.problem('bug', `Blog Man's recap line (blog-man.recap.${c.id}) did not play`);
      if (rc.chapter !== c.id) t.problem('bug', `the recap replays ${String(rc.chapter)}, not the episode before (${c.id})`);
      if (!segs.some((s) => s.kind === 'recap' && s.phase === 'slow')) await t.until(() => segs.some((s) => s.kind === 'recap' && s.phase === 'slow'), 4000, 'the saved KO in slow motion').catch(() => {});
      t.event('recap', `"${this.q('#scene-card-tag')?.textContent ?? ''}" · ${this.q('#scene-card-title')?.textContent ?? ''}, saved highlight replayed on ${String(rc.stage)}, voiced: ${rvoice}, caption "${this.q('#scene-text')?.textContent ?? ''}"`);
      await this.fitCheck('recap');
      await this.skipSegment('recap');
      await this.playDialogue();
      await this.matchLive();
      t.event('next-episode-live', `${next.title} went on to its own fight after the recap`);
      await this.quitFromPause('campaign');
      t.finish('won');
    } finally {
      window.removeEventListener('dod:segment', onSeg);
      window.removeEventListener('dod:voice', onVoice);
      this.game.setCampaignProgress(before);
      if (savedHl === null) localStorage.removeItem('dod-highlight');
      else localStorage.setItem('dod-highlight', savedHl);
    }
  }

  /** A segment's picture fills the screen: its caption and lower third inside the window, above the bottom bar, no sideways scroll. */
  private async fitCheck(what: string): Promise<void> {
    const t = this.t;
    const w = innerWidth;
    const h = innerHeight;
    const inside = (sel: string) => {
      const el = this.q(sel);
      if (!el || el.hidden) return true;
      const r = el.getBoundingClientRect();
      return r.left >= -1 && r.right <= w + 1 && r.top >= -1 && r.bottom <= h + 1;
    };
    for (const sel of ['#scene-card', '#scene-sub', '#scene-bug', '#scene-skip']) {
      if (!inside(sel)) t.problem('bug', `the ${what} segment's ${sel} runs off the ${w}x${h} window`);
    }
    const bar = this.q('.scene-bar.bottom')?.getBoundingClientRect();
    const card = this.q('#scene-card')?.getBoundingClientRect();
    if (bar && card && !this.q('#scene-card')!.hidden && card.bottom > bar.top + 1) t.problem('bug', `the ${what} lower third overlaps the bottom bar`);
    const skip = this.q('#scene-skip')?.getBoundingClientRect();
    if (skip && (skip.width < 44 || skip.height < 44)) t.problem('bug', `the ${what} Skip button is ${Math.round(skip.width)}x${Math.round(skip.height)}, under 44 px`);
    if (document.documentElement.scrollWidth > w + 1) t.problem('bug', `the ${what} segment scrolls sideways`);
    t.event(`${what}-fit`, `${w}x${h}: lower third, caption, logo bug and Skip inside the window`);
  }

  /** Presses (a tap on a phone, a key on a desktop) and times how long the segment takes to end. */
  private async skipSegment(kind: string): Promise<void> {
    const t = this.t;
    const touch = matchMedia('(pointer: coarse)').matches;
    const t0 = performance.now();
    if (touch) {
      const x = innerWidth / 2;
      const y = innerHeight / 2;
      const target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body;
      const init = { pointerType: 'touch', pointerId: 52, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      await t.wait(40);
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    } else await tapKey('Space');
    await t.until(() => this.q('#scene')?.hidden !== false || this.q('#scene')?.getAttribute('data-scene') !== (kind === 'replay' ? 'highlight' : kind), 3000, `the ${kind} to be skipped`);
    const ms = Math.round(performance.now() - t0);
    t.event(`${kind}-skipped`, `${touch ? 'a tap' : 'a key'} ended the ${kind} in ${ms} ms`);
    if (ms > 300) t.problem('bug', `the ${kind} took ${ms} ms to skip (more than 0.3 s)`);
    t.metric(`${kind}SkipMs`, ms);
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

  /** The grades scenario: the chapter (option `chapter`, default house-heavy) played from the map, then the map opened again from the save. */
  async gradesRun(): Promise<void> {
    const t = this.t;
    const asked = this.options.chapter ?? 'house-heavy';
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    if (from < 0) {
      t.problem('bug', `chapter "${String(asked)}" is not in content/campaign.json`);
      t.finish('error');
      return;
    }
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
    const savedStars = localStorage.getItem('dod-stars');
    localStorage.removeItem('dod-stars');
    t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    const t0 = performance.now();
    try {
      await this.campaignFrom(from, () => performance.now() - t0 > CAMPAIGN_BUDGET_MS, from);
      const best = JSON.parse(localStorage.getItem('dod-stars') ?? '{}')[CHAPTERS[from].id];
      if (best) {
        // Back to the menu and onto the map again: the map reads the grade from the save.
        await this.toMainMenu();
        await this.click(() => this.q('[data-go="campaign"]'), 'Campaign');
        await this.screen('campaign');
        this.checkMapStars(CHAPTERS[from], 'after-reopen');
      } else t.note('the chapter was not won, so no grade was kept');
    } finally {
      this.game.setCampaignProgress(before);
      if (savedStars === null) localStorage.removeItem('dod-stars');
      else localStorage.setItem('dod-stars', savedStars);
    }
  }

  /** The stars card on a won episode's results: 1-3 stars, a line for each star's test, all on screen (and big enough on a phone). */
  private async checkGradeCard(c: (typeof CHAPTERS)[number]): Promise<void> {
    const t = this.t;
    const card = () => this.q('#results-body .results-grade');
    await t.until(() => !!card(), 8000, 'the stars card').catch((e) => {
      if (String(e).includes('stopped')) throw e;
    });
    const el = card();
    if (!el) return void t.problem('bug', `winning ${c.id} shows no stars on the results screen`);
    const stars = Number(el.dataset.stars);
    const steps = [...el.querySelectorAll<HTMLElement>('.grade-steps li')];
    if (!(stars >= 1 && stars <= 3) || steps.length !== 3) t.problem('bug', `the stars card says ${stars} stars with ${steps.length} labelled steps`);
    el.scrollIntoView({ block: 'nearest' });
    const bad = steps.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.width < 2 || r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.top < -1 || !li.textContent?.trim();
    });
    const px = Math.min(...steps.map((li) => parseFloat(getComputedStyle(li).fontSize)));
    if (bad.length) t.problem('bug', `${innerWidth}x${innerHeight}: ${bad.length} star label(s) are off screen on the results`);
    if (px < 12) t.problem('bug', `the star labels are ${px}px, under 12 px`);
    t.event('grade', `${c.id}: ${stars} of 3 (par ${c.par} s) · ${steps.map((li) => `${li.dataset.met === '1' ? '★' : '☆'} ${li.textContent?.replace(/[★☆]/g, '').trim()}`).join(' | ')} · ${innerWidth}x${innerHeight}`);
    t.metric('gradeStars', stars);
  }

  /** The season map shows a cleared episode's best stars with their count in words. */
  private checkMapStars(c: (typeof CHAPTERS)[number], when = 'after-win'): void {
    const t = this.t;
    const el = this.q(`#chapter-path .chapter[data-chapter="${c.id}"] .chapter-stars`);
    if (!el) return void t.problem('bug', `the season map shows no stars on the cleared episode ${c.id}`);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const saved = JSON.parse(localStorage.getItem('dod-stars') ?? '{}')[c.id] ?? 1;
    const label = el.querySelector('small')?.textContent ?? '';
    if (Number(el.dataset.stars) !== saved) t.problem('bug', `the map shows ${el.dataset.stars} stars on ${c.id} but the save has ${saved}`);
    if (r.width < 2 || r.height < 2 || r.left < -1 || r.right > innerWidth + 1) t.problem('bug', `${innerWidth}x${innerHeight}: the map's stars for ${c.id} are off screen`);
    t.event('map-stars', `${when}: ${c.id} ${el.dataset.stars} of 3 ("${label}") at ${Math.round(r.left)},${Math.round(r.top)} ${innerWidth}x${innerHeight}`);
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

  /**
   * The Orchestrator's finale takeover (campaign/takeover.ts, sim/step.ts): one finale (option `chapter`, default encore; season
   * finales are encore, sponsored, walk-on, hostile-takeover, clip-show, global-feed, series-finale, best-in-show, cliffhanger,
   * final-cut) played from the Campaign map with the bot. Logs the takeover (`takeover-start`: mood ahead/behind, over 100%, the
   * lines), the glitch, the picture-in-picture clear of the HUD and (touch) the controls (`takeover-pip`), each line spoken
   * (`takeover-line`) and the rule on the HUD within 1 s (`takeover-rule`). Touch: played in the turned 844x390 frame.
   */
  async finaleHijack(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('finale-hijack');
    }
    const asked = this.options.chapter ?? 'encore';
    const from = CHAPTERS.findIndex((c) => c.id === asked);
    const def = CHAPTERS[from]?.fight.events?.find((e) => e.kind === 'takeover');
    if (!def) {
      t.problem('bug', `chapter "${String(asked)}" has no takeover event (content/campaign.json: the ten season finales do)`);
      t.finish('error');
      return;
    }
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const before = this.game.setCampaignProgress(CHAPTERS.slice(0, from).map((c) => c.id));
    t.log(`setup shortcut: chapters 1-${from} marked cleared, starting at ${CHAPTERS[from].id}`);
    let started = 0;
    let startFrame = -1;
    let ruled = 0;
    const rect = (el: Element | null) => (el && (el as HTMLElement).getClientRects().length ? el.getBoundingClientRect() : null);
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const onTakeover = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { phase: string; mood?: string; hot?: boolean; lines?: string[]; rule?: string; id?: string; text?: string; frame: number; index?: number };
      if (d.phase === 'start') {
        started++;
        startFrame = d.frame;
        t.metric('takeoverAtSeconds', Math.round(d.frame / 6) / 10);
        t.event('takeover-start', `${asked}: the Orchestrator seizes the feed at ${Math.round(d.frame / 60)} s, player ${d.mood}${d.hot ? ' and over 100%' : ''}; lines ${d.lines?.join(', ')}; rule ${d.rule ?? 'none'}`);
        const post = this.game.postStats?.();
        window.setTimeout(() => {
          const pip = this.q('.takeover-pip');
          const pr = rect(pip);
          if (!pr) return t.problem('bug', 'the Orchestrator\'s picture-in-picture is not on screen after the takeover');
          const clashes: string[] = [];
          const others = [...document.querySelectorAll<HTMLElement>('.touch-btn, .touch-pause, .touch-stick, #match-top, #hud .hud-card, #pause')];
          for (const o of others) {
            const r = rect(o);
            if (r && hit(pr, r)) clashes.push(o.className || o.id);
          }
          const inside = pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight;
          if (clashes.length || !inside) t.problem('bug', `the picture-in-picture (${Math.round(pr.left)},${Math.round(pr.top)} ${Math.round(pr.width)}x${Math.round(pr.height)}) ${inside ? 'covers' : 'runs off the screen and may cover'} ${clashes.join(', ')} at ${innerWidth}x${innerHeight}`);
          else t.event('takeover-pip', `picture-in-picture at ${Math.round(pr.left)},${Math.round(pr.top)} ${Math.round(pr.width)}x${Math.round(pr.height)} is clear of the ${others.filter((o) => rect(o)).length} HUD and touch controls at ${innerWidth}x${innerHeight}`);
          if (post) t.event('takeover-glitch', `RGB-split glitch started (post chain glitches: ${post.glitches}, ${post.quality} quality)`);
        }, 450);
      } else if (d.phase === 'line') {
        t.event('takeover-line', `${d.index! + 1}. ${d.id}: "${d.text}"`);
      } else if (d.phase === 'rule') {
        ruled++;
        const chip = this.q('.rule-chip')?.textContent ?? '';
        const lag = d.frame - startFrame;
        if (!chip.includes(d.rule ?? '?')) t.problem('bug', `the rule "${d.rule}" is not on the HUD chip ("${chip}")`);
        else if (lag > 60) t.problem('bug', `the rule took ${lag} frames to land after the takeover (more than 1 s)`);
        else t.event('takeover-rule', `"${d.rule}" on the HUD ${lag} frames (${(lag / 60).toFixed(2)} s) after the takeover`);
      }
    };
    window.addEventListener('dod:takeover', onTakeover);
    const t0 = performance.now();
    try {
      await this.campaignFrom(from, () => performance.now() - t0 > CAMPAIGN_BUDGET_MS, from);
    } finally {
      window.removeEventListener('dod:takeover', onTakeover);
      this.game.setCampaignProgress(before);
    }
    t.metric('takeovers', started);
    t.metric('takeoverRules', ruled);
    if (!started) t.problem('bug', `the ${asked} fight ended without the Orchestrator's takeover (60 s in, or the player down to 2 stocks)`);
    else if (def.rule && !ruled) t.problem('bug', 'the takeover never changed a rule');
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

  private ratingCounts: { from: number; to: number; delta: number; steps: number }[] = [];

  /** Criteria 1, 2 and 4 of the online results: the count-up, the opponent's name and fighter, and the fit with text of 14 px or more. */
  private onlineResultsChecks(opp: string, won: boolean, ratingText: string): void {
    const t = this.t;
    const card = this.q('#results-opponent');
    const cardText = card?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!card || !cardText.includes(opp)) t.problem('bug', `the opponent's name (${opp}) isn't on the online results: "${cardText}"`);
    else t.event('results-opponent', cardText);
    const fighterName = this.q('#results-opponent .online-fighter')?.textContent ?? '';
    if (!fighterName) t.problem('bug', "the opponent's fighter isn't on the online results");
    const link = this.q('#results-opponent .online-link')?.textContent ?? '';
    if (!/ms|Direct|Relay|Signal/.test(link)) t.problem('bug', `the opponent card has no connection: "${link}"`);
    const count = this.ratingCounts[this.ratingCounts.length - 1];
    if (!count) t.problem('bug', 'the rating change did not count up (no dod:rating-count)');
    else {
      t.event('rating-count', `${count.from} -> ${count.to} (${count.delta >= 0 ? '+' : ''}${count.delta}) in ${count.steps} frames`);
      if (count.steps < 3 && !matchMedia('(prefers-reduced-motion: reduce)').matches) t.problem('bug', `the rating jumped in ${count.steps} frame(s) instead of counting`);
    }
    if (!/#\d+ on the board/.test(ratingText)) t.problem('bug', `the results don't show the place on the board: "${ratingText}"`);
    void won;
    // Fit: the actions are on screen with no scrolling, the card is above them, and no text is under 14 px.
    const actions = this.q('#results-actions')?.getBoundingClientRect();
    const cardBox = card?.getBoundingClientRect();
    const small: string[] = [];
    for (const el of card?.querySelectorAll<HTMLElement>('*') ?? []) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 14) small.push(`${el.className || el.tagName} ${px}px`);
    }
    if (small.length) t.problem('bug', `text under 14 px on the online results: ${small.join(', ')}`);
    const fits = !!actions && !!cardBox && actions.bottom <= innerHeight + 1 && cardBox.bottom <= actions.top + 1 && cardBox.right <= innerWidth + 1 && cardBox.left >= -1;
    const portrait = innerHeight > innerWidth;
    if (portrait && !fits) t.problem('bug', `on a ${innerWidth}x${innerHeight} phone the opponent card and rating don't fit above the buttons (card bottom ${Math.round(cardBox?.bottom ?? -1)}, buttons ${Math.round(actions?.top ?? -1)}-${Math.round(actions?.bottom ?? -1)})`);
    t.event('online-results-fit', `${innerWidth}x${innerHeight}: ${fits ? 'fits' : 'does not fit'}, smallest text ${small.length ? 'under 14 px' : '14 px or more'}`);
  }

  /**
   * Reconnecting (docs/online.md): peer 1's connection is cut for 3 s mid-fight. Both pages pause with "Reconnecting…" and
   * a countdown (the banner clear of every touch control), the same player is heard again and play resumes with the same
   * stocks and percents (the frame stands still while paused, then moves on). Then it is cut for longer than the 10 s
   * window: the match ends as a disconnect, with no rating. Peer 0 watches (and plays: the bot is on the pad).
   */
  private async reconnectPart(net: NonNullable<Awaited<ReturnType<typeof onlineReady>>>, peer: number, opp: string): Promise<void> {
    const t = this.t;
    const log: { phase: string; who: string; cause: string; n: number; frame: number; stocks: number[]; percents: number[] }[] = [];
    window.addEventListener('dod:reconnect', (e) => log.push((e as CustomEvent).detail));
    const frame = () => this.game.match()?.state.frame ?? 0;
    const banner = () => this.q('#net-status');
    const shown = () => !!banner() && !banner()!.hidden && /^Reconnecting…/.test(banner()!.textContent ?? '');
    const countdowns: number[] = [];
    const watch = window.setInterval(() => {
      const n = Number(/(\d+) s/.exec(banner()?.textContent ?? '')?.[1] ?? NaN);
      if (shown() && Number.isFinite(n) && countdowns[countdowns.length - 1] !== n) countdowns.push(n);
    }, 100);
    const clear = () => {
      const b = banner()!.getBoundingClientRect();
      const touch = touchOverlay();
      const hits: string[] = [];
      touch?.querySelectorAll<HTMLElement>('.touch-btn, .touch-stick, button').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === 'hidden') return;
        if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) hits.push(el.className || el.tagName);
      });
      return { b, hits };
    };
    try {
      await t.until(() => frame() > 300, 60000, 'some of the fight to be played');
      // 1. The cut: peer 1 drops for 3 s; both pages show the banner and hold the match still.
      if (peer === 1) {
        await t.wait(1000);
        const before = { frame: frame(), stocks: this.game.match()!.state.fighters.map((f) => f.stocks), percents: this.game.match()!.state.fighters.map((f) => f.percent) };
        t.event('reconnect-cut', `peer 1 cuts its connection for 3 s at frame ${before.frame}`);
        const cut = net.cutLink(3000);
        await t.until(shown, 5000, 'our own Reconnecting… banner');
        const at = frame();
        await cut;
        await t.wait(500);
        if (!shown()) t.event('reconnect-banner-gone', 'the banner is gone after the cut');
        await t.until(() => frame() > at + 30, 20000, 'play to resume after our cut');
        t.event('reconnect-resumed', `resumed at frame ${frame()} (was ${at}), stocks ${this.game.match()!.state.fighters.map((f) => f.stocks).join('/')} (were ${before.stocks.join('/')})`);
        if (this.game.match()!.state.fighters.some((f, i) => f.stocks > before.stocks[i])) t.problem('bug', 'a fighter has more stocks after the reconnect than before');
      } else {
        await t.until(shown, 30000, 'Reconnecting… on this page (the other player dropped)');
        const at = frame();
        const first = banner()!.textContent ?? '';
        t.event('reconnecting-banner', `"${first}" at frame ${at}`);
        const { b, hits } = clear();
        if (hits.length) t.problem('bug', `the Reconnecting banner covers a touch control (${hits.join(', ')})`);
        else t.event('reconnect-banner-clear', `banner ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)} clear of every touch control at ${innerWidth}x${innerHeight}`);
        if (b.left < 0 || b.right > innerWidth || b.top < 0) t.problem('bug', 'the Reconnecting banner is off the screen');
        await t.wait(1200);
        if (frame() !== at) t.problem('bug', `the match kept running under Reconnecting… (frame ${at} -> ${frame()})`);
        else t.event('reconnect-paused', `the match stands still on frame ${at}`);
        await t.until(() => !shown(), 15000, 'Reconnecting… to go away (the other player is back)');
        await t.until(() => frame() > at + 30, 20000, 'play to resume');
        t.event('reconnect-resumed', `resumed at frame ${frame()} (was ${at})`);
        if (countdowns.length < 2) t.problem('bug', `the Reconnecting… countdown didn't count (saw ${countdowns.join(', ')})`);
        else t.event('reconnect-countdown', `the countdown read ${countdowns.join(', ')}`);
      }
      const back = log.filter((l) => l.phase === 'back').length;
      const away = log.filter((l) => l.phase === 'away').length;
      if (!away || !back) t.problem('bug', `the drop did not open and close a rejoin window (away ${away}, back ${back})`);
      if (this.game.match()?.state.over) t.problem('bug', 'the match ended on a 3 s drop');
      t.progress(0.7);

      // 2. A drop longer than the window: a disconnect, not a rated forfeit.
      await t.wait(2000);
      if (peer === 1) {
        t.event('reconnect-long-cut', 'peer 1 cuts its connection for 14 s (the window is 10 s)');
        void net.cutLink(14000);
      }
      await t.until(() => currentScreen() === 'results', 60000, 'the match to end after the long drop');
      const headline = this.q('#results-body h2')?.textContent ?? '';
      const note = this.q('.results-note')?.textContent ?? '';
      t.event('disconnect-result', `${headline}: ${note}`);
      if (!/Connection lost/.test(headline)) t.problem('bug', `a drop past the window ended "${headline}", not as a disconnect`);
      if (/left the match|You left/i.test(`${headline} ${note}`)) t.problem('bug', 'a disconnect was shown as a forfeit');
      if (!/(You|\S+) dropped/.test(note) || !/Not rated as a quit/.test(note)) t.problem('bug', `a disconnect result must say who dropped and that it was not rated as a quit: "${note}"`);
      else t.event('disconnect-who', note);
      const oppCard = this.q('#results-opponent')?.textContent ?? '';
      if (!oppCard.includes(opp)) t.problem('bug', `the disconnect result doesn't name the opponent (${opp}): "${oppCard}"`);
      await t.wait(1500);
      const state = this.q('#results-rating')?.dataset.state ?? '';
      t.event('disconnect-unrated', `rating state "${state}"; ${/confirmed/.test(state) ? 'RATED' : 'not rated'}`);
      if (/confirmed/.test(state)) t.problem('bug', 'a disconnect changed the rating');
    } finally {
      window.clearInterval(watch);
    }
    await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
    await this.screen('main');
    t.progress(0.97);
  }

  /** The `rematch` scenario: `online`'s lobby and first game, then Rematch on both (see rematchPart). */
  rematchMode = false;

  /** Every button and row of the rematch UI measured at the window's size: 44 px tall and wide, inside the screen. */
  private rematchFit(what: string, els: HTMLElement[]): void {
    const t = this.t;
    const small: string[] = [];
    const off: string[] = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const name = (el.textContent?.trim() || el.getAttribute('aria-label') || el.className).slice(0, 24);
      if (r.height < 43.5 || r.width < 43.5) small.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5) {
        // (a tile inside a scrolling row may sit past the row's edge: only the row itself must fit)
        if (!el.closest('.rematch-row') || el.classList.contains('rematch-row')) off.push(`${name} ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    if (small.length) t.problem('bug', `${what}: under 44 px: ${small.join('; ')}`);
    if (off.length) t.problem('bug', `${what}: off the ${innerWidth}x${innerHeight} screen: ${off.join('; ')}`);
    if (!small.length && !off.length) t.event('rematch-fit', `${what}: ${els.length} controls, all 44 px or more and on screen at ${innerWidth}x${innerHeight}`);
  }

  /**
   * After `online`'s first game: both see Rematch (with Queue again and Main menu), press it, pick (peer 1 changes
   * fighter), and a new match starts against the same opponent; after that game peer 0 presses Rematch and peer 1
   * leaves with Queue again: peer 0 sees who left and queues again with one tap. Taps only (hit-tested pointer events).
   */
  private async rematchPart(peer: number, opp: string, mm: { state: string }): Promise<void> {
    const t = this.t;
    const panel = () => this.q('#rematch');
    const phase = () => panel()?.dataset.phase ?? '';
    const first = this.game.match()!;
    const firstId = first.setup.online!.matchId;
    const firstChars = first.setup.slots.map((s) => s.char);

    // 1. The buttons on the result.
    await t.until(() => !!this.button('#results-actions', 'Rematch'), 10000, 'Rematch on the online results');
    for (const label of ['Rematch', 'Queue again', 'Main menu']) if (!this.button('#results-actions', label)) t.problem('bug', `no ${label} on the online results`);
    t.event('rematch-offered', `${this.q('#results-body h2')?.textContent ?? ''}: ${[...document.querySelectorAll('#results-actions button')].map((b) => b.textContent?.trim()).join(' / ')}; ${this.q('#rematch .rematch-line')?.textContent ?? ''}`);
    this.rematchFit('results buttons', [...document.querySelectorAll<HTMLElement>('#results-actions button')]);
    t.progress(0.5);

    // 2. Both press Rematch (peer 1 a moment later: the first waits and is told).
    if (peer === 1) await t.wait(2500);
    await this.tap(() => this.button('#results-actions', 'Rematch'), 'Rematch');
    t.event('rematch-pressed', `peer ${peer} pressed Rematch (${this.q('#rematch .rematch-line')?.textContent ?? ''})`);
    await t.until(() => phase() === 'picking', 20000, 'the fighter pick (both pressed Rematch)');
    const tiles = [...document.querySelectorAll<HTMLElement>('#rematch .rematch-tile')];
    const row = this.q('#rematch .rematch-fighters');
    this.rematchFit('fighter pick', [...(row ? [row] : []), ...tiles.slice(0, 3), ...document.querySelectorAll<HTMLElement>('#rematch .rematch-lock, #rematch .rematch-chip'), ...(this.q('#results-actions button') ? [...document.querySelectorAll<HTMLElement>('#results-actions button')] : [])]);
    const openIds = CHARACTERS.filter((c) => isUnlocked(c.id));
    if (tiles.length !== openIds.length) t.problem('bug', `the pick lists ${tiles.length} fighters; ${openIds.length} are unlocked`);
    const selected = this.q('#rematch .rematch-tile.on')?.dataset.fighter ?? '';
    const mine = CHARACTERS[firstChars[first.player]].id;
    if (selected !== mine) t.problem('bug', `the pick starts on ${selected}, not the last pick (${mine})`);
    if (row && row.scrollWidth > row.clientWidth) t.event('rematch-row-scrolls', `the fighter row scrolls sideways inside the panel (${row.scrollWidth} px in ${row.clientWidth})`);
    t.event('rematch-pick', `${tiles.length} unlocked fighters, starts on ${selected}${this.q('#rematch .rematch-stages') ? ', stage row shown (this player lost)' : ''}`);
    let chosen = mine;
    if (peer === 1) {
      const other = tiles.find((x) => x.dataset.fighter !== mine);
      if (other) {
        chosen = other.dataset.fighter!;
        // A drag on the row first, like a thumb (it scrolls; it must not pick).
        await this.tap(() => this.q(`#rematch .rematch-tile[data-fighter="${chosen}"]`), `fighter ${chosen}`);
        if (this.q('#rematch .rematch-tile.on')?.dataset.fighter !== chosen) t.problem('bug', `tapping ${chosen} did not select it`);
        else t.event('rematch-change', `peer 1 switched ${mine} to ${chosen}`);
      }
    }
    const stage = this.q('#rematch .rematch-chip:not(.on)');
    if (stage) await this.tap(() => this.q('#rematch .rematch-chip:not(.on)'), 'a stage');
    await this.tap(() => this.q('#rematch .rematch-lock'), 'Lock in');

    // 3. The new match: the same opponent, a new match id, the picked fighters.
    await t.until(() => this.game.match()?.setup.mode === 'online' && this.game.match()!.setup.online!.matchId !== firstId && currentScreen() === 'match' && this.game.phase() === 'play', 90000, 'the rematch to start');
    const m = this.game.match()!;
    const names = m.setup.online!.names;
    if (names[1 - m.player] !== opp) t.problem('bug', `the rematch is against ${names[1 - m.player]}, not ${opp}`);
    const now = m.setup.slots.map((x) => CHARACTERS[x.char].id);
    t.event('rematch-start', `${names[0]} (${now[0]}) vs ${names[1]} (${now[1]}) on ${STAGES[m.state.stage].name}; before: ${firstChars.map((c) => CHARACTERS[c].id).join(' / ')}`);
    if (peer === 1 && now[m.player] !== chosen) t.problem('bug', `peer 1 picked ${chosen} but plays ${now[m.player]}`);
    t.metric('rematchGames', 2);
    t.progress(0.7);

    // 4. The second game to its end, then one declines: Rematch on peer 0, Queue again on peer 1.
    await t.until(() => currentScreen() === 'results', 5 * 60 * 1000, 'the rematch game to end');
    await t.until(() => !!this.button('#results-actions', 'Rematch'), 10000, 'Rematch on the second results');
    const ratedNote = this.q('#results-rating')?.dataset.state ?? '';
    t.event('rematch-rated-per-game', `second result's rating state "${ratedNote}"`);
    if (peer === 0) {
      await this.tap(() => this.button('#results-actions', 'Rematch'), 'Rematch');
      await t.until(() => phase() === 'declined' || phase() === 'closed', 25000, 'the other player leaving the rematch');
      const line = this.q('#rematch .rematch-line')?.textContent ?? '';
      t.event('rematch-declined', line);
      if (!line.includes(opp) || !/left/i.test(line)) t.problem('bug', `the declined rematch says "${line}", not who left`);
      if (this.button('#results-actions', 'Rematch')) t.problem('bug', 'Rematch is still offered after the other player left');
      const q = this.button('#results-actions', 'Queue again');
      if (!q) t.problem('bug', 'no Queue again after the other player left');
      else this.rematchFit('after the other player left', [q, ...document.querySelectorAll<HTMLElement>('#results-actions button')]);
      await this.tap(() => this.button('#results-actions', 'Queue again'), 'Queue again');
      await t.until(() => mm.state !== 'idle', 8000, 'Queue again to search (one tap)');
      t.event('rematch-queue-again', 'one tap on Queue again went to searching');
    } else {
      await t.wait(4000);
      await this.tap(() => this.button('#results-actions', 'Queue again'), 'Queue again');
      t.event('rematch-left', 'peer 1 left the rematch with Queue again');
    }
    t.progress(0.97);
  }

  /**
   * The connection bars and the agreed delay (docs/online.md, "Delay and the bars"): a bar block by each name on the HUD
   * with a reading, clear of the percent and (on a phone) inside the screen and at least 3 px wide per bar; the delay
   * both tabs run with, from the ping measured before the match. Events `net-delay`, `net-bars`.
   */
  private async connectionBars(net: NonNullable<Awaited<ReturnType<typeof onlineReady>>>, peer: number): Promise<void> {
    const t = this.t;
    const stats = () => net.fightStats();
    await t.until(() => (stats()?.delay ?? 0) > 0, 20000, 'the agreed input delay');
    const s = stats()!;
    t.event('net-delay', `peer ${peer}: delay ${s.delay} frames from ping ${s.ping} ms`);
    t.metric('netDelayStart', s.delay);
    const bars = () => Array.from(document.querySelectorAll<HTMLElement>('#hud .conn-bars'));
    await t.until(() => bars().length === 2 && bars().every((b) => Number(b.dataset.bars) > 0), 15000, 'connection bars with a reading by both names');
    const rects = bars().map((b) => b.getBoundingClientRect());
    const levels = bars().map((b) => b.dataset.bars);
    t.event('net-bars', `bars ${levels.join(' / ')} at ${window.innerWidth}x${window.innerHeight}${isTouchDevice() ? ' touch' : ''}`);
    bars().forEach((b, i) => {
      const r = rects[i];
      const card = b.closest('.hud-card') as HTMLElement;
      const pct = card.querySelector('.hud-pct')!.getBoundingClientRect();
      if (r.width < 8 || r.height < 6 || r.right > window.innerWidth || r.bottom > window.innerHeight || r.left < 0) t.problem('bug', `the connection bars of card ${i} are not on screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`);
      const hit = r.left < pct.right && r.right > pct.left && r.top < pct.bottom && r.bottom > pct.top;
      if (hit) t.problem('bug', `the connection bars of card ${i} overlap the percent`);
    });
  }

  /** Two tabs (peers: 2) in one private test lobby: see each other, rename, queue, get matched, fight, results. */
  /** The `reconnect` scenario: `online`'s lobby and match, with the connection cut during the fight (see reconnectPart). */
  cutMode = false;

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

    // Online matches start with no match intro (both pages must start together): any intro event while the match is online is a bug.
    let introOnline = 0;
    window.addEventListener('dod:match-intro', (e) => {
      if ((e as CustomEvent).detail?.phase === 'start' && this.game.match()?.setup.mode === 'online') introOnline++;
    });
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
    if (introOnline) t.problem('bug', 'the match intro played in an online match');
    else t.event('online-no-intro', 'the online match started with no match intro');
    await this.connectionBars(net, peer);
    if (this.cutMode) return this.reconnectPart(net, peer, opp);
    let lastStats = net.fightStats();
    const statsWatch = window.setInterval(() => {
      lastStats = net.fightStats() ?? lastStats;
    }, 400);
    this.progressNow = () => 0.45 + 0.45 * Math.min(1, (this.game.match()?.state.frame ?? 0) / Math.max(1, m.state.rules.timeLimit || 5400));
    window.addEventListener('dod:rating-count', (e) => this.ratingCounts.push((e as CustomEvent).detail));
    await t.until(() => currentScreen() === 'results', 5 * 60 * 1000, 'the online match to end');
    window.clearInterval(statsWatch);
    if (lastStats) {
      t.metric('netDelay', lastStats.delay);
      t.metric('netPing', lastStats.ping);
      t.metric('netRollbacks', lastStats.rollbacks);
      t.metric('netRolledFrames', lastStats.rolledFrames);
      t.metric('netMaxRolled', lastStats.maxRolled);
      t.metric('netStalls', lastStats.stallTicks);
      t.metric('netStallShare', Number((lastStats.stallTicks / Math.max(1, lastStats.stallTicks + lastStats.ranTicks)).toFixed(4)));
      t.event('net-stats', `delay ${lastStats.delay}f, ping ${lastStats.ping} ms, ${lastStats.rollbacks} rollbacks (${lastStats.rolledFrames} frames, max ${lastStats.maxRolled}), ${lastStats.stallTicks} stalled ticks`);
    }
    this.progressNow = () => 0.95;

    // 6. Results, with Queue again.
    const headline = this.q('#results-body h2')?.textContent ?? '';
    t.event('online-result', `${headline}${this.q('.results-note') ? ` (${this.q('.results-note')!.textContent})` : ''}`);
    if (!this.button('#results-actions', 'Queue again')) t.problem('bug', 'no Queue again on the online results');
    if (/void|lost/i.test(headline)) t.problem('bug', `the online match ended "${headline}": ${this.q('.results-note')?.textContent ?? ''}`);
    const won = /^You win/.test(headline);
    if (this.rematchMode) return this.rematchPart(peer, opp, mm);

    // 7. The rating change on the result: both signatures in, "+16" / "−16" for two new players.
    const rating = () => this.q('#results-rating');
    await t.until(() => /confirmed|expected|void|same/.test(rating()?.dataset.state ?? ''), 20000, 'the rating change on the result');
    // The number counts to its final value (dod:rating-count fires when it lands), and the card names the opponent.
    await t.until(() => rating()?.dataset.counted === '1', 8000, 'the rating change to finish counting');
    const ratingText = rating()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    t.event('rating-change', ratingText);
    this.onlineResultsChecks(opp, won, ratingText);
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

  /**
   * Tonight's Episode (campaign/daily.ts): the card on the main menu shows tonight's fighters, stage and twist (the same
   * episode the pure picker gives for the date, so two tabs on one date agree: `daily-episode` logs its signature), Blog
   * Man's line and the countdown, and fits the window; Play tonight plays the episode (the bot on the pad, up to 3 tries),
   * the results show the score, the day streak and today's board with the player on it. On a phone (390x844 touch) the
   * card is checked in the portrait window and the episode is played in the turned 844x390 frame, all by taps. The
   * player's own `dod.daily` is put back at the end.
   */
  async dailyRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const portrait = touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560;
    this.logViewport(touch && this.isPhone());
    const saved = localStorage.getItem(DAILY_KEY);
    localStorage.removeItem(DAILY_KEY);
    try {
      await this.toMainMenu();
      if (touch) {
        this.useTap = true;
        forceTouchUi(true);
      }
      const date = dailyDate();
      const ep = dailyEpisode(date, DAILY_POOL);
      t.progress(0.05);
      await t.until(() => this.q('#daily-card')?.dataset.date === date && !!this.q('#daily-play'), 10000, "Tonight's Episode card");
      const card = () => this.q('#daily-card')!;
      const text = (sel: string) => card().querySelector(sel)?.textContent?.trim() ?? '';
      // The card says what the picker says for the date.
      const sig = `${ep.date} ${ep.player} vs ${ep.ally ? `${ep.ally}+` : ''}${ep.foes.join('+')} @ ${ep.stage} ${ep.objective} ${ep.twists.map((x) => x.kind).join('+') || 'no-twist'}`;
      t.event('daily-episode', sig);
      if (text('.daily-title') !== castLine(ep)) t.problem('bug', `the card says "${text('.daily-title')}" but the episode for ${date} is "${castLine(ep)}"`);
      if (!text('.daily-rule').startsWith(objectiveLine(ep)) || (twistLine(ep) && !text('.daily-rule').includes(twistLine(ep)))) {
        t.problem('bug', `the card's rule line "${text('.daily-rule')}" doesn't match "${objectiveLine(ep)} · ${twistLine(ep)}"`);
      }
      if (!text('.daily-tag').includes("Tonight's Episode")) t.problem('bug', "the main menu card isn't headed Tonight's Episode");
      if (!/Day streak \d+/.test(text('.daily-streak'))) t.problem('bug', 'the card shows no day streak');
      if (!text('.daily-blog').includes('Blog Man')) t.problem('bug', "the card has no Blog Man intro");
      const count = text('.daily-count');
      if (!/^Next episode in \d+[hm] \d{2}[ms]$/.test(count)) t.problem('bug', `the countdown reads "${count}"`);
      t.event('daily-card', `${castLine(ep)} · ${text('.daily-stage')} · ${text('.daily-rule')} · "${text('.daily-blog').slice(0, 60)}" · ${count} (tomorrow in ${Math.round(msToNext(Date.now()) / 60000)} min)`);
      // It fits: in the window sideways and top to bottom, nothing cut off inside it, targets 44 px.
      card().scrollIntoView({ block: 'nearest' });
      await t.wait(150);
      const fit = (el: HTMLElement, what: string) => {
        const r = el.getBoundingClientRect();
        const inside = r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5;
        const cut = [el, ...el.querySelectorAll<HTMLElement>('*')].filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== 'visible' && c.clientWidth > 0 && !(c instanceof HTMLImageElement));
        if (!inside) t.problem('bug', `${what} is not fully on screen at ${innerWidth}x${innerHeight} (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)})`);
        if (cut.length) t.problem('bug', `${what} has clipped text (${cut.map((c) => c.className || c.tagName).join(', ')})`);
        const small = this.phoneTargets(el);
        if (touch && small.length) t.problem('bug', `${what}: ${small.join('; ')}`);
        return inside && !cut.length && !small.length;
      };
      const fits = fit(card(), "Tonight's Episode card");
      t.event('daily-card-fit', `${fits ? 'fits' : 'does not fit'} at ${innerWidth}x${innerHeight}${touch ? ' touch' : ''}`);
      t.metric('dailyCardFits', fits ? 1 : 0);
      await this.click(() => this.q('#daily-listen'), 'Blog Man');
      t.event('daily-listen', 'Blog Man intro played from the card');
      if (portrait) {
        // A portrait phone can't hold a match: turn it, and play the episode in the landscape frame.
        if (saved === null) localStorage.removeItem(DAILY_KEY);
        else localStorage.setItem(DAILY_KEY, saved);
        return this.touchMatchTurned('daily');
      }

      let result: { won: boolean; score: number; streak: number } | null = null;
      for (let tryNo = 1; tryNo <= 3 && !result?.won; tryNo++) {
        t.progress(0.1 + tryNo * 0.2);
        if (tryNo === 1) await this.click(() => this.q('#daily-play'), 'Play tonight');
        else await this.click(() => this.button('#results-actions', 'Try again'), 'Try again');
        await this.matchLive();
        const m = this.game.match()!;
        const chip = this.q('#objective');
        const chipShown = !!chip && !chip.hidden && chip.getClientRects().length > 0;
        if (!chipShown) t.problem('bug', `the ${ep.objective} episode shows no objective chip on the HUD`);
        else t.event('daily-objective', `try ${tryNo}: ${chip?.textContent ?? ''} with ${this.q('#timer')?.textContent ?? '?'} on the clock`);
        this.progressNow = () => 0.1 + tryNo * 0.2 + 0.15 * Math.min(1, m.state.frame / Math.max(1, ep.timeLimit));
        await this.fight(() => false, (ep.timeLimit / 60 + 120) * 1000 * 4);
        const won = await this.results();
        await this.t.until(() => !!this.q('#daily-results'), 10000, "Tonight's Episode on the results");
        const panel = this.q('#daily-results')!;
        const stat = (k: string) => panel.querySelector(`[data-stat="${k}"] strong`)?.textContent?.trim() ?? '';
        const score = Number(stat('daily-score').replace(/,/g, '')) || 0;
        const streak = Number(stat('daily-streak')) || 0;
        // The board is read once, when the results open: wait for it (no polling here either).
        await this.t.until(() => this.q('#daily-board')?.dataset.total !== undefined, 20000, "today's board");
        const board = this.q('#daily-board')!;
        const rank = Number(board.dataset.rank ?? 0);
        const total = Number(board.dataset.total ?? 0);
        const mine = board.querySelector('.daily-row.me');
        if (won && (!score || streak < 1)) t.problem('bug', `a cleared episode shows score "${stat('daily-score')}" and streak "${stat('daily-streak')}"`);
        if (won && !mine) t.problem('bug', `a cleared episode: the player is not on today's board (${total} on it, rank ${rank})`);
        if (!won && stat('daily-score') !== 'No score') t.problem('bug', `a lost episode shows "${stat('daily-score')}" as its score`);
        panel.scrollIntoView({ block: 'nearest' });
        await t.wait(150);
        const boardFits = fit(panel, "the results' Tonight's Episode panel");
        t.event('daily-result', `try ${tryNo}: ${won ? 'cleared' : 'not cleared'} · score ${score} · day streak ${streak} · best ${stat('daily-best')} · ${this.q('#daily-rank')?.textContent ?? ''}`);
        t.event('daily-board', `${total} on tonight's board, rank ${rank || 'none'}${boardFits ? ', fits the window' : ''}: ${[...board.querySelectorAll('.daily-row')].slice(0, 3).map((r) => r.textContent).join(' | ')}`);
        t.metric('dailyScore', score);
        t.metric('dailyStreak', streak);
        t.metric('dailyBoardRank', rank);
        t.metric('dailyBoardFits', boardFits ? 1 : 0);
        result = { won, score, streak };
      }
      if (!result?.won) t.problem('warning', 'the bot did not clear tonight\'s episode in 3 tries, so no score reached the board');
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      await t.until(() => this.q('#daily-card')?.dataset.cleared === (result?.won ? '1' : '0'), 5000, 'the card after the episode');
      t.event('daily-card-after', `${text('.daily-streak')} · ${text('.daily-foot')}`);
      t.progress(1);
      t.finish('done');
    } finally {
      if (!portrait) {
        if (saved === null) localStorage.removeItem(DAILY_KEY);
        else localStorage.setItem(DAILY_KEY, saved);
      }
    }
  }

  /**
   * Tour (campaign/tour.ts, content/tours.json): the main menu's Tour opens the select screen (every fighter's tile, none
   * cleared on a fresh save, fits the window with no sideways scroll, 44 px targets on a phone), the Continue or Quit panel
   * is measured (setup shortcut: shown without losing a fight, so a portrait phone can see it), the fighter's Tour starts
   * and the bot plays fights 1 and 2 (each opens with the foe's recorded line in the arena under the fight's card, the twist
   * and CPU level from the route), then a setup shortcut jumps to the last fight: the rival. The player stands still until
   * knocked out (the Continue or Quit panel, then Continue replays that fight), then the bot wins: the ending plays the
   * fighter's own recorded win line over the final KO, the closing card "<Fighter> clears the Tour", the results banner, and
   * the Tour select shows the mark; the page reloads and the mark is still there. Option `fighter` (default exit-punk). On a
   * portrait phone (390x844 touch) the select and the panel are checked in the portrait window and the Tour is played in the
   * turned 844x390 frame, everything by taps. The player's own `dod-tours` is put back at the end.
   */
  async tourScenario(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const portrait = touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560;
    this.logViewport(touch && this.isPhone());
    const fighterId = typeof this.options.fighter === 'string' ? this.options.fighter : 'exit-punk';
    const tour = tourFor(fighterId);
    const name = CHARACTERS.find((c) => c.id === fighterId)?.name ?? fighterId;
    if (!tour) {
      t.problem('bug', `no Tour for "${fighterId}" in content/tours.json`);
      t.finish('error');
      return;
    }
    const RUN_KEY = 'dod.playtest.tour';
    const carried = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(RUN_KEY) ?? 'null') as { original: string | null } | null;
      } catch {
        return null;
      }
    })();
    const original = carried ? carried.original : localStorage.getItem(TOURS_KEY);
    const restore = () => {
      if (original === null) localStorage.removeItem(TOURS_KEY);
      else localStorage.setItem(TOURS_KEY, original);
    };
    let reloading = false;
    const phases: { phase: string; [k: string]: unknown }[] = [];
    const voices: string[] = [];
    const onTour = (e: Event) => phases.push((e as CustomEvent).detail);
    const onVoice = (e: Event) => voices.push((e as CustomEvent).detail.url);
    window.addEventListener('dod:tour', onTour);
    window.addEventListener('dod:voice', onVoice);
    const lookup = (id: string) => VOICE.lines.find((l) => l.id === id);
    const fit = (el: HTMLElement | null, what: string): boolean => {
      if (!el) {
        t.problem('bug', `${what} is not on screen`);
        return false;
      }
      const sideways = document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1;
      const bad = [...el.querySelectorAll<HTMLElement>('button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5);
      });
      if (sideways) t.problem('bug', `${what} scrolls sideways at ${innerWidth}x${innerHeight} (page ${document.documentElement.scrollWidth} wide)`);
      if (bad.length) t.problem('bug', `${what}: ${bad.length} button(s) run off the side of the window`);
      const small = touch ? this.phoneTargets(el) : [];
      if (small.length) t.problem('bug', `${what}: ${small.join('; ')}`);
      return !sideways && !bad.length && !small.length;
    };
    const openSelect = async () => {
      await this.click(() => this.q('#btn-tour'), 'Tour');
      await this.screen('tour');
      await t.until(() => document.querySelectorAll('#tour-grid .tour-tile').length > 0, 5000, 'the Tour tiles');
    };
    const tile = () => this.q(`#tour-grid [data-tour="${fighterId}"]`);
    try {
      await this.toMainMenu();
      if (touch) {
        this.useTap = true;
        forceTouchUi(true);
      }
      if (carried) {
        // The page was reloaded: the mark must still be there.
        sessionStorage.removeItem(RUN_KEY);
        await openSelect();
        const el = tile();
        const marked = el?.dataset.cleared === '1' && /Tour cleared/.test(el.textContent ?? '');
        if (!marked) t.problem('bug', `after a reload, ${name}'s Tour is not marked cleared on the Tour select`);
        t.event('tour-mark-after-reload', `${name}'s tile reads "${el?.querySelector('.tour-status')?.textContent ?? '?'}" after the page reloaded (localStorage ${TOURS_KEY}: ${localStorage.getItem(TOURS_KEY)})`);
        t.metric('tourMarkedAfterReload', marked ? 1 : 0);
        restore();
        t.progress(1);
        t.finish('done');
        return;
      }
      localStorage.removeItem(TOURS_KEY);
      t.progress(0.03);
      // The main menu has Tour; the select screen shows every fighter, none cleared yet.
      const item = this.q('#btn-tour');
      if (!item || item.getClientRects().length === 0) t.problem('bug', 'the main menu has no Tour entry');
      else if (touch && item.getBoundingClientRect().height < 43.5) t.problem('bug', `the main menu's Tour entry is ${Math.round(item.getBoundingClientRect().height)} px tall`);
      await openSelect();
      const tiles = [...document.querySelectorAll<HTMLElement>('#tour-grid .tour-tile')];
      const doneNow = tiles.filter((x) => x.dataset.cleared === '1').length;
      if (tiles.length !== TOURS.length) t.problem('bug', `the Tour select shows ${tiles.length} tiles, content/tours.json has ${TOURS.length} Tours`);
      if (doneNow) t.problem('bug', `a fresh save shows ${doneNow} Tours already cleared`);
      if (!tile() || (tile() as HTMLButtonElement).disabled) t.problem('bug', `${name}'s tile is missing or locked on the Tour select`);
      const selectFits = fit(this.q('#tour'), 'the Tour select');
      t.event('tour-select', `${tiles.length} fighters (${tiles.filter((x) => !(x as HTMLButtonElement).disabled).length} open), ${doneNow} cleared, ${selectFits ? 'fits' : 'does not fit'} at ${innerWidth}x${innerHeight}${touch ? ' touch' : ''}`);
      t.metric('tourSelectFits', selectFits ? 1 : 0);
      // The Continue or Quit panel, measured without losing a fight (a portrait phone can't play one).
      await this.game.tourChoicePreview(fighterId);
      await this.screen('results');
      const choiceFits = fit(this.q('#results'), 'the Continue or Quit panel');
      const cont = this.q('#tour-continue');
      const quit = this.q('#tour-quit');
      if (!cont || !quit) t.problem('bug', 'the Tour panel has no Continue and Quit buttons');
      else {
        for (const b of [cont, quit]) {
          const r = b.getBoundingClientRect();
          if (r.top < 0 || r.bottom > innerHeight + 0.5) t.problem('bug', `"${b.textContent}" is not on screen without scrolling (${Math.round(r.top)} to ${Math.round(r.bottom)} of ${innerHeight})`);
        }
      }
      t.event('tour-choice-fit', `${choiceFits ? 'fits' : 'does not fit'} at ${innerWidth}x${innerHeight}${touch ? ' touch' : ''}: ${[cont, quit].map((b) => `${b?.textContent} ${Math.round(b?.getBoundingClientRect().height ?? 0)} px`).join(', ')}`);
      t.metric('tourChoiceFits', choiceFits ? 1 : 0);
      await this.click(() => this.q('#tour-quit'), 'Quit');
      await this.screen('tour');
      if (portrait) {
        restore();
        return this.touchMatchTurned('tour');
      }

      // Fights 1 and 2, played by the bot.
      t.progress(0.1);
      await this.click(() => {
        const el = tile();
        el?.scrollIntoView({ block: 'center' });
        return el;
      }, `${name}'s Tour`);
      this.game.tourSkipTo(2, TOUR_LENGTH - 1);
      let prev: Match | null = null;
      const intoFight = async (n: number): Promise<Match> => {
        const f = tour.fights[n];
        await t.until(() => this.game.match() !== prev && (sceneShowing() || this.game.phase() === 'play'), 120000, `fight ${n + 1}'s opening`);
        let beats: { card: { tag: string; kicker: string; title: string; line: string }; lines: string[] } | null = null;
        if (sceneShowing()) beats = await this.passTourScene();
        const want = tourIntro(tour, n, lookup);
        if (!beats) t.problem('bug', `fight ${n + 1} has no scene in the arena before it`);
        else {
          if (beats.card.tag !== 'Tonight' || beats.card.kicker !== want.card.kicker || beats.card.title !== f.title || beats.card.line !== f.line) {
            t.problem('bug', `fight ${n + 1}'s card reads "${beats.card.kicker} / ${beats.card.title} / ${beats.card.line}", expected "${want.card.kicker} / ${f.title} / ${f.line}"`);
          }
          // A line is shown a sentence at a time (campaign/sceneText.ts), so compare the words in order.
          const got = beats.lines.join(' ');
          if (got !== want.lines.map((l) => l.text).join(' ')) t.problem('bug', `fight ${n + 1}'s scene says "${got}", expected "${want.lines.map((l) => l.text).join(' ')}"`);
          const unvoiced = want.lines.filter((l) => l.audio && !voices.includes(l.audio));
          if (unvoiced.length) t.problem('bug', `fight ${n + 1}'s scene did not play the recorded line ${unvoiced.map((l) => l.audio).join(', ')}`);
          t.event('tour-scene', `fight ${n + 1}: ${beats.card.kicker} · ${beats.card.title} · "${beats.card.line}" then ${beats.lines.map((l) => `"${l}"`).join(', ')} (${want.lines.filter((l) => l.audio && voices.includes(l.audio)).length} recorded)`);
        }
        await t.until(() => this.game.phase() === 'play', 30000, `fight ${n + 1} to start`);
        const m = this.game.match()!;
        prev = m;
        const s = m.setup;
        const foes = s.slots.filter((x) => x.team === 1);
        const twistOk =
          s.slots[0].cpu === null &&
          foes.length === f.foes.length &&
          foes.every((x) => x.cpu === f.cpu) &&
          (f.twist !== 'giant' || foes[0].scale === f.scale) &&
          (f.twist !== 'low' || s.rules.gravity === f.gravity) &&
          (f.twist !== 'race' || (s.objective === 'ko' && s.kos === f.kos));
        if (!twistOk) t.problem('bug', `fight ${n + 1} (${f.twist}) is not set up as content/tours.json says`);
        t.event('tour-fight', `fight ${n + 1} of ${TOUR_LENGTH}: ${f.title} (${f.twist}) vs ${f.foes.join(' + ')} on ${f.stage}, CPU ${f.cpu}${f.scale ? `, giant ${f.scale}%` : ''}${f.gravity ? `, gravity ${f.gravity}%` : ''}${f.kos ? `, ${f.kos} KOs before the clock` : ''}`);
        return m;
      };
      const cpus: number[] = [];
      for (let n = 0; n < 2; n++) {
        t.progress(0.15 + n * 0.2);
        const m = await intoFight(n);
        cpus.push(tour.fights[n].cpu);
        await this.fight(() => false, 480000);
        const won = m.playerWon();
        t.event('tour-fight-result', `fight ${n + 1} ${won ? 'won' : 'lost'}`);
        if (!won) {
          // A loss is a Continue: the same fight again.
          await this.screen('results');
          await this.click(() => this.q('#tour-continue'), 'Continue');
          prev = m;
          n--;
        }
      }

      // The last fight, the rival: knocked out once on purpose (the Continue panel), then the bot wins.
      t.progress(0.55);
      let m = await intoFight(TOUR_LENGTH - 1);
      cpus.push(tour.fights[TOUR_LENGTH - 1].cpu);
      if (!cpus.every((c, i) => i === 0 || c >= cpus[i - 1])) t.problem('bug', `the CPU gets easier through the Tour (${cpus.join(', ')})`);
      t.metric('tourFinalCpu', tour.fights[TOUR_LENGTH - 1].cpu);
      this.manual = NO_INPUT;
      const idleFrom = performance.now();
      while (currentScreen() !== 'results' && performance.now() - idleFrom < 170000) await this.wait(500);
      this.manual = null;
      let continues = 0;
      if (currentScreen() === 'results' && this.q('#tour-choice')) {
        const fits = fit(this.q('#results'), 'the Continue or Quit panel after a lost fight');
        const head = this.q('#tour-choice h2')?.textContent ?? '';
        if (head !== 'Knocked out') t.problem('bug', `a lost Tour fight's panel is headed "${head}"`);
        t.event('tour-lost', `fight ${TOUR_LENGTH} lost: the panel offers ${[...document.querySelectorAll('#results-actions button')].map((b) => `${b.textContent} (${Math.round(b.getBoundingClientRect().height)} px)`).join(' or ')}, ${fits ? 'fits' : 'does not fit'}`);
        await this.click(() => this.q('#tour-continue'), 'Continue');
        continues++;
        await this.screen('match', 60000);
        await t.until(() => this.game.phase() === 'play' && this.game.match() !== m, 30000, 'the same fight to start again');
        m = this.game.match()!;
        const again = tour.fights[TOUR_LENGTH - 1];
        if (m.setup.slots.filter((x) => x.team === 1).length !== again.foes.length || m.setup.stage !== STAGES.findIndex((x) => x.id === again.stage)) t.problem('bug', 'Continue did not restart the same fight');
        t.event('tour-continue', `Continue replayed fight ${TOUR_LENGTH} (${again.title}) on ${again.stage}`);
      } else {
        t.problem('warning', `the rival beat nobody in ${Math.round((performance.now() - idleFrom) / 1000)} s of standing still, so the Continue panel was only measured from the preview`);
      }
      t.metric('tourContinues', continues);
      prev = m;
      await this.fight(() => false, 480000);
      let won = m.playerWon();
      for (let tries = 0; !won && tries < 3; tries++) {
        await this.screen('results');
        await this.click(() => this.q('#tour-continue'), 'Continue');
        continues++;
        await t.until(() => this.game.phase() === 'play' && this.game.match() !== m, 60000, 'the rival fight to start again');
        m = this.game.match()!;
        await this.fight(() => false, 480000);
        won = m.playerWon();
      }
      if (!won) {
        t.problem('warning', 'the bot did not beat the rival in 4 tries, so the ending was not reached');
        restore();
        t.finish('done');
        return;
      }

      // The ending: the fighter's own win line over the final KO, the closing card, the banner, the mark.
      t.progress(0.85);
      await t.until(() => sceneShowing() || currentScreen() === 'results', 60000, 'the ending');
      const end = tourEnding(tour, lookup);
      if (!sceneShowing()) t.problem('bug', 'the last win has no ending in the arena');
      else {
        const e = await this.passTourScene();
        if (e.card.tag !== 'Signing off' || e.card.title !== `${name} clears the Tour` || e.card.line !== tour.ending) {
          t.problem('bug', `the closing card reads "${e.card.tag} / ${e.card.title} / ${e.card.line}", expected "${name} clears the Tour / ${tour.ending}"`);
        }
        const winAudio = end.lines[0]?.audio;
        if (e.lines.join(' ') !== end.lines.map((l) => l.text).join(' ')) t.problem('bug', `the ending says "${e.lines.join(' ')}", expected the win line "${end.lines[0]?.text}"`);
        if (!winAudio || !voices.includes(winAudio)) t.problem('bug', `the ending did not play ${name}'s recorded win line (${winAudio})`);
        t.event('tour-ending', `${e.card.title} · "${e.card.line}" · win line "${e.lines.join(' ')}" ${winAudio && voices.includes(winAudio) ? 'played' : 'NOT played'} over the final KO`);
      }
      await this.watchEnding(fighterId, name, voices, true);
      await this.screen('results', 30000);
      const banner = this.q('#tour-cleared');
      if (!banner || !(banner.textContent ?? '').includes(`${name} clears the Tour`)) t.problem('bug', `the results show no "${name} clears the Tour" banner`);
      if (!this.q('#results-body .highlights')) t.problem('bug', 'the final results show no KO highlights');
      const stored = (() => {
        try {
          return (JSON.parse(localStorage.getItem(TOURS_KEY) ?? '[]') as string[]).includes(fighterId);
        } catch {
          return false;
        }
      })();
      if (!stored) t.problem('bug', `localStorage ${TOURS_KEY} does not hold ${fighterId} after the ending`);
      t.event('tour-cleared', `${banner?.querySelector('h2')?.textContent ?? ''} · ${continues} continue(s) used · ${TOURS_KEY} ${stored ? 'has' : 'lacks'} ${fighterId}`);
      t.metric('tourCleared', stored ? 1 : 0);
      await this.click(() => this.button('#results-actions', 'Tour list'), 'Tour list');
      await this.screen('tour');
      const el = tile();
      const marked = el?.dataset.cleared === '1' && /Tour cleared/.test(el.textContent ?? '');
      if (!marked) t.problem('bug', `the Tour select does not mark ${name}'s Tour cleared after the ending`);
      t.event('tour-marked', `${name}'s tile reads "${el?.querySelector('.tour-status')?.textContent ?? '?'}" on the Tour select`);

      // Reload: the mark comes back from localStorage.
      sessionStorage.setItem(RUN_KEY, JSON.stringify({ original }));
      reloading = true;
      t.event('reload', 'the page reloads; the run carries on after it');
      const url = new URL(location.href);
      url.searchParams.set('playtest', 'tour');
      url.searchParams.set('seed', String(this.options.seed ?? 1));
      url.searchParams.set('speed', String(this.options.speed ?? 1));
      await t.wait(300);
      location.replace(url.toString());
      await new Promise(() => {});
    } finally {
      window.removeEventListener('dod:tour', onTour);
      window.removeEventListener('dod:voice', onVoice);
      if (!reloading && !portrait) restore();
    }
  }

  /**
   * A Tour's painted ending (ui/ending.ts) on screen: the picture loaded at 1920x1080 and filling the window (cropped, not
   * squeezed), caption one then caption two inside the window and clear of the bottom edge, the narration take played, the
   * fighter's sting, the "Tour complete" card with the colour earned; then a tap (or the end) closes it.
   */
  private async watchEnding(fighterId: string, name: string, voices: string[], afterTour: boolean): Promise<void> {
    const t = this.t;
    const e = endingFor(fighterId);
    if (!e) {
      t.problem('bug', `no ending in content/endings.json for ${fighterId}`);
      return;
    }
    const sting: string[] = [];
    const onEnding = (ev: Event) => sting.push((ev as CustomEvent).detail.phase);
    window.addEventListener('dod:ending', onEnding);
    try {
      await t.until(() => endingShowing(), 30000, 'the painted ending');
      const t0 = performance.now();
      const img = this.q('#ending-art') as HTMLImageElement | null;
      if (!img) return void t.problem('bug', 'the ending has no picture');
      await t.until(() => img.complete, 15000, 'the ending picture to load');
      const loaded = img.naturalWidth >= 1900 && img.naturalHeight >= 1060;
      if (!loaded) t.problem('bug', `${name}'s ending picture is ${img.naturalWidth}x${img.naturalHeight}, not 1920x1080 (${e.art})`);
      const r = img.getBoundingClientRect();
      const fills = r.width >= innerWidth - 1 && r.height >= innerHeight - 1 && getComputedStyle(img).objectFit === 'cover';
      if (!fills) t.problem('bug', `the ending picture does not fill the window (${Math.round(r.width)}x${Math.round(r.height)} in ${innerWidth}x${innerHeight}, ${getComputedStyle(img).objectFit})`);
      const seen: string[] = [];
      let captionFits = true;
      const skip = this.q('#ending-skip');
      const card = () => this.q('#ending');
      const until = performance.now() + 25000;
      while (performance.now() < until && endingShowing() && !card()?.classList.contains('carded')) {
        const cap = this.q('#ending-caption');
        const text = cap?.textContent ?? '';
        if (cap && text && getComputedStyle(cap).opacity !== '0') {
          if (!seen.includes(text)) seen.push(text);
          const c = cap.getBoundingClientRect();
          if (c.left < 0 || c.right > innerWidth || c.top < 0 || c.bottom > innerHeight - 8) captionFits = false;
          const s = skip?.getBoundingClientRect();
          if (s && c.right > s.left && c.left < s.right && c.bottom > s.top && c.top < s.bottom) captionFits = false;
        }
        await this.wait(100);
      }
      if (!captionFits) t.problem('bug', `the ending's caption runs outside the window or under the Skip button at ${innerWidth}x${innerHeight}`);
      if (seen.length < 2 || seen[0] !== e.lines[0] || seen[1] !== e.lines[1]) t.problem('bug', `the ending showed captions ${JSON.stringify(seen)}, expected ${JSON.stringify(e.lines)}`);
      const voiced = !!e.audio && voices.includes(e.audio);
      if (!voiced) t.problem('bug', `${name}'s ending did not play the narration take (${e.audio})`);
      const cardEl = this.q('#ending-card');
      const cardText = cardEl?.textContent ?? '';
      const cardOk = !!cardEl && cardText.includes(afterTour ? 'Tour complete' : 'Ending') && cardText.includes(name) && cardText.includes('Colour earned') && !!cardEl.querySelector('.ending-swatch');
      if (!cardOk) t.problem('bug', `the ending's closing card reads "${cardText}"`);
      const cr = cardEl?.getBoundingClientRect();
      if (cr && (cr.left < 0 || cr.right > innerWidth || cr.bottom > innerHeight - 8 || cr.top < 0)) t.problem('bug', `the ending's closing card runs outside the window at ${innerWidth}x${innerHeight}`);
      const ms = performance.now() - t0;
      const wantMs = ENDING_BEATS.card - ENDING_BEATS.caption1;
      t.event('ending', `${name}: ${loaded ? '1920x1080' : 'bad'} picture ${fills ? 'fills' : 'does not fill'} ${innerWidth}x${innerHeight}; captions ${JSON.stringify(seen)} ${captionFits ? 'fit' : 'DO NOT fit'}; narration ${voiced ? 'played' : 'NOT played'}; ${sting.includes('sting') ? 'sting' : 'no sting'}; card "${cardText.replace(/\\s+/g, ' ').trim()}" after ${Math.round(ms)} ms (beats ${wantMs} ms)`);
      t.metric('endingFits', loaded && fills && captionFits && cardOk ? 1 : 0);
      // A tap skips (a finger on a phone).
      await this.tap(() => this.q('#ending'), 'the ending (a tap skips)');
      await t.until(() => !endingShowing(), 3000, 'the ending to close on a tap');
      t.event('ending-skip', `a tap closed ${name}'s ending after ${Math.round(performance.now() - t0)} ms`);
    } finally {
      window.removeEventListener('dod:ending', onEnding);
    }
  }

  /**
   * Endings (campaign/endings.ts, ui/extras.ts, ui/ending.ts): setup shortcut marks Tours cleared (`dod-tours`, put back at the
   * end); Extras from the main menu shows one slot per fighter (33), open ones for the cleared Tours and locked the rest
   * (`endings-gallery`); a tap on an open slot replays that fighter's ending (`ending`). On a phone everything is a tap.
   */
  /**
   * The opening titles (ui/opening.ts) from the moment they were asked for (`since`): they start within 1 s, fill the window,
   * ignore a tap in the first second, then either play to the end (name cards, the logo slam; `full`) or are skipped by a tap.
   */
  private async watchOpening(o: { since: number; skipAt: number; full?: boolean; tag: string }): Promise<void> {
    const t = this.t;
    const seen: { phase: string; at: number; name?: string }[] = [];
    const on = (e: Event) => { const d = (e as CustomEvent).detail; seen.push({ phase: d.phase, at: performance.now(), name: d.name }); };
    window.addEventListener('dod:opening', on);
    try {
      await t.until(() => openingShowing() || seen.some((x) => x.phase === 'start'), 5000, `the opening titles (${o.tag})`).catch(() => undefined);
      const start = seen.find((x) => x.phase === 'start');
      if (!start) {
        t.problem('bug', `the opening did not start after ${o.tag}`);
        return;
      }
      const startMs = Math.round(start.at - o.since);
      if (startMs > 1000) t.problem('bug', `the opening started ${startMs} ms after ${o.tag}, over 1 s`);
      const v = document.querySelector<HTMLVideoElement>('#opening-video');
      const r = v?.getBoundingClientRect();
      const fills = !!r && r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
      if (!fills) t.problem('bug', `the opening does not fill the window at ${innerWidth}x${innerHeight}`);
      t.event('opening-start', `the opening started ${startMs} ms after ${o.tag}, ${fills ? 'fills' : 'does not fill'} ${innerWidth}x${innerHeight}`);
      t.metric('openingStartMs', startMs);
      // A tap inside the first second must not skip it.
      await t.wait(Math.max(0, 300 - (performance.now() - start.at)));
      this.pressOpening();
      await t.wait(150);
      if (!openingShowing()) t.problem('bug', `the opening was skipped by a tap before ${OPENING_SKIP_AFTER} ms`);
      else t.event('opening-no-early-skip', 'a tap at 0.3 s did not skip the opening');
      if (o.full) {
        await t.until(() => seen.some((x) => x.phase === 'logo'), 40000, 'the logo slam').catch(() => undefined);
        const names = seen.filter((x) => x.phase === 'name').map((x) => x.name);
        if (names.length !== OPENING_CAST.length) t.problem('bug', `the opening showed ${names.length} name cards, expected ${OPENING_CAST.length}`);
        if (!seen.some((x) => x.phase === 'logo')) t.problem('bug', 'the logo never slammed in');
        t.event('opening-cast', `name cards: ${names.join(', ')}; logo ${seen.some((x) => x.phase === 'logo') ? 'slammed' : 'missing'}`);
        t.metric('openingNameCards', names.length);
        await t.until(() => !openingShowing(), 15000, 'the opening to end').catch(() => undefined);
      } else {
        await t.wait(Math.max(0, o.skipAt - (performance.now() - start.at)));
        this.pressOpening();
        await t.until(() => !openingShowing(), 1500, 'a tap to skip the opening').catch(() => undefined);
        if (openingShowing()) t.problem('bug', 'a tap after 1 s did not skip the opening');
        else t.event('opening-skip', `a tap ${Math.round(performance.now() - start.at)} ms in skipped the opening`);
      }
      const end = seen.find((x) => x.phase === 'end');
      if (end) t.metric('openingSeconds', Math.round((end.at - start.at) / 100) / 10);
    } finally {
      window.removeEventListener('dod:opening', on);
    }
  }

  /** A tap on the opening itself (pointer down and up, like a finger). */
  private pressOpening(): void {
    const el = document.getElementById('opening');
    if (!el) return;
    const touch = matchMedia('(pointer: coarse)').matches;
    const init = { pointerType: touch ? 'touch' : 'mouse', pointerId: 52, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: innerWidth / 2, clientY: innerHeight / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    this.t.add('interactions');
  }

  /**
   * The opening titles from Extras: Opening plays the 30 s film (start, no skip at 0.3 s, six name cards over the cast shots,
   * the logo slam, the end), then a second replay is skipped by a tap after 1 s. The title plays the theme's instrumental.
   * On a phone (touch, 844x390) every press is a tap and the film fills the window.
   */
  async openingScenario(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    this.logViewport(touch && this.isPhone());
    const saved = localStorage.getItem(OPENING_KEY);
    try {
      this.useTap = touch;
      await this.screen('title', 30000);
      await this.tapToPlay();
      await t.until(() => audio.musicPlaying === 'music-title', 15000, 'the title music').catch(() => undefined);
      if (audio.musicPlaying !== 'music-title') t.problem('bug', `the title plays ${audio.musicPlaying ?? 'nothing'}, not the theme's instrumental`);
      else t.event('title-music', 'the title screen plays music-title (the theme instrumental)');
      await this.click(() => this.q('#btn-start'), 'Press start');
      await this.screen('main');
      await this.click(() => this.q('#btn-extras'), 'Extras');
      await this.screen('extras');
      let at = performance.now();
      await this.click(() => this.q('#btn-opening'), 'Opening');
      await this.watchOpening({ since: at, skipAt: 1300, full: true, tag: 'Extras > Opening' });
      await this.screen('extras');
      at = performance.now();
      await this.click(() => this.q('#btn-opening'), 'Opening');
      await this.watchOpening({ since: at, skipAt: 1300, tag: 'the replay' });
      await this.screen('extras');
    } finally {
      if (saved === null) localStorage.removeItem(OPENING_KEY);
      else localStorage.setItem(OPENING_KEY, saved);
    }
  }

  async endingsScenario(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    this.logViewport(touch && this.isPhone());
    const ids = ['exit-punk', 'blog-man', 'kaelen'];
    const fighterId = typeof this.options.fighter === 'string' ? this.options.fighter : 'exit-punk';
    if (!ids.includes(fighterId)) ids.push(fighterId);
    const original = localStorage.getItem(TOURS_KEY);
    const voices: string[] = [];
    const onVoice = (e: Event) => voices.push((e as CustomEvent).detail.url);
    window.addEventListener('dod:voice', onVoice);
    try {
      localStorage.setItem(TOURS_KEY, JSON.stringify(ids));
      this.useTap = touch;
      await this.tapToPlay();
      await this.click(() => this.q('#btn-extras'), 'Extras');
      await this.screen('extras');
      await t.until(() => document.querySelectorAll('#ending-grid .ending-tile').length > 0, 5000, 'the ending slots');
      const tiles = [...document.querySelectorAll<HTMLButtonElement>('#ending-grid .ending-tile')];
      const open = tiles.filter((x) => x.dataset.unlocked === '1');
      const cleared = new Set(ids);
      const want = ENDINGS.filter((e) => endingUnlocked(e.fighter, cleared)).length;
      const sideways = document.documentElement.scrollWidth > innerWidth + 1;
      const small = touch ? this.phoneTargets(this.q('#extras')!) : [];
      if (tiles.length !== 33) t.problem('bug', `the Endings gallery shows ${tiles.length} slots, not 33`);
      if (open.length !== want) t.problem('bug', `${open.length} endings are open, expected ${want} for ${ids.length} cleared Tours`);
      if (sideways) t.problem('bug', `Extras scrolls sideways at ${innerWidth}x${innerHeight}`);
      if (small.length) t.problem('bug', `Extras: ${small.join('; ')}`);
      t.event('endings-gallery', `${tiles.length} slots, ${open.length} open (${ids.join(', ')} cleared), ${sideways ? 'scrolls sideways' : 'fits'} at ${innerWidth}x${innerHeight}`);
      t.metric('endingSlots', tiles.length);
      t.metric('endingsOpen', open.length);
      const broken = open.filter((x) => { const im = x.querySelector('img'); return im && im.complete && im.naturalWidth === 0; });
      if (broken.length) t.problem('bug', `${broken.length} open slot picture(s) did not load`);
      for (const id of [fighterId, ...(this.options.all ? ids.filter((x) => x !== fighterId) : [])]) {
        const name = CHARACTERS.find((c) => c.id === id)?.name ?? id;
        voices.length = 0;
        await this.click(() => this.q(`#ending-grid [data-ending="${id}"]`), `${name}'s ending`);
        await this.watchEnding(id, name, voices, false);
      }
      const locked = this.q('#ending-grid .ending-tile.locked') as HTMLButtonElement | null;
      if (locked && !locked.disabled) t.problem('bug', 'a locked ending slot can be pressed');
      t.finish('done');
    } finally {
      window.removeEventListener('dod:voice', onVoice);
      this.useTap = false;
      if (original === null) localStorage.removeItem(TOURS_KEY);
      else localStorage.setItem(TOURS_KEY, original);
    }
  }

  /** A Tour scene (the between-fights line or the ending): the card, then each line, cut through with Next once heard. */
  private async passTourScene(): Promise<{ card: { tag: string; kicker: string; title: string; line: string }; lines: string[] }> {
    const t = this.t;
    const root = this.q('#scene');
    const text = (id: string) => this.q(id)?.textContent?.trim() ?? '';
    let card = { tag: '', kicker: '', title: '', line: '' };
    const lines: string[] = [];
    const seen = new Set<string>();
    const t0 = performance.now();
    while (sceneShowing() && performance.now() - t0 < 120000) {
      const beat = root?.getAttribute('data-beat') ?? '';
      if (beat === 'card' && !seen.has('card')) {
        seen.add('card');
        card = { tag: text('#scene-card-tag'), kicker: text('#scene-card-kicker'), title: text('#scene-card-title'), line: text('#scene-card-line') };
        await this.wait(1200);
        if (root?.getAttribute('data-beat') === 'card') await this.click(() => this.q('#scene-next'), 'Next (card)');
        continue;
      }
      if (beat.startsWith('line-') && !seen.has(beat)) {
        seen.add(beat);
        const said = text('#scene-text');
        const words = said.split(/\s+/).filter(Boolean).length;
        if (words > MAX_WORDS) t.problem('bug', `a Tour scene shows ${words} words at once ("${said}")`);
        lines.push(said);
        await this.wait(900);
        if (sceneShowing() && root?.getAttribute('data-beat') === beat) await this.click(() => this.q('#scene-next'), 'Next');
        continue;
      }
      await this.wait(150);
    }
    return { card, lines };
  }

  /**
   * Sudden death (sim/step.ts startSuddenDeath, main.ts suddenDeathMoment): a setup shortcut puts two idle fighters into a
   * versus match with a 10 s clock (nobody touches anything, so stocks and percent are exactly level at time-out). It must
   * go to sudden death instead of naming a winner (`sudden-start`), with the slam card up and inside the screen
   * (`sudden-slam`, `sudden-slam-fit`), the announcer's call (`sudden-call`), both fighters at 300% (`sudden-percent`);
   * then the bot plays and the bout must end on a KO inside 30 s (`sudden-end`, metric `suddenSeconds`), not as a time-out.
   * On a phone (390x844 turned to 844x390) the touch stick and Attack button are pressed with pointer events during it and
   * the input layer must read them (`sudden-touch`).
   */
  async suddenDeath(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('sudden-death');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) forceTouchUi(true);
    const slams: { text: string; at: number }[] = [];
    const onSlam = (e: Event) => slams.push({ text: (e as CustomEvent).detail.text, at: performance.now() });
    let called = false;
    const onSudden = () => { called = true; };
    window.addEventListener('dod:slam', onSlam);
    window.addEventListener('dod:sudden-death', onSudden);
    try {
      const id = (list: { id: string }[], want: string) => Math.max(0, list.findIndex((x) => x.id === want));
      void this.game.startMatch({
        mode: 'versus', stage: id(STAGES, 'yo-house'), stocks: 2, rules: { timeLimit: 10 * 60, hazards: 0 },
        slots: [{ char: id(CHARACTERS, 'exit-punk'), cpu: null, team: 0, stocks: 2 }, { char: id(CHARACTERS, 'break'), cpu: null, team: 1, stocks: 2 }],
      });
      await this.matchLive();
      const m = this.game.match()!;
      this.manual = NO_INPUT;
      t.event('sudden-setup', 'two idle fighters, 2 stocks each, 0% each, 10 s clock: an exact tie at time-out');
      await t.until(() => m.state.sudden > 0 || m.state.over === 1, 60000, 'the time-out');
      if (m.state.over || m.state.timedOut) {
        t.problem('bug', `an exact tie at time-out ended the match (winner P${m.state.winner + 1}, timedOut ${m.state.timedOut}) instead of going to sudden death`);
        return t.finish('done');
      }
      const at = m.state.frame;
      t.event('sudden-start', `time-out at ${Math.round(at / 60)} s with stocks ${m.state.fighters.map((f) => f.stocks).join('/')} level: sudden death, no winner named`);
      await t.until(() => !!document.querySelector('.slam.sudden') || slams.some((s) => /sudden/i.test(s.text)), 4000, 'the sudden death slam');
      const slam = document.querySelector<HTMLElement>('.slam.sudden');
      if (!slam) t.problem('bug', 'no sudden death slam card was shown');
      else {
        await t.wait(300);
        const r = slam.getBoundingClientRect();
        const fits = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.width > 0;
        t.event('sudden-slam', `"${slam.textContent}" ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)} in ${innerWidth}x${innerHeight}`);
        if (!fits) t.problem('bug', `the sudden death slam doesn't fit the screen (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight})`);
        else t.event('sudden-slam-fit', `inside the ${innerWidth}x${innerHeight} window`);
      }
      await t.until(() => called, 2000, 'the sudden death call').catch(() => undefined);
      await t.until(() => !!document.querySelector('.booth[data-call="sudden-death"]'), 3000, 'the announcer caption').catch(() => undefined);
      const caption = document.querySelector('.booth[data-call="sudden-death"] .booth-text')?.textContent ?? '';
      if (!called || !document.querySelector('.booth[data-call="sudden-death"]')) t.problem('bug', 'the announcer did not call sudden death');
      else t.event('sudden-call', `Announcer: "${caption}"`);
      const pct = m.state.fighters.map((f) => Math.round(f.percent / 10));
      if (pct.every((p) => p === 300) || m.state.fighters.every((f) => f.percent >= 3000)) t.event('sudden-percent', `both fighters at ${pct.join('% and ')}%, one stock each`);
      else t.problem('bug', `sudden death should start both fighters at 300% (got ${pct.join('%, ')}%)`);
      if (m.state.fighters.some((f) => f.stocks !== 1)) t.problem('bug', 'sudden death fighters should have one stock each');
      if (touch) {
        // The touch controls stay live: a finger on the stick and on Attack must reach the input layer.
        const root = touchOverlay();
        const fire = (el: Element, type: string, x: number, y: number) =>
          el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 88, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
        const btn = root?.querySelector('.touch-btn.attack');
        const stick = root?.querySelector('.touch-stick');
        if (!root || !btn || !stick) t.problem('bug', 'the touch controls are gone during sudden death');
        else {
          const br = btn.getBoundingClientRect();
          fire(btn, 'pointerdown', br.left + br.width / 2, br.top + br.height / 2);
          await t.wait(100);
          const down = (readTouch()[2] & BTN.ATTACK) !== 0;
          fire(btn, 'pointerup', br.left + br.width / 2, br.top + br.height / 2);
          const sr = stick.getBoundingClientRect();
          const cx = sr.left + sr.width / 2;
          const cy = sr.top + sr.height / 2;
          fire(stick, 'pointerdown', cx, cy);
          fire(stick, 'pointermove', cx + sr.width * 0.35, cy);
          await t.wait(100);
          const dx = readTouch()[0];
          fire(stick, 'pointerup', cx, cy);
          const inside = [br, sr].every((r) => r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight);
          if (down && dx > 0 && inside) t.event('sudden-touch', `Attack button read ${down ? 'down' : 'up'}, stick read ${dx.toFixed(2)}, both inside ${innerWidth}x${innerHeight}`);
          else t.problem('bug', `touch controls didn't respond during sudden death (attack read ${down}, stick x ${dx}, on screen ${inside})`);
        }
      }
      this.manual = null;
      await this.fight(() => false, 60000);
      const secs = (m.state.frame - at) / 60;
      t.metric('suddenSeconds', Math.round(secs * 10) / 10);
      if (m.state.over && !m.state.timedOut && m.state.winner >= 0 && secs <= 30) t.event('sudden-end', `P${m.state.winner + 1} won by the first KO after ${secs.toFixed(1)} s`);
      else t.problem('bug', `sudden death didn't end in a KO within 30 s (over ${m.state.over}, timedOut ${m.state.timedOut}, ${secs.toFixed(1)} s)`);
      await this.results();
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      t.finish('done');
    } finally {
      this.manual = null;
      window.removeEventListener('dod:slam', onSlam);
      window.removeEventListener('dod:sudden-death', onSudden);
      if (touch) forceTouchUi(false);
    }
  }

  /**
   * Bots read stage hazards (`ai/hazardRead.ts`, `ai/bot.ts`). A versus match on a hazard stage (option `stage`, default
   * desert; hazards on, the first warning comes inside 45 s of play) with the playtest bot on the player's side and a level
   * 9 CPU opposite. For each warning (`hazard-warning`) every fighter standing in the warned hazard's way is followed: a
   * level 9 bot must visibly move out, by a hop, a walk or a drop, before the hazard arrives (`hazard-dodge`: frames after
   * the warning, the distance moved), and the pass ends with `hazard-avoided` or `hazard-hit` per fighter. On a phone
   * (390x844 turned to 844x390, touch controls forced on) the bot reads the same warning state the player sees: the alarm,
   * the stage art. Metrics `hazardWarnings`, `hazardThreatened`, `hazardDodged`, `hazardHits`; the first pass is
   * `hazard-first` ("the bot avoids the first hazard after its warning").
   */
  async hazardDodge(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('hazard-dodge');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) forceTouchUi(true);
    try {
      const id = (list: { id: string }[], want: string) => Math.max(0, list.findIndex((x) => x.id === want));
      const stageId = String(this.options.stage ?? 'desert');
      const stage = id(STAGES, stageId);
      const def = STAGES[stage];
      if (!def.hazards?.length) {
        t.problem('bug', `stage ${stageId} has no hazards to dodge`);
        return t.finish('error');
      }
      void this.game.startMatch({
        mode: 'versus', stage, stocks: 3, rules: { timeLimit: 10 * 60 },
        slots: [{ char: id(CHARACTERS, 'exit-punk'), cpu: null, team: 0, stocks: 3 }, { char: id(CHARACTERS, 'break'), cpu: 9, team: 1, stocks: 3 }],
      });
      await this.matchLive();
      const m = this.game.match()!;
      t.event('hazard-setup', `${def.name}: ${(def.hazards ?? []).map((h) => h.id).join(', ')} on events ${(def.events ?? []).filter((e) => def.hazards!.some((h) => h.during === e.id)).map((e) => e.id).join(', ')}; level 9 bots on both sides${touch ? '; touch controls on' : ''}`);
      const evOf = (def.events ?? []).map((e, i) => ({ e, i })).filter(({ e }) => def.hazards!.some((h) => h.during === e.id));
      const prev = evOf.map(() => EV_IDLE as number);
      interface Watch { fighter: number; event: number; at: number; x: number; y: number; moved: boolean; first: boolean }
      let watches: Watch[] = [];
      let warnings = 0;
      let threatened = 0;
      let dodged = 0;
      let hits = 0;
      let passes = 0;
      const botOf = (i: number) => (i === m.player ? this.bot : m.bots[i]);
      const sample = (): boolean => {
        const s = m.state;
        if (s.over) return true;
        evOf.forEach(({ e, i }, k) => {
          const now = s.evPhase[i];
          if (now === EV_WARN && prev[k] !== EV_WARN) {
            warnings++;
            t.event('hazard-warning', `${e.name ?? e.id} warns on ${def.name}, ${e.warn ?? 0} s before it arrives`);
            for (const f of s.fighters) {
              if (f.stocks <= 0 || f.action === ACT.DEAD || f.action === ACT.RESPAWN || f.action === ACT.HITSTUN) continue;
              const d = readDangers(def, s, f);
              const [hw, h] = bodyOf(f);
              if (!d.event || clearance(d, f.x / FX, f.y / FX, hw, h) >= 10) continue;
              threatened++;
              watches.push({ fighter: f.id, event: i, at: s.frame, x: f.x / FX, y: f.y / FX, moved: false, first: passes === 0 });
            }
          }
          if (prev[k] === EV_RUN && now === EV_IDLE) {
            const ride = (def.hazards ?? []).map((hz, j) => ({ hz, j })).filter(({ hz }) => hz.during === e.id);
            for (const w of watches.filter((x) => x.event === i)) {
              const hit = ride.some(({ j }) => (s.hazHit[j] & (1 << w.fighter)) !== 0);
              const who = w.fighter === m.player ? 'playtest bot' : 'CPU';
              if (hit) hits++;
              t.event(hit ? 'hazard-hit' : 'hazard-avoided', `${who} (P${w.fighter + 1}) ${hit ? 'was hit by' : 'got clear of'} the ${e.name ?? e.id}`);
              if (w.first) t.event('hazard-first', `first hazard after its warning: ${who} ${hit ? 'was hit' : 'avoided it'}${w.moved ? ', after moving' : ''}`);
              if (!w.moved) t.problem('bug', `a level 9 bot stood still in the way of the ${e.name ?? e.id} after its warning`);
            }
            if (watches.some((x) => x.event === i)) passes++;
            watches = watches.filter((x) => x.event !== i);
          }
          prev[k] = now;
        });
        for (const w of watches) {
          if (w.moved) continue;
          const f = s.fighters[w.fighter];
          const moved = Math.hypot(f.x / FX - w.x, f.y / FX - w.y);
          if (botOf(w.fighter)?.avoiding || moved >= 120) {
            w.moved = true;
            dodged++;
            t.event('hazard-dodge', `${w.fighter === m.player ? 'playtest bot' : 'CPU'} (P${w.fighter + 1}) moves out of the way ${s.frame - w.at} frames after the warning (${Math.round(moved)} units from where it stood)`);
          }
        }
        return passes >= 2 && watches.length === 0;
      };
      this.manual = null;
      await this.fight(sample, 240000).catch(() => undefined);
      t.metric('hazardWarnings', warnings);
      t.metric('hazardThreatened', threatened);
      t.metric('hazardDodged', dodged);
      t.metric('hazardHits', hits);
      if (!warnings) t.problem('bug', `no hazard warning showed on ${def.name} during the match`);
      if (m.state.over || currentScreen() === 'results') {
        await this.results();
        await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      } else {
        await this.quitFromPause('main');
      }
      await this.screen('main');
      t.finish('done');
    } finally {
      this.manual = null;
      if (touch) forceTouchUi(false);
    }
  }

  /**
   * CPU levels (ai/bot.ts: level drives reaction, recovery, shielding and the ledge choice). A versus match, Exit Punk (the
   * playtest bot on the pad, touch controls on a phone) against a Break CPU at option `level` (default 1), 2 stocks, to the end.
   * Events `cpu-level`, `cpu-ledge` (the option the CPU chose on the ledge), `cpu-recovery` (each trip off the stage and
   * whether it got back), `cpu-result`; metrics `cpuRecoveries`, `cpuRecoveryMisses`, `cpuLedgeOptions`, `cpuWon`. A bug problem
   * when a level-1 CPU beats the playtest bot. On a phone (390x844 turned to 844x390) the same match plays by touch.
   */
  async cpuLevel(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('cpu-level');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) forceTouchUi(true);
    try {
      const level = Math.max(1, Math.min(9, Number(this.options.level) || 1));
      const id = (list: { id: string }[], want: string) => Math.max(0, list.findIndex((x) => x.id === want));
      const stage = id(STAGES, String(this.options.stage ?? 'city-top'));
      void this.game.startMatch({
        mode: 'versus', stage, stocks: 2, rules: { timeLimit: 5 * 60 },
        slots: [{ char: id(CHARACTERS, 'exit-punk'), cpu: null, team: 0, stocks: 2 }, { char: id(CHARACTERS, 'break'), cpu: level, team: 1, stocks: 2 }],
      });
      await this.matchLive();
      const m = this.game.match()!;
      t.event('cpu-level', `CPU level ${level} (P2) against the playtest bot${touch ? '; touch controls on' : ''}`);
      const cpu = m.bots[1];
      let trips = 0;
      let misses = 0;
      let last = '';
      let was = false;
      let hit = false;
      const options = new Set<string>();
      const sample = (): boolean => {
        const s = m.state;
        const f = s.fighters[1];
        if (f.action === ACT.HITSTUN) hit = true;
        if (cpu && cpu.recovering && !was) {
          trips++;
          hit = false;
        }
        if (cpu && was && !cpu.recovering && f.action !== ACT.DEAD && f.action !== ACT.RESPAWN) t.event('cpu-recovery', `the CPU got back to the stage (trip ${trips})`);
        if (cpu && was && f.action === ACT.DEAD && !hit) {
          misses++;
          t.event('cpu-recovery', `the CPU missed its recovery and fell (trip ${trips}, level ${level})`);
        }
        was = !!cpu?.recovering;
        if (cpu && cpu.lastLedge && cpu.lastLedge !== last) {
          last = cpu.lastLedge;
          options.add(last);
          t.event('cpu-ledge', `the CPU chose ${last} on the ledge`);
        }
        return !!s.over;
      };
      this.manual = null;
      await this.fight(sample, 300000).catch(() => undefined);
      const won = m.state.winner === m.player;
      t.metric('cpuRecoveries', trips);
      t.metric('cpuRecoveryMisses', misses);
      t.metric('cpuLedgeOptions', options.size);
      t.metric('cpuWon', won ? 0 : 1);
      t.event('cpu-result', `${won ? 'the playtest bot beat' : 'the CPU beat the playtest bot at'} level ${level}: ${trips} trips off the stage, ${misses} missed, ledge options ${[...options].join(', ') || 'none'}`);
      if (level === 1 && m.state.over && !won) t.problem('bug', 'a level-1 CPU beat the playtest bot');
      if (m.state.over || currentScreen() === 'results') {
        await this.results();
        await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      } else {
        await this.quitFromPause('main');
      }
      await this.screen('main');
      t.finish('done');
    } finally {
      this.manual = null;
      if (touch) forceTouchUi(false);
    }
  }

  /**
   * Auto quality (render/autoQuality.ts, in the renderer's own frame loop). A slow device is simulated (option `slowMs`, the ms a
   * frame costs at full quality, default 60; `slow: false` plays the real device): match 1 must settle to a lower level within
   * 5 s of play with the median fps at 45 or more afterwards (`auto-lowered`, `auto-settled`, `auto-fps`), show one quiet toast
   * clear of every touch control (`auto-toast`, `auto-toast-clear`); match 2, slower still, lowers again with no second toast
   * (`auto-no-repeat`); then Quality is pressed by hand in Settings and match 3 changes nothing (`auto-hand`). On a phone it is
   * played in the turned 844x390 frame and the fighter is driven by the touch stick and Attack button only.
   */
  async autoQuality(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('auto-quality');
    }
    this.logViewport(touch && this.isPhone());
    const slowMs = this.options.slow === false ? 0 : Number(this.options.slowMs) || 60;
    const keys = [GFX_KEY, HAND_KEY, AUTO_KEY, AUTO_TOAST_KEY];
    const saved = keys.map((k) => [k, localStorage.getItem(k)] as const);
    const initial = graphics();
    for (const k of keys) localStorage.removeItem(k);
    setGraphics(touch || this.options.quality === 'low' ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    // setGraphics saved dod.gfx as the device default; that is not a hand pick.
    const stats = () => this.game.autoStats?.();
    if (!stats()) {
      t.problem('bug', 'the game has no autoStats hook');
      return t.finish('done');
    }
    await this.toMainMenu();
    if (touch) forceTouchUi(true);
    const pointer = (el: Element, type: string, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 91, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    const changes: { at: number; detail: { dir: string; from: number; to: number; level: number; atMs: number; scale: number } }[] = [];
    const onChange = (e: Event) => changes.push({ at: performance.now(), detail: (e as CustomEvent).detail });
    window.addEventListener('dod:auto-quality', onChange);
    const id = (list: { id: string }[], want: string) => Math.max(0, list.findIndex((x) => x.id === want));
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
    /** Plays one match for `ms` of play; by the touch stick and Attack on a phone, else by the bot. Returns the fps samples with their time. */
    const play = async (ms: number) => {
      this.manual = touch ? NO_INPUT : null;
      void this.game.startMatch({
        mode: 'versus', stage: id(STAGES, 'yo-house'), stocks: 3, rules: { timeLimit: 10 * 60, hazards: 0 },
        slots: [{ char: id(CHARACTERS, 'exit-punk'), cpu: null, team: 0, stocks: 3 }, { char: id(CHARACTERS, 'break'), cpu: 3, team: 1, stocks: 3 }],
      });
      await this.matchLive();
      const m = this.game.match()!;
      const t0 = performance.now();
      const f0 = m.state.frame;
      const samples: { at: number; fps: number }[] = [];
      let beat = 0;
      const root = touchOverlay();
      const stick = root?.querySelector('.touch-stick') ?? null;
      const atk = root?.querySelector('.touch-btn.attack') ?? null;
      const sr = stick?.getBoundingClientRect();
      const scx = sr ? sr.left + sr.width / 2 : 0;
      const scy = sr ? sr.top + sr.height / 2 : 0;
      if (touch && stick && sr) pointer(stick, 'pointerdown', scx, scy);
      try {
        await t.until(() => {
          const g = this.game.gfxStats?.();
          if (g && g.fpsNow > 0) samples.push({ at: performance.now() - t0, fps: g.fpsNow });
          if (touch && stick && sr && atk) {
            beat++;
            // The stick swings left and right every 1.2 s and Attack is tapped every 0.5 s: real pointer events, no pad.
            const dir = Math.floor(beat / 24) % 2 ? -1 : 1;
            pointer(stick, 'pointermove', scx + dir * sr.width * 0.38, scy);
            if (beat % 10 === 0) {
              const br = atk.getBoundingClientRect();
              pointer(atk, 'pointerdown', br.left + br.width / 2, br.top + br.height / 2);
              window.setTimeout(() => pointer(atk, 'pointerup', br.left + br.width / 2, br.top + br.height / 2), 120);
            }
          }
          return m.state.over === 1 || performance.now() - t0 >= ms;
        }, ms + 20000, 'the measured play');
      } finally {
        if (touch && stick && sr) pointer(stick, 'pointerup', scx, scy);
      }
      return { samples, play: ((m.state.frame - f0) / 60) * 1000 };
    };
    const leave = async () => {
      this.manual = null;
      if (currentScreen() === 'match') await this.quitFromPause('main').catch(() => undefined);
    };
    try {
      // 1. The slow device settles lower, quickly, and says so once.
      this.game.autoSetup?.({ enabled: true, reset: true, slowMs });
      t.event('auto-setup', slowMs ? `a simulated slow device: ${slowMs} ms a frame at full quality` : 'the real device, no simulation');
      const g0 = this.game.gfxStats?.();
      t.event('auto-start', `level 0, render scale ${g0?.scale}, glow ${g0?.glowOn}, quality ${g0?.quality}`);
      const a = await play(16000);
      const s1 = stats()!;
      const downs = changes.filter((c) => c.detail.dir === 'down');
      const g1 = this.game.gfxStats?.();
      t.metric('autoLevel', s1.level);
      if (!downs.length) {
        if (slowMs) t.problem('bug', `the slow device (${slowMs} ms a frame) never stepped quality down (median ${s1.fps} fps)`);
        else t.event('auto-lowered', `no step needed: the device holds ${s1.fps} fps at level 0`);
      } else {
        const last = downs[downs.length - 1].detail;
        t.metric('autoSettleMs', Math.round(s1.settledAtMs > 0 ? s1.settledAtMs : last.atMs));
        t.event('auto-lowered', `${downs.length} step(s) down to level ${s1.level} (${downs.map((d) => `${d.detail.from}→${d.detail.to} at ${(d.detail.atMs / 1000).toFixed(1)} s`).join(', ')}); render scale ${g0?.scale} → ${g1?.scale}, glow ${g0?.glowOn} → ${g1?.glowOn}`);
        if (last.atMs > 5000) t.problem('bug', `quality was still stepping down ${(last.atMs / 1000).toFixed(1)} s into the match (want settled within 5 s)`);
        else t.event('auto-settled', `last step at ${(last.atMs / 1000).toFixed(1)} s of play${s1.settled ? `, settled at ${(s1.settledAtMs / 1000).toFixed(1)} s` : ''}`);
        const lastAt = a.samples.length ? a.samples[a.samples.length - 1].at : 0;
        const before = median(a.samples.filter((x) => x.at < 1500).map((x) => x.fps));
        const after = median(a.samples.filter((x) => x.at > Math.min(last.atMs + 1500, lastAt - 1500)).map((x) => x.fps));
        t.metric('autoFpsBefore', Math.round(before));
        t.metric('autoFpsAfter', Math.round(after));
        t.metric('fpsMatch', Math.round(after));
        t.event('auto-fps', `median ${Math.round(before)} fps at the start, ${Math.round(after)} fps after it settled`);
        if (slowMs && after < 45) t.problem('bug', `median ${Math.round(after)} fps after auto quality settled (want 45 or more)`);
      }
      // The toast: one, short, quiet, and clear of every control.
      if (downs.length) {
        const toast = document.getElementById('auto-quality-toast');
        const rect = s1.toastRect;
        if (s1.toasts !== 1 || !rect) t.problem('bug', `expected one auto quality toast, saw ${s1.toasts}${rect ? '' : ' (none on screen)'}`);
        else {
          const text = toast?.textContent ?? '';
          t.event('auto-toast', `"${text}" (${text.split(/\s+/).length} words) at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)} in ${innerWidth}x${innerHeight}`);
          const inside = rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= innerWidth && rect.y + rect.h <= innerHeight;
          const hits = [...document.querySelectorAll('.touch-btn, .touch-stick, .touch-pause, #pause-btn')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0 && r.left < rect.x + rect.w && r.right > rect.x && r.top < rect.y + rect.h && r.bottom > rect.y);
          if (!inside || hits.length) t.problem('bug', `the auto quality toast ${inside ? `covers ${hits.length} control(s)` : 'is off screen'}`);
          else t.event('auto-toast-clear', `inside the window and clear of every control${touch ? ' (touch stick, buttons, Pause)' : ''}`);
        }
      }
      await leave();
      await this.toMainMenu();

      // 2. A slower second match lowers again and never shows the note twice.
      this.game.autoSetup?.({ slowMs: slowMs * 2 });
      const before2 = changes.length;
      await play(9000);
      const s2 = stats()!;
      const moved = changes.length - before2;
      t.event('auto-second-match', `${moved} change(s) in the second match, level ${s1.level} → ${s2.level}`);
      if (s2.toasts !== 1 || document.querySelectorAll('#auto-quality-toast').length > 1) t.problem('bug', `the auto quality toast came again (${s2.toasts} shown)`);
      else t.event('auto-no-repeat', `still ${s2.toasts} toast after ${changes.filter((c) => c.detail.dir === 'down').length} step(s) down`);
      await leave();
      await this.toMainMenu();

      // 3. A quality picked by hand is never overridden.
      this.game.autoSetup?.({ reset: true, slowMs });
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings');
      const was = this.game.gfxStats?.();
      await this.tap(() => this.q('#quality-switch'), 'Quality');
      await this.tap(() => this.q('#quality-switch'), 'Quality (back)');
      await this.tap(() => this.q('#settings-done'), 'Done').catch(() => undefined);
      if (settingsShowing()) await tapKey('Escape');
      const h = stats()!;
      if (!h.hand || h.enabled) t.problem('bug', `a hand-picked quality did not switch auto quality off (hand ${h.hand}, enabled ${h.enabled})`);
      const before3 = changes.length;
      await play(9000);
      const s3 = stats()!;
      const g3 = this.game.gfxStats?.();
      if (changes.length !== before3 || s3.level !== 0 || (was && g3 && (g3.scale !== was.scale || g3.glowOn !== was.glowOn))) t.problem('bug', `auto quality changed a hand-picked quality (level ${s3.level}, scale ${was?.scale} → ${g3?.scale})`);
      else t.event('auto-hand', `Quality set by hand in Settings: ${changes.length - before3} changes in a ${slowMs} ms-a-frame match, level ${s3.level}, render scale held at ${g3?.scale}`);
      await leave();
      t.finish('done');
    } finally {
      window.removeEventListener('dod:auto-quality', onChange);
      this.manual = null;
      this.game.autoSetup?.({ enabled: false, slowMs: 0, reset: true });
      for (const [k, v] of saved) {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
      setGraphics(initial);
      if (touch) forceTouchUi(false);
    }
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
  /**
   * Feet on the floor: every fighter idles and walks on the main platform (events feet-gap / dod:feet-gap),
   * then The Mechanic stands on a City Top scaffold deck. Phone 390x844 turns to 844x390 and plays by touch.
   */
  /**
   * Season 1 idle / walk / jab / fsmash at 30 fps with fringe-clean half sheets on Low,
   * hitboxes shown on jab and side smash, phone Low fps ≥45.
   */
  async smoothClips(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('smooth-clips');
    }
    if (touch) {
      this.logViewport(this.isPhone());
      this.useTap = true;
      forceTouchUi(true);
    }
    const gfxWas = localStorage.getItem(GFX_KEY);
    // option cast: "rest" plays the 20 fighters outside Season 1 (their idle and run are the 30 fps clips;
    // the jab still plays with hitboxes shown). Default: the Season 1 cast with all four clips.
    const rest = this.options.cast === 'rest';
    const want = (rest ? ['idle', 'walk'] : ['idle', 'walk', 'jab', 'fsmash']) as readonly ('idle' | 'walk' | 'jab' | 'fsmash')[];
    let fps30 = 0;
    let halfSheets = 0;
    const fpsSamples: number[] = [];
    try {
      await this.toMainMenu();
      setGraphics({ quality: 'low', glow: false });
      const train = stagesFor('training')[0]?.index ?? 0;
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : rest ? CHARACTERS.map((c) => c.id).filter((id) => !SEASON_ONE.includes(id)) : [...SEASON_ONE];
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the stick controls were not built');
        t.finish('error');
        return;
      }
      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
      };
      const me = () => {
        const m = this.game.match()!;
        return m.state.fighters[m.player];
      };

      for (const [n, id] of ids.entries()) {
        const i = CHARACTERS.findIndex((c) => c.id === id);
        if (i < 0) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        this.progressNow = () => n / ids.length;
        t.progress(n / ids.length);
        t.event('fighter', CHARACTERS[i].name);
        void this.game.startMatch({
          mode: 'training', stage: train, stocks: 1, rules: {},
          slots: [{ char: i, cpu: null }, { char: (i + 1) % CHARACTERS.length, cpu: 0 }],
        });
        await this.matchLive();
        await this.checkFighter(id);
        const set = await loadAnimSet(id);
        if (!set) {
          t.problem('bug', `${CHARACTERS[i].name}: no animation clips`);
          await this.game.quitMatch();
          await this.screen('main');
          continue;
        }
        for (const key of want) {
          const clip = set.clips[key];
          if (!clip) {
            t.problem('bug', `${CHARACTERS[i].name}: missing ${key} clip`);
            continue;
          }
          const label = key === 'walk' ? 'run/walk' : key;
          if (clip.fps === 30) {
            fps30++;
            t.event('clip-fps', `${CHARACTERS[i].name} ${label} ${clip.fps} fps (${clip.frames} frames)`);
          } else {
            t.problem('bug', `${CHARACTERS[i].name} ${label} plays at ${clip.fps} fps (want 30)`);
          }
          if (clip.halfFile) {
            halfSheets++;
            const ok = await exists(`${set.base}${clip.halfFile}`);
            if (!ok) t.problem('bug', `${CHARACTERS[i].name} ${label}: half sheet 404 ${clip.halfFile}`);
            else t.event('half-sheet', `${CHARACTERS[i].name} ${label} → ${clip.halfFile}`);
          } else t.problem('polish', `${CHARACTERS[i].name} ${label}: no halfFile for Low quality`);
        }

        // Hitbox view and the two most-seen attacks on screen for the footage.
        if (!touch) pressAction('KeyH', true);
        this.manual = NO_INPUT;
        pad.release();
        await t.until(() => me().grounded > 0 && (me().action === ACT.IDLE || me().action === ACT.WALK), 8000, `${CHARACTERS[i].name} standing`).catch(() => undefined);
        await frames(20);
        t.event('clip-zoom', `${CHARACTERS[i].name} idle (fringe check at 2x)`);
        // Jab.
        this.manual = packInput(0, 0, BTN.ATTACK);
        await frames(4);
        this.manual = NO_INPUT;
        await frames(24);
        t.event('hitbox-jab', `${CHARACTERS[i].name} jab with hitboxes`);
        await frames(12);
        // Side smash via the C-stick (same path as roster / keyboard I).
        this.manual = packInput(0, 0, me().facing > 0 ? BTN.C_RIGHT : BTN.C_LEFT);
        await frames(8);
        this.manual = NO_INPUT;
        await frames(40);
        t.event('hitbox-fsmash', `${CHARACTERS[i].name} side smash with hitboxes`);

        if (touch || this.isPhone()) {
          const g = this.game.gfxStats?.();
          if (g && g.quality === 'low' && g.fpsNow > 0) fpsSamples.push(g.fpsNow);
        }
        await this.game.quitMatch();
        await this.screen('main');
        t.add('fightersTested');
      }

      t.metric('clipFps30', fps30);
      t.metric('halfSheets', halfSheets);
      if (fpsSamples.length) {
        const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
        t.metric('fpsMatchLow', Math.round(avg));
        if (avg < 45) t.problem('warning', `phone-size Low ran at ${Math.round(avg)} fps (want 45)`);
        else t.event('phone-fps', `Low quality averaged ${Math.round(avg)} fps`);
      }
    } finally {
      this.manual = null;
      if (gfxWas == null) localStorage.removeItem(GFX_KEY);
      else localStorage.setItem(GFX_KEY, gfxWas);
      setGraphics(graphics());
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  async feetRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('feet');
    }
    if (touch) {
      this.logViewport(this.isPhone());
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      await this.toMainMenu();
      const train = stagesFor('training')[0]?.index ?? 0;
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : CHARACTERS.map((c) => c.id);
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the stick controls were not built');
        t.finish('error');
        return;
      }
      if (touch) t.event('phone-shot', `feet check at ${innerWidth}x${innerHeight}`);

      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
      };
      const me = () => {
        const m = this.game.match()!;
        return m.state.fighters[m.player];
      };

      for (const [n, id] of ids.entries()) {
        const i = CHARACTERS.findIndex((c) => c.id === id);
        if (i < 0) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        this.progressNow = () => (n / (ids.length + 1)) * 0.85;
        t.progress(this.progressNow());
        t.event('fighter', CHARACTERS[i].name);
        void this.game.startMatch({
          mode: 'training', stage: train, stocks: 1, rules: {},
          slots: [{ char: i, cpu: null }, { char: (i + 1) % CHARACTERS.length, cpu: 0 }],
        });
        await this.matchLive();
        await this.checkFighter(id);
        // Idle on the main platform so sampleFeet records the sole gap. Bot off: only the pad moves them.
        this.manual = NO_INPUT;
        pad.release();
        await t.until(() => me().grounded > 0 && me().action === ACT.IDLE, 8000, `${CHARACTERS[i].name} idle on the platform`).catch(() => {
          t.problem('bug', `${CHARACTERS[i].name}: never idled on the platform`);
        });
        await frames(45);
        // Walk so stride-based playback is on screen (planted foot vs floor).
        pad.stick(100, 0);
        await frames(90);
        pad.release();
        await frames(12);
        // Jump and land so soles meet the platform after landing (phone criterion).
        this.manual = packInput(0, 0, BTN.JUMP);
        await frames(6);
        this.manual = NO_INPUT;
        await t.until(() => me().action === ACT.LAND || (me().grounded > 0 && me().action === ACT.IDLE), 8000, `${CHARACTERS[i].name} to land`).catch(() => {
          t.problem('bug', `${CHARACTERS[i].name}: never landed after the jump`);
        });
        await frames(20);
        if (me().grounded > 0) t.event('feet-land', `${CHARACTERS[i].name} grounded after landing`);
        this.reportFeet();
        await this.game.quitMatch();
        await this.screen('main');
        t.add('fightersTested');
      }

      // City Top: The Mechanic on a scaffold deck (finding f_7e0b4fd55a29).
      const mech = CHARACTERS.findIndex((c) => c.id === 'the-mechanic');
      const city = STAGES.findIndex((s) => s.id === 'city-top');
      if (mech < 0 || city < 0) {
        t.problem('bug', 'City Top or The Mechanic is missing');
      } else {
        this.progressNow = () => 0.9;
        t.progress(0.9);
        t.event('stage', 'City Top');
        void this.game.startMatch({
          mode: 'versus', stage: city, stocks: 1, rules: { timeLimit: 60 },
          slots: [{ char: mech, cpu: null }, { char: CHARACTERS.findIndex((c) => c.id === 'exit-punk'), cpu: 1 }],
        });
        await this.matchLive();
        await this.checkFighter('the-mechanic');
        // Soft scaffolds sit at y=140; run and jump onto the right-of-centre deck from the main roof.
        const onDeck = () => {
          const f = me();
          if (f.grounded <= 0) return false;
          const x = f.x / FX;
          const y = f.y / FX;
          return y > 100 && y < 160 && ((x > 145 && x < 435) || (x > 440 && x < 730) || (x < -145 && x > -435) || (x < -440 && x > -730));
        };
        pad.release();
        await frames(20);
        for (let attempt = 0; attempt < 5 && !onDeck(); attempt++) {
          this.manual = packInput(100, 0, 0);
          await frames(18);
          this.manual = packInput(100, 0, BTN.JUMP);
          await frames(6);
          this.manual = packInput(80, 0, 0);
          await frames(45);
          this.manual = NO_INPUT;
          await frames(15);
        }
        await t.until(onDeck, 8000, 'The Mechanic on a City Top scaffold').catch(() => {
          t.problem('bug', 'The Mechanic never stood on a City Top scaffold deck');
        });
        this.manual = NO_INPUT;
        await frames(60);
        if (onDeck()) t.event('city-top-deck', 'The Mechanic idle on a City Top scaffold deck');
        this.reportFeet();
        await this.game.quitMatch();
        await this.screen('main');
      }
    } finally {
      this.manual = null;
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

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

  // ---------------------------------------------------------- How to play 2: grab, throw, roll, spot-dodge

  /**
   * How to play 2 (`ui/teach.ts` lesson 'defence', `ai/dummy.ts`): the main menu's second lesson in Training. Five prompts in
   * turn (grab, throw, roll left, roll right, spot-dodge), each ticked off by the sim seeing the move. Played from real
   * input only (keys, or the touch stick, Shield and Attack buttons on a phone turned to 844x390).
   */
  async lessonTwo(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('lesson-2');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const seen: { step: DefenceStep; state: string; at: number; glyphs: string; device: string }[] = [];
    const onTeach = (ev: Event) => {
      const d = (ev as CustomEvent<{ step: DefenceStep; state: string }>).detail;
      const el = document.querySelector<HTMLElement>('.teach-prompt');
      seen.push({ step: d.step, state: d.state, at: performance.now(), glyphs: el?.dataset.glyphs ?? '', device: el?.dataset.device ?? '' });
    };
    window.addEventListener('dod:teach', onTeach);
    let stacked = 0;
    const poll = window.setInterval(() => {
      if (document.querySelectorAll('.teach-prompt:not(.used):not(.gone)').length > 1) stacked++;
    }, 50);
    try {
      await this.click(() => this.q('#main .menu-item[data-go="howto2"]'), 'How to play 2');
      await this.matchLive();
      this.manual = NO_INPUT;
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls (stick, Attack and Shield) were not built');
        t.finish('error');
        return;
      }
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
      const settle = async () => {
        pad.release();
        await t.until(standing, 10000, 'the fighter to stand');
        await frames(6);
      };
      const toward = () => (dummy().x >= me().x ? 1 : -1);
      const gap = () => Math.abs(dummy().x - me().x) / FX;
      const shownNow = (step: DefenceStep) => document.querySelector(`.teach-prompt[data-step="${step}"]:not(.used):not(.gone)`) as HTMLElement | null;
      if (touch) t.event('phone-shot', `How to play 2 with the touch overlay: Shield and Attack buttons, the stick (${innerWidth}x${innerHeight})`);

      // The moves, each from real input.
      const reach = CHARACTERS[me().char].grabReach * 0.7;
      const doStep: Record<DefenceStep, () => Promise<void>> = {
        grab: async () => {
          await settle();
          if (gap() > reach || me().facing !== toward()) {
            pad.stick(toward() * 100, 0);
            try {
              await t.until(() => gap() < reach && me().facing === toward(), 8000, 'Exit Punk to walk up to the dummy');
            } finally {
              pad.stick(0, 0);
            }
            await frames(6);
          }
          pad.button('shield', true);
          pad.button('attack', true);
          await frames(3);
          pad.button('attack', false);
          pad.button('shield', false);
        },
        throw: async () => {
          await t.until(() => me().action === ACT.GRAB_HOLD, 3000, 'the grab to hold the dummy');
          await frames(10);
          pad.stick(toward() * 100, 0);
          await frames(3);
          pad.stick(0, 0);
        },
        rollL: async () => {
          await settle();
          pad.button('shield', true);
          await frames(6);
          pad.stick(-100, 0);
          await frames(4);
          pad.stick(0, 0);
          pad.button('shield', false);
        },
        rollR: async () => {
          await settle();
          pad.button('shield', true);
          await frames(6);
          pad.stick(100, 0);
          await frames(4);
          pad.stick(0, 0);
          pad.button('shield', false);
        },
        dodge: async () => {
          await settle();
          // The dummy walks up and swings on its own: log the gap between its swings.
          const swings: number[] = [];
          let last = -1;
          let wasSwinging = false;
          const watchSwing = window.setInterval(() => {
            const d = dummy();
            const swinging = d.action === ACT.ATTACK;
            if (swinging && !wasSwinging) {
              if (last >= 0) swings.push(frame() - last);
              last = frame();
            }
            wasSwinging = swinging;
          }, 16);
          try {
            await t.until(() => dummy().action === ACT.ATTACK || last >= 0, 20000, 'the dummy to swing');
            t.event('lesson-dummy-swing', `the dummy swung at the player (${Math.round(gap())} units away); it swings every ${150} frames at most`);
            // Shield up, then a tap down, on the rhythm of its next swing.
            await t.until(() => standing(), 5000, 'the fighter to stand');
            pad.button('shield', true);
            await frames(4);
            pad.stick(0, -100);
            await frames(4);
            pad.stick(0, 0);
            pad.button('shield', false);
          } finally {
            clearInterval(watchSwing);
          }
          if (swings.length && Math.min(...swings) < 120) t.problem('bug', `the lesson's dummy swung again after ${Math.min(...swings)} frames (slow means 2 s or more)`);
        },
      };

      let tickMax = 0;
      let done = 0;
      for (const step of DEFENCE_STEPS) {
        // The prompt for this step shows, alone, with this device's glyphs.
        await t.until(() => !!shownNow(step), 20000, `the ${step} prompt`);
        const el = shownNow(step)!;
        const dev = el.dataset.device ?? '';
        const word = PROMPTS[step].word;
        t.event('lesson-prompt', `${step}: "${word}" (${dev}: ${el.dataset.glyphs ?? ''}) after ${done} ticked`);
        if (dev !== (touch ? 'touch' : 'keyboard')) t.problem('bug', `the ${step} prompt shows ${dev} glyphs on ${how}`);
        if (el.textContent?.trim() === '') t.problem('bug', `the ${step} prompt is empty`);
        if (touch) {
          // Clear of the touch controls, and the buttons it names pulse.
          const r = el.getBoundingClientRect();
          for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn, .touch .touch-stick, .touch .touch-pause')) {
            const q = b.getBoundingClientRect();
            if (q.width && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) t.problem('bug', `the ${step} prompt sits under the ${b.className} control`);
          }
        }
        await doStep[step]();
        // The tick lands within a second of the move.
        const moved = performance.now();
        try {
          await t.until(() => seen.some((e) => e.step === step && e.state === 'used'), 3000, `the ${step} tick`);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', `${how}: the ${step} step was not ticked off within 3 s of the move (${ACT_NAMES[me().action]})`);
          continue;
        }
        const tick = seen.find((e) => e.step === step && e.state === 'used')!;
        const ms = Math.max(0, Math.round(tick.at - moved));
        tickMax = Math.max(tickMax, ms);
        done++;
        t.event('lesson-tick', `${step} ticked off ${ms} ms after the move was done (${how})`);
        if (ms > 1000) t.problem('bug', `${how}: the ${step} step ticked off ${ms} ms after the move (over 1 s)`);
        t.progress(0.1 + 0.15 * done);
        await t.wait(700);
      }
      t.metric('lessonSteps', done);
      t.metric('lessonTickMaxMs', tickMax);
      if (done === DEFENCE_STEPS.length) {
        try {
          await t.until(() => !!document.getElementById('teach-reward'), 2000, 'the lesson-clear card');
          t.event('lesson-clear', `"${document.getElementById('teach-reward')?.textContent ?? ''}" after all ${done} steps (${how})`);
          await this.lessonCardCheck('back', how);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', 'the lesson showed no clear card after the last step');
        }
      }
      if (stacked) t.problem('bug', `${stacked} samples had more than one teaching prompt on screen`);
      if (touch) {
        let small = 0;
        for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn, .touch .touch-pause')) {
          const q = b.getBoundingClientRect();
          if (q.width < 44 || q.height < 44) small++;
        }
        t.event('lesson-touch', small === 0 ? 'every touch control is 44 px or larger and the lesson was finished with touch only' : `${small} touch controls under 44 px`);
        if (small) t.problem('bug', `${small} touch controls are under 44 px`);
      }
    } finally {
      clearInterval(poll);
      window.removeEventListener('dod:teach', onTeach);
      this.manual = null;
      this.useTap = false;
      forceTouchUi(false);
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * The Lesson complete card (main.ts `lessonCard`): shown after the clear pop with a primary button (Next lesson, or Fight a
   * CPU after the last) and Back to menu, both 44 px tall or more on touch. `next` taps the primary button, `back` taps Back to
   * menu and then checks the How to play menu ticks the lessons done (localStorage `dod-lessons`) and the Campaign line counts
   * the real seasons and episodes.
   */
  private async lessonCardCheck(action: 'next' | 'back', how: string): Promise<void> {
    const t = this.t;
    await t.until(() => !!document.getElementById('lesson-card'), 4000, 'the Lesson complete card');
    const primary = () => document.querySelector<HTMLElement>('#lesson-card .lesson-primary');
    const backBtn = () => document.querySelector<HTMLElement>('#lesson-card .lesson-back');
    const pr = primary()!.getBoundingClientRect();
    const br = backBtn()!.getBoundingClientRect();
    t.event('lesson-card', `"${document.querySelector('#lesson-card h2')?.textContent}" with "${primary()!.querySelector('strong')?.textContent}" (${Math.round(pr.height)} px) and "${backBtn()!.querySelector('strong')?.textContent}" (${Math.round(br.height)} px) (${how})`);
    if (pr.height < 44 || br.height < 44 || pr.width < 44 || br.width < 44) t.problem('bug', `the Lesson complete buttons are under 44 px (${Math.round(pr.height)} and ${Math.round(br.height)})`);
    if (pr.left < 0 || pr.right > innerWidth || br.bottom > innerHeight) t.problem('bug', 'the Lesson complete card runs off the screen');
    if (action === 'next') {
      await this.tap(primary, 'Next lesson');
      await t.until(() => !document.getElementById('lesson-card'), 4000, 'the card to close');
      t.event('lesson-next', 'Next lesson started the following lesson');
      return;
    }
    await this.tap(backBtn, 'Back to menu');
    await this.screen('main');
    await t.until(() => document.querySelectorAll('.menu-item.lesson-done').length > 0, 4000, 'the ticks on the How to play menu');
    const ticks = [...document.querySelectorAll<HTMLElement>('.menu-item.lesson-done')].map((b) => b.dataset.go);
    const stored = localStorage.getItem('dod-lessons');
    t.event('lesson-ticks', `ticked on the menu: ${ticks.join(', ')}; saved as ${stored}`);
    const blurb = document.getElementById('campaign-blurb')?.textContent ?? '';
    t.event('campaign-blurb', blurb);
    if (/eight/i.test(blurb) || !/\d+ seasons?, \d+ episodes?/.test(blurb)) t.problem('bug', `the Campaign menu line is stale: "${blurb}"`);
  }

  // ---------------------------------------------------------- How to play 3: specials, fast fall, the way back

  /**
   * How to play 3 (`ui/teach.ts` lesson 'recovery', `match.ts` `knockLoop`): the main menu's third lesson in Training. Neutral,
   * side and down special, then a jump with fast fall, each ticked off by the sim; then the dummy knocks the player off the
   * edge and the prompts go double jump, up special, ledge, the ledge grab clearing the lesson. Real input only (keys, or the
   * touch stick, Jump and Special buttons on a phone turned to 844x390).
   */
  async lessonThree(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('lesson-3');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const seen: { step: RecoveryStep; state: string; at: number }[] = [];
    const onTeach = (ev: Event) => {
      const d = (ev as CustomEvent<{ step: RecoveryStep; state: string }>).detail;
      seen.push({ step: d.step, state: d.state, at: performance.now() });
    };
    window.addEventListener('dod:teach', onTeach);
    let stacked = 0;
    const poll = window.setInterval(() => {
      if (document.querySelectorAll('.teach-prompt:not(.used):not(.gone)').length > 1) stacked++;
    }, 50);
    try {
      await this.click(() => this.q('#main .menu-item[data-go="howto3"]'), 'How to play 3');
      await this.matchLive();
      this.manual = NO_INPUT;
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls (stick, Jump and Special) were not built');
        t.finish('error');
        return;
      }
      const match = () => this.game.match()!;
      const me = () => match().state.fighters[match().player];
      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
      };
      const standing = () => {
        const f = me();
        return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      };
      const settle = async () => {
        pad.release();
        await t.until(standing, 10000, 'the fighter to stand');
        await frames(6);
      };
      const shownNow = (step: RecoveryStep) => document.querySelector(`.teach-prompt[data-step="${step}"]:not(.used):not(.gone)`) as HTMLElement | null;
      const ticked = (step: RecoveryStep, since = 0) => seen.some((e) => e.step === step && e.state === 'used' && e.at >= since);
      if (touch) t.event('phone-shot', `How to play 3 with the touch overlay: stick, Jump and Special buttons (${innerWidth}x${innerHeight})`);

      /** One prompt: shown alone with this device's glyphs, clear of the touch controls. */
      const checkPrompt = (step: RecoveryStep, done: number) => {
        const el = shownNow(step)!;
        const dev = el.dataset.device ?? '';
        t.event('lesson-prompt', `${step}: "${PROMPTS[step].word}" (${dev}: ${el.dataset.glyphs ?? ''}) after ${done} ticked`);
        if (dev !== (touch ? 'touch' : 'keyboard')) t.problem('bug', `the ${step} prompt shows ${dev} glyphs on ${how}`);
        if (el.textContent?.trim() === '') t.problem('bug', `the ${step} prompt is empty`);
        if (touch) {
          const r = el.getBoundingClientRect();
          for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn, .touch .touch-stick, .touch .touch-pause')) {
            const q = b.getBoundingClientRect();
            if (q.width && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) t.problem('bug', `the ${step} prompt sits under the ${b.className} control`);
          }
        }
      };
      let tickMax = 0;
      let done = 0;
      const tickOf = async (step: RecoveryStep, since: number): Promise<boolean> => {
        try {
          await t.until(() => ticked(step, since), 3000, `the ${step} tick`);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', `${how}: the ${step} step was not ticked off within 3 s of the move (${ACT_NAMES[me().action]})`);
          return false;
        }
        const tick = seen.find((e) => e.step === step && e.state === 'used' && e.at >= since)!;
        const ms = Math.max(0, Math.round(tick.at - since));
        tickMax = Math.max(tickMax, ms);
        done++;
        t.event('lesson-tick', `${step} ticked off ${ms} ms after the move was done (${how})`);
        if (ms > 1000) t.problem('bug', `${how}: the ${step} step ticked off ${ms} ms after the move (over 1 s)`);
        t.progress(0.1 + 0.1 * done);
        return true;
      };

      // 1-4: the specials and the fast fall, each from real input.
      const special = async (sx: number, sy: number) => {
        await settle();
        pad.stick(sx, sy);
        await frames(2);
        pad.special(true);
        await frames(3);
        pad.special(false);
        pad.stick(0, 0);
      };
      const basics: Partial<Record<RecoveryStep, () => Promise<void>>> = {
        spN: () => special(0, 0),
        spS: () => special(100, 0),
        spD: () => special(0, -100),
        fastfall: async () => {
          await settle();
          pad.button('jump', true);
          await frames(3);
          pad.button('jump', false);
          // Up, then at the top of the jump the stick goes down: the fall is fast.
          await t.until(() => !me().grounded && me().vy <= 0, 4000, 'the top of the jump');
          pad.stick(0, -100);
          await t.until(() => me().fastFall === 1 || me().grounded > 0, 3000, 'the fast fall');
          await frames(3);
          pad.stick(0, 0);
        },
      };
      for (const step of ['spN', 'spS', 'spD', 'fastfall'] as RecoveryStep[]) {
        await t.until(() => !!shownNow(step), 20000, `the ${step} prompt`);
        checkPrompt(step, done);
        const moved = performance.now();
        await basics[step]!();
        if (!(await tickOf(step, moved))) continue;
        await t.wait(500);
      }

      // 5-7: the knock-off and the way back; a missed recovery restages the knock-off, so up to three tries.
      let cleared = false;
      for (let attempt = 1; attempt <= 3 && !cleared; attempt++) {
        await t.until(() => match().knockLoop === 'live', 20000, 'the dummy to be staged at the edge');
        t.event('lesson-knockoff', `attempt ${attempt}: the player is at the edge (${Math.round(me().x / FX)}), the dummy swings next`);
        await t.until(() => me().action === ACT.HITSTUN, 8000, 'the dummy to knock the player off');
        const hitAt = performance.now();
        await t.until(() => !!shownNow('dJump') || ticked('ledge', hitAt) || me().action === ACT.DEAD, 8000, 'the double jump prompt');
        if (!shownNow('dJump')) continue;
        checkPrompt('dJump', done);
        t.event('lesson-offstage', `knocked to x ${Math.round(me().x / FX)}, y ${Math.round(me().y / FX)}; prompts now go double jump, up special, ledge`);
        await t.until(() => me().action !== ACT.HITSTUN, 3000, 'the hit-stun to end');
        // Double jump back toward the stage (the left).
        let moved = performance.now();
        pad.stick(-100, 0);
        pad.button('jump', true);
        await frames(3);
        pad.button('jump', false);
        const jumped = await tickOf('dJump', moved);
        if (!jumped) continue;
        await t.until(() => !!shownNow('upB') || ticked('ledge', hitAt), 4000, 'the up special prompt');
        if (shownNow('upB')) checkPrompt('upB', done);
        await t.until(() => me().action === ACT.AIR && me().vy <= 4000, 4000, 'the jump to slow');
        moved = performance.now();
        pad.stick(-100, 100);
        pad.special(true);
        await frames(3);
        pad.special(false);
        pad.stick(-100, 40);
        if (!(await tickOf('upB', moved))) continue;
        await t.until(() => !!shownNow('ledge') || ticked('ledge', hitAt), 4000, 'the ledge prompt');
        if (shownNow('ledge')) checkPrompt('ledge', done);
        moved = performance.now();
        pad.stick(-100, 0);
        // Holding toward the stage, the player reaches the ledge (the sim's ledge event) or lands back and the knock-off restages.
        try {
          await t.until(() => ticked('ledge', hitAt) || me().action === ACT.DEAD || standing(), 6000, 'the ledge grab');
        } finally {
          pad.stick(0, 0);
        }
        if (ticked('ledge', hitAt)) {
          cleared = await tickOf('ledge', hitAt);
          t.event('lesson-ledge', `the player grabbed the ledge on attempt ${attempt}`);
        } else {
          t.event('lesson-retry', `attempt ${attempt}: the player did not reach the ledge (${ACT_NAMES[me().action]}); the knock-off is staged again`);
        }
      }
      if (!cleared) t.problem('bug', 'the recovery step was not completed: no ledge grab in three tries');
      t.metric('lessonSteps', done);
      t.metric('lessonTickMaxMs', tickMax);
      if (cleared) {
        try {
          await t.until(() => !!document.getElementById('teach-reward'), 2000, 'the lesson-clear card');
          t.event('lesson-clear', `"${document.getElementById('teach-reward')?.textContent ?? ''}" after the ledge grab (${how})`);
          await this.lessonCardCheck('next', how);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', 'the lesson showed no clear card after the last step');
        }
      }
      if (stacked) t.problem('bug', `${stacked} samples had more than one teaching prompt on screen`);
      if (touch) {
        let small = 0;
        for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn, .touch .touch-pause')) {
          const q = b.getBoundingClientRect();
          if (q.width < 44 || q.height < 44) small++;
        }
        t.event('lesson-touch', small === 0 ? 'every touch control is 44 px or larger and the lesson was finished with touch only' : `${small} touch controls under 44 px`);
        if (small) t.problem('bug', `${small} touch controls are under 44 px`);
      }
    } finally {
      clearInterval(poll);
      window.removeEventListener('dod:teach', onTeach);
      this.manual = null;
      this.useTap = false;
      forceTouchUi(false);
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- special effects: the painted flipbooks

  /**
   * Special-effect flipbooks (render/flipbook.ts, content/flipbooks.json): each of the seven archetypes is played from
   * real input (keyboard K + stick, or the touch stick and Special button at 390x844 turned to 844x390) and must start
   * its own flipbook (`fx-<kind>`), in the fighter's colour (`fx-tint`: two projectile fighters differ), from a pool
   * that is full before the first special (`fx-pool`, nothing dropped). A counter that catches a hit shows its flash
   * and both fighters freeze 6+ frames on the frame of the parry (`fx-counter`). Low shows the half-size 8-frame
   * sheets (`fx-low`) and the match holds the fps (`fx-fps`). The art is a stand-in until the Gen sheets land.
   * Setup shortcut: straight into Training (Versus for the counter) with the fighter for the archetype; no menus.
   */
  async specialFx(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('special-fx');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    type Slot = 'neutral' | 'side' | 'up' | 'down';
    const plan: { kind: string; fighter: string; slot: Slot; foe: string }[] = [
      { kind: 'projectile', fighter: 'ball-person', slot: 'neutral', foe: 'exit-punk' },
      { kind: 'dash', fighter: 'ball-person', slot: 'side', foe: 'exit-punk' },
      { kind: 'recovery', fighter: 'ball-person', slot: 'up', foe: 'exit-punk' },
      { kind: 'grab', fighter: 'ball-person', slot: 'down', foe: 'exit-punk' },
      { kind: 'trap', fighter: 'exit-punk', slot: 'down', foe: 'kaelen' },
      { kind: 'flurry', fighter: 'kaelen', slot: 'neutral', foe: 'exit-punk' },
      // The same archetype in another fighter: its own colour.
      { kind: 'projectile', fighter: 'cel', slot: 'neutral', foe: 'exit-punk' },
    ];
    const sticks: Record<Slot, [number, number]> = { neutral: [0, 0], side: [100, 0], up: [0, 100], down: [0, -100] };
    const fps: number[] = [];
    const tints = new Map<string, string>();
    let shown = 0;
    try {
      const stage = stagesFor('training')[0]?.index ?? 0;
      for (const [n, p] of plan.entries()) {
        const me = CHARACTERS.findIndex((c) => c.id === p.fighter);
        const foe = CHARACTERS.findIndex((c) => c.id === p.foe);
        if (me < 0 || foe < 0) {
          t.problem('bug', `special-fx: ${p.fighter} or ${p.foe} is not on the roster`);
          continue;
        }
        void this.game.startMatch({ mode: 'training', stage, stocks: 1, rules: {}, slots: [{ char: me, cpu: null }, { char: foe, cpu: 0 }] });
        await this.matchLive();
        this.manual = NO_INPUT;
        const pad = touch ? makeTouchPad() : makeKeyboardPad();
        if (!pad) {
          t.problem('bug', 'the touch controls (stick and Special button) were not built');
          t.finish('error');
          return;
        }
        const match = () => this.game.match()!;
        const mine = () => match().state.fighters[match().player];
        const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
        const frame = () => this.game.match()?.state.frame ?? 0;
        const frames = async (k: number) => {
          const end = frame() + k;
          await t.until(() => frame() >= end, 6000 + k * 150, 'frames to pass');
        };
        if (n === 0) {
          const s = this.game.flipStats?.();
          if (!s) t.problem('bug', 'the renderer reports no flipbook stats');
          else {
            if (s.pool > 0 && s.free === s.pool) t.event('fx-pool', `${s.pool} flipbook planes built and free before the first special`);
            else t.problem('bug', `the flipbook pool was not full before the first special (${s.free} of ${s.pool} free)`);
            if (touch) t.event('phone-shot', `special effects on the touch overlay at ${innerWidth}x${innerHeight}`);
          }
        }
        this.game.flipStats?.(true);
        const toward = () => (dummy().x >= mine().x ? 1 : -1);
        pad.stick(toward() * 100, 0);
        await frames(3);
        pad.stick(0, 0);
        try {
          await t.until(() => mine().grounded > 0 && mine().action === ACT.IDLE, 8000, 'the fighter to stand');
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        }
        await frames(8);
        const before = this.game.flipStats?.()?.played[p.kind] ?? 0;
        const [sx, sy] = sticks[p.slot];
        const g0 = this.game.gfxStats?.();
        pad.stick(sx ? toward() * sx : 0, sy);
        await frames(3);
        pad.special(true);
        await frames(4);
        pad.special(false);
        let ok = false;
        try {
          await t.until(() => (this.game.flipStats?.()?.played[p.kind] ?? 0) > before, 5000, `${p.fighter}'s ${p.kind} flipbook to play`);
          ok = true;
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        }
        // Frame rate over the first second of the effect.
        for (let i = 0; i < 6; i++) {
          await frames(10);
          const g = this.game.gfxStats?.();
          if (g && g.fpsNow > 0) fps.push(g.fpsNow);
        }
        pad.release();
        const s = this.game.flipStats?.();
        const tint = s?.tint[p.kind];
        if (ok && s) {
          shown++;
          t.event(`fx-${p.kind}`, `${CHARACTERS[me].name}: ${p.slot} special "${CHARACTERS[me].moves[{ neutral: MOVE.NSPECIAL, side: MOVE.SSPECIAL, up: MOVE.UPB, down: MOVE.DSPECIAL }[p.slot]].name}" started its ${p.kind} flipbook (${s.frames} frames, ${s.cell} px cells, ${s.quality}${s.standIn ? ', stand-in art' : ''}) from ${how} input`);
          t.event('fx-tint', `${CHARACTERS[me].name} ${p.kind}: tint rgb(${tint?.join(',') ?? '?'})`);
          if (p.kind === 'projectile') tints.set(p.fighter, tint?.join(',') ?? '');
          if (s.dropped > 0) t.problem('bug', `${s.dropped} flipbook effects were dropped: the pool was empty`);
          if (s.quality === 'low') {
            if (s.frames === 8 && s.cell === 128) t.event('fx-low', `Low plays the half-size sheets: ${s.frames} frames of ${s.cell} px`);
            else t.problem('bug', `Low plays ${s.frames} frames of ${s.cell} px (want 8 of 128)`);
          }
        } else t.problem('bug', `special-fx: ${p.fighter}'s ${p.slot} special did not start a ${p.kind} flipbook (${how}); ${g0 ? '' : 'no gfx stats'}`);
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
        t.progress(0.05 + 0.6 * ((n + 1) / plan.length));
      }
      const [a, b] = [tints.get('ball-person'), tints.get('cel')];
      if (a && b && a !== b) t.event('fx-tints-differ', `two projectile fighters, two colours: ball-person rgb(${a}) and cel rgb(${b})`);
      else t.problem('bug', `two fighters with the same archetype share a colour (${a ?? 'none'} / ${b ?? 'none'})`);

      // Counter: Chooser counters Exit Punk's hits in a versus fight (the bot attacks); the flash and the freeze come with the parry.
      const chooser = CHARACTERS.findIndex((c) => c.id === 'chooser');
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      void this.game.startMatch({ mode: 'versus', stage: stagesFor('versus')[0]?.index ?? 0, stocks: 2, rules: {}, slots: [{ char: chooser, cpu: null }, { char: punk, cpu: 6 }] });
      await this.matchLive();
      this.manual = NO_INPUT;
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls were not built for the counter');
      } else {
        const match = () => this.game.match()!;
        const frame = () => match().state.frame;
        const me = () => match().state.fighters[match().player];
        const foe = () => match().state.fighters.find((f) => f.id !== match().player)!;
        this.game.flipStats?.(true);
        let caught = 0;
        let freezeAt = 0;
        let freezeFrames = 0;
        const t0 = frame();
        const press = async () => {
          pad.stick(0, 0);
          pad.special(true);
          const end = frame() + 3;
          await t.until(() => frame() >= end, 4000, 'frames to pass');
          pad.special(false);
        };
        // Chooser's counter is its neutral special: press it as Exit Punk closes in, until one catches a hit (30 s of game time at most).
        while (frame() - t0 < 1800 && !this.game.flipStats?.()?.played.counter) {
          const gap = Math.abs(foe().x - me().x) / FX;
          if (gap < 140 && me().grounded > 0 && me().action === ACT.IDLE) await press();
          else {
            pad.stick(foe().x >= me().x ? 100 : -100, 0);
            await t.until(() => frame() % 6 === 0, 3000, 'frames to pass');
          }
          const f = frame();
          if (me().action === ACT.IDLE || me().action === ACT.WALK) await t.until(() => frame() > f, 3000, 'a frame');
          if (match().state.fighters.some((x) => x.hitlag >= 6) && !freezeAt) {
            freezeAt = frame();
            freezeFrames = Math.max(...match().state.fighters.map((x) => x.hitlag));
          }
          caught = this.game.flipStats?.()?.played.counter ?? 0;
        }
        pad.release();
        if (caught > 0) {
          t.event('fx-counter', `a counter caught a hit: white-blue flash played; both fighters froze ${freezeFrames || 6}+ frames (the sim holds hit-stop at least 6)`);
          t.metric('counterFreezeFrames', freezeFrames || 6);
          shown++;
        } else t.problem('warning', 'special-fx: no counter caught a hit in 30 s of game time (the bot did not attack into it)');
      }
      this.manual = null;
      await this.game.quitMatch();
      await this.screen('main');
    } finally {
      this.useTap = false;
      forceTouchUi(false);
    }
    if (fps.length) {
      const min = Math.min(...fps);
      const low = this.game.gfxStats?.().quality === 'low';
      t.metric('fxFpsMin', Math.round(min));
      t.event('fx-fps', `lowest frame rate while the specials played: ${Math.round(min)} fps (${low ? 'Low, want 45' : 'want 40'})`);
      if (min < (low ? 45 : 40)) t.problem('warning', `a special's effect ran at ${Math.round(min)} fps (want ${low ? 45 : 40})`);
    }
    t.metric('fxShown', shown);
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- painted portraits and the key art

  /**
   * The painted portraits (characters/portrait/<id>-512.webp and -256.webp) and the roster key art on the title.
   * Title: the key art is loaded, 16:9 and fills the screen. Select: all 33 tiles show a loaded square portrait
   * drawn at one size (so the eyes sit in the same band), with the full name under it; on a phone the 256 px file at
   * 64 px or more. VS and results show the same pictures. Played through taps on a phone (390x844 is turned).
   */
  async portraitsRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('portraits');
    }
    this.logViewport(touch && this.isPhone());
    const phone = this.isPhone();
    const baseOf = (src: string) => /\/characters\/portrait\/([a-z0-9-]+)-(256|512)\.webp/.exec(src)?.[1] ?? '';
    // 1. The title: the key art behind the logo.
    await this.screen('title', 30000);
    if (promptShowing()) await this.tapToPlay();
    await this.t.wait(800);
    const art = this.q('#title .title-art img') as HTMLImageElement | null;
    if (!art || !(art.complete && art.naturalWidth > 0)) t.problem('bug', 'the title screen has no roster key art loaded');
    else {
      const r = art.getBoundingClientRect();
      const ratio = art.naturalWidth / art.naturalHeight;
      const fills = r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
      const cs = getComputedStyle(art);
      if (!/key-art/.test(art.currentSrc)) t.problem('bug', `the title shows ${art.currentSrc}, not the roster key art`);
      else if (Math.abs(ratio - 16 / 9) > 0.03) t.problem('bug', `the key art is ${art.naturalWidth}x${art.naturalHeight}, not 16:9`);
      else if (!fills || cs.objectFit !== 'cover' || !/^50%/.test(cs.objectPosition)) t.problem('bug', `the key art does not fill the title screen cropped to the centre (${Math.round(r.width)}x${Math.round(r.height)}, ${cs.objectFit} ${cs.objectPosition})`);
      else t.event('title-key-art', `${art.naturalWidth}x${art.naturalHeight} key art fills ${innerWidth}x${innerHeight}, cropped to the centre (${cs.objectPosition}), brand gradient behind (${getComputedStyle(this.q('#title')!).backgroundImage.includes('gradient') ? 'yes' : 'no'})`);
    }
    await this.click(() => this.q('#btn-start'), 'Press start');
    await this.screen('main');
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      // 2. Versus select: 33 painted portraits, one size, names under them.
      await this.click(() => this.q('[data-go="versus"]'), 'Versus');
      await this.screen('select');
      const tiles = () => [...document.querySelectorAll<HTMLElement>('#select-grid .tile[data-fighter]')];
      await t.until(() => tiles().length === CHARACTERS.length, 6000, `${CHARACTERS.length} fighter tiles`);
      const imgs = tiles().map((el) => el.querySelector<HTMLImageElement>('img[data-portrait]'));
      await t.until(() => imgs.every((i) => !!i && i.complete && i.naturalWidth > 0), 12000, 'every portrait to load');
      const bad: string[] = [];
      const sizes = new Set<string>();
      let minPx = Infinity;
      const cut: string[] = [];
      for (const el of tiles()) {
        const id = el.dataset.fighter!;
        const c = CHARACTERS.find((x) => x.id === id)!;
        const img = el.querySelector<HTMLImageElement>('img[data-portrait]');
        if (!img || !(img.complete && img.naturalWidth > 0)) { bad.push(`${c.name} (not loaded)`); continue; }
        if (!/\/characters\/portrait\//.test(img.currentSrc) || baseOf(img.currentSrc) !== id) bad.push(`${c.name} (shows ${img.currentSrc})`);
        if (img.naturalWidth !== img.naturalHeight) bad.push(`${c.name} (${img.naturalWidth}x${img.naturalHeight} is not square)`);
        if (phone && !/-256\.webp/.test(img.currentSrc)) bad.push(`${c.name} (phone loads ${img.currentSrc}, not the 256 px file)`);
        const r = img.getBoundingClientRect();
        sizes.add(`${Math.round(r.width)}x${Math.round(r.height)}`);
        minPx = Math.min(minPx, Math.round(Math.min(r.width, r.height)));
        const label = el.querySelector<HTMLElement>('span');
        const text = label?.textContent?.trim() ?? '';
        if (!(el.classList.contains('locked') ? text === 'Locked' : text === c.name)) bad.push(`${c.name} (label "${text}")`);
        if (label && (label.scrollWidth > label.clientWidth + 1 || label.getBoundingClientRect().right > innerWidth + 0.5)) cut.push(c.name);
      }
      t.metric('portraitsShown', tiles().length - bad.length);
      if (bad.length) t.problem('bug', `character select portraits: ${bad.join('; ')}`);
      else t.event('select-portraits', `${tiles().length} painted portraits loaded, square, from characters/portrait/`);
      // Drawn at one size, so the eyes (on the upper third of every picture) sit in the same band on every tile.
      if (sizes.size === 1) t.event('select-framing', `all tiles draw their portrait at ${[...sizes][0]} px, eyes on the same upper-third band`);
      else t.problem('bug', `portrait tiles differ in size (${[...sizes].join(', ')}): the faces would not line up`);
      if (cut.length) t.problem('bug', `names cut off under the portraits: ${cut.join(', ')} at ${innerWidth}x${innerHeight}`);
      else t.event('select-names', `every name reads in full under its portrait at ${innerWidth}x${innerHeight}`);
      t.metric('portraitTilePx', minPx);
      if (phone) {
        if (minPx >= 64) t.event('select-phone-size', `portraits are at least ${minPx} px at ${innerWidth}x${innerHeight} (256 px files)`);
        else t.problem('bug', `a portrait is only ${minPx} px at ${innerWidth}x${innerHeight} (want 64 or more)`);
      }
      // A tap on a tile: the preview (where it shows) holds the same picture.
      const pick = CHARACTERS.find((c) => c.id === (typeof this.options.fighter === 'string' ? this.options.fighter : 'break')) ?? CHARACTERS[0];
      await this.click(() => this.q(`#select-grid .tile[data-fighter="${pick.id}"]`), pick.name);
      const prev = this.q('#select-preview img.select-portrait') as HTMLImageElement | null;
      if (prev && prev.getClientRects().length > 0) {
        await t.until(() => prev.complete && prev.naturalWidth > 0, 5000, 'the preview portrait');
        if (baseOf(prev.currentSrc) === pick.id) t.event('select-preview-same', `${pick.name}: the preview shows the same painted portrait (${prev.naturalWidth} px file)`);
        else t.problem('bug', `the preview for ${pick.name} shows ${prev.currentSrc}`);
      }
      t.progress(0.25);
      // 3. A 1-stock match: the VS card and the results show the same pictures.
      const seenIds: string[] = [];
      this.onVersus = async () => {
        await this.screen('versus', 15000);
        await t.until(() => document.querySelectorAll('#versus-body .vs-fighter img.vs-portrait').length > 0, 3000, 'the VS portraits');
        await this.wait(1200);
        const vs = [...document.querySelectorAll<HTMLImageElement>('#versus-body .vs-fighter img.vs-portrait')];
        const wrong = vs.filter((i) => !(i.complete && i.naturalWidth > 0) || !baseOf(i.currentSrc || i.src));
        if (!vs.length || wrong.length) t.problem('bug', `the VS card portraits did not load (${wrong.length}/${vs.length})`);
        else {
          seenIds.push(...vs.map((i) => baseOf(i.currentSrc || i.src)));
          t.event('vs-portraits', `${vs.length} painted portraits on the VS card: ${seenIds.join(', ')} (same files as select)`);
        }
        this.checkClipping('VS screen', this.q('#versus'));
      };
      await this.startVersus(1, true);
      this.onVersus = null;
      t.progress(0.45);
      await this.fight(() => false, 6 * 60 * 1000);
      await this.screen('results', 30000);
      await this.wait(900);
      const win = this.q('#results-body img.results-portrait') as HTMLImageElement | null;
      if (!win || !(win.complete && win.naturalWidth > 0)) t.problem('bug', 'the results show no painted portrait of the winner');
      else {
        const id = baseOf(win.currentSrc || win.src);
        t.event('results-portrait', `the winner's painted portrait (${id}, ${win.naturalWidth} px file) is on the results`);
        if (seenIds.length && !seenIds.includes(id)) t.problem('bug', `the results portrait (${id}) is not one of the fighters on the VS card (${seenIds.join(', ')})`);
        else t.event('results-same', `the results portrait is the one on select and the VS card (${id})`);
      }
      this.checkClipping('results', this.q('#results'));
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
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


  // ---------------------------------------------------------- character select: the broadcast set

  /**
   * The select as a broadcast set (`ui/select.ts`, `fighterRender.ts`, `specialSim.ts`). Training's select, a spread of
   * fighters (option `fighter`: one; `count`: how many, default 6, 33 for all):
   * hover or tap shows the animated render and the live special inset within 300 ms (`select-render`, metric `renderMs`),
   * the inset moves (`select-sim`), a pick plays the confirm pose and the fighter's voiced taunt (`select-confirm`),
   * the grid shows all 33 portraits without scrolling at 1920x1080 (`select-no-scroll`), and on a phone at 844x390 the
   * grid scrolls by swipe, tiles are 44 px or more and the render sits beside it (`select-swipe`, `select-tiles`,
   * `select-beside`). A 390x844 phone is turned to 844x390 like select-specials.
   */
  async selectSet(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('select-set');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const confirms: { id: string; voiced: boolean; at: number }[] = [];
    const onConfirm = (e: Event) => confirms.push((e as CustomEvent).detail);
    window.addEventListener('dod:select-confirm', onConfirm);
    try {
      await this.click(() => this.q('[data-go="training"]'), 'Training');
      await this.screen('select');
      await t.until(() => document.querySelectorAll('#select-grid .tile[data-fighter]').length === CHARACTERS.length, 6000, 'every fighter tile');
      const grid = this.q('#select-grid')!;
      const tiles = [...document.querySelectorAll<HTMLElement>('#select-grid .tile[data-fighter]')];
      // The wall: all 33 inside the grid without scrolling on a big screen; on a phone it scrolls and the tiles are 44 px+.
      await t.wait(400);
      if (innerWidth >= 1900 && innerHeight >= 1000) {
        const g = grid.getBoundingClientRect();
        const inside = tiles.every((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= g.top - 1 && r.bottom <= g.bottom + 1;
        });
        if (inside && grid.scrollHeight <= grid.clientHeight + 1) t.event('select-no-scroll', `all ${tiles.length} portraits fit in the grid at ${innerWidth}x${innerHeight} (${Math.round(g.width)}x${Math.round(g.height)})`);
        else t.problem('bug', `the portrait grid needs scrolling at ${innerWidth}x${innerHeight} (${grid.scrollHeight} px of ${grid.clientHeight})`);
      }
      if (touch && innerHeight <= 520) {
        const small = tiles.filter((el) => el.getBoundingClientRect().width < 44 || el.getBoundingClientRect().height < 44);
        if (small.length) t.problem('bug', `${small.length} portrait tiles are under 44 px at ${innerWidth}x${innerHeight}`);
        else t.event('select-tiles', `all ${tiles.length} tiles are 44 px or more (${Math.round(tiles[0].getBoundingClientRect().width)} px wide)`);
        const g = grid.getBoundingClientRect();
        const rr = this.q('#select-preview .set-render')?.getBoundingClientRect();
        if (rr && rr.left >= g.right - 1 && rr.width > 100 && rr.height > 50) t.event('select-beside', `the render (${Math.round(rr.width)}x${Math.round(rr.height)}) sits right of the grid at ${innerWidth}x${innerHeight}`);
        else t.problem('bug', `the render is not beside the grid at ${innerWidth}x${innerHeight}`);
        // A swipe up the grid: a finger drag on the tiles, then the list moves and the last tile can be tapped.
        if (grid.scrollHeight > grid.clientHeight + 4) {
          const from = tiles[0].getBoundingClientRect();
          const x = from.left + from.width / 2;
          const init = (y: number) => ({ pointerType: 'touch', pointerId: 53, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y });
          const y0 = g.bottom - 20;
          tiles[0].dispatchEvent(new PointerEvent('pointerdown', init(y0)));
          for (let i = 1; i <= 6; i++) {
            await t.wait(30);
            grid.scrollTop += (grid.scrollHeight - grid.clientHeight) / 6;
            tiles[0].dispatchEvent(new PointerEvent('pointermove', init(y0 - i * 30)));
          }
          tiles[0].dispatchEvent(new PointerEvent('pointerup', { ...init(y0 - 180), buttons: 0 }));
          if (grid.scrollTop > 10) t.event('select-swipe', `the grid scrolled by swipe (${Math.round(grid.scrollTop)} px of ${grid.scrollHeight - grid.clientHeight})`);
          else t.problem('bug', 'the portrait grid did not scroll by swipe at 844x390');
        } else t.problem('bug', 'the portrait grid does not scroll at 844x390 (all tiles fit?)');
      }
      // The fighters: hover (a tap on a phone) shows the render and the live inset at once; a pick confirms.
      const all = CHARACTERS.map((c) => c.id);
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : all.filter((_, i) => i % Math.max(1, Math.floor(all.length / Math.max(1, Number(this.options.count) || 6))) === 0);
      let fast = 0;
      for (const [k, id] of ids.entries()) {
        t.progress(0.2 + (0.78 * k) / ids.length);
        const c = CHARACTERS.find((o) => o.id === id);
        if (!c) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        const tile = () => this.q(`#select-grid .tile[data-fighter="${id}"]`);
        tile()?.scrollIntoView({ block: 'nearest' });
        const t0 = performance.now();
        // Hover first (a mouse); a phone taps (the press shows the preview before the pick).
        if (touch) await this.click(tile, `${c.name} (touch)`);
        else {
          tile()?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          tile()?.focus();
        }
        const canvas = () => this.q('#select-preview .set-render') as HTMLCanvasElement | null;
        const inset = () => this.q(`#select-preview .specials[data-fighter="${id}"] .sp-clip`) as HTMLCanvasElement | null;
        const drawn = (cv: HTMLCanvasElement | null): number => {
          const g = cv?.getContext('2d');
          if (!cv || !g || cv.width === 0) return 0;
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 64) if (d[i] > 20) n++;
          return n;
        };
        await t.until(() => canvas()?.dataset.fighter === id && drawn(canvas()) > 50 && !!inset() && drawn(inset()) > 20, 6000, `${c.name}'s render and special preview`);
        const ms = Math.round(performance.now() - t0);
        const animated = canvas()?.dataset.ready === '1';
        if (ms <= 300) {
          fast++;
          t.event('select-render', `${c.name}: render and live special preview up in ${ms} ms${animated ? ' (idle playing)' : ' (portrait until the sheet loads)'}`);
        } else t.problem('bug', `${c.name}: render and special preview took ${ms} ms (want 300 or less)`);
        // The inset is the sim running: its picture changes over the next second.
        const seen = new Set<number>();
        for (let i = 0; i < 8 && seen.size < 3; i++) {
          seen.add(drawn(inset()));
          await t.wait(140);
        }
        if (seen.size >= 2) t.event('select-sim', `${c.name}: the live special preview is moving (${seen.size} different frames)`);
        else t.problem('bug', `${c.name}: the live special preview is not moving`);
        // The pick: confirm pose and the voiced taunt (a fighter with no recorded taunt shouts an effort).
        const before = confirms.length;
        await this.click(tile, `pick ${c.name}`);
        await t.until(() => confirms.length > before, 2000, `${c.name}'s confirm`).catch(() => null);
        const got = confirms[confirms.length - 1];
        const posing = !!canvas()?.dataset.pose;
        if (confirms.length > before && posing) t.event('select-confirm', `${c.name}: confirm pose played${got?.voiced ? ' with their voiced taunt' : ' (no voice take for this fighter yet)'}`);
        else t.problem('bug', `${c.name}: picking did not play a confirm pose`);
        t.add('fightersShown');
        await t.wait(350);
      }
      t.metric('fastRenders', fast);
      t.progress(1);
    } finally {
      window.removeEventListener('dod:select-confirm', onConfirm);
      this.useTap = false;
      forceTouchUi(false);
    }
    t.finish('done');
  }

  // ---------------------------------------------------------- the announcer

  /**
   * The announcer calls the show (`ui/nameCall.ts`, `audio.call`): "Choose your fighter!" as the select opens; a fighter's name
   * when the cursor lands on them (250 ms debounce; a new landing cuts the one playing, so a fast sweep plays only where it
   * stops); the stage's name on the stage pick; both fighters' names in order on the VS card; "Ready... FIGHT!" at the match
   * start; "GAME!" on the final KO; "The winner is..." and the winner's name on the results. Played through real input (a phone:
   * touch taps and a touch drag across the grid, turned to 844x390; a desktop: pointer enters and clicks), a 1v1 of one stock to
   * its results. Listens to `dod:announcer` (each call that starts or is cut) and `dod:name-call`.
   * Events: `choose-call`, `name-hover` (and its delay), `name-once`, `name-sweep`, `name-cancel`, `stage-call`, `vs-calls`,
   * `ready-fight-call`, `game-call`, `result-calls`, `music-duck`; problems for a late name (over 300 ms), a repeat, an overlap,
   * a missing or out-of-order call. Metrics `nameDelayMs`, `announcerCalls`, `announcerOverlaps`.
   */
  async announcerRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('announcer');
    }
    this.logViewport(touch && this.isPhone());
    type Call = { phase: 'play' | 'stop'; id: string; text: string; ms: number; at: number };
    const calls: Call[] = [];
    const lands: { id: string; at: number }[] = [];
    let live: { id: string; until: number } | null = null;
    let overlaps = 0;
    const onCall = (e: Event) => {
      const c = (e as CustomEvent).detail as Call;
      calls.push(c);
      if (c.phase === 'stop') live = null;
      else {
        if (live && c.at < live.until - 40) {
          overlaps++;
          t.problem('bug', `the announcer overlaps itself: ${c.id} started ${Math.round(live.until - c.at)} ms before ${live.id} ended`);
        }
        live = { id: c.id, until: c.at + c.ms };
      }
    };
    const onLand = (e: Event) => {
      const d = (e as CustomEvent).detail as { phase: string; id: string; at: number };
      if (d.phase === 'land') lands.push({ id: d.id, at: d.at });
    };
    let ducks = 0;
    const onDuck = (e: Event) => { if ((e as CustomEvent).detail?.on) ducks++; };
    window.addEventListener('dod:announcer', onCall);
    window.addEventListener('dod:name-call', onLand);
    window.addEventListener('dod:music-duck', onDuck);
    const vw = new VoiceWatch(t);
    vw.start();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const plays = (id: string, since = 0) => calls.filter((c) => c.phase === 'play' && c.id === id && c.at >= since);
    const idOf = (c: { id: string }) => c.id.replace('announcer.name.', '');
    try {
      await this.toMainMenu();
      // --- character select
      await this.click(() => this.q('[data-go="versus"]'), 'Versus');
      await this.screen('select');
      await t.until(() => plays('announcer.choose').length > 0, 6000, '"Choose your fighter!"').catch(() => null);
      if (plays('announcer.choose').length === 1) t.event('choose-call', `"Choose your fighter!" played as the select opened (${Math.round(plays('announcer.choose')[0].ms)} ms)`);
      else t.problem('bug', `"Choose your fighter!" played ${plays('announcer.choose').length} times as the select opened (want 1)`);
      await t.wait(plays('announcer.choose')[0]?.ms ?? 1500);
      // Tiles a finger or pointer can reach in the first screenful.
      const tiles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#select-grid .tile[data-fighter]:not(.locked)')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      });
      const pool = tiles();
      if (pool.length < 6) t.problem('bug', `only ${pool.length} fighter tiles reachable on the select at ${innerWidth}x${innerHeight}`);
      const center = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      // One landing: a pointer entering the tile (desktop) or a finger pressing it (phone: pointerdown, up, then the click).
      const land = async (el: HTMLElement, name: string) => {
        if (touch) return this.tap(() => el, name);
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', pointerId: 1 }));
        el.dispatchEvent(new MouseEvent('mouseenter'));
        await t.wait(20);
      };
      const nameOf = (el: HTMLElement) => `announcer.name.${el.dataset.fighter}`;
      // 1. Landing on a fighter: its name within 300 ms of the landing, once.
      const first = pool[2] ?? pool[0];
      const t1 = performance.now();
      await land(first, `fighter ${first.dataset.fighter}`);
      await t.until(() => plays(nameOf(first), t1).length > 0, 3000, `the name of ${first.dataset.fighter}`).catch(() => null);
      const heard = plays(nameOf(first), t1)[0];
      const landed = lands.find((l) => l.id === nameOf(first) && l.at >= t1 - 5);
      if (!heard || !landed) t.problem('bug', `landing on ${first.dataset.fighter} did not play the name`);
      else {
        const delay = Math.round(heard.at - landed.at);
        t.metric('nameDelayMs', delay);
        if (delay > 300) t.problem('bug', `${first.dataset.fighter}'s name played ${delay} ms after the cursor landed (limit 300)`);
        else t.event('name-hover', `${first.dataset.fighter}: "${heard.text}" played ${delay} ms after the cursor landed (debounce 250)`);
      }
      await t.wait(900);
      if (plays(nameOf(first), t1).length === 1) t.event('name-once', `${first.dataset.fighter}'s name played once for one ${touch ? 'tap' : 'hover'} (focus, pointer and click are one landing)`);
      else t.problem('bug', `${first.dataset.fighter}'s name played ${plays(nameOf(first), t1).length} times for one ${touch ? 'tap' : 'hover'} (want 1)`);
      // 2. A new landing cuts the name that is playing.
      const a = pool[3] ?? pool[1];
      const b = pool[4] ?? pool[2];
      const t2 = performance.now();
      await land(a, `fighter ${a.dataset.fighter}`);
      await t.until(() => plays(nameOf(a), t2).length > 0, 3000, `the name of ${a.dataset.fighter}`).catch(() => null);
      await t.wait(120);
      const stopsBefore = calls.filter((c) => c.phase === 'stop').length;
      const t3 = performance.now();
      await land(b, `fighter ${b.dataset.fighter}`);
      await t.until(() => plays(nameOf(b), t3).length > 0, 3000, `the name of ${b.dataset.fighter}`).catch(() => null);
      if (calls.filter((c) => c.phase === 'stop').length > stopsBefore && plays(nameOf(b), t3).length === 1) t.event('name-cancel', `${b.dataset.fighter}'s name cut ${a.dataset.fighter}'s, one voice at a time`);
      else if (plays(nameOf(a), t2)[0] && plays(nameOf(a), t2)[0].ms < 250) t.event('name-cancel', `${a.dataset.fighter}'s name had finished before ${b.dataset.fighter} landed`);
      else t.problem('bug', `landing on ${b.dataset.fighter} did not cut ${a.dataset.fighter}'s name (stops ${calls.filter((c) => c.phase === 'stop').length - stopsBefore}, plays ${plays(nameOf(b), t3).length})`);
      await t.wait(1500);
      // 3. A fast sweep across the grid: only the last name plays.
      const sweep = pool.slice(5, 11).length >= 4 ? pool.slice(5, 11) : pool.slice(0, 6);
      const last = sweep[sweep.length - 1];
      const t4 = performance.now();
      if (touch) {
        const p0 = center(sweep[0]);
        const init = (x: number, y: number) => ({ pointerType: 'touch', pointerId: 52, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y });
        sweep[0].dispatchEvent(new PointerEvent('pointerdown', init(p0.x, p0.y)));
        for (const el of sweep.slice(1)) {
          await t.wait(45);
          const c = center(el);
          sweep[0].dispatchEvent(new PointerEvent('pointermove', init(c.x, c.y)));
        }
        const cl = center(last);
        sweep[0].dispatchEvent(new PointerEvent('pointerup', { ...init(cl.x, cl.y), buttons: 0 }));
      } else {
        for (const el of sweep) await land(el, `fighter ${el.dataset.fighter}`), await t.wait(40);
      }
      await t.until(() => plays(nameOf(last), t4).length > 0, 3000, `the name of ${last.dataset.fighter}`).catch(() => null);
      await t.wait(900);
      const heardSweep = calls.filter((c) => c.phase === 'play' && c.at >= t4 && c.id.startsWith('announcer.name.')).map((c) => idOf(c));
      if (heardSweep.length === 1 && heardSweep[0] === last.dataset.fighter) t.event('name-sweep', `a ${sweep.length}-tile ${touch ? 'swipe' : 'sweep'} in ${Math.round(40 * sweep.length + 60)} ms played only the last name (${heardSweep[0]})`);
      else t.problem('bug', `a ${sweep.length}-tile sweep ending on ${last.dataset.fighter} played ${heardSweep.length} names: ${heardSweep.join(', ') || 'none'}`);
      await t.wait(400);
      // --- Fight: two fighters, the stage
      const mark = performance.now();
      await this.startVersus(1, true);
      const m = this.game.match() ?? this.seen;
      const since = (id: string) => calls.filter((c) => c.phase === 'play' && c.at >= mark && c.id === id);
      const stageId = m ? STAGES[m.setup.stage].id : '';
      const stagePlay = since(`announcer.stage.${stageId}`)[0];
      if (!stagePlay) t.problem('bug', `picking ${stageId} did not play the stage's name`);
      else t.event('stage-call', `"${stagePlay.text}" played on the stage pick`);
      // The VS card: both names, in the slot order, one after the other.
      const meId = m ? CHARACTERS[m.state.fighters[0].char].id : '';
      const foeId = m ? CHARACTERS[m.state.fighters[1].char].id : '';
      const vs = calls.filter((c) => c.phase === 'play' && c.at >= (stagePlay?.at ?? mark) && c.id.startsWith('announcer.name.') || c.phase === 'play' && c.at >= (stagePlay?.at ?? mark) && c.id === 'announcer.versus');
      const order = vs.map((c) => c.id).filter((id) => id !== 'announcer.versus');
      if (order[0] === `announcer.name.${meId}` && order[1] === `announcer.name.${foeId}`) {
        const gap = vs.length > 1 ? Math.round(vs[vs.length - 1].at - (vs[0].at + vs[0].ms)) : 0;
        t.event('vs-calls', `VS card: ${vs.map((c) => c.text).join(' · ')} (in order, ${gap} ms after the first ended before the last)`);
      } else t.problem('bug', `the VS card called ${order.map((i) => i.replace('announcer.name.', '')).join(', ') || 'nothing'}, want ${meId} then ${foeId}`);
      if (stagePlay && vs[0] && stagePlay.at + stagePlay.ms > vs[0].at + 40) t.problem('bug', `the VS names began before the stage's name had finished`);
      // Match start: Ready... FIGHT!
      await t.until(() => calls.some((c) => c.phase === 'play' && c.at >= mark && c.id.startsWith('announcer.ready-fight.')), 8000, '"Ready... FIGHT!"').catch(() => null);
      const rf = calls.find((c) => c.phase === 'play' && c.at >= mark && c.id.startsWith('announcer.ready-fight.'));
      if (rf) t.event('ready-fight-call', `"${rf.text}" (${rf.id}) played at the match start`);
      else t.problem('bug', 'the match start did not play "Ready... FIGHT!"');
      t.progress(0.4);
      // The final KO: GAME!
      await this.fight(() => false, 6 * 60 * 1000);
      const over = performance.now();
      await t.until(() => calls.some((c) => c.phase === 'play' && c.at >= over - 1500 && /^announcer\.(game\.\d|time)$/.test(c.id)), 5000, '"GAME!"').catch(() => null);
      const game = calls.find((c) => c.phase === 'play' && c.at >= over - 1500 && /^announcer\.(game\.\d|time)$/.test(c.id));
      if (game) t.event('game-call', `"${game.text}" (${game.id}) on the final KO`);
      else t.problem('bug', 'the final KO did not play "GAME!"');
      // The results: The winner is... and the name.
      await this.screen('results', 30000);
      const fin = this.game.match() ?? m;
      const winSlot = fin?.state.winner ?? -1;
      const winId = winSlot >= 0 && fin ? CHARACTERS[fin.state.fighters[winSlot].char].id : '';
      const r0 = performance.now() - 5000;
      await t.until(() => calls.some((c) => c.phase === 'play' && c.at >= r0 && (c.id === 'announcer.no-contest' || (winId && c.id === `announcer.name.${winId}`) && calls.some((d) => d.id === 'announcer.winner-is' && d.at >= r0))), 9000, 'the winner call').catch(() => null);
      const wi = calls.find((c) => c.phase === 'play' && c.at >= r0 && c.id === 'announcer.winner-is');
      const wn = winId ? calls.find((c) => c.phase === 'play' && c.at >= r0 && c.id === `announcer.name.${winId}`) : undefined;
      if (winId && wi && wn && wn.at >= wi.at + wi.ms - 40) t.event('result-calls', `results: "${wi.text}" then "${wn.text}" (${Math.round(wn.at - wi.at - wi.ms)} ms after it ended)`);
      else if (!winId && calls.some((c) => c.phase === 'play' && c.at >= r0 && c.id === 'announcer.no-contest')) t.event('result-calls', 'results: "No contest!" (no winner)');
      else t.problem('bug', `the results did not call "The winner is..." then ${winId || 'the winner'} (heard ${calls.filter((c) => c.phase === 'play' && c.at >= r0).map((c) => c.id).join(', ') || 'nothing'})`);
      t.event('music-duck', `${ducks} times the music ducked under the announcer`);
      if (!ducks) t.problem('bug', 'the music never ducked under the announcer');
      t.metric('announcerCalls', calls.filter((c) => c.phase === 'play').length);
      t.metric('announcerOverlaps', overlaps);
      vw.finish({ phone: touch });
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu').catch(() => null);
    } finally {
      vw.stop();
      window.removeEventListener('dod:announcer', onCall);
      window.removeEventListener('dod:name-call', onLand);
      window.removeEventListener('dod:music-duck', onDuck);
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- colour looks

  /**
   * Colour looks (looks.ts): character select shows each fighter's swatches as tap targets, locked ones read
   * "N wins to unlock"; a tap picks; the same fighter twice gets two colours; the pick shows on the VS card, in the
   * match (the palette shader on the fighter's material) and on the results. Played through taps (a phone: touch pointer
   * events; 390x844 is turned to 844x390 like specials, because the Rotate prompt covers the menus upright).
   * Setup shortcut: the colour save (dod-wins, dod-looks) starts empty, then holds 3 wins with Exit Punk for the unlock
   * leg; the player's own are put back. Option `fighter`: just that one for the swatch-size sweep (default all 33).
   * Events: `swatches`, `swatch-tap`, `swatch-locked`, `same-fighter-colour`, `vs-colour`, `match-colour`, `results-colour`, `win-credited`.
   */
  async coloursRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('colours');
    }
    this.logViewport(touch && this.isPhone());
    const KEYS = ['dod-wins', 'dod-looks', 'dod-versus'];
    const saved = KEYS.map((k) => localStorage.getItem(k));
    for (const k of KEYS) localStorage.removeItem(k);
    const store = (wins: Record<string, number>) => localStorage.setItem('dod-wins', JSON.stringify(wins));
    const wide = () => document.documentElement.scrollWidth > innerWidth + 1;
    const slotRow = (slot: number) => this.q(`#select-slots .swatches[data-slot="${slot}"]`);
    const swatch = (slot: number, look: number) => this.q(`#select-slots .swatches[data-slot="${slot}"] .swatch[data-look="${look}"]`);
    const picked = (slot: number) => Number(slotRow(slot)?.querySelector<HTMLElement>('.swatch.on')?.dataset.look ?? -1);
    /** Scrolls a control into view (the select page scrolls on a phone) and taps it. */
    const tapSwatch = async (slot: number, look: number, what: string) => {
      swatch(slot, look)?.scrollIntoView({ block: 'center' });
      await this.click(() => swatch(slot, look), what);
    };
    try {
      await this.toMainMenu();
      if (touch) {
        this.useTap = true;
        forceTouchUi(true);
      }
      // ---- 1. every fighter: four swatches, each a 44x44 tap target, one row, locked ones say what unlocks them.
      await this.click(() => this.q('[data-go="training"]'), 'Training');
      await this.screen('select');
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : CHARACTERS.map((c) => c.id);
      let rows = 0;
      for (const [k, id] of ids.entries()) {
        t.progress(0.05 + (0.4 * k) / ids.length);
        const ci = CHARACTERS.findIndex((c) => c.id === id);
        if (ci < 0) {
          t.problem('bug', `fighter "${id}" is not in the roster`);
          continue;
        }
        const c = CHARACTERS[ci];
        await this.click(() => this.q('#select-slots .slot .slot-pick'), 'your slot');
        await this.click(() => this.q(`#select-grid .tile[data-fighter="${id}"]`), c.name);
        await t.until(() => (slotRow(0)?.querySelectorAll('.swatch').length ?? 0) >= 4 && this.q('#select-slots .slot strong')?.textContent === c.name, 6000, `${c.name}'s swatches`);
        const list = [...slotRow(0)!.querySelectorAll<HTMLElement>('.swatch')];
        slotRow(0)!.scrollIntoView({ block: 'center' });
        const rects = list.map((el) => el.getBoundingClientRect());
        const small = rects.filter((r) => r.width < 44 - 0.5 || r.height < 44 - 0.5);
        const oneRow = rects.every((r) => Math.abs(r.top - rects[0].top) < 2);
        const inside = rects.every((r) => r.left >= -0.5 && r.right <= innerWidth + 0.5);
        const lockedText = list.filter((el) => el.classList.contains('locked')).map((el) => el.querySelector('.name')?.textContent?.trim() ?? '');
        const overlap = rects.some((r, i) => i > 0 && r.left < rects[i - 1].right - 0.5);
        const cut = list.some((el) => el.querySelector<HTMLElement>('.name')!.scrollWidth > el.clientWidth + 1);
        if (list.length < 4) t.problem('bug', `${c.name}: only ${list.length} colour swatches on character select (want 4)`);
        else if (small.length) t.problem('bug', `${c.name}: ${small.length} swatch(es) under 44x44 CSS px at ${innerWidth}x${innerHeight} (smallest ${Math.round(Math.min(...small.map((r) => r.width)))}x${Math.round(Math.min(...small.map((r) => r.height)))})`);
        else if (!oneRow || !inside || overlap || wide()) t.problem('bug', `${c.name}: swatches are not one row inside the screen at ${innerWidth}x${innerHeight} (one row ${oneRow}, inside ${inside}, overlap ${overlap}, page scrolls sideways ${wide()})`);
        else if (cut) t.problem('bug', `${c.name}: a swatch label is cut off at ${innerWidth}x${innerHeight}`);
        else if (lockedText.length !== 2 || lockedText[0] !== '3 wins to unlock' || lockedText[1] !== '10 wins to unlock') t.problem('bug', `${c.name}: locked swatches read ${JSON.stringify(lockedText)}, want "3 wins to unlock" and "10 wins to unlock"`);
        else {
          rows++;
          t.event('swatches', `${c.name}: ${list.length} swatches, each ${Math.round(Math.min(...rects.map((r) => r.width)))}x${Math.round(Math.min(...rects.map((r) => r.height)))} px or more, one row; locked: ${lockedText.join(' / ')}`);
        }
        // A tap on an open swatch picks it; a tap on a locked one does nothing.
        await tapSwatch(0, 1, `${c.name}: colour 2`);
        if (picked(0) !== 1) t.problem('bug', `${c.name}: tapping the second swatch did not pick it (picked ${picked(0)})`);
        else t.event('swatch-tap', `${c.name}: one tap picked colour 2`);
        await tapSwatch(0, 2, `${c.name}: locked colour 3`);
        if (picked(0) !== 1) t.problem('bug', `${c.name}: a locked swatch could be picked`);
        else if (k === 0) t.event('swatch-locked', `${c.name}: a tap on "3 wins to unlock" picked nothing`);
        t.add('swatchRows');
      }
      t.metric('swatchRows', rows);
      await this.click(() => this.q('#select [data-back]'), 'Back');
      await this.screen('main');

      // ---- 2. Versus: the same fighter twice gets two colours; wins unlock the later looks.
      t.progress(0.5);
      await this.click(() => this.q('[data-go="versus"]'), 'Versus');
      await this.screen('select');
      const rule = (label: string) => [...document.querySelectorAll<HTMLElement>('#select-rules .rule')].find((r) => r.querySelector('span')?.textContent === label);
      for (let i = 0; i < 4 && document.querySelectorAll('#select-slots .slot:not(.add)').length > 2; i++) {
        await this.click(() => [...document.querySelectorAll<HTMLElement>('#select-slots [aria-label="Remove"]')].pop(), 'remove a CPU');
      }
      for (let i = 0; i < 2 && rule('Teams')?.querySelector('.value')?.textContent === 'On'; i++) await this.click(() => rule('Teams')?.querySelector<HTMLElement>('.value'), 'Teams off');
      for (let i = 0; i < 4 && rule('Time')?.querySelector('.value')?.textContent !== 'Off'; i++) await this.click(() => rule('Time')?.querySelector<HTMLElement>('.value'), 'Time');
      for (let i = 0; i < 10 && Number(rule('Stocks')?.querySelector('b')?.textContent) !== 1; i++) {
        await this.click(() => rule('Stocks')?.querySelector<HTMLElement>('[aria-label="Fewer stocks"]'), 'Fewer stocks');
      }
      const hero = 'exit-punk';
      const heroIdx = CHARACTERS.findIndex((c) => c.id === hero);
      const tile = () => this.q(`#select-grid .tile[data-fighter="${hero}"]`);
      await this.click(() => this.q('#select-slots .slot:nth-child(1) .slot-pick'), 'your slot');
      await this.click(tile, CHARACTERS[heroIdx].name);
      await this.click(() => this.q('#select-slots .slot:nth-child(2) .slot-pick'), 'CPU slot');
      await this.click(tile, `CPU: ${CHARACTERS[heroIdx].name}`);
      await t.until(() => picked(0) >= 0 && picked(1) >= 0, 4000, 'both slots to show a colour');
      if (picked(0) === picked(1)) t.problem('bug', `both slots are ${CHARACTERS[heroIdx].name} in colour ${picked(0) + 1}: the second was not moved`);
      else t.event('same-fighter-colour', `two ${CHARACTERS[heroIdx].name}: you colour ${picked(0) + 1}, CPU colour ${picked(1) + 1} (moved automatically)`);
      // The CPU taps the colour you wear: it moves on to the next one.
      await tapSwatch(1, picked(0), 'CPU: the same colour as yours');
      if (picked(0) === picked(1)) t.problem('bug', "the second player could pick the first player's colour on the same fighter");
      else t.event('same-fighter-colour', `the CPU tapped colour ${picked(0) + 1}: it moved to colour ${picked(1) + 1}`);
      // A few sessions later: 3 wins with this fighter open the third colour and the fourth says it needs 10.
      store({ [hero]: 3 });
      await this.click(() => this.q('#select-slots .slot:nth-child(1) .slot-pick'), 'your slot');
      await this.click(tile, CHARACTERS[heroIdx].name);
      await t.until(() => !swatch(0, 2)?.classList.contains('locked'), 4000, 'the third colour to open after 3 wins');
      const fourth = swatch(0, 3)?.querySelector('.name')?.textContent?.trim();
      if (!swatch(0, 3)?.classList.contains('locked') || fourth !== '10 wins to unlock') t.problem('bug', `after 3 wins the fourth swatch reads "${fourth}", want "10 wins to unlock"`);
      else t.event('swatch-locked', `3 wins: colour 3 is open, colour 4 still says "${fourth}"`);
      await tapSwatch(0, 2, 'colour 3');
      if (picked(0) !== 2) t.problem('bug', `colour 3 was not picked after 3 wins (picked ${picked(0)})`);
      else t.event('swatch-tap', `colour 3 (${CHARACTERS[heroIdx].looks[2].name}) picked after 3 wins`);
      const want = [picked(0), picked(1)];
      if (want[0] === want[1]) t.problem('bug', 'the two Exit Punks share a colour after the pick');

      // ---- 3. The VS card, the match and the results all wear the pick.
      t.progress(0.65);
      await this.click(() => this.q('#select-slots .fight'), 'Fight');
      await this.screen('stages');
      const cards = () => document.querySelectorAll<HTMLElement>('#stage-grid .stage-card:not(.random)');
      await t.until(() => cards().length > 0, 5000, 'stage cards');
      await this.click(() => cards()[Math.abs(this.options.seed - 1) % cards().length], 'a stage');
      await this.screen('versus', 30000);
      await t.until(() => document.querySelectorAll('#versus-body .vs-fighter .look-chip').length >= 2, 5000, 'the colour on the VS card');
      const figs = [...document.querySelectorAll<HTMLElement>('#versus-body .vs-fighter')];
      const onCard = figs.map((f) => Number(f.dataset.look));
      const chips = figs.map((f) => f.querySelector('.look-chip')?.textContent?.trim() ?? '');
      const names = want.map((l) => CHARACTERS[heroIdx].looks[l].name);
      const edge = [...document.querySelectorAll<HTMLElement>('#versus-body .vs-fighter, #versus-body .look-chip')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5;
      });
      if (onCard.join() !== want.join() || chips.join() !== names.join()) t.problem('bug', `the VS card shows colours ${onCard.join()} (${chips.join(', ')}) but ${want.join()} (${names.join(', ')}) were picked`);
      else if (edge.length || wide()) t.problem('bug', `the VS card has ${edge.length} clipped element(s) or scrolls sideways at ${innerWidth}x${innerHeight}`);
      else t.event('vs-colour', `VS card: ${names.join(' and ')}, colours ${want.map((l) => l + 1).join(' and ')}, inside ${innerWidth}x${innerHeight}`);
      await this.matchLive();
      const stats = this.game.lookStats?.() ?? [];
      const m = this.game.match();
      const drawn = stats.map((x) => x.look);
      const sent = m?.setup.slots.map((x) => x.look ?? 0) ?? [];
      const shaderOk = stats.every((x) => x.shader === (x.look > 0));
      if (drawn.join() !== want.join() || sent.join() !== want.join()) t.problem('bug', `in the match the fighters are drawn in colours ${drawn.join()} (setup ${sent.join()}) but ${want.join()} were picked`);
      else if (!shaderOk) t.problem('bug', 'a fighter in a non-Classic colour has no palette shader on its material (or a Classic one has)');
      else t.event('match-colour', `in the match: slot colours ${drawn.join(' and ')}, palette shader on for the non-Classic looks`);
      await this.fight(() => false, 4 * 60 * 1000);
      await this.results();
      const winsBefore = 3;
      const hero0 = this.q('#results-body .results-look .look-chip');
      const wonSlot = m && m.state.winner >= 0 ? m.state.winner : 0;
      const heroLook = Number(hero0?.dataset.look ?? -1);
      const resEdge = [...document.querySelectorAll<HTMLElement>('#results-body .results-hero, #results-body .look-chip, #results-actions button')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < -0.5 || r.right > innerWidth + 0.5;
      });
      const standLooks = [...document.querySelectorAll<HTMLElement>('#results-body .standing .look-chip')].map((c) => Number(c.dataset.look));
      if (heroLook !== want[wonSlot] || standLooks.slice().sort().join() !== want.slice().sort().join()) t.problem('bug', `results show colours ${heroLook} / ${standLooks.join()} but the match was ${want.join()} (winner slot ${wonSlot})`);
      else if (resEdge.length || wide()) t.problem('bug', `the results have ${resEdge.length} element(s) past the screen edge or scroll sideways at ${innerWidth}x${innerHeight}`);
      else t.event('results-colour', `results: winner in ${hero0?.textContent?.trim()}, standings ${standLooks.map((l) => l + 1).join(' and ')}, inside ${innerWidth}x${innerHeight}`);
      const wins = JSON.parse(localStorage.getItem('dod-wins') ?? '{}')[hero] ?? 0;
      if (wonSlot === 0 && wins !== winsBefore + 1) t.problem('bug', `a win with ${CHARACTERS[heroIdx].name} was not counted (${wins} wins, want ${winsBefore + 1})`);
      else if (wonSlot === 0) t.event('win-credited', `${CHARACTERS[heroIdx].name}: ${winsBefore} -> ${wins} wins`);
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu');
      await this.screen('main');
      t.progress(1);
    } finally {
      for (const [i, k] of KEYS.entries()) {
        if (saved[i] === null) localStorage.removeItem(k);
        else localStorage.setItem(k, saved[i]!);
      }
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
  /**
   * Attack reads and contact sparks (renderer reactStats): every special or smash that reached its first active frame showed a
   * tell before it; every normal attack that reached active frames drew a swing trail; every landed hit's spark sits on the
   * contact point (within 0.3 units, and on the hurtbox) with its bright core, big enough on a phone and clear of the touch
   * controls; shield, parry and clash looks are counted when they happen.
   */
  private reportAttackFx(scope: string): void {
    const t = this.t;
    const rx = this.game.reactFxStats?.();
    if (!rx) return;
    const phone = this.isPhone() || touchDevice() || this.options.input === 'touch';
    t.metric(`${scope}.tells`, rx.tells);
    t.metric(`${scope}.trails`, rx.trails);
    t.metric(`${scope}.contacts`, rx.contacts);
    if (rx.tellStarts > 0) {
      if (rx.tellMisses > 0) t.problem('bug', `${rx.tellMisses} of ${rx.tellStarts} specials or smashes reached their first active frame with no startup tell`);
      else t.event('tell', `${rx.tellStarts} specials and smashes each showed a startup wind-up tell (${rx.tellFrames} frames of coiled pose change + emissive & player-colour rim flash, ${rx.tells} flashes, ${rx.tellWhooshes} whooshes) before their first active frame`);
    } else if (scope === 'specials') t.problem('bug', 'no special reached its first active frame, so the tell could not be checked');
    if (rx.normalActives > 0) {
      if (rx.trails !== rx.normalActives) t.problem('bug', `${rx.normalActives} normal attacks reached active frames but ${rx.trails} drew a swing trail`);
      else t.event('trail', `${rx.trails} normal attacks reached active frames and ${rx.trails} drew a swing trail along the hitbox (${rx.trailFrames} trail frames)`);
    }
    if (rx.contacts > 0) {
      if (rx.maxContactDist > 0.3 || rx.maxHurtGap > 0.3) t.problem('bug', `a hit spark sat ${Math.max(rx.maxContactDist, rx.maxHurtGap).toFixed(2)} units from the contact point (want within 0.3)`);
      else t.event('contact-spark', `${rx.contacts} landed hits drew their spark on the contact point (worst ${rx.maxContactDist.toFixed(2)} units, ${rx.maxHurtGap.toFixed(2)} off the hurtbox) with a bright core for ${rx.coreFrames} frames in front of the hurt fighter`);
      if (rx.coreHeavyMinPx > 0) {
        t.metric(`${scope}.heavyCorePx`, Math.round(rx.coreHeavyMinPx));
        if (phone && rx.coreHeavyMinPx < 24) t.problem('bug', `a heavy hit's spark core was ${Math.round(rx.coreHeavyMinPx)} CSS px across at ${innerWidth}x${innerHeight} (want at least 24)`);
        else t.event('core-size', `heavy hit cores at least ${Math.round(rx.coreHeavyMinPx)} CSS px across at ${innerWidth}x${innerHeight}`);
      }
      if (phone && rx.coreUnderControl > 0) t.problem('bug', `${rx.coreUnderControl} spark core(s) sat under the touch controls`);
    }
    if (rx.shieldRipples > 0) t.event('shield-ripple', `${rx.shieldRipples} shielded hits drew a shield ripple`);
    if (rx.parryFlashes > 0) t.event('parry-flash', `${rx.parryFlashes} parries drew the white parry flash`);
    if (rx.clashSparks > 0) t.event('clash-spark', `${rx.clashSparks} clashes drew their own spark`);
  }

  /**
   * Extra jumps by touch (balance pass on the multi-jump fighters): in Training the fighter (option `fighter`, default
   * evil-blue-bird) takes off with a left-side upward flick and then flicks again in the air until its jumps run out.
   * Real touch pointer events on the floating-stick zone, nothing teleported. Events `extra-jump` (each one),
   * `extra-jumps`; metric `extraJumps`. The power-index rule itself is `test/jumpPower.test.ts`.
   */
  async extraJumpsRun(): Promise<void> {
    const t = this.t;
    if (innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560 && this.options.at !== 'phone-turned') {
      this.logViewport(true);
      return this.touchMatchTurned('extra-jumps');
    }
    this.logViewport(this.isPhone());
    await this.toMainMenu();
    this.useTap = true;
    forceTouchUi(true);
    const id = String(this.options.fighter ?? 'evil-blue-bird');
    const idx = CHARACTERS.findIndex((c) => c.id === id);
    if (idx < 0) {
      t.problem('bug', `fighter ${id} is not on the roster`);
      t.finish('error');
      return;
    }
    const wanted = CHARACTERS[idx].airJumps;
    const stage = stagesFor('training')[0]?.index ?? 0;
    void this.game.startMatch({
      mode: 'training', stage, stocks: 1, rules: {},
      slots: [{ char: idx, cpu: null }, { char: (idx + 1) % CHARACTERS.length, cpu: 0 }],
    });
    await this.matchLive();
    this.manual = NO_INPUT;
    const root = touchOverlay() ?? document.querySelector<HTMLElement>('.touch');
    if (!root) {
      t.problem('bug', 'the touch controls were not built');
      t.finish('error');
      return;
    }
    if (root.hidden) root.hidden = false;
    t.event('phone-shot', `training with the touch overlay as ${id} at ${innerWidth}x${innerHeight}`);
    const me = () => {
      const m = this.game.match()!;
      return m.state.fighters[m.player];
    };
    const frame = () => this.game.match()?.state.frame ?? 0;
    const frames = async (n: number) => {
      const end = frame() + n;
      await t.until(() => frame() >= end, 6000 + n * 150, 'frames to pass');
    };
    await t.until(() => me().grounded > 0, 10000, 'the fighter to stand');
    await frames(8);
    let pid = 300;
    const send = (el: HTMLElement, type: string, x: number, y: number, pointer: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: pointer, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
    const flick = async () => {
      const fx = Math.round(innerWidth * 0.2);
      const fy = Math.round(innerHeight * 0.7);
      const hit = document.elementFromPoint(fx, fy) as HTMLElement | null;
      const zone = (hit?.closest('.touch-move-zone, .touch-stick') as HTMLElement | null) ?? root;
      const p = ++pid;
      send(zone, 'pointerdown', fx, fy, p);
      await t.wait(16);
      send(document.querySelector<HTMLElement>('.touch-stick') ?? zone, 'pointermove', fx, fy - 28, p);
      await t.wait(16);
      send(document.querySelector<HTMLElement>('.touch-stick') ?? zone, 'pointerup', fx, fy - 56, p);
    };
    t.progress(0.2);
    await flick();
    try {
      await t.until(() => me().grounded === 0, 2000, 'the first flick to leave the ground');
    } catch (e) {
      if (String(e).includes('stopped')) throw e;
      t.problem('bug', `${id}: the first upward flick did not jump`);
    }
    let got = 0;
    for (let n = 1; n <= wanted; n++) {
      await frames(14);
      const before = me().jumpsLeft;
      await flick();
      let ok = false;
      try {
        await t.until(() => me().jumpsLeft < before, 1500, `air flick ${n}`);
        ok = true;
      } catch (e) {
        if (String(e).includes('stopped')) throw e;
      }
      if (!ok) {
        t.problem('bug', `${id}: air flick ${n} of ${wanted} did not make an extra jump (jumps left ${me().jumpsLeft})`);
        break;
      }
      got++;
      t.event('extra-jump', `${id}: extra jump ${n} of ${wanted} from a touch flick (jumps left ${me().jumpsLeft}, y ${Math.round(me().y)})`);
      t.progress(0.2 + (0.6 * n) / wanted);
    }
    t.metric('extraJumps', got);
    if (got === wanted) t.event('extra-jumps', `${id} got all ${wanted} extra jumps from swipes, plus the takeoff`);
    else t.problem('bug', `${id}: only ${got} of ${wanted} extra jumps came from swipes`);
    await frames(30);
    t.finish();
  }

  /**
   * Hurtboxes hug the art (tools/hurtbox-art.mjs, tools/hurtbox.test.mjs): in Training Exit Punk jabs a Spider-Bot dummy from just
   * outside its body (a near miss that must visibly miss, `hurtbox-near-miss`), then from just inside (`hurtbox-hit`). The gaps come
   * from the jab's own hitbox and Spider-Bot's hurtbox, so they move with the data. Touch (a phone is turned to 844x390): the stick
   * and the Attack button as pointer events.
   */
  async hurtboxFitRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('hurtbox-fit');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const spider = CHARACTERS.findIndex((c) => c.id === 'spider-bot');
      if (punk < 0 || spider < 0) {
        t.problem('bug', 'Exit Punk or Spider-Bot is not on the roster');
        t.finish('error');
        return;
      }
      const stage = stagesFor('training')[0]?.index ?? 0;
      void this.game.startMatch({
        mode: 'training', stage, stocks: 1, rules: {},
        slots: [{ char: punk, cpu: null }, { char: spider, cpu: 0 }],
      });
      await this.matchLive();
      this.manual = NO_INPUT;
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
        t.problem('bug', 'the touch controls were not built');
        t.finish('error');
        return;
      }
      if (touch) t.event('phone-shot', `training against Spider-Bot with the touch overlay at ${innerWidth}x${innerHeight}`);

      // The jab's tip (world units from the fighter's centre) and Spider-Bot's half width.
      const box = CHARACTERS[punk].moves[MOVE.JAB].hits[0].boxes[0];
      const tip = box.x + box.r;
      const half = CHARACTERS[spider].width / 2;
      t.event('hurtbox-fit', `Spider-Bot hurtbox ${CHARACTERS[spider].width}x${CHARACTERS[spider].height} (was 100 wide); Exit Punk's jab reaches ${tip}`);
      t.metric('spiderBotHurtW', CHARACTERS[spider].width);

      const standing = () => {
        const f = me();
        return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      };
      const gap = () => Math.abs(dummy().x - me().x) / FX;
      const dir = () => (dummy().x >= me().x ? 1 : -1);
      /** Walks to a centre gap (stepping back if too close), lets go and stands still. */
      const approach = async (want: number) => {
        for (let i = 0; i < 6 && Math.abs(gap() - want) > 3; i++) {
          const d = gap() > want ? dir() : -dir();
          pad.stick(d * 100, 0);
          try {
            await t.until(() => (d === dir() ? gap() <= want + 2 : gap() >= want - 2), 12000, 'the fighter to reach the gap');
          } finally {
            pad.stick(0, 0);
          }
          await t.until(standing, 10000, 'the fighter to stand');
          await frames(6);
        }
      };
      const jab = async (): Promise<number> => {
        const before = dummy().percent;
        pad.button('attack', true);
        await frames(3);
        pad.button('attack', false);
        await frames(30);
        return dummy().percent - before;
      };

      // Face it first: a jab only reaches forward.
      pad.stick(dir() * 100, 0);
      await frames(4);
      pad.stick(0, 0);
      await approach(tip + half + 16);
      const missGap = gap();
      const missDmg = await jab();
      if (missDmg > 0) t.problem('bug', `a jab from ${missGap.toFixed(0)} units away (16 outside Spider-Bot's body) hit it: its hurtbox is wider than it looks`);
      t.event('hurtbox-near-miss', `jab from ${missGap.toFixed(0)} units (body edge ${half}, jab tip ${tip}): ${missDmg > 0 ? 'HIT' : 'visibly missed'}`);
      t.metric('nearMissHit', missDmg > 0 ? 1 : 0);
      t.progress(0.55);

      await approach(tip + half - 8);
      const hitGap = gap();
      const hitDmg = await jab();
      if (hitDmg <= 0) t.problem('bug', `a jab from ${hitGap.toFixed(0)} units away (8 inside Spider-Bot's body) missed`);
      t.event('hurtbox-hit', `jab from ${hitGap.toFixed(0)} units: ${hitDmg > 0 ? 'connected' : 'MISSED'}`);
      t.metric('closeJabHit', hitDmg > 0 ? 1 : 0);
      pad.release();
      await frames(30);
      t.finish();
    } finally {
      this.useTap = false;
      forceTouchUi(false);
    }
  }

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
      this.game.reactFxStats?.(true);
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
      this.reportAttackFx('specials');
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


  /**
   * CPU playstyles (ai/profiles.ts, docs/story.md "How the CPU fights"): Versus against a CPU while the player stands still
   * (on a phone: the touch overlay up, 390x844 turned to 844x390). Round 1 a rushdown CPU (Kaelen) must close the distance
   * within 3 s of GO; round 2 a zoner CPU (Exit Punk) keeps more room over the same 10 s. Events `cpu-style`, `cpu-close`,
   * `cpu-spacing`; metrics `rushCloseSeconds`, `rushAvgDistance`, `zonerAvgDistance`.
   */
  async cpuStylesRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('cpu-styles');
    }
    this.logViewport(touch && this.isPhone());
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const rounds = [
        { cpu: 'kaelen', label: 'rushdown' },
        { cpu: 'exit-punk', label: 'zoner' },
      ];
      const avg: Record<string, number> = {};
      for (const [ri, round] of rounds.entries()) {
        const foe = CHARACTERS.findIndex((c) => c.id === round.cpu);
        const mine = CHARACTERS.findIndex((c) => c.id === (round.cpu === 'kaelen' ? 'exit-punk' : 'wallit'));
        void this.game.startMatch({
          mode: 'versus', stage: stagesFor('versus')[0]?.index ?? 0, stocks: 3, rules: {},
          slots: [{ char: mine < 0 ? punk : mine, cpu: null }, { char: foe, cpu: 7 }],
        });
        await this.matchLive();
        // The player stands still: only the keyboard or the on-screen controls would move the fighter.
        this.manual = NO_INPUT;
        const match = () => this.game.match()!;
        const frame = () => this.game.match()?.state.frame ?? 0;
        const gap = () => {
          const fs = match().state.fighters;
          return Math.abs(fs[0].x - fs[1].x) / 1000;
        };
        const f0 = frame();
        const d0 = gap();
        t.event('cpu-style', `${round.label}: ${CHARACTERS[foe].name} is the CPU, style ${styleId(foe)}, ${Math.round(d0)} units away at GO`);
        let closed = -1;
        let sum = 0;
        let n = 0;
        const end = f0 + 10 * 60;
        await t.until(() => {
          const f = frame();
          if (f > f0 && closed < 0 && gap() < 170) closed = (f - f0) / 60;
          if (f > f0) { sum += gap(); n++; }
          return f >= end || !!match().state.over;
        }, 60000, 'ten seconds of the fight');
        avg[round.label] = n ? sum / n : 0;
        if (ri === 0) {
          if (closed < 0 || closed > 3) t.problem('bug', `the rushdown CPU did not close to a jab's reach within 3 s of GO (${closed < 0 ? 'never in 10 s' : closed.toFixed(1) + ' s'})`);
          else t.event('cpu-close', `rushdown CPU closed the distance ${closed.toFixed(1)} s after GO`);
          t.metric('rushCloseSeconds', closed < 0 ? 99 : closed);
          t.metric('rushAvgDistance', Math.round(avg[round.label]));
        } else t.metric('zonerAvgDistance', Math.round(avg[round.label]));
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
      }
      if (avg.zoner > avg.rushdown) t.event('cpu-spacing', `zoner CPU kept ${Math.round(avg.zoner)} units on average, rushdown ${Math.round(avg.rushdown)}`);
      else t.problem('bug', `the zoner CPU (${Math.round(avg.zoner)} units) did not keep more distance than the rushdown (${Math.round(avg.rushdown)})`);
    } finally {
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- archetype normals

  /**
   * Archetype normals (`sim/fighterDefs.ts` `applyArchetype`, content/archetypes.json): in Training a fast fighter (Kaelen) and a
   * heavy (Break) each walk up to a dummy and press Attack once, from real input (keyboard, or on a phone, 390x844 turned to
   * 844x390, the Attack button as a touch pointer event). The sim's own hit events are counted: the fast jab lands its three-hit
   * flurry from one press, the heavy's one hit comes later and launches harder; a fast and a floaty fighter's neutral air are
   * compared in the data. Events `archetype-jab`, `archetype-data`, `archetype-touch`; metrics `fastJabHits`, `heavyJabHits`,
   * `fastJabStartup`, `heavyJabStartup`.
   */
  async archetypeNormals(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('archetype-normals');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    try {
      const stage = stagesFor('training')[0]?.index ?? 0;
      const dummyChar = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const results: Record<string, { hits: number; startup: number; kb: number; arch: string }> = {};
      for (const [round, id] of [['fast', 'kaelen'], ['heavy', 'break']] as const) {
        const ix = CHARACTERS.findIndex((c) => c.id === id);
        if (ix < 0) {
          t.problem('bug', `${id} is not on the roster`);
          t.finish('error');
          return;
        }
        void this.game.startMatch({ mode: 'training', stage, stocks: 1, rules: {}, slots: [{ char: ix, cpu: null }, { char: dummyChar, cpu: 0 }] });
        await this.matchLive();
        this.manual = NO_INPUT;
        const match = () => this.game.match()!;
        const me = () => match().state.fighters[match().player];
        const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
        const frame = () => match().state.frame;
        const pad = touch ? makeTouchPad() : makeKeyboardPad();
        if (!pad) {
          t.problem('bug', 'the touch controls were not built');
          t.finish('error');
          return;
        }
        if (touch && round === 'fast') {
          const small: string[] = [];
          for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn')) {
            const r = b.getBoundingClientRect();
            if (r.width && (r.width < 44 || r.height < 44)) small.push(`${b.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          if (small.length) t.problem('bug', `touch buttons under 44 px: ${small.join(', ')}`);
          else t.event('archetype-touch', `Attack is the same button for every archetype (${document.querySelectorAll('.touch .touch-btn').length} on the overlay, ${innerWidth}x${innerHeight}); nothing new`);
        }
        const c = CHARACTERS[ix];
        const reach = Math.max(...c.moves[MOVE.JAB].hits.flatMap((w) => w.boxes.map((b) => b.x))) * 0.5;
        // Walk up to the dummy with the stick until it is close, then stand still.
        await t.until(() => me().grounded > 0 && me().action === ACT.IDLE, 12000, 'the fighter to stand');
        const toward = () => (dummy().x >= me().x ? 1 : -1);
        for (let i = 0; i < 400 && Math.abs(dummy().x - me().x) / FX > reach + 10; i++) {
          pad.stick(toward() * 100, 0);
          await t.wait(40);
        }
        pad.stick(0, 0);
        await t.until(() => me().action === ACT.IDLE || me().action === ACT.WALK, 3000, 'the fighter to stop');
        await t.wait(250);
        // One press of Attack, from a still stick, facing the dummy.
        const before = dummy().percent;
        let hits = 0;
        let last = before;
        let startup = -1;
        const f0 = frame();
        pad.button('attack', true);
        await t.wait(70);
        pad.button('attack', false);
        const end = f0 + c.moves[MOVE.JAB].total + 30;
        while (frame() < end) {
          if (me().action === ACT.ATTACK && startup < 0 && dummy().percent > last) startup = me().frame;
          if (dummy().percent > last) {
            hits++;
            last = dummy().percent;
          }
          await t.wait(16);
        }
        const hitboxes = c.moves[MOVE.JAB].hits;
        const kb = Math.max(...hitboxes.flatMap((w) => w.boxes.map((b) => b.kbg)));
        const first = Math.min(...hitboxes.map((w) => w.start));
        results[round] = { hits, startup: first, kb, arch: c.archetype };
        t.event('archetype-jab', `${how}: ${c.name} (${c.archetype}) one Attack press: ${hits} hit${hits === 1 ? '' : 's'} on the dummy, first hitbox on frame ${first}, ${hitboxes.length} hit window${hitboxes.length === 1 ? '' : 's'}, launch growth ${kb}`);
        t.metric(round === 'fast' ? 'fastJabHits' : 'heavyJabHits', hits);
        t.metric(round === 'fast' ? 'fastJabStartup' : 'heavyJabStartup', first);
        pad.release();
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
        t.progress(round === 'fast' ? 0.45 : 0.85);
      }
      const f = results.fast, h = results.heavy;
      if (f.hits < 3) t.problem('bug', `${how}: the fast jab landed ${f.hits} hits from one Attack press (want 3)`);
      if (h.hits < 1) t.problem('bug', `${how}: the heavy jab hit nothing from one Attack press`);
      if (h.startup <= f.startup) t.problem('bug', `a heavy's jab starts on frame ${h.startup}, not later than the fast one's (${f.startup})`);
      if (h.kb <= f.kb) t.problem('bug', 'a heavy\'s jab does not launch harder than the fast one\'s');
      // The data side: every fighter has an archetype, and floaty aerials hang out longer than fast ones.
      const active = (ch: (typeof CHARACTERS)[number]) => Math.max(...ch.moves[MOVE.NAIR].hits.map((w) => w.end)) - Math.min(...ch.moves[MOVE.NAIR].hits.map((w) => w.start)) + 1;
      const floaty = CHARACTERS.filter((ch) => ch.archetype === 'floaty'), fast = CHARACTERS.filter((ch) => ch.archetype === 'fast');
      const minF = Math.min(...floaty.map(active)), maxQ = Math.max(...fast.map(active));
      if (minF > maxQ && CHARACTERS.every((ch) => ch.archetype)) t.event('archetype-data', `every fighter has an archetype (${['heavy', 'floaty', 'fast', 'standard'].map((a) => `${a} ${CHARACTERS.filter((ch) => ch.archetype === a).length}`).join(', ')}); floaty neutral air stays out ${minF}+ frames, fast ${maxQ} at most`);
      else t.problem('bug', `archetype data: floaty neutral air ${minF}, fast ${maxQ}`);
    } finally {
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- ledge options

  /**
   * The ledge is a choice (`sim/step.ts` "The ledge is a choice", docs/ledge.md): in Training Exit Punk walks off the stage
   * edge (the sim grabs the ledge by itself), then each option is played from real input: stick up (getup), Shield (roll, a
   * body-length further in), Attack (a low sweep that hits a dummy stood at the edge, setup shortcut), Jump (a higher leap) and
   * finally nothing at all until the hang runs out and the fighter drops. Keyboard, or on a phone (390x844 turned to 844x390)
   * the on-screen stick, Attack, Shield and Jump buttons, with no new button. The All controls page lists the options.
   * Events `ledge-hold`, `ledge-getup`, `ledge-roll`, `ledge-attack`, `ledge-jump`, `ledge-drop`, `ledge-controls`,
   * `ledge-touch`; metrics `ledgeOptions` (how many worked), `ledgeHangFrames`.
   */
  async ledgeOptions(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('ledge-options');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const chosen: { option: string; id: number; frame: number }[] = [];
    const onLedge = (ev: Event) => chosen.push((ev as CustomEvent<{ option: string; id: number; frame: number }>).detail);
    window.addEventListener('dod:ledge', onLedge);
    try {
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      if (punk < 0) {
        t.problem('bug', 'Exit Punk is not on the roster');
        t.finish('error');
        return;
      }
      const stage = stagesFor('training')[0]?.index ?? 0;
      // Setup shortcut: straight into Training, no menus.
      void this.game.startMatch({
        mode: 'training', stage, stocks: 1, rules: {},
        slots: [{ char: punk, cpu: null }, { char: (punk + 1) % CHARACTERS.length, cpu: 0 }],
      });
      await this.matchLive();
      this.manual = NO_INPUT;
      t.progress(0.08);

      const match = () => this.game.match()!;
      const me = () => match().state.fighters[match().player];
      const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 8000 + n * 150, 'frames to pass');
      };
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls (stick, Attack, Shield, Jump) were not built');
        t.finish('error');
        return;
      }
      if (touch) {
        t.event('phone-shot', `training with the touch overlay at ${innerWidth}x${innerHeight}: the ledge options use the stick, Attack, Shield and Jump`);
        const small: string[] = [];
        for (const b of document.querySelectorAll<HTMLElement>('.touch .touch-btn')) {
          const r = b.getBoundingClientRect();
          if (r.width && (r.width < 44 || r.height < 44)) small.push(`${b.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        if (small.length) t.problem('bug', `touch buttons under 44 px: ${small.join(', ')}`);
        else t.event('ledge-touch', `Attack, Shield and Jump are the same buttons as everywhere else, no new buttons (${document.querySelectorAll('.touch .touch-btn').length} on the overlay)`);
      }
      const standing = () => {
        const f = me();
        return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      };
      const settle = async () => {
        pad.release();
        await t.until(standing, 12000, 'the fighter to stand');
        await frames(8);
      };
      const sideOf = () => (me().x >= 0 ? 1 : -1);
      /** The ledge the fighter is hanging on: where it is, and which side of the stage. */
      const held = () => ledges(STAGES[stage])[me().ledge - 1];

      /** Walks off the nearer stage edge; the sim catches the ledge. Real input: the stick, then let go. */
      const toLedge = async (): Promise<boolean> => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          await settle();
          const dir = sideOf();
          pad.stick(dir * 100, 0);
          try {
            await t.until(() => !me().grounded || me().action === ACT.DEAD, 25000, 'the fighter to walk off the edge');
          } finally {
            pad.stick(0, 0);
          }
          try {
            await t.until(() => me().action === ACT.LEDGE || me().grounded > 0 || me().action === ACT.DEAD, 4000, 'the ledge grab');
          } catch (e) {
            if (String(e).includes('stopped')) throw e;
          }
          if (me().action === ACT.LEDGE) return true;
          t.event('ledge-retry', `${how}: attempt ${attempt} did not catch the ledge (${ACT_NAMES[me().action]}); walking off again`);
        }
        return false;
      };
      const results = new Map<string, boolean>();
      const fail = (option: string, why: string) => {
        results.set(option, false);
        t.problem('bug', `${how}: ledge ${option}: ${why}`);
      };
      const optionSince = (option: string, since: number) => chosen.some((c) => c.option === option && c.id === me().id && c.frame >= since);
      const w = () => bodySize(me())[0];
      const insideBy = (l: { x: number; side: number }) => ((me().x - l.x * FX) * -l.side) / FX;

      // ---- 1. getup: stick up. The fighter keeps hanging until it chooses.
      if (!(await toLedge())) {
        t.problem('bug', `${how}: could not reach the ledge by walking off the stage`);
        t.finish('error');
        return;
      }
      let l = held();
      await frames(LEDGE_CHOOSE + 6);
      if (me().action === ACT.LEDGE) t.event('ledge-hold', `${how}: hanging on the ledge with no input for ${LEDGE_CHOOSE + 6} frames; nothing climbs by itself`);
      else fail('hold', `the fighter did not keep hanging with no input (${ACT_NAMES[me().action]})`);
      let at = frame();
      pad.stick(0, 100);
      await t.until(() => me().action !== ACT.LEDGE, 3000, 'the getup to start');
      // Held past the touch stick's flick window (a quick flick up is a jump), so this is a held stick up, the getup.
      await t.wait(260);
      pad.stick(0, 0);
      const climb = me();
      const getupInvuln = climb.intangible;
      if (climb.action !== ACT.LEDGE_CLIMB || !optionSince('getup', at)) fail('getup', `stick up did not start a getup (${ACT_NAMES[climb.action]})`);
      else {
        await t.until(standing, 6000, 'the getup to end on the stage');
        await frames(2);
        const inside = insideBy(l);
        if (inside <= 0 || inside > w() / FX) fail('getup', `stood ${Math.round(inside)} units inside the edge (body ${Math.round(w() / FX)})`);
        else {
          results.set('getup', true);
          t.event('ledge-getup', `${how}: ${touch ? 'stick up' : 'W'} climbed back on the stage (${Math.round(frame() - at)} frames, invincible ${getupInvuln} frames), standing ${Math.round(inside)} units inside the edge`);
        }
      }
      t.progress(0.25);

      // ---- 2. roll: Shield. Lands a body-length further in than the getup, invincible for most of it.
      if (!(await toLedge())) fail('roll', 'could not reach the ledge again');
      else {
        l = held();
        await frames(LEDGE_CHOOSE + 3);
        at = frame();
        pad.button('shield', true);
        await t.until(() => me().action !== ACT.LEDGE, 3000, 'the roll to start');
        pad.button('shield', false);
        const roll = me();
        const rollInvuln = roll.intangible;
        if (roll.action !== ACT.LEDGE_ROLL || !optionSince('roll', at)) fail('roll', `Shield did not roll onto the stage (${ACT_NAMES[roll.action]})`);
        else {
          await t.until(standing, 8000, 'the roll to end on the stage');
          await frames(2);
          const inside = insideBy(l);
          // The getup lands about half a body plus 6 units in; a roll lands a body further.
          if (inside < w() / FX) fail('roll', `landed ${Math.round(inside)} units inside the edge, less than a body-length (${Math.round(w() / FX)})`);
          else {
            results.set('roll', true);
            t.event('ledge-roll', `${how}: ${touch ? 'Shield' : 'L'} rolled onto the stage (${Math.round(frame() - at)} frames, invincible ${rollInvuln} frames), landing ${Math.round(inside)} units inside the edge (body ${Math.round(w() / FX)})`);
          }
        }
      }
      t.progress(0.4);

      // ---- 3. ledge attack: Attack. A low sweep that hits a fighter standing at the edge (setup shortcut: the dummy is put there).
      let swept = false;
      for (let attempt = 1; attempt <= 3 && !swept; attempt++) {
        if (!(await toLedge())) {
          fail('attack', 'could not reach the ledge again');
          break;
        }
        l = held();
        const d = dummy();
        d.x = l.x * FX - l.side * w();
        d.y = l.y * FX;
        d.vx = d.vy = 0;
        d.grounded = 1;
        d.platform = me().platform >= 0 ? me().platform : d.platform;
        const before = d.percent;
        await frames(LEDGE_CHOOSE + 3);
        at = frame();
        pad.button('attack', true);
        await t.until(() => me().action !== ACT.LEDGE, 3000, 'the ledge attack to start');
        pad.button('attack', false);
        const atk = me();
        const atkInvuln = atk.intangible;
        if (atk.action !== ACT.LEDGE_ATTACK || !optionSince('attack', at)) {
          fail('attack', `Attack did not start a ledge attack (${ACT_NAMES[atk.action]})`);
          break;
        }
        let sweepSeen = false;
        await t.until(() => {
          if (me().action === ACT.ATTACK && me().move === MOVE.DTILT) sweepSeen = true;
          return sweepSeen && me().action !== ACT.ATTACK;
        }, 6000, 'the sweep to finish');
        const dmg = dummy().percent - before;
        if (dmg > 0) {
          swept = true;
          results.set('attack', true);
          t.event('ledge-attack', `${how}: ${touch ? 'Attack' : 'J'} climbed and swept low (invincible ${atkInvuln} frames) and hit the fighter at the edge for ${(dmg / 10).toFixed(1)}%`);
        } else t.event('ledge-retry', `${how}: the ledge attack missed the dummy (attempt ${attempt}); trying again`);
        await settle();
      }
      if (!swept && !results.has('attack')) fail('attack', 'the sweep never hit a fighter standing at the edge');
      t.progress(0.55);

      // ---- 4. ledge jump: Jump. A higher leap off the ledge.
      if (!(await toLedge())) fail('jump', 'could not reach the ledge again');
      else {
        l = held();
        const hangY = me().y;
        await frames(LEDGE_CHOOSE + 3);
        at = frame();
        pad.button('jump', true);
        await t.until(() => me().action !== ACT.LEDGE, 3000, 'the ledge jump to start');
        pad.button('jump', false);
        const jump = me();
        const jumpInvuln = jump.intangible;
        if (jump.action !== ACT.LEDGE_JUMP || !optionSince('jump', at)) fail('jump', `Jump did not leap off the ledge (${ACT_NAMES[jump.action]})`);
        else {
          let top = me().y;
          await t.until(() => {
            top = Math.max(top, me().y);
            return me().vy <= 0;
          }, 4000, 'the top of the jump');
          const rise = Math.round((top - hangY) / FX);
          if (rise < 60 || top <= l.y * FX) fail('jump', `rose only ${rise} units (the top ${Math.round(top / FX)} vs the ledge ${l.y})`);
          else {
            results.set('jump', true);
            t.event('ledge-jump', `${how}: ${touch ? 'Jump' : 'Space'} leapt ${rise} units up and clear of the ledge (invincible ${jumpInvuln} frames)`);
          }
        }
      }
      t.progress(0.7);
      await settle();

      // ---- 5. the hang limit: no input at all, and the fighter lets go.
      if (!(await toLedge())) fail('drop', 'could not reach the ledge again');
      else {
        at = frame();
        let hung = 0;
        await t.until(() => {
          if (me().action === ACT.LEDGE) hung = frame() - at;
          return me().action !== ACT.LEDGE;
        }, 20000 + LEDGE_HANG_MAX * 150, 'the hang to run out');
        await frames(2);
        const fell = me().ledge === 0 && me().action !== ACT.LEDGE;
        if (!optionSince('drop', at) || !fell) fail('drop', `holding the ledge never dropped the fighter (${hung} frames, ${ACT_NAMES[me().action]})`);
        else if (hung < LEDGE_HANG_MAX - 5) fail('drop', `let go after only ${hung} frames (the limit is ${LEDGE_HANG_MAX})`);
        else {
          results.set('drop', true);
          t.metric('ledgeHangFrames', hung);
          t.event('ledge-drop', `${how}: holding the ledge with no input dropped the fighter after ${hung} frames (${(hung / 60).toFixed(1)} s)`);
        }
      }
      pad.release();
      await settle();
      t.metric('ledgeOptions', [...results.values()].filter(Boolean).length);
      t.progress(0.85);

      // ---- the All controls page lists the ledge options for every device.
      this.manual = null;
      await this.game.quitMatch();
      await this.screen('main');
      await this.click(() => this.q('#main .menu-item[data-go="controls"]'), 'All controls');
      await t.until(() => !!document.querySelector('#ctl-kb dt'), 6000, 'the controls lists');
      for (const [id, name] of [['ctl-kb', 'keyboard'], ['ctl-pad', 'gamepad'], ['ctl-touch', 'touch']] as const) {
        const row = [...document.querySelectorAll(`#${id} dt`)].find((e) => /ledge/i.test(e.textContent ?? ''));
        const text = row?.nextElementSibling?.textContent ?? '';
        const need = name === 'touch' ? ['Attack', 'Shield', 'Jump'] : name === 'keyboard' ? ['J', 'L', 'Space'] : ['jump'];
        if (!row || need.some((n) => !text.toLowerCase().includes(n.toLowerCase()))) t.problem('bug', `the All controls ${name} list has no complete "On the ledge" row ("${text}")`);
        else t.event('ledge-controls', `${name}: "${row.textContent}": ${text}`);
      }
      const close = document.getElementById('btn-controls-close');
      if (close) close.click();
    } finally {
      window.removeEventListener('dod:ledge', onLedge);
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- training combo

  /**
   * Training's combo readout and dummy options (Match.readout, main.ts updateReadout / wireTrainingOptions, ai/trainingDummy.ts).
   * Setup shortcut: straight into Training (Exit Punk vs Break, no menus). The readout sits top left clear of the pause button,
   * the timer and every touch control. Pause: the dummy's percent is set to 100 and read back from the sim, then Reset puts it at 0;
   * the dummy's behaviour is set to Jump, Shield, Stand and CPU (level raised) in turn, each seen in the sim. Then a true combo from
   * real input: the stick down plus Attack (down tilt) again and again lands a string while the dummy is still in hitstun, the
   * readout counting to 3 or more with the combo's damage and the last hit's. Every Pause control must be 44 px and on screen.
   * Keyboard on a desktop; at phone size (390x844, turned to 844x390 like ledge-options) the same through touch taps and the
   * on-screen stick and Attack button. Events `training-readout`, `training-percent`, `training-reset`, `training-dummy`,
   * `training-combo`, `training-fit`; metrics `trainingComboHits`, `trainingComboDamage`.
   */
  async trainingCombo(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('training-combo');
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
      const foe = CHARACTERS.findIndex((c) => c.id === 'break');
      if (punk < 0 || foe < 0) {
        t.problem('bug', 'Exit Punk or Break is not on the roster');
        t.finish('error');
        return;
      }
      const stage = stagesFor('training')[0]?.index ?? 0;
      void this.game.startMatch({
        mode: 'training', stage, stocks: 1, rules: {},
        slots: [{ char: punk, cpu: null }, { char: foe, cpu: 0 }],
      });
      await this.matchLive();
      this.manual = NO_INPUT;
      const match = () => this.game.match()!;
      const me = () => match().state.fighters[match().player];
      const dummy = () => match().state.fighters[match().dummySlot];
      const frame = () => this.game.match()?.state.frame ?? 0;
      const frames = async (n: number) => {
        const end = frame() + n;
        await t.until(() => frame() >= end, 8000 + n * 150, 'frames to pass');
      };
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the touch controls were not built');
        t.finish('error');
        return;
      }
      const vw = innerWidth;
      const vh = innerHeight;
      const rectOf = (el: Element) => el.getBoundingClientRect();
      const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;

      // ---- 1. the readout is up, on screen, clear of the controls.
      const readout = this.q('#training-readout');
      if (!visible(readout)) {
        t.problem('bug', `${how}: no combo readout on the Training screen`);
        t.finish('error');
        return;
      }
      const rr = rectOf(readout);
      const blockers = [...document.querySelectorAll<HTMLElement>('.touch-btn, .touch-stick, .touch-pause, #match-top, #hud .hud-card')].filter(visible);
      const hit = blockers.find((b) => overlap(rr, rectOf(b)));
      if (rr.left < 0 || rr.top < 0 || rr.right > vw || rr.bottom > vh) t.problem('bug', `${how}: the combo readout runs off the screen (${Math.round(rr.left)},${Math.round(rr.top)} ${Math.round(rr.width)}x${Math.round(rr.height)} in ${vw}x${vh})`);
      else if (hit) t.problem('bug', `${how}: the combo readout is under ${hit.className || hit.id}`);
      else t.event('training-readout', `${how}: readout top left at ${Math.round(rr.left)},${Math.round(rr.top)} (${Math.round(rr.width)}x${Math.round(rr.height)} in ${vw}x${vh}), clear of the pause button and the controls`);
      t.progress(0.1);

      // ---- 2. Pause: the options are there, every control 44 px, on screen.
      const openPause = async () => {
        const pauseBtn = () => (touch && visible(this.q('.touch-pause')) ? this.q('.touch-pause') : null);
        if (pauseBtn()) await this.tap(pauseBtn, 'Pause');
        else await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause' && visible(this.q('#training-options')), 4000, 'Pause with the Training options');
        await t.wait(300);
      };
      const closePause = async () => {
        await this.tap(() => this.q('#btn-resume'), 'Resume');
        await t.until(() => this.game.phase() === 'play', 4000, 'the match to resume');
      };
      await openPause();
      const small: string[] = [];
      const off: string[] = [];
      for (const b of document.querySelectorAll<HTMLElement>('#pause button')) {
        if (!visible(b)) continue;
        const r = rectOf(b);
        if (r.width < 44 || r.height < 44) small.push(`${b.textContent?.trim() || b.id} ${Math.round(r.width)}x${Math.round(r.height)}`);
        if (r.left < 0 || r.top < 0 || r.right > vw + 1 || r.bottom > vh + 1) off.push(`${b.textContent?.trim() || b.id}`);
      }
      const pausePanel = this.q('#pause .panel');
      const pr = pausePanel ? rectOf(pausePanel) : null;
      if (small.length) t.problem('bug', `${how}: Pause controls under 44 px: ${small.join(', ')}`);
      else if (off.length) t.problem('bug', `${how}: Pause controls off the screen: ${off.join(', ')}`);
      else if (pr && (pr.left < 0 || pr.top < 0 || pr.right > vw + 1 || pr.bottom > vh + 1)) t.problem('bug', `${how}: the Pause panel runs off the screen (${Math.round(pr.width)}x${Math.round(pr.height)} in ${vw}x${vh})`);
      else t.event('training-fit', `${how}: ${document.querySelectorAll('#pause button').length} Pause buttons, all at least 44x44, panel ${pr ? `${Math.round(pr.width)}x${Math.round(pr.height)}` : '?'} inside ${vw}x${vh}`);

      // ---- 3. the dummy's percent: set 100, then Reset.
      const pctBtn = (n: number) => () => this.q(`#to-percents button[data-percent="${n}"]`);
      await this.tap(pctBtn(100), 'Dummy 100%');
      if (dummy().percent !== 1000) t.problem('bug', `${how}: the 100% button left the dummy at ${dummy().percent / 10}%`);
      else t.event('training-percent', `${how}: the dummy was set to 100% from Pause (sim ${dummy().percent / 10}%)`);
      await this.tap(pctBtn(0), 'Dummy Reset');
      if (dummy().percent !== 0) t.problem('bug', `${how}: Reset left the dummy at ${dummy().percent / 10}%`);
      else t.event('training-reset', `${how}: Reset put the dummy back at 0%`);
      await closePause();
      t.progress(0.3);

      // ---- 4. the dummy's behaviour: Jump, Shield, Stand, CPU. Each is seen in the sim after Resume.
      const mode = async (id: string, seen: () => boolean, label: string, ms = 6000) => {
        await openPause();
        await this.tap(() => this.q(`#to-modes button[data-dummy="${id}"]`), `Dummy ${id}`);
        if (this.q(`#to-modes button[data-dummy="${id}"]`)?.getAttribute('aria-pressed') !== 'true') t.problem('bug', `${how}: ${id} is not marked as chosen`);
        if (id === 'cpu') {
          await this.tap(() => this.q('#to-level-up'), 'CPU level up');
          await this.tap(() => this.q('#to-level-up'), 'CPU level up');
          if (!/level 7/i.test(this.q('#to-level')?.textContent ?? '')) t.problem('bug', `${how}: the CPU level did not go up ("${this.q('#to-level')?.textContent}")`);
        }
        await closePause();
        try {
          await t.until(seen, ms, label);
          t.event('training-dummy', `${how}: dummy ${id}: ${label}`);
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', `${how}: dummy set to ${id} but ${label} never happened`);
        }
      };
      await mode('jump', () => dummy().grounded === 0, 'it jumped');
      await mode('shield', () => dummy().action === ACT.SHIELD, 'it shielded');
      await mode('stand', () => dummy().action === ACT.IDLE && dummy().grounded > 0, 'it stood');
      await mode('cpu', () => dummy().action !== ACT.IDLE, 'it acted as a CPU');
      // Back to a still dummy at 0% for the combo.
      await openPause();
      await this.tap(() => this.q('#to-modes button[data-dummy="stand"]'), 'Dummy stand');
      await this.tap(pctBtn(0), 'Dummy Reset');
      await closePause();
      t.progress(0.55);

      // ---- 5. a true combo: down tilt again and again, the dummy still in hitstun at each hit.
      const standing = () => {
        const f = me();
        return f.grounded > 0 && (f.action === ACT.IDLE || f.action === ACT.WALK || f.action === ACT.CROUCH);
      };
      let best = 0;
      let bestDmg = 0;
      let lastText = '';
      for (let attempt = 1; attempt <= 8 && best < 3; attempt++) {
        pad.release();
        await t.until(() => standing() && dummy().grounded > 0 && dummy().action !== ACT.HITSTUN, 12000, 'both fighters to stand');
        // Setup shortcut: stand the fighters 50 units apart facing each other (the hits are real input).
        const p = me();
        const d = dummy();
        p.x = d.x - 50 * FX;
        p.y = d.y;
        p.facing = 1;
        d.facing = -1;
        p.vx = 0;
        await frames(4);
        const start = frame();
        while (frame() - start < 6 * 19 && best < 3) {
          pad.stick(0, -100);
          pad.button('attack', true);
          await frames(3);
          pad.button('attack', false);
          await frames(16);
          const r = match().readout;
          if (r.count > best) {
            best = r.count;
            bestDmg = r.dmg;
            lastText = `${this.q('#training-readout .tr-count')?.textContent} ${this.q('#training-readout .tr-dmg')?.textContent} / last ${this.q('#training-readout .tr-last')?.textContent}`;
          }
        }
        pad.release();
        if (best < 3) t.event('training-retry', `${how}: attempt ${attempt} reached a ${best}-hit combo; trying again`);
      }
      if (best < 3) t.problem('bug', `${how}: the down tilt string never made a 3-hit true combo (best ${best})`);
      else {
        await frames(4);
        const shownCount = Number(this.q('#training-readout .tr-count')?.textContent);
        const shownDmg = this.q('#training-readout .tr-dmg')?.textContent ?? '';
        const shownLast = this.q('#training-readout .tr-last')?.textContent ?? '';
        if (shownCount < 3 || !/\d+\.\d%/.test(shownDmg) || shownDmg === '0.0%') t.problem('bug', `${how}: a ${best}-hit combo but the readout shows "${shownCount}" and "${shownDmg}"`);
        else if (!visible(this.q('#training-readout .tr-tag'))) t.problem('bug', `${how}: the readout does not say the ${best}-hit combo was true`);
        else t.event('training-combo', `${how}: ${best}-hit true combo (${touch ? 'stick down + Attack' : 'S + J'}); readout ${lastText}; after: ${shownCount} hits, combo ${shownDmg}, last hit ${shownLast}`);
      }
      t.metric('trainingComboHits', best);
      t.metric('trainingComboDamage', Math.round(bestDmg) / 10);
      pad.release();
    } finally {
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- special sounds

  /**
   * Special sounds (docs/specials.md "Sound"): each Season 1 fighter in Training fires its four specials from real
   * input (the keyboard, or with `input: "touch"` / a phone the on-screen stick and Special button at 844x390). Every
   * special must play its archetype's release (`special-<kind>-release`, logged as `dod:sound-take`) within 50 ms of the
   * move starting (`special-release`, metric `releaseLatencyMs`), with the fighter's accent on top
   * (`special-accent-<id>`, `special-accent`); impacts (`special-impact`) are logged when the dummy is hit. The run ends
   * by reporting which of the seven archetypes played a release and an impact (`archetype-pools`) and fails on a take
   * played twice in a row. Options: `fighter` (one id), `input`, `at`.
   */
  async specialSounds(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('special-sounds');
    }
    this.logViewport(touch && this.isPhone());
    const how = touch ? 'touch' : 'keyboard';
    const takes: { id: string; takeId: string; t: number }[] = [];
    const last = new Map<string, string>();
    const onTake = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; takeId: string; t: number };
      if (!d.id.startsWith('special-')) return;
      takes.push({ id: d.id, takeId: d.takeId, t: d.t });
      if (last.get(d.id) === d.takeId) t.problem('bug', `special sound take ${d.takeId} played twice in a row for ${d.id}`);
      last.set(d.id, d.takeId);
    };
    window.addEventListener('dod:sound-take', onTake);
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const release = new Set<string>();
    const impact = new Set<string>();
    const latencies: number[] = [];
    try {
      const ids = typeof this.options.fighter === 'string' ? [this.options.fighter] : SEASON_ONE;
      const stage = stagesFor('training')[0]?.index ?? 0;
      for (const [n, id] of ids.entries()) {
        const ci = CHARACTERS.findIndex((c) => c.id === id);
        if (ci < 0) {
          t.problem('bug', `special-sounds: ${id} is not on the roster`);
          continue;
        }
        const c = CHARACTERS[ci];
        void this.game.startMatch({
          mode: 'training', stage, stocks: 1, rules: {},
          slots: [{ char: ci, cpu: null }, { char: (ci + 1) % CHARACTERS.length, cpu: 0 }],
        });
        await this.matchLive();
        this.manual = NO_INPUT;
        const pad = touch ? makeTouchPad() : makeKeyboardPad();
        if (!pad) {
          t.problem('bug', 'the touch controls (stick and Special button) were not built');
          break;
        }
        const match = () => this.game.match()!;
        const me = () => match().state.fighters[match().player];
        const dummy = () => match().state.fighters.find((f) => f.id !== match().player)!;
        const frame = () => this.game.match()?.state.frame ?? 0;
        const frames = async (k: number) => {
          const end = frame() + k;
          await t.until(() => frame() >= end, 6000 + k * 150, 'frames to pass');
        };
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
        const slots = [
          { slot: 'neutral', sx: 0, sy: 0, move: MOVE.NSPECIAL },
          { slot: 'side', sx: 100, sy: 0, move: MOVE.SSPECIAL },
          { slot: 'up', sx: 0, sy: 100, move: MOVE.UPB },
          { slot: 'down', sx: 0, sy: -100, move: MOVE.DSPECIAL },
        ];
        for (const sl of slots) {
          await settle();
          // Close up on the dummy, facing it, so a melee special can land.
          const toward = () => (dummy().x >= me().x ? 1 : -1);
          pad.stick(toward() * 100, 0);
          try {
            await t.until(() => Math.abs(dummy().x - me().x) / FX < 70, 3000, 'the fighter to reach the dummy');
          } catch (e) {
            if (String(e).includes('stopped')) throw e;
          }
          pad.stick(0, 0);
          await frames(3);
          this.movesSeen.clear();
          this.moveStartMs.clear();
          const from = takes.length;
          pad.stick(sl.sx, sl.sy);
          await frames(3);
          pad.special(true);
          await frames(4);
          pad.special(false);
          try {
            await t.until(() => this.movesSeen.has(sl.move), 4000, `${id}'s ${sl.slot} special to come out`);
          } catch (e) {
            if (String(e).includes('stopped')) throw e;
          }
          pad.stick(0, 0);
          const mv = c.moves[sl.move];
          const kind = mv.kind ?? 'shared';
          if (!this.movesSeen.has(sl.move)) {
            t.problem('bug', `${how}: ${id}'s ${sl.slot} special "${mv.name}" did not come out`);
            continue;
          }
          // Let the hit land and the take play out.
          await frames(30);
          const got = takes.slice(from);
          const rel = got.find((x) => x.id === `special-${kind}-release`);
          const acc = got.find((x) => x.id === `special-accent-${id}`);
          const imp = got.find((x) => x.id === `special-${kind}-impact`);
          const start = this.moveStartMs.get(sl.move);
          if (!rel) t.problem('bug', `${how}: ${id}'s ${sl.slot} special "${mv.name}" (${kind}) played no release sound (pool special-${kind}-release)`);
          else {
            release.add(kind);
            const ms = start == null ? 0 : Math.round(Math.abs(rel.t - start));
            latencies.push(ms);
            t.event('special-release', `${how}: ${id} ${sl.slot} "${mv.name}" -> ${rel.id} / ${rel.takeId}, ${ms} ms after the move started`);
            if (ms > 50) t.problem('bug', `${how}: ${id}'s ${sl.slot} special release sound came ${ms} ms after the move started (want 50 ms)`);
          }
          if (!acc) t.problem('bug', `${how}: ${id}'s ${sl.slot} special played no signature accent (special-accent-${id})`);
          else t.event('special-accent', `${id} ${sl.slot}: ${acc.id} / ${acc.takeId} on top of the ${kind} release`);
          if (imp) {
            impact.add(kind);
            t.event('special-impact', `${id} ${sl.slot} "${mv.name}": ${imp.id} / ${imp.takeId}`);
          }
        }
        pad.release();
        this.manual = null;
        await this.game.quitMatch();
        await this.screen('main');
        t.progress((n + 1) / ids.length);
      }
      const kinds = ['projectile', 'dash', 'counter', 'grab', 'trap', 'flurry', 'recovery'];
      if (typeof this.options.fighter !== 'string') {
        t.event('archetype-pools', `release: ${kinds.filter((k) => release.has(k)).join(', ') || 'none'}; impact: ${kinds.filter((k) => impact.has(k)).join(', ') || 'none'}`);
        for (const k of kinds) {
          if (!release.has(k)) t.problem('bug', `no ${k} special played its own release sound`);
          if (!impact.has(k)) t.problem('warning', `no ${k} special landed on the dummy with its own impact sound (a counter needs a hit to turn back)`);
        }
      }
      if (latencies.length) t.metric('releaseLatencyMs', Math.max(...latencies));
      t.metric('specialTakes', takes.length);
    } finally {
      window.removeEventListener('dod:sound-take', onTake);
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- fast-start
  /** The title answers at once: Press start (a touch tap on a phone) shows the main menu within 1 s; the first-load chunks it ran on are logged. */
  async fastStart(): Promise<void> {
    const t = this.t;
    await this.screen('title', 30000);
    await this.tapToPlay();
    const loaded = performance.getEntriesByType('resource').filter((e) => /\.js(\?|$)/.test(e.name));
    const bytes = loaded.reduce((n, e) => n + ((e as PerformanceResourceTiming).transferSize || 0), 0);
    t.event('first-load', `${loaded.length} script files, ${Math.round(bytes / 1024)} KB transferred before Press start`);
    t.metric('firstLoadScriptKB', Math.round(bytes / 1024));
    await t.wait(300);
    // The boot line (Game/index.html inline script, src/game/boot.ts): real steps, never still for 5 s, above the safe area.
    const boot = (window as unknown as { __dodBoot?: { isReady: boolean; software: boolean } }).__dodBoot;
    const bootLine = this.q('#boot-progress');
    if (!boot) t.problem('bug', 'the boot line (window.__dodBoot) is missing');
    else t.event('boot-state', `ready ${boot.isReady}, software renderer ${boot.software}`);
    if (bootLine && !bootLine.hidden) {
      const r = bootLine.getBoundingClientRect();
      const safe = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom') || '0') || 0;
      t.event('boot-line', `bottom ${Math.round(innerHeight - r.bottom)} px above the edge, text "${bootLine.textContent?.trim()}"`);
      if (r.bottom > innerHeight - safe || r.left < 0 || r.right > innerWidth) t.problem('bug', 'the boot line is off the screen or under the safe area');
    }
    const at = performance.now();
    // The press must answer within 100 ms: the pressed look (data-pressed / .starting) or the screen already changing.
    const btn = this.q('#btn-start');
    let respondedMs = -1;
    const watch = setInterval(() => {
      if (respondedMs < 0 && (btn?.dataset.pressed !== undefined || btn?.classList.contains('starting') || document.body.dataset.screen !== 'title')) {
        respondedMs = Math.round(performance.now() - at);
      }
    }, 8);
    await this.tap(() => this.q('#btn-start'), 'Press start');
    clearInterval(watch);
    t.metric('pressRespondMs', respondedMs);
    t.event('press-response', respondedMs < 0 ? 'no visible response' : `Press start showed a response ${respondedMs} ms after the press (the tap itself holds 60 ms before release)`);
    if (respondedMs < 0 || respondedMs > 100) t.problem('bug', `Press start gave no visible response within 100 ms (${respondedMs} ms)`);
    await this.screen('main', 5000);
    const ms = Math.round(performance.now() - at);
    t.metric('pressStartMs', ms);
    t.event('press-start', `Press start answered with the main menu in ${ms} ms`);
    if (ms > 1000) t.problem('bug', `Press start took ${ms} ms to answer (1000 wanted)`);
    // Boot steps seen (dod:boot events are kept by the page's own log), and the no-WebGL line: shown by hand, measured, put away.
    const state = (window as unknown as { __dodBoot?: { fail(m: string): void; failed: boolean } }).__dodBoot;
    const line = this.q('#boot-progress');
    if (state && line) {
      line.hidden = false;
      line.classList.remove('done');
      state.fail('Graphics (WebGL) are not available in this browser.');
      await t.wait(100);
      const msg = line.querySelector<HTMLElement>('.boot-msg');
      const retry = line.querySelector<HTMLElement>('.boot-retry');
      const rr = retry?.getBoundingClientRect();
      const mr = msg?.getBoundingClientRect();
      const oneLine = !!mr && mr.height <= parseFloat(getComputedStyle(msg!).lineHeight || '24') * 1.6 + 4;
      t.event('webgl-message', `message "${msg?.textContent}" one line ${oneLine}, Retry ${Math.round(rr?.width ?? 0)}x${Math.round(rr?.height ?? 0)} px`);
      if (!rr || rr.height < 44 || rr.width < 44) t.problem('bug', 'the Retry button is under 44 px');
      line.hidden = true;
      line.querySelector<HTMLElement>('.boot-fail')!.hidden = true;
      state.failed = false;
    }
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
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    // On a portrait phone (390x844 touch), check the portrait menus have no horizontal scroll or unclickable buttons, then turn to 844x390 landscape for the match.
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      this.useTap = true;
      forceTouchUi(true);
      try {
        await this.toMainMenu();
        await this.phoneUiClipTour('portrait');
        t.progress(0.04);
      } finally {
        this.useTap = false;
        forceTouchUi(false);
      }
      return this.touchMatchTurned('hit-feel');
    }
    this.logViewport(touch && (this.isPhone() || this.options.at === 'phone-turned'));
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    // Check that every special and smash across all 33 fighters has a startup wind-up tell (flash + pose change).
    {
      const tellMoveIds = [MOVE.FSMASH, MOVE.USMASH, MOVE.DSMASH, MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL];
      let checkedMoves = 0;
      let missingTells = 0;
      for (const ch of CHARACTERS) {
        for (const mid of tellMoveIds) {
          const mv = ch.moves[mid];
          const start = moveStartFrame(mv);
          const tf = tellFrames(start);
          const wp = windupPose(Math.max(0, start - 1), start, mid, 1);
          const posed = wp.sx !== 1 || wp.sy !== 1 || wp.rot !== 0;
          if (start <= 0 || tf <= 0 || wp.flash <= 0.3 || !posed) missingTells++;
          else checkedMoves++;
        }
      }
      t.metric('windupTellMoves', checkedMoves);
      t.metric('specials.total', CHARACTERS.length * tellMoveIds.length);
      t.metric('specials.withTell', checkedMoves);
      if (missingTells > 0) t.problem('bug', `${missingTells} specials or smashes in the roster are missing a startup wind-up flash or pose change`);
      else t.event('windup-tell-roster', `all ${checkedMoves} specials and smashes across ${CHARACTERS.length} fighters have a startup wind-up flash and coiled pose tell`);
    }
    const original = localStorage.getItem(SHAKE_STORAGE_KEY);
    try {
      localStorage.removeItem(SHAKE_STORAGE_KEY);
    } catch {
      // Storage blocked.
    }
    // Impact sound per weight and the kill sting, read from the audio's own take log (dod:sound-take).
    const hitSounds = new Map<string, Set<string>>();
    let stingTakes = 0;
    const onHitSound = (ev: Event) => {
      const d = (ev as CustomEvent<{ id: string; takeId: string; rate: number }>).detail;
      if (!d) return;
      if (d.id === 'hit-light' || d.id === 'hit-medium' || d.id === 'hit-heavy') {
        if (!hitSounds.has(d.id)) {
          t.event('hit-sound', `${d.id} plays take ${d.takeId} (rate ${d.rate.toFixed(3)})`);
          hitSounds.set(d.id, new Set());
        }
        hitSounds.get(d.id)!.add(d.takeId);
      } else if (d.id === 'kill-sting') {
        stingTakes++;
        t.event('kill-sting', `kill sting ${d.takeId} (rate ${d.rate.toFixed(3)})`);
      }
    };
    window.addEventListener('dod:sound-take', onHitSound);
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
    let tagMissing = 0;
    let tagProblems = 0;
    let tagFrames = 0;
    const tagLogged = new Set<number>();
    const tagBubbleLogged = new Set<number>();
    const phaseIsPlay = () => !!this.game.match();
    let windupTellsLogged = 0;
    let windupDodges = 0;
    let cpuWindup: { move: number; name: string; frame: number; char: number; dodged: boolean } | null = null;
    const touchUi = touch || touchDevice();
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
      // Name tags: every fighter shows one (on the stage over the head, or on its edge bubble with the same text), at least 12 px
      // tall, inside the window, clear of the touch controls.
      const ts = this.game.tagStats?.();
      const mt = this.game.match();
      if (ts && mt && phaseIsPlay()) {
        const bubbles = new Map(ms.rects.map((b) => [b.id, b.tag ?? '']));
        for (const f of mt.state.fighters) {
          if (f.stocks <= 0 || f.action === ACT.DEAD) continue;
          const tg = ts.rects.find((q) => q.id === f.id);
          if (!tg && !bubbles.has(f.id)) { tagMissing++; continue; }
          if (!tg) { if (!bubbles.get(f.id)) tagMissing++; else if (!tagBubbleLogged.has(f.id)) { tagBubbleLogged.add(f.id); t.event('tag-bubble', `fighter ${f.id}'s edge bubble shows the tag "${bubbles.get(f.id)}"`); } continue; }
          const r = tg.rect;
          if (!tagLogged.has(f.id)) { tagLogged.add(f.id); t.event('tag', `fighter ${f.id} shows the tag "${tg.text}" (${Math.round(r.r - r.l)}x${Math.round(r.b - r.t)} px, font ${tg.fontPx}px${touchUi ? ', phone layout' : ''})`); }
          const under = blockers.find((b) => overlap(r, { l: b.left, t: b.top, r: b.right, b: b.bottom }));
          if (r.b - r.t < 12 || r.r - r.l < 12 || r.l < 0 || r.t < 0 || r.r > innerWidth || r.b > innerHeight || under) {
            tagProblems++;
            if (tagProblems <= 3) t.problem('bug', `the tag "${tg.text}" (${Math.round(r.l)},${Math.round(r.t)} to ${Math.round(r.r)},${Math.round(r.b)}) is ${under ? 'under a control' : 'too small or off the window'}${touchUi ? ' on the phone layout' : ''}`);
          }
        }
        tagFrames++;
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
      // Track CPU wind-up tells (flash + pose change) and player dodges in response.
      const me = m.state.fighters[m.player];
      for (const f of m.state.fighters) {
        if (f.id === m.player) continue;
        if (f.action === ACT.ATTACK && (isSmashMove(f.move) || isSpecialMove(f.move))) {
          const mv = CHARACTERS[f.char].moves[f.move];
          const start = moveStartFrame(mv);
          if (inWindupTell(f.action, f.move, f.frame, start)) {
            if (!cpuWindup || cpuWindup.move !== f.move || m.state.frame - cpuWindup.frame > 20) {
              cpuWindup = { move: f.move, name: mv.name, frame: m.state.frame, char: f.char, dodged: false };
              if (windupTellsLogged < 4) {
                windupTellsLogged++;
                const wp = windupPose(f.frame, start, f.move, f.facing);
                t.event('windup-tell', `CPU ${CHARACTERS[f.char].name} wind-up tell on "${mv.name}" (${start}-frame startup: flash ${wp.flash.toFixed(2)}, pose ${wp.sx.toFixed(2)}x${wp.sy.toFixed(2)}, tilt ${wp.rot.toFixed(2)} rad)`);
              }
            } else {
              cpuWindup.frame = m.state.frame;
            }
          }
        }
      }
      if (cpuWindup && !cpuWindup.dodged && m.state.frame - cpuWindup.frame <= 24 && me) {
        const counter = me.action === ACT.ATTACK && !!CHARACTERS[me.char].moves[me.move].counter;
        if (me.action === ACT.ROLL || me.action === ACT.SPOTDODGE || me.action === ACT.AIRDODGE || me.action === ACT.SHIELD || counter) {
          cpuWindup.dodged = true;
          windupDodges++;
          if (windupDodges <= 4) {
            t.event('windup-dodge', `player read CPU ${CHARACTERS[cpuWindup.char].name}'s "${cpuWindup.name}" wind-up tell and dodged (${counter ? 'counter' : (ACT_NAMES[me.action] ?? 'dodge')})`);
          }
        }
      }
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
      this.checkClipping('main menu', this.q('#main'));
      if (document.documentElement.scrollWidth > innerWidth + 1) {
        t.problem('bug', `horizontal scrolling on main menu (${document.documentElement.scrollWidth} > ${innerWidth})`);
      }
      t.progress(0.05);
      // Screen shake is on by default, and Settings shows it.
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
      this.checkClipping('Settings', this.q('#settings'));
      const sw = this.q('#shake-level') as HTMLInputElement | null;
      if (!sw) t.problem('bug', 'Settings has no Screen shake slider');
      else if (reduceMotion()) t.event('shake-default', `Reduce motion is on in this browser: Screen shake defaults to ${sw.value}%`);
      else if (Number(sw.value) !== 100 || !screenShake()) t.problem('bug', 'Screen shake is not at 100% by default');
      else t.event('shake-default', 'Settings shows Screen shake: 100%');
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);

      await this.startVersus(3);
      if (touch) {
        const root = touchOverlay() ?? this.q('.touch');
        if (root && root.hidden) root.hidden = false;
        document.body.classList.add('touch-ui');
      }
      t.progress(0.15);
      this.game.reactFxStats?.(true);
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
          const oldX = foe.x;
          const oldY = foe.y;
          foe.x = (b.right - 20) * FX;
          foe.y = Math.max(b.bottom + 200, foe.y / FX) * FX;
          foe.vx = foe.vy = foe.kbx = foe.kby = 0;
          t.event('marker-setup', `setup shortcut: fighter ${foe.id} placed 20 units inside the right blast line`);
          await t.wait(900);
          if (foe.stocks > 0 && foe.action !== ACT.DEAD) {
            foe.x = oldX;
            foe.y = oldY;
            foe.vx = foe.vy = foe.kbx = foe.kby = 0;
          }
        }
      }
      t.metric('tagFrames', tagFrames);
      t.metric('tagMissing', tagMissing);
      if (tagFrames > 0 && tagMissing > tagFrames * 0.05) t.problem('bug', `a fighter had no name tag (on the stage or on its edge bubble) in ${tagMissing} checks over ${tagFrames} frames`);
      if (!this.game.markerStats?.()?.shown) t.problem('warning', 'no fighter went off screen, so no edge marker was seen (the kill cue usually shows one)');
      else t.metric('markersShown', this.game.markerStats!()!.shown);
      // Ensure at least one wind-up tell dodge was observed; if the CPU only threw normals in the window, stage one close CPU smash so the bot reads the wind-up tell and dodges it live.
      if (windupDodges === 0 && m0()) {
        const mm = m0()!;
        const me = mm.state.fighters[mm.player];
        const foe = mm.state.fighters.find((f) => f.id !== mm.player);
        if (me && foe && me.stocks > 0 && foe.stocks > 0) {
          const p = STAGES[mm.state.stage].platforms[0];
          const cx = ((p.x1 + p.x2) / 2) * FX;
          me.x = cx - 45 * FX;
          me.y = p.y * FX;
          me.vx = me.vy = me.kbx = me.kby = 0;
          me.grounded = 1;
          me.action = ACT.IDLE;
          me.frame = 0;
          me.facing = 1;
          foe.x = cx + 45 * FX;
          foe.y = p.y * FX;
          foe.vx = foe.vy = foe.kbx = foe.kby = 0;
          foe.grounded = 1;
          foe.facing = -1;
          foe.action = ACT.ATTACK;
          foe.move = MOVE.FSMASH;
          foe.frame = 0;
          await this.fight(() => windupDodges > 0, 2500);
        }
      }
      t.metric('windupDodges', windupDodges);
      if (windupDodges === 0) t.problem('bug', 'the player never dodged a CPU special or smash wind-up tell');
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
      const pauseBtn = () => {
        const el = this.q('.touch-pause');
        return el && el.getClientRects().length > 0 ? el : null;
      };
      if (touch && pauseBtn()) await this.tap(pauseBtn, 'Pause');
      else await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      this.checkClipping('Pause menu', this.q('#pause'));
      await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      await t.until(settingsShowing, 3000, 'Settings to open from Pause');
      await t.wait(400);
      {
        const sl = this.q('#shake-level') as HTMLInputElement | null;
        if (sl) {
          sl.value = '0';
          sl.dispatchEvent(new Event('input', { bubbles: true }));
          sl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (screenShake() || (this.q('#shake-level') as HTMLInputElement | null)?.value !== '0' || localStorage.getItem(SHAKE_STORAGE_KEY) !== '0') {
        t.problem('bug', 'Screen shake 0% did not apply and save');
      } else t.event('shake-off', 'Screen shake set to 0% in Settings (saved as dod.shake=0)');
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
      const rx = this.game.reactFxStats?.();
      if (rx) {
        t.metric('squashFrames', rx.squashFrames);
        t.metric('tumbleFrames', rx.tumbleFrames);
        if (rx.squashes > 0 && rx.squashFrames >= 2) t.event('squash', `${rx.squashes} hits squashed the victim (up to ${(rx.maxSquash * 100).toFixed(0)}%) for ${rx.squashFrames} frames`);
        else t.problem('bug', 'hits landed but the victim never squashed');
        if (rx.tumbleFrames > 0) t.event('tumble', `launches spun the victim for ${rx.tumbleFrames} frames of hit-stun`);
        if (rx.bounces > 0) t.event('bounce', `${rx.bounces} ground bounces with ${rx.dustBursts} dust bursts`);
        if (rx.smashSmears > 0) t.event('smear', `${rx.smears} smears, ${rx.smearFrames} streak frames (${rx.smashSmears} on smashes), ${rx.charges} smash charges (${rx.quality} quality)`);
        else if (rx.quality === 'low') t.event('smear-low', 'Low drops smears, keeps squash and tumble');
      }
      window.removeEventListener('dod:sound-take', onHitSound);
      t.metric('hitSoundWeights', hitSounds.size);
      t.metric('killStings', stingTakes);
      if (hitSounds.size < 2) t.problem('bug', `only ${hitSounds.size} hit weight(s) made an impact sound in this fight`);
      if (stingTakes === 0) t.problem('warning', 'no kill sting played in this fight (no KO?)');
      this.reportAttackFx('hit-feel');
      {
        const r2 = this.game.reactFxStats?.();
        if (r2 && !(r2.shieldRipples + r2.parryFlashes + r2.clashSparks)) t.problem('warning', 'no shielded hit, parry or clash happened in this fight, so their looks were not seen');
      }
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
          if (lc && !reduceMotion() && !(lc.zoom && lc.slow && lc.whistle)) t.problem('bug', 'a kill cue was missing its zoom, slow motion or whistle');
          if (lc && !reduceMotion() && lc.punch <= 0.2) t.problem('bug', 'the kill cue did not punch the camera in');
          if (lc && cam.killCues > 0 && !screenShake() && lc.shake > 0) t.problem('bug', 'the kill cue shook the camera with Screen shake off');
          else if (lc && !screenShake()) t.event('kill-cue-no-shake', `with Screen shake off the kill cue still zoomed (punch ${lc.punch.toFixed(2)}) and the shake was ${lc.shake}`);
        }
      }
      t.progress(0.9);

      // Back on for the next visit, then out.
      if (touch && pauseBtn()) await this.tap(pauseBtn, 'Pause');
      else await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
    } finally {
      unwatch();
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
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

  // ---------------------------------------------------------- rumble

  /**
   * Rumble (rumble.ts): Settings has a Rumble switch (on by default, 44 px tall); in a versus match each light, heavy and KO
   * the player lands or takes sends its own pulse (logged `rumble` with strength and length, different per tier), and from
   * Pause turning Rumble off sends no more rumble and no phone vibrate. A phone (390x844, turned to 844x390) plays it by taps.
   * The pad's actuator and the phone's vibrator are counted at the browser call (navigator.vibrate is wrapped here).
   */
  async rumbleRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      this.useTap = true;
      forceTouchUi(true);
      try {
        await this.toMainMenu();
        await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
        await t.until(settingsShowing, 3000, 'Settings to open');
        this.checkClipping('Settings (portrait)', this.q('#settings'));
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.wait(300);
      } finally {
        this.useTap = false;
        forceTouchUi(false);
      }
      return this.touchMatchTurned('rumble');
    }
    this.logViewport(touch && (this.isPhone() || this.options.at === 'phone-turned'));
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const original = localStorage.getItem(TOUCH_KEY);
    try {
      localStorage.removeItem(TOUCH_KEY);
    } catch {
      // Storage blocked.
    }
    // Count the browser's own vibrate calls.
    let vibrateCalls = 0;
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    const hadOwn = Object.prototype.hasOwnProperty.call(nav, 'vibrate');
    const realVibrate = nav.vibrate?.bind(navigator);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: (p: number | number[]) => { vibrateCalls++; return realVibrate ? realVibrate(p) : true; } });
    let hits = 0;
    const unwatch = this.game.watch((m, events) => {
      for (const e of events) if (e.type === 'hit' && !e.shield && (e.attacker === m.player || e.victim === m.player)) hits++;
    });
    const m0 = () => this.game.match();
    const logged = (r: RumbleSent) => t.event('rumble', `${r.kind}: ${r.ms} ms, strong ${r.strong}, weak ${r.weak}${r.calm ? ' (calm limits)' : ''}; pad ${r.pad ? 'rumbled' : 'none'}, phone ${r.phone ? 'vibrated' : 'no vibrator'}`);
    try {
      await this.toMainMenu();
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
      this.checkClipping('Settings', this.q('#settings'));
      const sw = this.q('#rumble-switch');
      const h = sw?.getBoundingClientRect().height ?? 0;
      if (!sw) t.problem('bug', 'Settings has no Rumble switch');
      else if (sw.getAttribute('aria-checked') !== 'true' || !touchSettings().vibrate) t.problem('bug', 'Rumble is not on by default');
      else if (h < 44) t.problem('bug', `the Rumble switch is only ${Math.round(h)} px tall`);
      else t.event('rumble-default', `Settings shows Rumble: On (${Math.round(h)} px tall)`);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);
      t.progress(0.1);

      await this.startVersus(3);
      if (touch) {
        const root = touchOverlay() ?? this.q('.touch');
        if (root && root.hidden) root.hidden = false;
        document.body.classList.add('touch-ui');
      }
      const start = rumbleLog.length;
      vibrateCalls = 0;
      this.progressNow = () => 0.1 + 0.5 * Math.min(1, ((m0()?.state.frame ?? 0) / (90 * 60)));
      const kinds = () => new Set(rumbleLog.slice(start).map((r) => r.kind));
      const ended = await this.fight(() => (kinds().has('light') && kinds().has('heavy') && kinds().has('ko')) || (m0()?.state.frame ?? 0) > 90 * 60, 5 * 60 * 1000);
      if (ended === 'over') t.problem('warning', 'the match ended before a light hit, a heavy hit and a KO were all rumbled');
      const seen = new Map<string, RumbleSent>();
      for (const r of rumbleLog.slice(start)) if (!seen.has(r.kind)) { seen.set(r.kind, r); logged(r); }
      for (const k of ['light', 'heavy', 'ko'] as const) if (!seen.has(k)) t.problem('bug', `no ${k} rumble was sent in this fight`);
      const [a, b, c] = [seen.get('light'), seen.get('heavy'), seen.get('ko')];
      if (a && b && c) {
        const differ = a.ms < b.ms && b.ms < c.ms && a.strong < b.strong && b.strong <= c.strong;
        if (!differ) t.problem('bug', 'light, heavy and KO rumbles are not each longer and stronger than the one before');
        else t.event('rumble-tiers', `light ${a.ms} ms / ${a.strong}, heavy ${b.ms} ms / ${b.strong}, KO ${c.ms} ms / ${c.strong}`);
      }
      t.metric('rumblesOn', rumbleLog.length - start);
      if (touch) {
        if (vibrateCalls === 0) t.problem('warning', 'no navigator.vibrate call was made on a hit with Rumble on');
        else t.event('vibrate-on', `${vibrateCalls} phone vibrate call(s) on hits with Rumble on`);
      }
      t.progress(0.65);

      // Pause → Settings → Rumble off; the fight goes on and nothing rumbles or vibrates.
      const pauseBtn = () => {
        const el = this.q('.touch-pause');
        return el && el.getClientRects().length > 0 ? el : null;
      };
      if (touch && pauseBtn()) await this.tap(pauseBtn, 'Pause');
      else await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      await t.until(settingsShowing, 3000, 'Settings to open from Pause');
      await t.wait(400);
      await this.tap(() => this.q('#rumble-switch'), 'Rumble off');
      if (touchSettings().vibrate || this.q('#rumble-switch')?.getAttribute('aria-checked') !== 'false') t.problem('bug', 'Rumble off did not apply');
      else t.event('rumble-off', 'Rumble switched Off in Settings (shared by pad rumble and phone vibrate)');
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
      await this.click(() => this.q('#btn-resume'), 'Resume');
      await t.until(() => this.game.phase() === 'play', 3000, 'the match to resume');
      const sentBefore = rumbleLog.length;
      const hitsBefore = hits;
      const supBefore = rumbleStats.suppressed;
      vibrateCalls = 0;
      const f0 = m0()?.state.frame ?? 0;
      await this.fight(() => hits - hitsBefore >= 4 || (m0()?.state.frame ?? 0) - f0 > 90 * 60, 3 * 60 * 1000);
      const landed = hits - hitsBefore;
      if (landed === 0) t.problem('warning', 'no hit landed with Rumble off, so it could not be checked');
      else if (rumbleLog.length !== sentBefore) t.problem('bug', `${rumbleLog.length - sentBefore} rumble(s) were sent with Rumble off`);
      else if (touch && vibrateCalls > 0) t.problem('bug', `${vibrateCalls} phone vibrate call(s) with Rumble off`);
      else t.event('rumble-silent', `${landed} hit(s) with Rumble off: 0 rumbles sent, 0 phone vibrate calls (${rumbleStats.suppressed - supBefore} held back)`);
      t.metric('rumblesOff', rumbleLog.length - sentBefore);
      t.metric('vibrateCallsOff', vibrateCalls);
      t.progress(0.9);

      if (touch && pauseBtn()) await this.tap(pauseBtn, 'Pause');
      else await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
    } finally {
      unwatch();
      if (hadOwn) Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: realVibrate });
      else delete (nav as { vibrate?: unknown }).vibrate;
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
      try {
        if (original === null) localStorage.removeItem(TOUCH_KEY);
        else localStorage.setItem(TOUCH_KEY, original);
      } catch {
        // Storage blocked.
      }
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- auto-level

  /**
   * Auto CPU level (ai/autoLevel.ts): quick play's CPU is on Auto by default. Setup shortcut: the saved Auto level (`dod.profile.cpu`)
   * is set to 4. Match 1 (3 stocks) is a win by the bot and, with 2+ stocks left, raises the level by 1; match 2 (1 stock, the player
   * held idle through the virtual pad) is a loss that takes no stock and lowers it by 1. Each match is entered from the menu so the
   * VS card is read (`vs-level`: "CPU · Level N · Auto"), and the Results' one-line note is measured (`level-note`, `level-note-fit`).
   * A phone (390x844) turns to 844x390 and plays by taps.
   */
  async autoLevelRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('auto-level');
    }
    this.logViewport(touch && (this.isPhone() || this.options.at === 'phone-turned'));
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const KEY = 'dod.profile.cpu';
    const original = localStorage.getItem(KEY);
    const saved = () => (JSON.parse(localStorage.getItem(KEY) ?? '{}') as { level?: number }).level ?? 3;
    localStorage.setItem(KEY, JSON.stringify({ level: 4 }));
    let vsText = '';
    let vsLevel = 0;
    const onVs = () => {
      const el = document.querySelector<HTMLElement>('.vs-level[data-level]');
      vsText = el?.textContent ?? '';
      vsLevel = Number(el?.dataset.level ?? 0);
      if (el) {
        const r = el.getBoundingClientRect();
        const inside = r.left >= 0 && r.right <= innerWidth && r.height < 40 * 1.6;
        if (!inside) t.problem('bug', `the VS card's level label runs off the screen or wraps ("${vsText}")`);
      }
    };
    window.addEventListener('dod:vs-calls', onVs);
    type AutoChange = { won: boolean; stocksLeft: number; from: number; to: number; changed: boolean };
    let change = null as AutoChange | null;
    const onAuto = (e: Event) => { change = (e as CustomEvent).detail; };
    window.addEventListener('dod:auto-level', onAuto);
    const note = () => this.q('.results-hero .level-note');
    const checkNote = (want: number) => {
      const el = note();
      if (!el) return t.problem('bug', 'Results has no level-change note after an Auto match that moved the level');
      const r = el.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
      const oneLine = r.height <= lh * 1.5 && el.scrollWidth <= el.clientWidth + 1;
      const inside = r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 2;
      t.event('level-note', `"${el.textContent}" (${Math.round(r.width)}x${Math.round(r.height)} px)`);
      if (!oneLine || !inside) t.problem('bug', `the level-change note is not on one line inside the screen (${Math.round(r.width)}x${Math.round(r.height)} px, scroll ${el.scrollWidth}/${el.clientWidth}, window ${innerWidth}x${innerHeight})`);
      else t.event('level-note-fit', `one line, ${Math.round(r.width)} px wide in a ${innerWidth}x${innerHeight} window`);
      if (!el.textContent?.includes(`→ ${want}`)) t.problem('bug', `the note says "${el.textContent}", the level moved to ${want}`);
    };
    const toResults = async () => {
      await this.results();
      await t.until(() => this.q('.results-row')?.getAttribute('data-phase') === 'panel', 12000, 'the results panel').catch(() => undefined);
      await t.wait(400);
    };
    try {
      await this.toMainMenu();
      t.progress(0.05);

      // Match 1: a win with 2+ stocks left.
      await this.startVersus(3);
      if (vsLevel !== 4 || !/Level 4/.test(vsText) || !/Auto/.test(vsText)) t.problem('bug', `the VS card shows "${vsText}", wanted CPU · Level 4 · Auto`);
      else t.event('vs-level', `VS card: "${vsText}"`);
      this.progressNow = () => 0.05 + 0.4 * Math.min(1, (this.game.match()?.state.frame ?? 0) / (180 * 60));
      await this.fight(() => false, 8 * 60 * 1000);
      await toResults();
      const won1 = change as AutoChange | null;
      if (!won1) t.problem('bug', 'no dod:auto-level event after the first match');
      else {
        t.event('auto-win', `won ${won1.won}, ${won1.stocksLeft} stocks left: level ${won1.from} → ${won1.to}`);
        if (won1.won && won1.stocksLeft >= 2) {
          if (won1.to !== won1.from + 1 || saved() !== 5) t.problem('bug', `a win with ${won1.stocksLeft} stocks left moved the Auto level ${won1.from} → ${won1.to} (saved ${saved()}), wanted +1`);
          else checkNote(5);
        } else t.problem('warning', `the bot ${won1.won ? `won with only ${won1.stocksLeft} stock(s) left` : 'lost'}: no clear win to check +1 on (try another seed)`);
      }
      t.metric('autoLevelAfterWin', saved());
      t.progress(0.5);

      // Match 2: a loss that takes no stock (the player stands still).
      change = null;
      await this.click(() => [...document.querySelectorAll<HTMLElement>('#results-actions button')].find((b) => b.textContent === 'Main menu'), 'Main menu');
      await this.screen('main');
      await this.startVersus(1, false);
      if (vsLevel !== saved() || !/Auto/.test(vsText)) t.problem('bug', `the second VS card shows "${vsText}", the Auto level is ${saved()}`);
      else t.event('vs-level', `VS card: "${vsText}"`);
      const before = saved();
      this.manual = NO_INPUT;
      try {
        await this.fight(() => false, 8 * 60 * 1000);
      } finally {
        this.manual = null;
      }
      await toResults();
      const lost = change as AutoChange | null;
      if (!lost) t.problem('bug', 'no dod:auto-level event after the second match');
      else {
        t.event('auto-loss', `won ${lost.won}: level ${lost.from} → ${lost.to}`);
        if (lost.won) t.problem('warning', 'the idle player won?');
        else if (lost.to !== before - 1 || saved() !== before - 1) t.problem('bug', `a loss without taking a stock moved the Auto level ${lost.from} → ${lost.to}, wanted ${before - 1}`);
        else checkNote(before - 1);
      }
      t.metric('autoLevelAfterLoss', saved());
      await this.click(() => [...document.querySelectorAll<HTMLElement>('#results-actions button')].find((b) => b.textContent === 'Main menu'), 'Main menu');
      await this.screen('main');
    } finally {
      window.removeEventListener('dod:vs-calls', onVs);
      window.removeEventListener('dod:auto-level', onAuto);
      this.manual = null;
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
      if (original === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, original);
    }
    t.progress(1);
    t.finish('done');
  }

  // ---------------------------------------------------------- touch-match

  /**
   * Portrait phone → landscape frame that plays a touch scenario. For `touch-match` the frame starts upright
   * (390x844, at=phone) so Rotate pause is proven, then turns to 844x390 and the match resumes; other scenarios
   * open already turned (mirrors smokeTurned).
   */
  private async touchMatchTurned(scenario = 'touch-match'): Promise<void> {
    const t = this.t;
    // Only insist on a phone-sized outer when we are already on one; a desktop runner frames a phone twin.
    if (Math.min(innerWidth, innerHeight) <= 560) this.logViewport(true);
    type Inner = { events: Array<{ type: string; detail?: string }>; problems: Array<{ severity: string; message: string }>; metrics?: Record<string, number>; outcome: string; state?: { progress?: number } };
    const proveRotate = scenario === 'touch-match';
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:#1c0d06 radial-gradient(ellipse at 50% 45%,#8a3010 0%,#3a1608 45%,#100e0c 80%);z-index:2147483647;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.title = proveRotate ? `Phone window (${scenario} playtest)` : `Phone window turned to landscape (${scenario} playtest)`;
    frame.allow = 'autoplay';
    const turn = (w: number, h: number) => {
      const k = Math.min(innerWidth / w, innerHeight / h, 1);
      frame.style.cssText = `position:absolute;left:50%;top:50%;width:${w}px;height:${h}px;border:0;transform-origin:0 0;transform:translate(${-(w * k) / 2}px,${-(h * k) / 2}px) scale(${k});background:transparent`;
    };
    if (proveRotate) turn(390, 844);
    else turn(844, 390);
    back.appendChild(frame);
    const q = new URLSearchParams(location.search);
    q.set('playtest', scenario);
    q.set('at', proveRotate ? 'phone' : 'phone-turned');
    if (!q.has('seed')) q.set('seed', String(this.options.seed ?? 1));
    frame.src = `${location.pathname}?${q.toString()}`;
    document.body.appendChild(back);
    const api = () => (frame.contentWindow as (Window & { hawkesPlaytest?: { report(): Inner | null; state(): { progress?: number } | null } }) | null)?.hawkesPlaytest;
    let seen = 0;
    const seenProblems = new Set<string>();
    let heart = 0;
    const has = (type: string) => !!api()?.report()?.events.some((e) => e.type === type);
    const forward = (): Inner | null => {
      const r = api()?.report() ?? null;
      if (!r) return null;
      for (const e of r.events.slice(seen)) if (e.type !== 'problem' && e.type !== 'start' && e.type !== 'start-at') t.event(e.type, `${e.detail ?? ''} [${proveRotate && !has('phone-turned') ? 'portrait' : 'landscape'} frame]`);
      seen = r.events.length;
      for (const p of r.problems) {
        if (!seenProblems.has(p.message)) {
          seenProblems.add(p.message);
          t.problem('bug', `${p.message} [phone frame]`);
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
      if (proveRotate) {
        t.event('phone-upright', 'a phone-sized window, 390x844 (portrait), opened over the game for touch-match');
        t.progress(0.04);
        await t.until(() => {
          heart += 1;
          if (heart === 1 || heart % 100 === 0) t.event('phone-turn-wait', `waiting for Rotate pause (${Math.round(heart / 20)} s)`);
          forward();
          return has('rotate-paused') || (api()?.report()?.problems.length ?? 0) > 0 || api()?.report()?.outcome === 'error';
        }, 180000, 'the upright phone to pause under Rotate');
        forward();
        await t.wait(800);
        turn(844, 390);
        t.event('phone-turned', `the phone window turned to 844x390 (landscape) for ${scenario}`);
      } else {
        t.event('phone-turned', `the portrait phone window (${innerWidth}x${innerHeight}) turned to 844x390 (landscape) for ${scenario}`);
      }
      t.progress(0.08);
      heart = 0;
      await t.until(() => {
        heart += 1;
        if (heart === 1 || heart % 100 === 0) t.event('phone-turn-wait', `waiting for the landscape ${scenario} (${Math.round(heart / 20)} s)`);
        const r = forward();
        return !!r && (r.outcome === 'done' || r.outcome === 'error' || r.outcome === 'stuck' || r.outcome === 'won' || r.outcome === 'lost');
      }, 300000, `the turned phone to play ${scenario}`);
      const r = forward();
      const out = r?.outcome;
      if (proveRotate) {
        if (!has('rotate-prompt')) t.problem('bug', 'the Rotate prompt was never seen at 390x844');
        if (!has('rotate-hidden') || !has('rotate-resumed')) t.problem('bug', 'the prompt did not hide and play resume at 844x390');
      }
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
   * Touch match: at phone size, menus to results with only pointer events on the floating stick and icon buttons
   * (input/touch.ts). Portrait opens a framed run that proves Rotate pause at 390x844 then turns to 844x390
   * (absorbs the rotate phone proof). Landscape drills the floating stick, flick-jump, ≥44 px icon arc (Attack
   * largest), reports Low fps, then the bot plays through touch to results.
   */
  async touchMatch(): Promise<void> {
    const t = this.t;
    // Outer portrait (or a desktop runner): frame the phone upright → Rotate pause → landscape match.
    if (this.options.at !== 'phone' && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      this.useTap = true;
      forceTouchUi(true);
      try {
        await this.toMainMenu();
        await this.phoneUiClipTour('portrait');
        t.progress(0.06);
      } finally {
        this.useTap = false;
        forceTouchUi(false);
      }
      return this.touchMatchTurned();
    }
    if (this.options.at !== 'phone' && this.options.at !== 'phone-turned' && Math.min(innerWidth, innerHeight) > 560) {
      // Desktop-sized window: still prove the phone path in a framed twin.
      return this.touchMatchTurned();
    }
    this.logViewport(true);
    this.useTap = true;
    forceTouchUi(true);
    const gfxWas = localStorage.getItem(GFX_KEY);
    try {
      await this.toMainMenu();
      const upright = innerHeight > innerWidth;
      if (this.options.at === 'phone-turned' || this.isPhone() || this.options.at === 'phone') {
        await this.phoneUiClipTour(upright ? 'portrait' : 'landscape');
      }
      t.progress(0.05);
      // Low quality for the fps acceptance check (phones default Low; force it so the metric is real).
      setGraphics({ quality: 'low', glow: false });
      this.onVersus = async () => {
        await this.screen('versus', 15000);
        await this.wait(400);
        this.checkClipping('VS screen', this.q('#versus'));
        t.event('phone-shot', `VS screen at ${innerWidth > innerHeight ? 'landscape' : 'portrait'} ${innerWidth}x${innerHeight}`);
        await this.wait(2000);
      };
      forceTouchPrompt(true);
      await this.startVersus(2);
      this.onVersus = null;
      t.progress(0.12);

      const frame = () => this.game.match()?.state.frame ?? 0;
      // Rotate proof (at=phone upright, or any upright phone): prompt covers, match paused; then wait for landscape.
      if (upright || rotateShowing()) {
        const prompt = () => document.getElementById('rotate-prompt');
        const size = () => `${innerWidth}x${innerHeight}`;
        await this.wait(400);
        const p = prompt();
        const r = p?.getBoundingClientRect();
        const covered = !!p && !p.hidden && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#rotate-prompt') === p;
        if (!p || !rotateShowing() || !r || r.width < innerWidth - 1 || r.height < innerHeight - 1 || !covered || !/Rotate your phone/i.test(p.textContent ?? '')) {
          t.problem('bug', `no full-screen "Rotate your phone" prompt over the game at ${size()}`);
        } else t.event('rotate-prompt', `"Rotate your phone" covers the game at ${size()}`);
        const before = frame();
        await t.wait(1500);
        if (frame() !== before) t.problem('bug', `the match kept running under the Rotate prompt at ${size()} (frame ${before} -> ${frame()})`);
        else t.event('rotate-paused', `the match is paused under the prompt at ${size()} (frame ${before})`);
        t.progress(0.14);
        try {
          await t.until(() => !rotateShowing() && innerWidth >= innerHeight, 120000, 'the window to turn to landscape');
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
          t.problem('bug', `touch-match could not play: the Rotate prompt stayed up at ${size()} (run it landscape, 844x390)`);
          t.finish('stuck');
          return;
        }
        await t.wait(300);
        if (prompt() && !prompt()!.hidden) t.problem('bug', `the Rotate prompt is still up at ${size()}`);
        else t.event('rotate-hidden', `no Rotate prompt at ${size()}`);
        const resumeAt = frame();
        await this.fight(() => frame() >= resumeAt + 30, 40000);
        if (frame() > resumeAt) t.event('rotate-resumed', `play goes on at ${size()} (frame ${resumeAt} -> ${frame()})`);
        else t.problem('bug', `the match did not resume at ${size()}`);
      }

      const root = touchOverlay() ?? this.q('.touch');
      if (!root) {
        t.problem('bug', 'touch controls overlay (.touch) was not built');
        t.finish('error');
        return;
      }
      if (root.hidden) {
        t.event('touch-forced', 'not a touch device: the overlay was shown for the run');
        root.hidden = false;
      }
      document.body.classList.add('touch-ui');
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
      const dropped = typeof this.options.drop === 'string' ? this.options.drop : '';
      const dropEl = dropped ? root.querySelector<HTMLElement>(CONTROLS.find((c) => c.key === dropped)?.sel ?? '.none') : null;
      if (dropEl) dropEl.style.display = 'none';
      const find = (key: string) => {
        const el = root.querySelector<HTMLElement>(CONTROLS.find((c) => c.key === key)!.sel);
        return el && el.getClientRects().length > 0 ? el : null;
      };

      const inset = this.safeInsets();
      const stage = document.getElementById('stage');
      const stageZ = stage ? Number(getComputedStyle(stage).zIndex) || 0 : 0;
      const touchZ = Number(getComputedStyle(root).zIndex) || 0;
      if (touchZ <= stageZ) t.problem('bug', `touch overlay z-index ${touchZ} is not above the Babylon canvas z-index ${stageZ}`);
      else t.event('touch-z-order', `touch z-index ${touchZ} above canvas z-index ${stageZ}`);
      let bad = 0;
      let minSide = Infinity;
      let attackSide = 0;
      const otherSides: number[] = [];
      for (const c of CONTROLS) {
        const el = find(c.key);
        if (!el) {
          bad++;
          t.problem('bug', `touch control missing: ${c.name} (${c.sel}) is not on the screen`);
          continue;
        }
        if (c.key !== 'stick' && c.key !== 'pause') {
          const label = el.getAttribute('aria-label') || '';
          if (!el.querySelector('svg') || label !== c.name) {
            bad++;
            t.problem('bug', `touch ${c.name} needs an icon and aria-label="${c.name}" (got "${label}")`);
          }
        }
        const r = el.getBoundingClientRect();
        const side = Math.min(r.width, r.height);
        if (side < minSide) minSide = side;
        if (c.key === 'attack') attackSide = side;
        else if (c.key !== 'stick' && c.key !== 'pause') otherSides.push(side);
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
      if (attackSide > 0 && otherSides.some((s) => s >= attackSide - 0.5)) {
        bad++;
        t.problem('bug', `Attack should be the largest touch button (Attack ${Math.round(attackSide)}px, others ${otherSides.map(Math.round).join('/')})`);
      } else if (attackSide > 0) {
        t.event('touch-attack-largest', `Attack ${Math.round(attackSide)}px > ${otherSides.map(Math.round).join('/')}`);
      }
      // Button circles must not overlap (8 px gap): centre-point hit-tests miss that.
      {
        const btns = CONTROLS.filter((c) => c.key !== 'stick' && c.key !== 'pause').map((c) => find(c.key)).filter((el): el is HTMLElement => !!el);
        for (let i = 0; i < btns.length; i++) {
          for (let j = i + 1; j < btns.length; j++) {
            const a = btns[i]!.getBoundingClientRect();
            const b = btns[j]!.getBoundingClientRect();
            const dx = a.left + a.width / 2 - (b.left + b.width / 2);
            const dy = a.top + a.height / 2 - (b.top + b.height / 2);
            const need = (Math.min(a.width, a.height) + Math.min(b.width, b.height)) / 2 + 8;
            if (Math.hypot(dx, dy) < need - 0.5) {
              bad++;
              t.problem('bug', `touch buttons overlap: ${btns[i]!.getAttribute('aria-label')} and ${btns[j]!.getAttribute('aria-label')} centres ${Math.round(Math.hypot(dx, dy))}px apart (need ≥${Math.round(need)})`);
            }
          }
        }
      }
      if (Number.isFinite(minSide)) t.metric('touchMinPx', Math.round(minSide));
      if (!bad) t.event('touch-controls-ok', `all ${CONTROLS.length} icon controls on screen, ≥44 px (min ${Math.round(minSide)}), Attack largest, no overlap, clear of the safe area (top ${inset.top}, right ${inset.right}, bottom ${inset.bottom}, left ${inset.left}) at ${innerWidth}x${innerHeight}`);
      t.event('phone-shot', `match touch controls at landscape ${innerWidth}x${innerHeight}`);
      await this.wait(2200);

      let pid = 100;
      const down = new Map<string, { id: number; el: HTMLElement }>();
      const send = (el: HTMLElement, type: string, x: number, y: number, id: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 100, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
      const stickAt = (sx: number, sy: number) => {
        const el = find('stick');
        if (!el) return;
        const r = el.getBoundingClientRect();
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
      const me = () => {
        const m = this.game.match();
        return m && m.player >= 0 ? m.state.fighters[m.player] : null;
      };
      const logged = new Set<string>();
      const note = (what: string, detail: string) => {
        counts[what]++;
        t.add(`touch${what[0].toUpperCase()}${what.slice(1)}s`);
        if (!logged.has(what)) {
          logged.add(what);
          t.event(`touch-${what}`, detail);
        }
      };
      const held = (bit: number) => (readTouch()[2] & bit) !== 0;

      // Floating stick: hit-test the left-40% zone (same path as a real thumb), then drag past the edge.
      {
        const spawnX = Math.round(innerWidth * 0.22);
        const spawnY = Math.round(innerHeight * 0.62);
        const hit = document.elementFromPoint(spawnX, spawnY) as HTMLElement | null;
        const zone = hit?.closest('.touch-move-zone, .touch-stick') as HTMLElement | null;
        if (!zone) {
          t.problem('bug', `left-40% touch at ${spawnX},${spawnY} hits ${hit?.id ? '#' + hit.id : hit?.tagName.toLowerCase() ?? 'nothing'} (want .touch-move-zone)`);
        }
        const target = zone ?? root;
        const id = ++pid;
        send(target, 'pointerdown', spawnX, spawnY, id);
        await t.wait(80);
        const stick = find('stick');
        const sr = stick?.getBoundingClientRect();
        const cx = sr ? sr.left + sr.width / 2 : 0;
        const cy = sr ? sr.top + sr.height / 2 : 0;
        if (!stick || !sr || Math.hypot(cx - spawnX, cy - spawnY) > Math.max(28, (sr?.width ?? 0) * 0.4)) {
          t.problem('bug', `floating stick did not spawn under the left-thumb touch at ${spawnX},${spawnY} (center ${Math.round(cx)},${Math.round(cy)})`);
        } else {
          t.event('touch-float-spawn', `stick spawned under thumb at ${Math.round(cx)},${Math.round(cy)} from left-40% touch ${spawnX},${spawnY}`);
        }
        const beforeLeft = sr?.left ?? 0;
        const dragX = Math.min(innerWidth * 0.38, spawnX + Math.round((sr?.width ?? 100) * 0.7));
        const dragY = spawnY;
        send(stick ?? target, 'pointermove', dragX, dragY, id);
        await t.wait(80);
        send(stick ?? target, 'pointermove', dragX + 40, dragY, id);
        await t.wait(80);
        const after = find('stick')?.getBoundingClientRect();
        const [rx] = readTouch();
        if (rx < 40) t.problem('bug', `floating stick drag was not read as move (x=${rx})`);
        else note('move', `floating stick dragged: read x=${rx}`);
        if (after && after.left > beforeLeft + 8) {
          t.event('touch-float-follow', `stick followed the thumb past its edge (left ${Math.round(beforeLeft)} → ${Math.round(after.left)})`);
        } else {
          t.event('touch-float-follow', `stick tracked the thumb (left ${Math.round(beforeLeft)} → ${Math.round(after?.left ?? beforeLeft)}, x=${rx})`);
        }
        send(stick ?? target, 'pointerup', dragX, dragY, id);
        await t.wait(100);
      }

      // Flick jump on the left: quick upward swipe through the move zone (must leave the ground).
      {
        const fx = Math.round(innerWidth * 0.2);
        const fy = Math.round(innerHeight * 0.7);
        const hit = document.elementFromPoint(fx, fy) as HTMLElement | null;
        const zone = (hit?.closest('.touch-move-zone, .touch-stick') as HTMLElement | null) ?? root;
        const id = ++pid;
        const y0 = me()?.y ?? 0;
        send(zone, 'pointerdown', fx, fy, id);
        await t.wait(16);
        send(find('stick') ?? zone, 'pointermove', fx, fy - 28, id);
        await t.wait(16);
        send(find('stick') ?? zone, 'pointerup', fx, fy - 56, id);
        let leftGround = false;
        try {
          await t.until(() => {
            const f = me();
            return !!f && (!f.grounded || f.y > y0 + 2);
          }, 1500, 'flick jump to leave the ground');
          leftGround = true;
        } catch (e) {
          if (String(e).includes('stopped')) throw e;
        }
        if (!leftGround) t.problem('bug', 'left-side upward flick did not jump');
        else {
          note('jump', 'left-side upward flick jumped');
          t.event('touch-flick-jump', 'quick upward flick on the left made the fighter jump');
        }
        await t.wait(200);
      }

      const drill = async (key: string, bit: number, what: string, label: string) => {
        if (!find(key)) return;
        press(key, true);
        await t.wait(120);
        if (!held(bit)) t.problem('bug', `${label} was touched but the game's input did not read it`);
        else note(what, `${label} touched: read by the game's input (touch buttons ${(readTouch()[2] >> 16).toString(2)})`);
        press(key, false);
        await t.wait(150);
      };
      if (!logged.has('jump')) await drill('jump', BTN.JUMP, 'jump', 'Jump');
      await drill('attack', BTN.ATTACK, 'attack', 'Attack');
      await drill('special', BTN.SPECIAL, 'special', 'Special');
      await drill('shield', BTN.SHIELD, 'shield', 'Shield');
      await drill('smash', BTN.C_NEUTRAL, 'smash', 'Smash');
      t.progress(0.28);

      // Sample Low fps during the fight.
      const fpsSamples: number[] = [];
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
        return 0.28 + 0.67 * Math.min(1, lost / Math.max(1, (m.state.fighters.length * stocks) / 2));
      };
      const drive = window.setInterval(() => {
        if (this.disposed) return;
        const g = this.game.gfxStats?.();
        if (g && g.quality === 'low' && g.fpsNow > 0) fpsSamples.push(g.fpsNow);
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
      if (fpsSamples.length) {
        const avg = Math.round(fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length);
        t.metric('fpsMatchLow', avg);
        t.event('touch-fps-low', `average ${avg} fps on Low (${fpsSamples.length} samples)`);
        if (avg < 45) t.problem('warning', `average ${avg} fps in Low on a touch match (want at least 45)`);
      } else {
        t.problem('bug', 'touch-match got no Low fps samples (gfxStats.fpsNow); Quality Low was forced for the fight');
      }
      t.event('touch-summary', `moves ${counts.move}, jumps ${counts.jump}, attacks ${counts.attack}, specials ${counts.special}, shield drills ${counts.shield}, smash drills ${counts.smash} (floating stick + icon buttons)`);
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
      forceTouchPrompt(false);
      this.onVersus = null;
      setVirtualPad(null);
      if (gfxWas === null) localStorage.removeItem(GFX_KEY);
      else localStorage.setItem(GFX_KEY, gfxWas);
      try {
        const g = gfxWas ? (JSON.parse(gfxWas) as { quality?: 'high' | 'low'; glow?: boolean; fps?: boolean }) : null;
        if (g) setGraphics(g);
      } catch {
        // Put-back best effort.
      }
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

  // ---------------------------------------------------------- menu-walk

  /**
   * Every menu screen from Tap to play (main, Versus select, stage pick, Settings, controls, campaign map, tour list, extras,
   * leaderboard, Pause, results), walked by keyboard, an emulated gamepad, then touch (menuWalk.ts has the measuring). On a
   * 390x844 touch phone it turns to 844x390 and walks by touch only. Option `input`: keyboard, gamepad or touch, to walk one.
   */
  async menuWalk(): Promise<void> {
    const touchOnly = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touchOnly && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('menu-walk');
    }
    this.logViewport(touchOnly && this.isPhone());
    const asked = this.options.input;
    const modes: Mode[] = touchOnly ? ['touch'] : asked === 'keyboard' || asked === 'gamepad' ? [asked] : ['keyboard', 'gamepad', 'touch'];
    await walkMenus(
      this.t,
      {
        toMainMenu: () => this.toMainMenu(),
        startVersus: (stocks) => this.startVersus(stocks),
        setTap: (on) => { this.useTap = on; },
        setSpeed: (n) => this.game.setSpeed(n),
        fightToEnd: async (ms) => { await this.fight(() => false, ms); },
        phase: () => this.game.phase(),
      },
      modes,
      this.isPhone(),
    );
  }

  // ---------------------------------------------------------- touch-settings

  /**
   * Touch size and Touch opacity (Settings, touch devices): the sliders show, move the stick, buttons and Pause button
   * live in a match (size and fade measured on the real elements, all kept inside the window), are saved in
   * localStorage "dod.touch", and are still set after a reload. The run treats the desktop browser as a touch device.
   */
  /**
   * Settings > Colour vision (colourVision.ts): the switch is on Settings (menu and Pause), the choice survives a reload,
   * and in a match every fighter's ring, tag and HUD card carries its own shape (circle, triangle, square, diamond) in
   * both modes, with the Okabe-Ito colours in Colourblind-safe. On a 390x844 phone the portrait Settings is checked, then
   * the run plays in the turned 844x390 frame by taps.
   */
  /**
   * Motion comfort (hitFeel.ts: Reduce motion, Screen shake 0-100%, Flashes Full/Soft/Off; renderer `flashScreen`, `killCue`,
   * `updateCamera`; post `punch`). With Reduce motion on from Settings a stock-ending KO must play with no slow motion, no punch-in
   * zoom, no full-screen flash and no camera shake; with Flashes Full and Shake 100 the flashes come back but never more than
   * 3 start in any second. Touch: every control is tapped / set through pointer events, the phone is turned to 844x390.
   */
  async motionComfort(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const KEYS = [MOTION_STORAGE_KEY, SHAKE_STORAGE_KEY, FLASH_STORAGE_KEY];
    const original = KEYS.map((k) => [k, localStorage.getItem(k)] as const);
    const restore = () => {
      for (const [k, v] of original) {
        try {
          if (v === null) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        } catch {
          // Storage blocked.
        }
      }
    };
    const openSettings = async (from: 'menu' | 'pause') => {
      if (from === 'menu') await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      else {
        const pauseBtn = () => {
          const el = this.q('.touch-pause');
          return el && el.getClientRects().length > 0 ? el : null;
        };
        if (touch && pauseBtn()) await this.tap(pauseBtn, 'Pause');
        else await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
        await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      }
      await t.until(settingsShowing, 3000, `Settings to open from ${from}`);
      await t.wait(300);
    };
    const closeSettings = async (from: 'menu' | 'pause') => {
      await this.tap(() => this.q('#settings-done'), 'Done');
      if (from === 'pause') {
        await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
        await this.click(() => this.q('#btn-resume'), 'Resume');
        await t.until(() => this.game.phase() === 'play', 3000, 'the match to resume');
      } else await t.wait(300);
    };
    const controls = (where: string) => {
      const ids = ['#motion-switch', '#shake-level', '#flash-seg [data-fl="full"]', '#flash-seg [data-fl="soft"]', '#flash-seg [data-fl="off"]'];
      const rects = ids.map((id) => ({ id, el: this.q(id) }));
      for (const { id, el } of rects) {
        if (!el) {
          t.problem('bug', `${where}: Settings has no ${id}`);
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.height < 44 || r.width < 44 || r.left < 0 || r.right > innerWidth) t.problem('bug', `${where}: ${id} is ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`);
      }
      this.checkClipping(`Settings (${where})`, this.q('#settings'));
      t.event('motion-controls', `${where} ${innerWidth}x${innerHeight}: Reduce motion ${this.q('#motion-switch')?.textContent}, Screen shake ${(this.q('#shake-level') as HTMLInputElement | null)?.value}%, Flashes ${flashMode()}`);
    };
    const setShake = (v: number) => {
      const el = this.q('#shake-level') as HTMLInputElement | null;
      if (!el) return;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const playUntil = async (stop: () => boolean, label: string) => {
      const m0 = () => this.game.match();
      const f0 = m0()?.state.frame ?? 0;
      await this.fight(() => stop() || (m0()?.state.frame ?? 0) - f0 > 120 * 60, 4 * 60 * 1000);
      t.event('motion-played', label);
    };

    forceTouchUi(touch);
    this.useTap = touch;
    try {
      if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
        this.logViewport(true);
        await this.toMainMenu();
        await openSettings('menu');
        controls('portrait phone');
        await closeSettings('menu');
        this.useTap = false;
        forceTouchUi(false);
        return this.touchMatchTurned('motion-comfort');
      }
      this.logViewport(touch);
      for (const k of KEYS) localStorage.removeItem(k);
      await this.toMainMenu();
      await openSettings('menu');
      controls('Settings');
      // Reduce motion on by hand (a player whose OS says so already has it): the defaults of the other two follow it.
      if (!reduceMotion()) await this.tap(() => this.q('#motion-switch'), 'Reduce motion');
      if (!reduceMotion() || this.q('#motion-switch')?.getAttribute('aria-checked') !== 'true') t.problem('bug', 'Reduce motion did not switch on');
      if (shakeLevel() !== 0 || flashMode() !== 'off') t.problem('bug', `Reduce motion's defaults are Screen shake ${shakeLevel()}% and Flashes ${flashMode()} (want 0% and Off)`);
      else t.event('motion-defaults', 'Reduce motion on: Screen shake 0% and Flashes Off by default');
      await closeSettings('menu');
      t.progress(0.1);

      await this.startVersus(3);
      await t.until(() => this.game.phase() === 'play', 20000, 'the match to begin');
      this.game.hitFxStats?.(true);
      this.game.camFxStats?.(true);
      this.game.flashFxStats?.(true);
      await playUntil(() => (this.game.camFxStats?.()?.killCues ?? 0) > 0 && (this.game.hitFxStats?.()?.hits ?? 0) >= 3, 'Reduce motion: played to a stock-ending KO');
      await t.wait(1200);
      const cam = this.game.camFxStats?.();
      const hit = this.game.hitFxStats?.();
      const fl = this.game.flashFxStats?.();
      t.metric('calmKillCues', cam?.killCues ?? 0);
      t.metric('calmFlashes', fl?.flashes ?? 0);
      t.metric('calmShakeMax', Number((hit?.shakeMax ?? 0).toFixed(3)));
      if (!cam || cam.killCues === 0) t.problem('warning', 'no stock ended in the Reduce motion fight, so the KO could not be checked');
      else {
        const lc = cam.lastCue;
        if (lc && (lc.zoom || lc.slow || lc.punch > 0)) t.problem('bug', `a KO with Reduce motion on still ${lc.slow ? 'slowed down ' : ''}${lc.zoom || lc.punch > 0 ? 'zoomed in' : ''}`);
        else t.event('ko-calm', `a KO with Reduce motion on: no slow motion, no zoom punch (${cam.killCues} KO cue(s))`);
        if ((fl?.flashes ?? 0) > 0) t.problem('bug', `${fl?.flashes} full-screen flash(es) on a KO or hit with Reduce motion on`);
        else t.event('ko-no-flash', 'no full-screen flash on hits or the KO with Reduce motion on (Flashes Off)');
        if ((hit?.shakeMax ?? 0) > 0) t.problem('bug', `the camera shook (${hit?.shakeMax.toFixed(2)}) with Screen shake 0%`);
        else t.event('ko-no-shake', `the camera never shook over ${hit?.hits ?? 0} hits and the KO (Screen shake 0%)`);
      }
      t.progress(0.5);

      // Everything back to Full from Pause, live: flashes return, still never over 3 a second.
      await openSettings('pause');
      if (reduceMotion()) await this.tap(() => this.q('#motion-switch'), 'Reduce motion');
      await this.tap(() => this.q('#flash-seg [data-fl="full"]'), 'Flashes Full');
      setShake(100);
      if (flashMode() !== 'full' || shakeLevel() !== 100 || reduceMotion()) t.problem('bug', `the Settings choices did not apply (Flashes ${flashMode()}, shake ${shakeLevel()}, reduce ${reduceMotion()})`);
      else t.event('motion-full', 'Reduce motion off, Screen shake 100%, Flashes Full, set from Pause');
      await closeSettings('pause');
      this.game.hitFxStats?.(true);
      this.game.flashFxStats?.(true);
      await playUntil(() => (this.game.hitFxStats?.()?.hits ?? 0) >= 10, 'Full: played ten hits');
      const full = this.game.flashFxStats?.();
      const fh = this.game.hitFxStats?.();
      t.metric('fullFlashes', full?.flashes ?? 0);
      t.metric('flashMaxPerSecond', full?.maxPerSecond ?? 0);
      t.metric('fullShakeMax', Number((fh?.shakeMax ?? 0).toFixed(3)));
      if ((full?.maxPerSecond ?? 0) > 3) t.problem('bug', `${full?.maxPerSecond} full-screen flashes started inside one second (the limit is 3)`);
      else t.event('flash-rate', `at Flashes Full: ${full?.flashes ?? 0} flash(es) over the fight, at most ${full?.maxPerSecond ?? 0} in any second (limit 3), ${full?.refused ?? 0} held back`);
      if ((fh?.shakeMax ?? 0) <= 0.05) t.problem('warning', 'no camera shake with Screen shake at 100%, so the setting could not be seen working');
      t.progress(0.9);
      await this.quitFromPause('main');
    } finally {
      restore();
      this.useTap = false;
      if (touch) forceTouchUi(false);
    }
    t.progress(1);
    t.finish('done');
  }

  async colourVisionRun(): Promise<void> {
    const t = this.t;
    const KEY = 'dod.colourvision';
    const RUN = 'hawkes.playtest.colour-vision';
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const carried = sessionStorage.getItem(RUN);
    const openSettings = async () => {
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
    };
    const switchLook = (where: string) => {
      const sw = this.q('#colour-switch');
      if (!sw) {
        t.problem('bug', `${where}: Settings has no Colour vision switch`);
        return null;
      }
      const r = sw.getBoundingClientRect();
      if (r.height < 44 || r.width < 44 || r.left < 0 || r.right > innerWidth || r.bottom > innerHeight + 400) t.problem('bug', `${where}: the Colour vision switch is ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`);
      return sw;
    };
    const shapesInMatch = async (mode: string) => {
      const want = ['circle', 'triangle', 'square', 'diamond'];
      await t.until(() => this.game.phase() === 'play', 20000, 'the match to begin');
      await t.wait(1200);
      const m = this.game.match();
      const n = m?.state.fighters.length ?? 0;
      const rings = this.game.ringShapes?.() ?? [];
      const tags = [...document.querySelectorAll<HTMLElement>('.fighter-tag:not(.edge-tag)')].filter((e) => !e.hidden);
      const cards = [...document.querySelectorAll<HTMLElement>('.hud-card')];
      const ringSet = new Set(rings.map((r) => r.shape));
      const cardSet = new Set(cards.map((c) => c.dataset.shape));
      const tagSet = new Set(tags.map((e) => e.dataset.shape));
      if (rings.length < n || ringSet.size !== n || rings.some((r, i) => r.shape !== want[i])) t.problem('bug', `${mode}: the rings are ${rings.map((r) => r.shape).join(', ')} (want ${want.slice(0, n).join(', ')})`);
      if (cards.length < n || cardSet.size !== n) t.problem('bug', `${mode}: the HUD cards show ${[...cardSet].join(', ')} for ${n} fighters`);
      if (tags.length && tagSet.size !== tags.length) t.problem('bug', `${mode}: the name tags repeat a shape (${tags.map((e) => e.dataset.shape).join(', ')})`);
      // The shape itself is drawn (::before glyph) and big enough to read on a phone.
      for (const c of cards) {
        const nm = c.querySelector('.hud-name');
        const glyph = nm ? getComputedStyle(nm, '::before').content : '';
        const px = nm ? parseFloat(getComputedStyle(nm).fontSize) : 0;
        const r = c.getBoundingClientRect();
        if (!/[●▲■◆]/.test(glyph)) t.problem('bug', `${mode}: HUD card ${c.dataset.slot} draws no shape (${glyph})`);
        else if (px < 10 || r.left < 0 || r.right > innerWidth) t.problem('bug', `${mode}: HUD card ${c.dataset.slot}'s shape is ${px}px or off screen`);
      }
      const colours = rings.map((r) => r.color);
      t.event('shapes', `${mode}: rings ${rings.map((r) => `${r.shape} ${r.color}`).join(', ')}; tags ${tags.map((e) => e.dataset.shape).join(', ') || 'none in view'}; HUD ${cards.map((c) => `${c.dataset.shape} ${c.style.getPropertyValue('--player')}`).join(', ')}${touch ? ' (phone layout, ' + innerWidth + 'x' + innerHeight + ')' : ''}`);
      t.metric('shapeCount', ringSet.size);
      return colours;
    };

    forceTouchUi(touch);
    this.useTap = touch;
    try {
      // A portrait phone: Settings in the portrait window, then the rest in the turned frame.
      if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
        this.logViewport(true);
        await this.toMainMenu();
        await openSettings();
        const sw = switchLook('portrait phone');
        if (sw) t.event('colour-switch', `portrait ${innerWidth}x${innerHeight}: Colour vision reads "${sw.textContent}", ${Math.round(sw.getBoundingClientRect().height)} px tall`);
        await this.tap(() => this.q('#settings-done'), 'Done');
        this.useTap = false;
        forceTouchUi(false);
        return this.touchMatchTurned('colour-vision');
      }
      this.logViewport(touch);
      if (!carried) {
        const original = localStorage.getItem(KEY);
        try {
          localStorage.removeItem(KEY);
        } catch {
          // Storage blocked.
        }
        sessionStorage.setItem(RUN, JSON.stringify({ original }));
        await this.toMainMenu();
        await openSettings();
        const sw = switchLook('Settings');
        if (!sw) return;
        if (sw.textContent !== 'Standard' || colourVision() !== 'standard') t.problem('bug', `Colour vision starts on "${sw.textContent}" (want Standard)`);
        t.event('colour-switch', `Settings shows Colour vision: ${sw.textContent}`);
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.wait(200);
        // Standard: a match with four distinct shapes in the orange, blue, yellow, green set.
        await this.startVersus(3);
        await shapesInMatch('Standard');
        // Pause → Settings → Colourblind-safe, live.
        await tapKey('Escape');
        await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
        await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
        await t.until(settingsShowing, 3000, 'Settings from Pause');
        switchLook('Settings (Pause)');
        await this.tap(() => this.q('#colour-switch'), 'Colour vision');
        if (localStorage.getItem(KEY) !== 'safe') t.problem('bug', `Colour vision did not save: ${localStorage.getItem(KEY)}`);
        else t.event('colour-saved', `dod.colourvision = ${localStorage.getItem(KEY)}`);
        const cards = [...document.querySelectorAll<HTMLElement>('.hud-card')].map((c) => c.style.getPropertyValue('--player').trim().toLowerCase());
        if (cards[0] !== '#d55e00') t.problem('bug', `the HUD did not take the colourblind-safe colours at once (${cards.join(', ')})`);
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
        await this.click(() => this.q('#btn-quit'), 'Quit');
        await this.screen('main');
        t.progress(0.5);
        t.event('reload', 'the page reloads; the run carries on after it');
        const url = new URL(location.href);
        url.searchParams.set('playtest', 'colour-vision');
        url.searchParams.set('seed', String(this.options.seed ?? 1));
        await t.wait(300);
        location.replace(url.toString());
        await new Promise(() => {});
        return;
      }

      const original = (JSON.parse(carried) as { original: string | null }).original;
      sessionStorage.removeItem(RUN);
      try {
        await this.toMainMenu();
        await openSettings();
        const sw = switchLook('Settings after the reload');
        if (sw?.textContent !== 'Colourblind-safe' || colourVision() !== 'safe') t.problem('bug', `after the reload Colour vision reads "${sw?.textContent}" (want Colourblind-safe)`);
        else t.event('colour-kept', `after the reload: Colour vision ${sw.textContent} (${localStorage.getItem(KEY)})`);
        await this.tap(() => this.q('#settings-done'), 'Done');
        await t.wait(200);
        await this.startVersus(3);
        const colours = await shapesInMatch('Colourblind-safe');
        if (colours[0] !== '#d55e00' || colours[1] !== '#56b4e9') t.problem('bug', `the safe colours are ${colours.join(', ')} (want the Okabe-Ito set)`);
        await this.quitFromPause('main');
      } finally {
        try {
          if (original === null) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, original);
        } catch {
          // Storage blocked.
        }
      }
      t.progress(1);
      t.finish('done');
    } finally {
      this.useTap = false;
      forceTouchUi(false);
    }
  }

  /**
   * Settings > Shield: Hold (default) / Toggle. With Toggle one press keeps the shield up with nothing held, a second
   * press, a roll or a jump drops it; on a phone the touch Shield button shows it is latched. Played from real input:
   * taps on the switch and the overlay buttons and a stick drag on touch, key presses otherwise.
   */
  /**
   * Rebinding (Settings → Controls, input/bindings.ts, ui/rebind.ts). Desktop: the Rebind screen is opened from Settings;
   * a clash is warned about and swaps the key; Reset restores every default; Attack is rebound to H by pressing the slot
   * and then the key, saved, and the page reloads; after it the binding is still there, the Controls page shows H for
   * Attack, and in a match H attacks while J no longer does; a second connected gamepad (emulated pad 2, no pad 1) also
   * plays. Phone (390x844 touch): Settings shows no rebinding row, fits, and nothing overlaps.
   * Events `rebind-open`, `rebind-clash`, `rebind-reset`, `rebind-set`, `rebind-saved`, `rebind-survived-reload`,
   * `rebind-controls-page`, `rebind-key-works`, `rebind-old-key-dead`, `rebind-second-pad`, `rebind-phone-hidden`, `rebind-phone-fit`.
   */
  async rebindRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const carried = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(REBIND_RUN_KEY) ?? 'null') as { original: string | null } | null;
      } catch {
        return null;
      }
    })();
    const rebindShowing = () => document.getElementById('rebind')?.hidden === false;
    const openSettings = async () => {
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
    };
    const note = () => (this.q('#rebind-note')?.textContent ?? '').trim();
    const slotBtn = (action: string, slot = 0) => this.q(`#rebind-rows [data-action="${action}"] [data-slot="${slot}"]`);
    const stored = () => {
      try {
        return JSON.parse(localStorage.getItem(REBIND_KEY) ?? 'null') as { keys?: Record<string, string[]> } | null;
      } catch {
        return null;
      }
    };
    const restore = (original: string | null) => {
      try {
        if (original === null) localStorage.removeItem(REBIND_KEY);
        else localStorage.setItem(REBIND_KEY, original);
      } catch {
        // Storage blocked.
      }
    };

    if (touch) {
      forceTouchUi(true);
      this.useTap = true;
      this.logViewport(true);
      try {
        await this.toMainMenu();
        await openSettings();
        await t.wait(300);
        const row = this.q('#controls-row');
        const btn = this.q('#rebind-open');
        if (row && row.getClientRects().length > 0) t.problem('bug', 'the rebinding row shows in Settings on a touch phone');
        else if (btn && btn.getClientRects().length > 0) t.problem('bug', 'the Rebind button shows on a touch phone');
        else t.event('rebind-phone-hidden', `touch ${innerWidth}x${innerHeight}: Settings has no rebinding row (touch has its own layout settings)`);
        // Settings fits: nothing off a side edge, no sideways scroll, no two controls on top of each other.
        const panel = this.q('#settings .settings-panel');
        const items = [...document.querySelectorAll<HTMLElement>('#settings button, #settings input')].filter((e) => e.getClientRects().length > 0);
        let bad = 0;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          if (r.left < -0.5 || r.right > innerWidth + 0.5) {
            bad++;
            t.problem('bug', `a Settings control runs off the screen sideways (${el.id || el.textContent?.trim()}, ${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})`);
          }
        }
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const a = items[i].getBoundingClientRect();
            const b = items[j].getBoundingClientRect();
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
              bad++;
              t.problem('bug', `two Settings controls overlap (${items[i].id || items[i].textContent?.trim()} and ${items[j].id || items[j].textContent?.trim()})`);
            }
          }
        }
        if (document.documentElement.scrollWidth > innerWidth + 1 || (panel && panel.scrollWidth > panel.clientWidth + 1)) {
          bad++;
          t.problem('bug', 'Settings scrolls sideways on the phone');
        }
        const done = this.q('#settings-done')?.getBoundingClientRect();
        if (!done || done.height < 44) t.problem('bug', `Done is under 44 px tall (${Math.round(done?.height ?? 0)})`);
        if (!bad) t.event('rebind-phone-fit', `Settings at ${innerWidth}x${innerHeight}: ${items.length} controls inside the screen, none overlapping, Done ${Math.round(done?.height ?? 0)} px`);
        await this.tap(() => this.q('#settings-done'), 'Done');
      } finally {
        this.useTap = false;
        forceTouchUi(false);
      }
      t.progress(1);
      t.finish('done');
      return;
    }

    const me = () => {
      const m = this.game.match();
      return m ? m.state.fighters[m.player] : null;
    };
    const attacking = () => me()?.action === ACT.ATTACK;
    const calm = async () => {
      try {
        await t.until(() => me()?.action === ACT.IDLE || me()?.action === ACT.WALK, 4000, 'the fighter to stand free');
      } catch {
        // Hit meanwhile: carry on.
      }
      await t.wait(150);
    };
    /** Presses `go` (down, hold, up) and says whether an Attack came out within 700 ms. */
    const triesAttack = async (down: () => void, up: () => void): Promise<boolean> => {
      await calm();
      down();
      let hit = false;
      for (let i = 0; i < 14 && !hit; i++) {
        await t.wait(50);
        hit = attacking();
      }
      up();
      await t.wait(400);
      return hit;
    };

    await this.screen('title', 30000);
    if (!carried) {
      const original = localStorage.getItem(REBIND_KEY);
      try {
        localStorage.removeItem(REBIND_KEY);
        await this.toMainMenu();
        await openSettings();
        await this.tap(() => this.q('#rebind-open'), 'Rebind');
        await t.until(rebindShowing, 3000, 'the rebinding screen');
        const tiny = [...document.querySelectorAll<HTMLElement>('#rebind button')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().height < 44);
        if (tiny.length) t.problem('bug', `${tiny.length} rebinding buttons are under 44 px tall`);
        const rows = document.querySelectorAll('#rebind-rows .rebind-row').length;
        t.event('rebind-open', `Settings > Controls: ${rows} actions, Attack reads "${slotBtn('attack')?.textContent}", Jump "${slotBtn('jump')?.textContent} / ${slotBtn('jump', 1)?.textContent}"`);

        // A clash: Special onto J (Attack's key). The warning says so, and Attack takes Special's old K (a swap).
        await this.tap(() => slotBtn('special'), 'Special slot');
        if (!/press/i.test(slotBtn('special')?.textContent ?? '')) t.problem('bug', 'picking a slot did not ask for a key');
        await tapKey('KeyJ');
        await t.wait(200);
        const warn = this.q('#rebind-note')?.dataset.warn === 'true' && /Attack/.test(note());
        const k = currentBindings().keys;
        if (!warn) t.problem('bug', `no clash warning when Special took Attack's J (note: "${note()}")`);
        else if (k.special[0] !== 'KeyJ' || k.attack.every((c) => !c)) t.problem('bug', `after the clash Special is ${k.special[0]} and Attack has ${k.attack.join('/')}`);
        else t.event('rebind-clash', `"${note()}"`);

        // Reset restores the defaults.
        await this.tap(() => this.q('#rebind-reset'), 'Reset to defaults');
        const d = currentBindings().keys;
        if (d.special[0] !== 'KeyK' || d.attack[0] !== 'KeyJ' || stored()?.keys?.special?.[0] !== 'KeyK') t.problem('bug', `Reset did not restore the defaults (Special ${d.special[0]}, Attack ${d.attack[0]})`);
        else t.event('rebind-reset', `Attack ${d.attack[0]}, Special ${d.special[0]} again, saved ${JSON.stringify(stored()?.keys?.attack)}`);

        // Attack onto H.
        await this.tap(() => slotBtn('attack'), 'Attack slot');
        await tapKey('KeyH');
        await t.wait(200);
        if (currentBindings().keys.attack[0] !== 'KeyH' || slotBtn('attack')?.textContent !== 'H') t.problem('bug', `Attack did not take H (${currentBindings().keys.attack[0]}, shows "${slotBtn('attack')?.textContent}")`);
        else t.event('rebind-set', `Attack = H: "${note()}"`);
        if (stored()?.keys?.attack?.[0] !== 'KeyH') t.problem('bug', 'the new binding was not saved');
        else t.event('rebind-saved', `dod.bindings attack = ${JSON.stringify(stored()?.keys?.attack)}`);

        // Gamepad tab lists the actions with the family's names.
        await this.tap(() => this.q('#rebind-tabs [data-tab="gamepad"]'), 'Gamepad tab');
        const padRows = [...document.querySelectorAll('#rebind-rows .rebind-key')].map((e) => e.textContent).join(' | ');
        t.event('rebind-pad-tab', `Gamepad: ${padRows}`);
        await this.tap(() => this.q('#rebind-done'), 'Done');
        await this.tap(() => this.q('#settings-done'), 'Done');
        t.progress(0.4);
      } catch (e) {
        restore(original);
        throw e;
      }
      sessionStorage.setItem(REBIND_RUN_KEY, JSON.stringify({ original }));
      t.event('reload', 'the page reloads; the run carries on after it');
      const url = new URL(location.href);
      url.searchParams.set('playtest', 'rebind');
      url.searchParams.set('seed', String(this.options.seed ?? 1));
      url.searchParams.set('speed', String(this.options.speed ?? 1));
      await t.wait(300);
      location.replace(url.toString());
      await new Promise(() => {}); // the page is going away
      return;
    }

    sessionStorage.removeItem(REBIND_RUN_KEY);
    try {
      if (currentBindings().keys.attack[0] !== 'KeyH') t.problem('bug', `the binding did not survive the reload (Attack is ${currentBindings().keys.attack[0]})`);
      else t.event('rebind-survived-reload', 'Attack is still H after the reload');
      await this.toMainMenu();
      // The Controls page shows the player's actual bindings.
      await this.click(() => this.q('[data-go="controls"]'), 'Controls');
      await this.screen('howto');
      const attackRow = [...document.querySelectorAll('#keys-kb dt')].find((e) => e.textContent === 'Attack')?.nextElementSibling?.textContent ?? '';
      if (attackRow.trim() !== 'H') t.problem('bug', `the Controls page shows Attack as "${attackRow}" but it is bound to H`);
      else t.event('rebind-controls-page', `Controls: Attack = "${attackRow}"`);
      await this.click(() => this.q('#howto [data-back]'), 'Back');
      await this.screen('main');

      await this.startVersus(3);
      await t.until(() => this.game.phase() === 'play', 20000, 'the match to begin');
      await t.wait(1500);
      const newKey = await triesAttack(
        () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', key: 'h', bubbles: true })),
        () => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyH', key: 'h', bubbles: true })),
      );
      if (!newKey) t.problem('bug', 'H, bound to Attack, did not attack in the match');
      else t.event('rebind-key-works', 'H attacked in the match');
      const oldKey = await triesAttack(
        () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true })),
        () => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', key: 'j', bubbles: true })),
      );
      if (oldKey) t.problem('bug', 'J still attacks after Attack was moved to H');
      else t.event('rebind-old-key-dead', 'J no longer attacks');
      t.progress(0.7);

      // A second connected gamepad (pad 2 only; no pad 1 plugged in) drives the player.
      const pressed = Array.from({ length: 17 }, (_, i) => i === 0);
      const second = await triesAttack(
        () => emulatePad({ buttons: pressed, axes: [0, 0], id: 'Xbox 360 Controller (second pad)' }, 1),
        () => emulatePad(null, 1),
      );
      if (!second) t.problem('bug', 'a second connected gamepad did not control the player');
      else t.event('rebind-second-pad', 'pad 2 button A attacked with no pad 1 connected');

      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
    } finally {
      emulatePad(null, 1);
      restore(carried.original);
    }
    t.progress(1);
    t.finish('done');
  }

  async shieldToggleRun(): Promise<void> {
    const t = this.t;
    const KEY = SHIELD_KEY_NAME;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const switchLook = (where: string) => {
      const sw = this.q('#shield-switch');
      if (!sw) {
        t.problem('bug', `${where}: Settings has no Shield switch`);
        return null;
      }
      const r = sw.getBoundingClientRect();
      if (r.height < 44 || r.width < 44 || r.left < 0 || r.right > innerWidth) t.problem('bug', `${where}: the Shield switch is ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`);
      return sw;
    };
    const openSettings = async () => {
      await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      await t.until(settingsShowing, 3000, 'Settings to open');
    };
    const me = () => {
      const m = this.game.match();
      return m ? m.state.fighters[m.player] : null;
    };
    const act = () => me()?.action ?? -1;
    const shielding = () => act() === ACT.SHIELD || act() === ACT.SHIELD_STUN;
    const btnEl = () => touchOverlay()?.querySelector<HTMLElement>('.touch-btn.shield') ?? null;
    const fire = (el: Element, type: string, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 61, isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2] as const;
    };
    // One press of the Shield control, then let go (a tap): the touch button or the L key.
    const tapShield = async () => {
      if (touch) {
        const b = btnEl();
        if (!b) return t.problem('bug', 'no touch Shield button to press');
        const [x, y] = centre(b);
        fire(b, 'pointerdown', x, y);
        await t.wait(90);
        fire(b, 'pointerup', x, y);
      } else {
        pressAction('shield', true);
        await t.wait(90);
        pressAction('shield', false);
      }
    };
    const press = async (action: 'jump' | 'attack', cls: string) => {
      if (touch) {
        const b = touchOverlay()?.querySelector<HTMLElement>(`.touch-btn.${cls}`);
        if (!b) return;
        const [x, y] = centre(b);
        fire(b, 'pointerdown', x, y);
        await t.wait(90);
        fire(b, 'pointerup', x, y);
      } else {
        pressAction(action, true);
        await t.wait(90);
        pressAction(action, false);
      }
    };
    // Roll: stick sideways while shielding (a drag on the touch stick, the D key otherwise).
    const roll = async () => {
      if (touch) {
        const stick = touchOverlay()?.querySelector<HTMLElement>('.touch-stick');
        if (!stick) return;
        const r = stick.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        fire(stick, 'pointerdown', cx, cy);
        fire(stick, 'pointermove', cx + r.width * 0.3, cy);
        await t.wait(200);
        fire(stick, 'pointerup', cx, cy);
      } else {
        pressAction('right', true);
        await t.wait(200);
        pressAction('right', false);
      }
    };
    const calm = async () => {
      try {
        await t.until(() => act() === ACT.IDLE || act() === ACT.WALK, 4000, 'the fighter to stand free');
      } catch {
        // Hit by the CPU meanwhile: carry on from wherever it is.
      }
      await t.wait(150);
    };
    const handsFree = () => !(touch && touchOverlay()?.querySelector('.touch-btn.down'));
    const latchedLook = () => (touch ? !!btnEl()?.classList.contains('latched') && btnEl()?.getAttribute('aria-pressed') === 'true' : true);

    forceTouchUi(touch);
    this.useTap = touch;
    const original = localStorage.getItem(KEY);
    try {
      // A portrait phone: Settings in the portrait window, then the rest in the turned frame.
      if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
        this.logViewport(true);
        await this.toMainMenu();
        await openSettings();
        const sw = switchLook('portrait phone');
        if (sw) t.event('shield-switch', `portrait ${innerWidth}x${innerHeight}: Shield reads "${sw.textContent}", ${Math.round(sw.getBoundingClientRect().height)} px tall`);
        await this.tap(() => this.q('#settings-done'), 'Done');
        this.useTap = false;
        forceTouchUi(false);
        return this.touchMatchTurned('shield-toggle');
      }
      this.logViewport(touch);
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Storage blocked.
      }
      await this.toMainMenu();
      await openSettings();
      const sw = switchLook('Settings');
      if (!sw) return;
      if (sw.textContent !== 'Hold' || shieldMode() !== 'hold') t.problem('bug', `Shield starts on "${sw.textContent}" (want Hold)`);
      t.event('shield-switch', `Settings shows Shield: ${sw.textContent}`);
      await this.tap(() => this.q('#shield-switch'), 'Shield');
      if (shieldMode() !== 'toggle' || localStorage.getItem(KEY) !== 'toggle' || this.q('#shield-switch')?.textContent !== 'Toggle') t.problem('bug', `the Shield switch did not turn to Toggle (${shieldMode()}, ${localStorage.getItem(KEY)})`);
      else t.event('shield-saved', `dod.shield = ${localStorage.getItem(KEY)}`);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(200);

      await this.startVersus(3);
      await t.until(() => this.game.phase() === 'play', 20000, 'the match to begin');
      await t.wait(1800);
      await calm();

      // 1. One press, nothing held: the shield stays up.
      await tapShield();
      await t.until(shielding, 1000, 'the shield to rise from one press').catch(() => t.problem('bug', 'Toggle: one press did not raise the shield'));
      await t.wait(1400);
      const stayed = shielding() && shieldLatched() && handsFree();
      if (!stayed) t.problem('bug', `Toggle: the shield did not stay up with nothing held (action ${ACT_NAMES[act()] ?? act()}, latched ${shieldLatched()})`);
      else t.event('shield-latched', `one press, 1.4 s later still shielding with no button held (${touch ? 'touch' : 'keyboard'})`);
      if (touch) {
        if (!latchedLook()) t.problem('bug', `the touch Shield button does not show it is latched (class "${btnEl()?.className}", aria-pressed ${btnEl()?.getAttribute('aria-pressed')})`);
        else {
          const r = btnEl()!.getBoundingClientRect();
          t.event('shield-button-latched', `the Shield button shows latched while shielding (${Math.round(r.width)}x${Math.round(r.height)} px at ${innerWidth}x${innerHeight})`);
        }
      }

      // 2. A second press drops it.
      await tapShield();
      await t.until(() => !shielding(), 1000, 'the shield to drop on the second press').catch(() => t.problem('bug', 'Toggle: the second press did not drop the shield'));
      await t.wait(250);
      if (shieldLatched() || (touch && btnEl()?.classList.contains('latched'))) t.problem('bug', 'Toggle: the latched look stayed after the second press');
      else t.event('shield-dropped-press', 'a second press dropped the shield and the latched look went');
      await calm();

      // 3. A roll drops it.
      await tapShield();
      await t.until(shielding, 1000, 'the shield to rise again');
      await t.wait(500);
      await roll();
      let rolled = false;
      try {
        await t.until(() => (rolled = rolled || act() === ACT.ROLL), 800, 'a roll out of the shield');
      } catch {
        t.problem('bug', 'Toggle: stick sideways in the shield did not roll');
      }
      await t.wait(900);
      if (shielding() || shieldLatched()) t.problem('bug', 'Toggle: the shield stayed up after the roll');
      else if (rolled) t.event('shield-dropped-roll', 'a roll dropped the shield');
      await calm();

      // 4. A jump drops it.
      await tapShield();
      await t.until(shielding, 1000, 'the shield to rise a third time');
      await t.wait(400);
      await press('jump', 'jump');
      await t.wait(900);
      if (shielding() || shieldLatched()) t.problem('bug', 'Toggle: the shield stayed up after the jump');
      else t.event('shield-dropped-jump', 'a jump dropped the shield');

      // Back to Hold from Pause: a press held is a shield held, let go is down.
      await this.quitFromPause('main');
      t.progress(1);
      t.finish('done');
    } finally {
      try {
        if (original === null) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, original);
      } catch {
        // Storage blocked.
      }
      this.useTap = false;
      forceTouchUi(false);
    }
  }

  // ---------------------------------------------------------- text-size

  /**
   * Settings → Text size 100 / 125 / 150% (textSize.ts, the --ts variable). At 100% no visible text on the screen is
   * under 12 px; at 150% menus, HUD and captions are measurably larger, nothing is clipped or runs off the window, and
   * the choice is in localStorage "dod.textsize". On a portrait phone the menus are checked in the portrait window and
   * the match in the turned frame.
   */
  async textSizeRun(): Promise<void> {
    const t = this.t;
    const KEY = 'dod.textsize';
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    const original = (() => {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    })();
    const restore = () => {
      try {
        if (original === null) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, original);
      } catch {
        // Storage blocked.
      }
    };
    /** Every visible element that owns text: its font size, and whether it is clipped or off the window. */
    const scan = (where: string, level: number) => {
      let small = 0;
      let clipped = 0;
      let off = 0;
      const biggest = new Map<string, number>();
      for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
        if (el.closest('[hidden], #tap-to-play, .hawkes-ask') || el.closest('svg')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
        if (!own) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05 || r.width < 2 || r.height < 2) continue;
        const label = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
        const px = parseFloat(cs.fontSize);
        if (px < 11.95) {
          small++;
          t.problem('bug', `${where}: ${label} is ${px.toFixed(1)}px at ${level}% (minimum 12px)`);
        }
        const hides = cs.overflowX !== 'visible' || cs.textOverflow === 'clip';
        if (hides && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
          clipped++;
          t.problem('bug', `${where}: ${label} is clipped at ${level}% (${el.scrollWidth}px of text in ${el.clientWidth}px)`);
        }
        if (r.left < -1 || r.right > innerWidth + 1) {
          off++;
          t.problem('bug', `${where}: ${label} runs off the ${innerWidth}px window at ${level}% (${Math.round(r.left)} to ${Math.round(r.right)})`);
        }
        biggest.set(el.tagName, Math.max(biggest.get(el.tagName) ?? 0, px));
      }
      t.event('text-scan', `${where} at ${level}%: ${small} under 12px, ${clipped} clipped, ${off} off screen (${innerWidth}x${innerHeight})`);
      t.metric(`textUnder12.${where}.${level}`, small);
      return { small, clipped, off };
    };
    const px = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    };
    const chooseSize = async (level: number) => {
      await this.tap(() => this.q(`#textsize-seg [data-ts="${level}"]`), `Text size ${level}%`);
      await t.wait(200);
      const saved = localStorage.getItem(KEY);
      const v = getComputedStyle(document.documentElement).getPropertyValue('--ts').trim();
      if (saved !== String(level) || Number(v) !== level / 100) t.problem('bug', `Text size ${level}% saved "${saved}" and set --ts to "${v}"`);
      else t.event('text-saved', `dod.textsize = ${saved}, --ts = ${v}`);
    };
    const openSettings = async (from: 'menu' | 'pause') => {
      if (from === 'menu') await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
      else await this.tap(() => this.q('#btn-pause-settings'), 'Settings (Pause)');
      await t.until(settingsShowing, 3000, `Settings from ${from}`);
    };
    const menuScans = async (level: number) => {
      scan('main-menu', level);
      await openSettings('menu');
      const seg = this.q('#textsize-seg');
      if (!seg || seg.getBoundingClientRect().width === 0) t.problem('bug', 'Settings has no Text size 100% / 125% / 150% choice');
      scan('settings', level);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);
      await this.click(() => this.q('[data-go="versus"]'), 'Versus');
      await this.screen('select');
      await t.wait(400);
      scan('select', level);
      await this.click(() => this.q('#select [data-back]'), 'Back');
      await this.screen('main');
    };

    forceTouchUi(touch);
    this.useTap = touch;
    try {
      this.logViewport(touch);
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Storage blocked.
      }
      const portrait = touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560;
      await this.toMainMenu();
      // 100%: the baseline, then 150%.
      await openSettings('menu');
      await chooseSize(100);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);
      await menuScans(100);
      const base = { menu: px('.menu-item strong'), body: px('.setting-row') };
      t.progress(0.25);
      await openSettings('menu');
      await chooseSize(125);
      await chooseSize(150);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.wait(300);
      const big = { menu: px('.menu-item strong') };
      if (!(big.menu > base.menu * 1.4)) t.problem('bug', `the menu text did not grow at 150% (${base.menu}px → ${big.menu}px)`);
      else t.event('text-bigger', `menu item ${base.menu.toFixed(1)}px → ${big.menu.toFixed(1)}px at 150%`);
      await menuScans(150);
      t.progress(0.5);
      if (portrait) {
        // The match and its HUD play in the turned frame (it starts from the saved 150%).
        restore();
        return this.touchMatchTurned('text-size');
      }
      await this.startVersus(3);
      await t.until(() => this.game.phase() === 'play', 20000, 'the match to begin');
      await t.wait(1500);
      const hud150 = px('.hud-pct');
      scan('hud', 150);
      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await openSettings('pause');
      await chooseSize(100);
      await this.tap(() => this.q('#settings-done'), 'Done');
      await t.until(() => !settingsShowing() && !this.q('#pause')!.hidden, 3000, 'back to the pause menu');
      const hud100 = px('.hud-pct');
      if (!(hud150 > hud100 * 1.4)) t.problem('bug', `the HUD percent did not grow at 150% (${hud100}px → ${hud150}px)`);
      else t.event('hud-bigger', `HUD percent ${hud100.toFixed(1)}px at 100% → ${hud150.toFixed(1)}px at 150%`);
      await this.click(() => this.q('#btn-resume, [data-resume]'), 'Resume');
      await t.wait(500);
      scan('hud', 100);
      await tapKey('Escape');
      await t.until(() => this.game.phase() === 'pause', 3000, 'the match to pause');
      await this.click(() => this.q('#btn-quit'), 'Quit');
      await this.screen('main');
      t.progress(1);
      t.finish('done');
    } finally {
      this.useTap = false;
      forceTouchUi(false);
      restore();
    }
  }

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
  /**
   * The decoded-audio cache (audio.ts `cacheStats`): 5 matches on 5 different stages in a row (each played a few seconds, left
   * from Pause), the held decoded audio read after each (`cache-size`, metrics `audioCacheMB`, `audioCachePeakMB`, `audioCacheBudgetMB`),
   * under the ceiling (desktop 120 MB, phone 60 MB); then the first stage again: its music is up within 1 s (`cache-return`, metric
   * `returnMusicMs`). On a 390x844 phone it turns to 844x390 and plays by touch. Option `stages` (ids) overrides the five.
   */
  async audioCache(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('audio-cache');
    }
    this.logViewport(touch && this.isPhone());
    const phone = touch || this.isPhone();
    const ceiling = phone ? 60 : 120;
    const stats = () => this.game.audioCacheStats?.();
    if (!stats()) {
      t.problem('bug', 'the game exposes no audioCacheStats');
      t.finish('error');
      return;
    }
    const ids = Array.isArray(this.options.stages) ? (this.options.stages as string[]) : STAGES.map((s) => s.id);
    const start = Math.abs((this.options.seed ?? 1) - 1) % ids.length;
    const five = Array.from({ length: Math.min(5, ids.length) }, (_, i) => ids[(start + i) % ids.length]);
    const opts = this.options as unknown as { stage?: string };
    const original = opts.stage;
    await this.toMainMenu();
    if (touch) forceTouchUi(true);
    try {
      for (let i = 0; i < five.length + 1; i++) {
        const back = i === five.length;
        const stage = back ? five[0] : five[i];
        opts.stage = stage;
        t.progress(0.05 + 0.9 * (i / (five.length + 1)));
        await this.startVersus(1);
        const m = () => this.game.match();
        const at = performance.now();
        if (back) {
          await t.until(() => !!this.game.musicBedStats?.()?.musicOn, 4000, 'the returning stage music').catch(() => undefined);
          const ms = Math.round(performance.now() - at);
          t.metric('returnMusicMs', ms);
          t.event('cache-return', `back on ${stage}: music up ${ms} ms after the match went live`);
          if (!this.game.musicBedStats?.()?.musicOn || ms > 1000) t.problem('bug', `returning to ${stage}: music took ${ms} ms (limit 1000)`);
        }
        await t.until(() => (m()?.state.frame ?? 0) > 180, 30000, 'a few seconds of play');
        const s = stats()!;
        t.event('cache-size', `${stage}: ${s.decodedMB} MB decoded (${s.entries} files, ${s.evictions} evicted, ceiling ${ceiling} MB, budget ${s.budgetMB} MB)`);
        t.metric('audioCacheMB', s.decodedMB);
        t.metric('audioCachePeakMB', s.peakMB);
        t.metric('audioCacheBudgetMB', s.budgetMB);
        t.metric('audioCacheEvictions', s.evictions);
        if (s.peakMB > ceiling) t.problem('bug', `decoded audio peaked at ${s.peakMB} MB (ceiling ${ceiling})`);
        await this.quitFromPause('main');
      }
    } finally {
      opts.stage = original;
    }
    t.progress(1);
    t.finish('done');
  }

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

  /**
   * The post chain: each stage's own colour grade (3D LUT), vignette and, on High, film grain and the 4-frame hit
   * punch. Setup shortcut: straight into a match on each stage (no menus); the options `stage` picks one. On a phone
   * (touch, 844x390) it plays Low, where only the grade and vignette run, and checks the frame rate holds 45.
   * Events `stage-grade` (per stage: LUT loaded, vignette, grain), `post-low`, `post-punch`; metrics fpsPost, postStages.
   */
  async postChain(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('post-chain');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const low = touch || this.options.quality === 'low';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(low ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    try {
      const want = typeof this.options.stage === 'string' ? STAGES.filter((s) => s.id === this.options.stage) : STAGES;
      if (!want.length) t.problem('bug', `stage "${String(this.options.stage)}" is not on the list`);
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const foe = (punk + 1) % CHARACTERS.length;
      const post = () => this.game.postStats?.();
      let graded = 0;
      for (const [i, st] of want.entries()) {
        t.progress(0.05 + (0.7 * i) / want.length);
        void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(st), stocks: 1, rules: {}, slots: [{ char: punk, cpu: null }, { char: foe, cpu: 5 }] });
        await this.matchLive();
        await this.t.until(() => !!post()?.lutReady, 8000, `${st.name}'s LUT to load`).catch((e) => {
          if (String(e).includes('stopped')) throw e;
        });
        await this.wait(1800);
        const p = post();
        if (!st.grade) t.problem('bug', `${st.name} has no grade in content/stages.json`);
        else if (!p || p.lut !== st.id || !p.lutReady) t.problem('bug', `${st.name}: the colour grade (stages/${st.id}/lut.png) is not applied (${JSON.stringify(p)})`);
        else if (p.vignette <= 0) t.problem('bug', `${st.name}: no vignette`);
        else if ((p.quality === 'low') !== (p.grain === 0)) t.problem('bug', `${st.name}: film grain ${p.grain} on ${p.quality} (Low runs the grade and vignette only)`);
        else {
          graded++;
          t.event('stage-grade', `${st.name}: LUT ${p.lut} loaded, tint ${st.grade.tint}, saturation ${st.grade.saturation}, vignette ${p.vignette}, grain ${p.grain} (${p.quality})`);
        }
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.metric('postStages', graded);
      // One full fight on the last stage: the bot hits, the punch is 4 frames; Low holds the frame rate.
      t.progress(0.8);
      void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(want[want.length - 1] ?? STAGES[0]), stocks: 1, rules: {}, slots: [{ char: punk, cpu: null }, { char: foe, cpu: 5 }] });
      await this.matchLive();
      const fps: number[] = [];
      let sampled = 0;
      await this.fight(() => {
        if (++sampled % 20 === 0) fps.push(this.game.gfxStats?.()?.fpsNow ?? 0);
        return !low && (post()?.punches ?? 0) >= 1 && post()?.punchFrames === 0;
      }, 240000);
      const p = post();
      if (low) {
        t.event('post-low', `Low: grade and vignette only (grain ${p?.grain}, punches ${p?.punches}, LUT ${p?.lutReady ? 'on' : 'off'})`);
        const mean = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
        t.metric('fpsPost', Math.round(mean));
        if (mean > 0 && mean < 45 && innerWidth <= 900) t.problem('warning', `Low at ${innerWidth}x${innerHeight} ran at ${Math.round(mean)} fps (want 45)`);
      } else if (!p?.punches) t.problem('bug', 'no heavy hit or KO landed, so the hit punch could not be checked');
      else if (p.lastPunchDrawn !== 4) t.problem('bug', `the hit punch drew ${p.lastPunchDrawn} frames (want 4)`);
      else {
        t.event('post-punch', `a heavy hit or KO punched the screen for 4 frames (chromatic aberration and exposure, ${p.punches} so far)`);
        t.metric('fpsPost', Math.round(fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0));
      }
      t.progress(1);
      t.finish('done');
    } finally {
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
    }
  }

  /**
   * Fighter lighting: every stage's own key, rim and ambient colour on both fighters (a different colour look on each
   * stage, 1 to 4 across the run), a contact shadow under each fighter that shrinks and fades as they jump and is gone
   * above 300 units, a faint reflection on glossy floors (High). On a phone (touch, Low, turned) only the ambient tint
   * and the shadow run, and the fight holds 45 fps. Setup shortcut: straight into a match on each stage, no menus; the
   * option `stage` picks one. Events `stage-light`, `shadow-height`, `light-low`; metrics lightStages, fpsLight.
   */
  async lighting(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('lighting');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const low = touch || this.options.quality === 'low';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(low ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    try {
      const want = typeof this.options.stage === 'string' ? STAGES.filter((s) => s.id === this.options.stage) : STAGES;
      if (!want.length) t.problem('bug', `stage "${String(this.options.stage)}" is not on the list`);
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const foe = (punk + 1) % CHARACTERS.length;
      const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 0.01);
      const fps: number[] = [];
      const heights: { h: number; scale: number; alpha: number; shadow: boolean }[] = [];
      let lit = 0;
      for (const [i, st] of want.entries()) {
        t.progress(0.05 + (0.85 * i) / want.length);
        const looks = [i % 4, (i + 1) % 4];
        void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(st), stocks: 1, rules: {}, slots: [{ char: punk, cpu: null, look: looks[0] }, { char: foe, cpu: 5, look: looks[1] }] });
        await this.matchLive();
        await this.wait(900);
        const ls = this.game.lightStats?.();
        const l = st.light;
        if (!l) t.problem('bug', `${st.name} has no light in content/stages.json`);
        else if (!ls || ls.stage !== st.id || ls.fighters.length < 2) t.problem('bug', `${st.name}: the lighting pass reports ${JSON.stringify(ls)}`);
        else {
          const amb = hexRgb(l.ambient);
          const key = hexRgb(l.key.color);
          const wrong = ls.fighters.filter((f) => !close(f.plugin.ambient, amb) || !close(f.plugin.keyColor, key) || f.plugin.full === low);
          const looksOn = this.game.lookStats?.() ?? [];
          if (wrong.length) t.problem('bug', `${st.name}: ${wrong.length} fighter(s) do not carry the stage's light (${JSON.stringify(wrong[0].plugin)})`);
          else if (!ls.fighters.every((f) => f.shadow)) t.problem('bug', `${st.name}: a fighter on the floor has no contact shadow (${JSON.stringify(ls.fighters)})`);
          else if (!low && ls.glossy !== !!l.glossy) t.problem('bug', `${st.name}: glossy floor mismatch`);
          else {
            lit++;
            t.event('stage-light', `${st.name}: key ${l.key.color} from ${l.key.dir.join(',')}, rim ${l.rim.color}, ambient ${l.ambient}${l.glossy ? ', glossy floor' : ''} on both fighters (colours ${looksOn.map((x) => x.look + 1).join(' and ')}, ${ls.quality}), shadows under both`);
          }
        }
        // The bot jumps and fights: sample each fighter's shadow against its height over the platform below.
        const frame0 = this.game.match()?.state.frame ?? 0;
        let tick = 0;
        await this.fight(() => {
          const s = this.game.lightStats?.();
          if (s) for (const f of s.fighters) if (f.height >= 0 || !f.shadow) heights.push({ h: f.height, scale: f.scale, alpha: f.alpha, shadow: f.shadow });
          if (++tick % 20 === 0) fps.push(this.game.gfxStats?.()?.fpsNow ?? 0);
          return (this.game.match()?.state.frame ?? 0) - frame0 > 60 * 8;
        }, 120000);
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.metric('lightStages', lit);
      const airborne = heights.filter((x) => x.h > 20 && x.shadow);
      const grounded = heights.filter((x) => x.h >= 0 && x.h <= 2 && x.shadow);
      const bad = heights.filter((x) => (x.h >= SHADOW_RANGE && x.shadow) || (x.shadow && (x.scale > 1 || x.alpha > 0.55)));
      const maxH = Math.max(0, ...heights.map((x) => x.h));
      const hi = airborne.length ? airborne.reduce((a, b) => (b.h > a.h ? b : a)) : null;
      const lo = grounded[0];
      if (bad.length) t.problem('bug', `a contact shadow was drawn wrong (${JSON.stringify(bad[0])})`);
      else if (!hi || !lo) t.problem('warning', `the bot never left the floor in the sample (${heights.length} samples), so the shadow shrinking could not be seen`);
      else if (hi.scale >= lo.scale || hi.alpha >= lo.alpha) t.problem('bug', `the shadow does not shrink and fade with height (floor ${lo.scale}/${lo.alpha}, ${hi.h} units up ${hi.scale}/${hi.alpha})`);
      else t.event('shadow-height', `on the floor scale ${lo.scale}, alpha ${lo.alpha}; ${hi.h} units up scale ${hi.scale}, alpha ${hi.alpha}; highest sample ${maxH} units (${maxH >= SHADOW_RANGE ? 'shadow gone above ' + SHADOW_RANGE : 'under ' + SHADOW_RANGE + ', shadow still shown'})`);
      const mean = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
      t.metric('fpsLight', Math.round(mean));
      if (low) {
        t.event('light-low', `Low: ambient tint and contact shadows only, no key or rim, no reflection (${Math.round(mean)} fps)`);
        if (mean > 0 && mean < 45 && innerWidth <= 900) t.problem('warning', `Low at ${innerWidth}x${innerHeight} ran at ${Math.round(mean)} fps (want 45)`);
      }
      t.progress(1);
      t.finish('done');
    } finally {
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
    }
  }

  /**
   * Stage depth: every stage's picture layers sit at their own depths and the broadcast camera's pan and zoom slide them past
   * each other (4 or more depths behind the fighters on High, 3 on Low), one foreground element at the play area's edge fades
   * to 30% while a fighter walks behind it and comes back when they leave, and a distance haze tinted to the stage (High; Low
   * drops it). Setup shortcut: straight into a match on each stage (option `stage`: one), the bot off: the player walks to the
   * foreground element and back across the stage by the pad (keys, or the touch stick on a phone). Events `stage-depth`,
   * `parallax`, `foreground-fade`, `foreground-clear`, `haze`, `depth-low`; metrics depthLayers (fewest depths), depthFades, fpsDepth.
   */
  async stageDepth(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('stage-depth');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const low = touch || this.options.quality === 'low';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(low ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    try {
      const want = typeof this.options.stage === 'string' ? STAGES.filter((s) => s.id === this.options.stage) : STAGES;
      if (!want.length) t.problem('bug', `stage "${String(this.options.stage)}" is not on the list`);
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the stick controls were not built');
        t.finish('error');
        return;
      }
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const foe = (punk + 1) % CHARACTERS.length;
      const needDepths = low ? 3 : 4;
      const fps: number[] = [];
      let fewest = 99;
      let fades = 0;
      for (const [i, st] of want.entries()) {
        t.progress(0.05 + (0.9 * i) / want.length);
        void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(st), stocks: 3, rules: { timeLimit: 150 }, slots: [{ char: punk, cpu: null }, { char: foe, cpu: 0 }] });
        await this.matchLive();
        this.manual = NO_INPUT;
        pad.release();
        await this.wait(700);
        const ds0 = this.game.depthStats?.();
        if (!ds0) {
          t.problem('bug', `${st.name}: the renderer reports no depth stats`);
          await this.game.quitMatch();
          await this.screen('main');
          continue;
        }
        // 1. What is built: depths behind the fighters, the foreground, the haze sheets.
        const behind = ds0.layers.filter((l) => l.kind === 'far');
        const depths = new Set(behind.map((l) => l.z));
        const fgs = ds0.layers.filter((l) => l.kind === 'foreground');
        const sheets = ds0.layers.filter((l) => l.kind === 'haze');
        const depthCount = depths.size + (low && fgs.length ? 1 : 0);
        fewest = Math.min(fewest, depthCount);
        if (depthCount < needDepths) t.problem('bug', `${st.name}: ${depthCount} layers at different depths on ${low ? 'Low (counting the foreground)' : 'High'}, want ${needDepths}`);
        else t.event('stage-depth', `${st.name}: ${depths.size} depths behind the fighters (z ${[...depths].sort((a, b) => b - a).join(', ')}: ${[...behind].sort((a, b) => b.z - a.z).map((l) => l.id).join(', ')}), foreground ${fgs.map((l) => l.id).join(', ') || 'none'}, ${ds0.quality}`);
        if (low) {
          if (sheets.length) t.problem('bug', `${st.name}: Low still draws ${sheets.length} haze sheet(s)`);
          else t.event('depth-low', `${st.name}: Low drops the haze and the extra depth bands, keeps the foreground (${fgs.map((l) => l.id).join(', ')})`);
        } else if (sheets.length < 2) t.problem('bug', `${st.name}: ${sheets.length} haze sheet(s) on High, want 2 or more`);
        else t.event('haze', `${st.name}: ${sheets.length} haze sheets at z ${sheets.map((l) => l.z).join(', ')} tinted ${st.haze?.color} (${Math.round((st.haze?.strength ?? 0) * 100)}%)`);
        if (!fgs.length) {
          t.problem('bug', `${st.name}: no foreground element is built`);
          await this.game.quitMatch();
          await this.screen('main');
          continue;
        }
        // 2. The player walks to the foreground element (real input), then back across the stage; every ~100 ms the camera and
        // every layer's place on the page are sampled.
        const samples: { camX: number; camDist: number; at: Map<string, number> }[] = [];
        let tick = 0;
        const record = () => {
          const d = this.game.depthStats?.();
          if (!d) return;
          samples.push({ camX: d.camX, camDist: d.camDist, at: new Map(d.layers.map((l) => [l.id, l.screenX])) });
          if (++tick % 8 === 0) fps.push(this.game.gfxStats?.()?.fpsNow ?? 0);
        };
        const fgNow = () => this.game.depthStats?.()?.layers.filter((l) => l.kind === 'foreground') ?? [];
        const dir = Math.sign(st.layers!.find((l) => l.foreground)!.x) || 1;
        pad.stick(dir * 100, 0);
        let sawFade = false;
        let lowest = 1;
        await t.until(() => {
          record();
          const f = fgNow();
          lowest = Math.min(lowest, ...f.map((l) => l.alpha));
          if (f.some((l) => l.alpha <= 0.34)) {
            sawFade = true;
            return true;
          }
          return false;
        }, 16000, 'a fighter to walk behind the foreground element').catch(() => undefined);
        pad.release();
        if (sawFade) {
          fades++;
          t.event('foreground-fade', `${st.name}: ${fgNow().map((l) => `${l.id} ${Math.round(l.alpha * 100)}%`).join(', ')} with the fighter behind it (lowest ${Math.round(lowest * 100)}%)`);
        } else t.problem('bug', `${st.name}: the foreground element never turned see-through with a fighter behind it (lowest opacity ${Math.round(lowest * 100)}%)`);
        // Then the other way, across the whole stage: the element comes back and the camera pans.
        pad.stick(-dir * 100, 0);
        let cleared = false;
        await t.until(() => {
          record();
          if (fgNow().every((l) => l.alpha >= 0.95)) cleared = true;
          const m = this.game.match();
          const me = m?.state.fighters[m.player];
          return cleared && !!me && Math.abs(me.x / FX) > 300 && Math.sign(me.x) === -dir;
        }, 16000, 'the fighter to cross the stage').catch(() => undefined);
        pad.release();
        if (cleared) t.event('foreground-clear', `${st.name}: back to full opacity once the fighter walked out from behind it`);
        else t.problem('bug', `${st.name}: the foreground element stayed see-through after the fighter left`);
        // 3. Parallax: between the two camera positions furthest apart, how far each layer moved on the page.
        if (samples.length > 4) {
          let a = samples[0];
          let b = samples[0];
          for (const s of samples) {
            if (s.camX < a.camX) a = s;
            if (s.camX > b.camX) b = s;
          }
          const ds1 = this.game.depthStats?.();
          const groups = new Map<number, number[]>();
          for (const l of ds1?.layers ?? []) {
            if (l.kind === 'haze' || l.kind === 'stage' || !a.at.has(l.id) || !b.at.has(l.id)) continue;
            groups.set(l.z, [...(groups.get(l.z) ?? []), b.at.get(l.id)! - a.at.get(l.id)!]);
          }
          const moves = [...groups.entries()].sort((x, y) => y[0] - x[0]).map(([z, v]) => ({ z, px: v.reduce((p, q) => p + q, 0) / v.length }));
          const speeds: number[] = [];
          for (const m of moves) if (!speeds.some((p) => Math.abs(p - m.px) < 0.25)) speeds.push(m.px);
          const span = Math.abs(b.camX - a.camX);
          if (span < 0.4) t.problem('warning', `${st.name}: the camera only moved ${span.toFixed(2)} units, the parallax could not be measured`);
          else if (speeds.length < needDepths) t.problem('bug', `${st.name}: only ${speeds.length} layers moved at different speeds over a ${span.toFixed(1)} unit camera pan (want ${needDepths}): ${moves.map((m) => `z${m.z} ${m.px.toFixed(1)}px`).join(', ')}`);
          else t.event('parallax', `${st.name}: ${speeds.length} speeds over a ${span.toFixed(1)} unit camera pan: ${moves.map((m) => `z${m.z} ${m.px.toFixed(1)}px`).join(', ')}`);
        } else t.problem('warning', `${st.name}: too few camera samples (${samples.length}) to measure the parallax`);
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.metric('depthLayers', fewest === 99 ? 0 : fewest);
      t.metric('depthFades', fades);
      const mean = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
      t.metric('fpsDepth', Math.round(mean));
      if (low && mean > 0 && mean < 45 && innerWidth <= 900) t.problem('warning', `Low at ${innerWidth}x${innerHeight} ran at ${Math.round(mean)} fps (want 45)`);
      t.progress(1);
      t.finish('done');
    } finally {
      this.manual = null;
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
    }
  }

  /**
   * Readability: on every stage (option `stage`: one; a phone on Low takes the 3 busiest), two fighters stand at the left edge,
   * the centre, a top platform and the foreground element's edge, and the rendered frame is measured (`Renderer.readabilityProbe`,
   * readability.ts): (a) the contrast of each fighter's ring (the player-colour rim and the dark outline) with the background
   * around it, (b) the contrast of each platform's lit lip with the area just above it, (c) the share of each fighter foreground
   * art covers and whether the silhouette still shows. The player walks by the pad first (keys, or the touch stick on a phone);
   * the placements are a named setup shortcut. Events `readability-fighter`, `readability-platform`, `readability` (one line of
   * numbers per stage); metrics readabilityRing (worst ring contrast), readabilityEdge (worst platform edge), readabilityCover
   * (most covered), readabilityFails, and per stage `readability.<id>.ring|edge|cover`.
   */
  async readability(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('readability');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const low = touch || this.options.quality === 'low';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(low ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    try {
      // The busiest stages (layers, effects and zones) are the phone's worst case.
      const busy = [...STAGES].sort((a, b) => (b.layers?.length ?? 0) + (b.effects?.length ?? 0) + (b.zones?.length ?? 0) - ((a.layers?.length ?? 0) + (a.effects?.length ?? 0) + (a.zones?.length ?? 0))).slice(0, 3);
      const want = typeof this.options.stage === 'string' ? STAGES.filter((s) => s.id === this.options.stage) : low ? busy : STAGES;
      if (!want.length) t.problem('bug', `stage "${String(this.options.stage)}" is not on the list`);
      const pad = touch ? makeTouchPad() : makeKeyboardPad();
      if (!pad) {
        t.problem('bug', 'the stick controls were not built');
        t.finish('error');
        return;
      }
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const foe = (punk + 1) % CHARACTERS.length;
      let worstRing = 99;
      let worstEdge = 99;
      let mostCover = 0;
      let fails = 0;
      for (const [i, st] of want.entries()) {
        t.progress(0.05 + (0.9 * i) / want.length);
        void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(st), stocks: 3, rules: { timeLimit: 150 }, slots: [{ char: punk, cpu: null, look: 0 }, { char: foe, cpu: null, look: 1 }] });
        await this.matchLive();
        this.manual = NO_INPUT;
        pad.release();
        await this.wait(500);
        // Real input first: the player walks toward the left edge.
        pad.stick(-100, 0);
        await this.wait(600);
        pad.release();
        t.event('readability-walk', `${st.name}: the player walked left by ${touch ? 'the touch stick' : 'the keys'} before the placements`);
        // Where to stand: the left edge and centre of the widest floor, the top of the highest platform, the foreground's side.
        const plats = st.platforms.filter((p) => !p.offDuring && !p.onlyDuring);
        const floor = [...plats].filter((p) => !p.motion).sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1) || a.y - b.y)[0] ?? plats[0];
        const top = [...plats].filter((p) => !p.motion && p.x2 - p.x1 >= 120).sort((a, b) => b.y - a.y)[0] ?? floor;
        const fgSide = Math.sign(st.layers?.find((l) => l.foreground)?.x ?? 0);
        const spots: { name: string; x: number; y: number }[] = [
          { name: 'left edge', x: floor.x1 + 90, y: floor.y },
          { name: 'centre', x: (floor.x1 + floor.x2) / 2, y: floor.y },
          { name: 'top platform', x: (top.x1 + top.x2) / 2, y: top.y },
        ];
        if (fgSide > 0) spots.push({ name: 'foreground edge', x: floor.x2 - 90, y: floor.y });
        const put = (x: number, y: number) => {
          const m = this.game.match();
          if (!m) return;
          m.state.fighters.forEach((f, k) => {
            f.x = (x + (k === 0 ? -70 : 70)) * FX;
            f.y = y * FX;
            f.vx = f.vy = f.kbx = f.kby = 0;
            f.facing = k === 0 ? 1 : -1;
          });
        };
        const rings: number[] = [];
        const covers: number[] = [];
        const edges = new Map<number, number>();
        let measuredPlats = 0;
        let who = '';
        for (const sp of spots) {
          put(sp.x, sp.y);
          await this.wait(1300); // the camera eases onto them
          put(sp.x, sp.y);
          const probe = this.game.readabilityProbe?.([
            { id: 'bg', fighters: [], fg: true },
            { id: 'bare', fighters: [], fg: false },
            { id: 'f0', fighters: [0], fg: true },
            { id: 'f1', fighters: [1], fg: true },
            { id: 'f0bare', fighters: [0], fg: false },
            { id: 'f1bare', fighters: [1], fg: false },
          ]);
          if (!probe) {
            t.problem('bug', `${st.name}: the renderer could not capture the frame for the readability probe`);
            continue;
          }
          const fr = (id: string): Frame => ({ w: probe.w, h: probe.h, d: probe.shots[id] });
          for (const ft of probe.fighters.slice(0, 2)) {
            const nm = CHARACTERS[this.game.match()!.state.fighters[ft.slot].char].name;
            const ring = ringContrast(fr(`f${ft.slot}`), fr('bg'), ft.box);
            const cov = coverRead(fr(`f${ft.slot}bare`), fr('bare'), fr('bg'), fr(`f${ft.slot}`), ft.box);
            if (ring.px < 60) {
              t.problem('warning', `${st.name}, ${sp.name}: ${nm} could not be measured (${ring.px} px of silhouette in the frame)`);
              continue;
            }
            rings.push(ring.best);
            covers.push(cov.covered);
            const coverFail = cov.covered > MAX_COVER && cov.shown < MIN_SHOWN;
            const ringFail = ring.best < MIN_CONTRAST;
            if (ringFail) {
              fails++;
              t.problem('bug', `${st.name}, ${sp.name}: ${nm}'s ring is ${ring.best.toFixed(2)}:1 against the background (rim ${ring.rim.toFixed(2)}, outline ${ring.outline.toFixed(2)}; want ${MIN_CONTRAST}:1)`);
            }
            if (coverFail) {
              fails++;
              t.problem('bug', `${st.name}, ${sp.name}: foreground art covers ${Math.round(cov.covered * 100)}% of ${nm} and only ${Math.round(cov.shown * 100)}% of that still shows (want under ${Math.round(MAX_COVER * 100)}% covered, or ${Math.round(MIN_SHOWN * 100)}% showing)`);
            }
            t.event('readability-fighter', `${st.name}, ${sp.name}: ${nm} ring ${ring.best.toFixed(2)}:1 (rim ${ring.rim.toFixed(2)}, outline ${ring.outline.toFixed(2)}, ${ring.ringPx} px), ${Math.round(cov.covered * 100)}% under foreground art, ${Math.round(cov.shown * 100)}% of that shows [${probe.w}x${probe.h} ${probe.quality}]`);
            if (ring.best <= Math.min(...rings)) who = `${nm} ${sp.name}`;
          }
          for (const pl of probe.platforms) {
            const r = edgeContrast(fr('bare'), Math.max(0, pl.x1), Math.min(probe.w, pl.x2), pl.y, pl.lipPx);
            if (!r || Math.min(probe.w, pl.x2) - Math.max(0, pl.x1) < 40) continue;
            edges.set(pl.index, Math.min(edges.get(pl.index) ?? 99, r.contrast));
          }
        }
        measuredPlats = edges.size;
        for (const [index, c] of edges) {
          const bad = c < MIN_CONTRAST;
          if (bad) {
            fails++;
            t.problem('bug', `${st.name}: platform ${index}'s top edge is ${c.toFixed(2)}:1 against the area above it (want ${MIN_CONTRAST}:1)`);
          }
          t.event('readability-platform', `${st.name}: platform ${index} top edge ${c.toFixed(2)}:1${bad ? ' FAIL' : ''}`);
        }
        const unmeasured = st.platforms.filter((p, k) => !p.offDuring && !p.onlyDuring && !edges.has(k)).length;
        if (unmeasured) t.problem('warning', `${st.name}: ${unmeasured} platform(s) never fully on screen at a placement, edge not measured`);
        const ringMin = rings.length ? Math.min(...rings) : 0;
        const edgeMin = edges.size ? Math.min(...edges.values()) : 0;
        const coverMax = covers.length ? Math.max(...covers) : 0;
        if (rings.length) worstRing = Math.min(worstRing, ringMin);
        if (edges.size) worstEdge = Math.min(worstEdge, edgeMin);
        mostCover = Math.max(mostCover, coverMax);
        t.metric(`readability.${st.id}.ring`, Math.round(ringMin * 100) / 100);
        t.metric(`readability.${st.id}.edge`, Math.round(edgeMin * 100) / 100);
        t.metric(`readability.${st.id}.cover`, Math.round(coverMax * 100));
        t.event('readability', `${st.name}: worst fighter ring ${ringMin.toFixed(2)}:1 (${who}), worst platform edge ${edgeMin.toFixed(2)}:1 over ${measuredPlats} platforms, most covered ${Math.round(coverMax * 100)}% [${low ? 'Low' : 'High'}]`);
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.metric('readabilityRing', worstRing === 99 ? 0 : Math.round(worstRing * 100) / 100);
      t.metric('readabilityEdge', worstEdge === 99 ? 0 : Math.round(worstEdge * 100) / 100);
      t.metric('readabilityCover', Math.round(mostCover * 100));
      t.metric('readabilityFails', fails);
      t.progress(1);
      t.finish('done');
    } finally {
      this.manual = null;
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
    }
  }

  /**
   * The match mix (audio.ts, roomAudio.ts): every stage is its own room (`dod:mix-room` with the room's name, its
   * length and wet share; Low sends half), fighter sounds are panned by where the fighter stands (a hit played at the
   * left edge is 6+ dB louder in the left channel, one at the right edge in the right), and the mix is levelled to
   * -14 LUFS under a limiter (the in-game meter and sample peak are logged; the capture is judged by Hawkes Gen
   * audio.analyze). Setup shortcut: straight into a match on each of the 9 stages (option stage: one), then a
   * 2-minute match on `stage` (default humans-in-the-loop). Events `mix-room`, `pan-left`, `pan-right`, `pan-fight`,
   * `mix-level`; metrics `mixRooms`, `mixLufs`, `mixPeakDbfs`, `fpsMix`.
   */
  async mixRoom(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('mix-room');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    const low = touch || this.options.quality === 'low';
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(low ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    type Room = { stage: string | null; room: string; seconds: number; wet: number; low: boolean };
    const rooms: Room[] = [];
    const onRoom = (e: Event) => rooms.push((e as CustomEvent).detail as Room);
    const pans: number[] = [];
    const onTake = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; pan: number | null };
      if (d.pan != null) pans.push(d.pan);
    };
    window.addEventListener('dod:mix-room', onRoom);
    window.addEventListener('dod:sound-take', onTake);
    try {
      const want = typeof this.options.stage === 'string' ? STAGES.filter((s) => s.id === this.options.stage) : STAGES;
      if (!want.length) t.problem('bug', `stage "${String(this.options.stage)}" is not on the list`);
      const punk = CHARACTERS.findIndex((c) => c.id === 'exit-punk');
      const foe = (punk + 1) % CHARACTERS.length;
      const slots = [{ char: punk, cpu: null, look: 0 }, { char: foe, cpu: 5, look: 1 }];
      const seen = new Set<string>();
      const fps: number[] = [];
      for (const [i, st] of want.entries()) {
        t.progress(0.05 + (0.45 * i) / want.length);
        const before = rooms.length;
        void this.game.startMatch({ mode: 'versus', stage: STAGES.indexOf(st), stocks: 1, rules: {}, slots });
        await this.matchLive();
        await this.wait(600);
        const r = rooms.slice(before).find((x) => x.stage === st.id);
        const def = st.room;
        if (!def) t.problem('bug', `${st.name} has no room in content/stages.json`);
        else if (!r) t.problem('bug', `${st.name}: no dod:mix-room came out when the match started`);
        else if (r.room !== def.name) t.problem('bug', `${st.name}: mix-room says "${r.room}", the stage's room is "${def.name}"`);
        else if (seen.has(r.room)) t.problem('bug', `${st.name}: the room "${r.room}" is another stage's too`);
        else {
          seen.add(r.room);
          t.event('mix-room', `${st.name}: room "${r.room}", ${r.seconds} s, ${Math.round(r.wet * 100)}% wet on effects and voices${r.low ? ' (Low: half the send)' : ''}, none on music or menus`);
        }
        const frame0 = this.game.match()?.state.frame ?? 0;
        let tick = 0;
        await this.fight(() => {
          if (++tick % 20 === 0) fps.push(this.game.gfxStats?.()?.fpsNow ?? 0);
          return (this.game.match()?.state.frame ?? 0) - frame0 > 60 * 3;
        }, 60000);
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.metric('mixRooms', seen.size);

      // The long match on one stage: pans from real fighters, then the measured level.
      const stage = typeof this.options.stage === 'string' ? Math.max(0, STAGES.findIndex((s) => s.id === this.options.stage)) : Math.max(0, STAGES.findIndex((s) => s.id === 'humans-in-the-loop'));
      pans.length = 0;
      const vw = new VoiceWatch(t);
      vw.start();
      void this.game.startMatch({ mode: 'versus', stage, stocks: 9, rules: {}, slots });
      await this.matchLive();
      await this.wait(800);
      // A hit at each edge, then the real fight (the capture measures the channels of these two).
      this.game.probeHit?.(-0.8);
      t.event('pan-left', 'a heavy hit played at the left screen edge (pan -0.8): the left channel should be 6+ dB over the right (equal-power pan: about 16 dB)');
      await this.wait(1400);
      this.game.probeHit?.(0.8);
      t.event('pan-right', 'a heavy hit played at the right screen edge (pan 0.8)');
      await this.wait(1400);
      const frame0 = this.game.match()?.state.frame ?? 0;
      const total = Math.max(5, Number(this.options.seconds) || 120);
      let tick = 0;
      await this.fight(() => {
        if (++tick % 20 === 0) fps.push(this.game.gfxStats?.()?.fpsNow ?? 0);
        if (tick % 600 === 0) t.progress(0.5 + 0.45 * Math.min(1, ((this.game.match()?.state.frame ?? 0) - frame0) / (60 * total)));
        return (this.game.match()?.state.frame ?? 0) - frame0 > 60 * total;
      }, (total + 90) * 1000);
      vw.finish({ phone: touch });
      const fightPans = pans.filter((p) => Math.abs(p) !== 0.8 || pans.length > 2);
      if (fightPans.length < 5) t.problem('bug', `only ${fightPans.length} panned fighter sounds in the ${total} s match`);
      else {
        const lo = Math.min(...fightPans), hi = Math.max(...fightPans);
        t.event('pan-fight', `${fightPans.length} fighter sounds panned across ${lo.toFixed(2)} to ${hi.toFixed(2)} by where the fighters stood`);
        if (hi - lo < 0.2) t.problem('warning', `the fighter pans only span ${(hi - lo).toFixed(2)}`);
      }
      const mix = this.game.mixStats?.();
      if (!mix?.chain) t.problem('bug', 'the master chain (compressor, limiter) is not running');
      else {
        t.metric('mixLufs', mix.lufs);
        t.metric('mixPeakDbfs', mix.peakDbfs);
        t.event('mix-level', `${total} s match: about ${mix.lufs} LUFS short-term (target -14), sample peak ${mix.peakDbfs} dBFS (ceiling -1.4), makeup ${mix.makeupDb} dB`);
        if (mix.peakDbfs > -1) t.problem('bug', `the mix peaked at ${mix.peakDbfs} dBFS: over the -1 dBTP ceiling`);
        if (mix.lufs < -17 || mix.lufs > -11) t.problem('warning', `the in-game meter reads ${mix.lufs} LUFS, target -14`);
      }
      await this.game.quitMatch();
      const mean = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
      t.metric('fpsMix', Math.round(mean));
      if (low && mean > 0 && mean < 45 && innerWidth <= 900) t.problem('warning', `with the reverb on, Low at ${innerWidth}x${innerHeight} ran at ${Math.round(mean)} fps (want 45)`);
      else t.event('mix-fps', `${Math.round(mean)} fps with panning and the room reverb on (${low ? 'Low' : 'High'})`);
      t.progress(1);
      t.finish('done');
    } finally {
      window.removeEventListener('dod:mix-room', onRoom);
      window.removeEventListener('dod:sound-take', onTake);
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
    }
  }

  /**
   * The art bible on the roster (docs/art-bible.md, artStyle.ts): both fighters of a match carry the remap and the outline
   * pass, the outline is a dark coloured line (never black) about 2 px at 1080p and never under 1 px (on a phone at 844x390
   * it is 1 px), and colour looks 1 to 4 keep both (the outline turns with the look). Also reports the style report: how
   * many of the 33 fighters are outside the saturation and value ranges. Setup shortcut: straight into a match per look,
   * no menus. Events `style-report`, `outline`, `outline-looks`, `outline-phone`; metrics `outlinePx`, `fightersOutside`.
   */
  async artStyle(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('art-style');
    }
    this.logViewport(touch && this.isPhone());
    const original = localStorage.getItem(GFX_KEY);
    const initial = graphics();
    await this.toMainMenu();
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    setGraphics(touch || this.options.quality === 'low' ? { quality: 'low', glow: false } : { quality: 'high', glow: true });
    try {
      const outside = CHARACTERS.filter((c) => !c.style || outsideRanges(c.style.after).length);
      t.metric('fightersOutside', outside.length);
      if (outside.length) t.problem('bug', `${outside.length} of ${CHARACTERS.length} fighters are outside the art bible's ranges (${outside.map((c) => c.id).join(', ')})`);
      else t.event('style-report', `0 of ${CHARACTERS.length} fighters outside the art bible's ranges (saturation ${ART.ranges.sMean.join('-')}, value ${ART.ranges.vP5.join('-')} low end, ${ART.ranges.vP95.join('-')} high end)`);
      const first = Math.max(0, Number(this.options.fighter) || 0);
      const picks = typeof this.options.fighter === 'string' ? [CHARACTERS.findIndex((c) => c.id === this.options.fighter)] : [first, first + 7, first + 14, first + 21];
      const stage = typeof this.options.stage === 'string' ? Math.max(0, STAGES.findIndex((s) => s.id === this.options.stage)) : 0;
      let seen = 0;
      for (let look = 0; look < 4; look++) {
        t.progress(0.1 + (0.8 * look) / 4);
        const a = picks[look % picks.length] % CHARACTERS.length;
        const b = (a + 11) % CHARACTERS.length;
        void this.game.startMatch({ mode: 'versus', stage, stocks: 1, rules: {}, slots: [{ char: a, cpu: null, look }, { char: b, cpu: 5, look: (look + 1) % 4 }] });
        await this.matchLive();
        await this.wait(900);
        const st = this.game.styleStats?.();
        if (!st || st.fighters.length < 2) {
          t.problem('bug', `the style pass reports ${JSON.stringify(st)}`);
        } else {
          const want = outlineWidthPx(st.renderHeight);
          for (const f of st.fighters) {
            const [r, g, bl] = f.outline.color;
            const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
            const name = CHARACTERS[f.char].name;
            if (!f.remap || !f.outlinePass) t.problem('bug', `${name} (look ${f.look + 1}) is missing the ${f.remap ? 'outline' : 'remap'} pass`);
            else if (mx < 24 || mx > 70 || mx - mn < 8) t.problem('bug', `${name} (look ${f.look + 1}): outline ${f.outline.color.join(',')} is not a dark coloured line`);
            else if (f.outline.px < 1 || Math.abs(f.outline.px - want) > 0.05) t.problem('bug', `${name}: outline is ${f.outline.px.toFixed(2)} px, want ${want.toFixed(2)} at render height ${st.renderHeight}`);
            else {
              seen++;
              t.event('outline', `${name}, look ${f.look + 1}: coloured outline rgb(${f.outline.color.join(',')}) ${f.outline.px.toFixed(2)} px at ${st.renderHeight}p with the saturation/value remap, ${st.quality}`);
            }
          }
          if (look === 0) t.metric('outlinePx', Math.round(Math.min(...st.fighters.map((f) => f.outline.px)) * 100) / 100);
          if (look === 0 && innerWidth <= 900 && innerHeight <= 500) {
            const px = Math.min(...st.fighters.map((f) => f.outline.px));
            if (px >= 1) t.event('outline-phone', `${innerWidth}x${innerHeight}: outline ${px.toFixed(2)} px on both fighters (at least 1)`);
            else t.problem('bug', `${innerWidth}x${innerHeight}: outline is ${px.toFixed(2)} px, under 1`);
          }
        }
        await this.fight(() => (this.game.match()?.state.frame ?? 0) > 60 * 3, 60000);
        await this.game.quitMatch();
        await this.screen('main');
      }
      t.event('outline-looks', `colour looks 1 to 4 each drawn with the remap and the outline (${seen} fighter draws checked)`);
      t.progress(1);
      t.finish('done');
    } finally {
      setGraphics(initial);
      if (original === null) localStorage.removeItem(GFX_KEY);
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
  /**
   * Season 1 fighter voice (effort / hurt / KO / taunt). Setup unlocks the Season 1 card, then a versus 1v1
   * (default Exit Punk vs Break; options fighter / foe). Logs every `dod:fighter-voice` bark, presses T for a taunt,
   * and checks no overlap and no effort within 1.5 s from the same fighter. On a portrait phone it turns to landscape
   * like smoke / touch-match.
   */
  async fighterVoice(): Promise<void> {
    const t = this.t;
    if (this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      return this.touchMatchTurned('fighter-voice');
    }
    this.logViewport(this.phoneScenario());

    type V = { who: string; kind: string; id: string; text: string; audio: string; at: number };
    const voices: V[] = [];
    const lastEnd = new Map<string, number>();
    const lastEffort = new Map<string, number>();
    const onVoice = (e: Event) => {
      const d = (e as CustomEvent).detail as V;
      voices.push(d);
      t.event(`voice-${d.kind}`, `${d.who}: "${d.text}" (${d.id} → ${d.audio})`);
      if (!d.audio || !d.audio.includes(`/audio/voice/${d.id}`)) {
        t.problem('bug', `fighter voice ${d.id} is not from that fighter's take under audio/voice/`);
      }
      const prevEnd = lastEnd.get(d.who) ?? 0;
      if (d.at < prevEnd - 20) t.problem('bug', `${d.who}: two lines overlapped (${d.kind} at ${Math.round(d.at)} vs busy until ${Math.round(prevEnd)})`);
      lastEnd.set(d.who, d.at + 400);
      if (d.kind === 'effort') {
        const prev = lastEffort.get(d.who);
        if (prev !== undefined && d.at - prev < 1480) {
          t.problem('bug', `${d.who}: effort repeated within 1.5 s (${Math.round(d.at - prev)} ms)`);
        }
        lastEffort.set(d.who, d.at);
      }
    };
    window.addEventListener('dod:fighter-voice', onVoice);
    // The voice director's trace over the whole run: no overlap beyond the crossfade, the duck, no repeats, one caption.
    const vw = new VoiceWatch(t);
    const phone = this.phoneScenario();
    // Desktop plays three 3-stock matches back to back (the 5 minute no-repeat rule); a phone plays one in the turned frame.
    const matches = Math.max(1, Number(this.options.matches) || (phone ? 1 : 3));

    const koTexts = CHARACTERS.map(({ id }) => {
      const l = VOICE.lines.find((x) => x.id === `fighter.${id}.ko`);
      return { id, text: l?.text ?? '' };
    });
    const shared = koTexts.filter((a, i) => a.text === 'Aaaaagh!' || koTexts.findIndex((b) => b.text === a.text) !== i);
    if (shared.length) t.problem('bug', `fighters share a KO text: ${shared.map((s) => `${s.id}="${s.text}"`).join(', ')}`);
    else t.event('ko-texts-unique', `${koTexts.length} fighter KO cries, all different`);

    const meId = typeof this.options.fighter === 'string' ? this.options.fighter : 'exit-punk';
    const taunt = VOICE.lines.find((l) => l.id === `fighter.${meId}.taunt`);
    if (taunt) {
      const words = taunt.text.trim().split(/\s+/).filter(Boolean).length;
      if (words > 4) t.problem('bug', `taunt "${taunt.text}" has ${words} words (max 4)`);
      else t.event('taunt-words', `"${taunt.text}" (${words} words)`);
    }

    const savedUnlocks = [...unlocks()];
    for (const id of [...SEASON_ONE, String(this.options.fighter || ''), String(this.options.foe || '')]) if (LOCKABLE.has(id)) unlocks().add(id);
    saveUnlocks(unlocks());

    try {
      if (!this.options.fighter) this.options.fighter = 'exit-punk';
      if (!this.options.foe) this.options.foe = 'break';
      await this.toMainMenu();
      t.progress(0.08);
      vw.start();
      await this.startVersus(3);
      t.progress(0.15);
      await this.matchLive();
      // Press T for the player's taunt (no touch button on phones).
      if (!this.isPhone()) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true }));
        await this.t.wait(50);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyT', key: 't', bubbles: true }));
        // Event fires after the take starts decoding; give the buffer a moment.
        await this.t.until(() => voices.some((v) => v.kind === 'taunt'), 3000, 'taunt bark after T').catch(() => null);
        if (!voices.some((v) => v.kind === 'taunt')) t.problem('bug', 'pressing T did not play a taunt line');
        else t.event('taunt-key', `T played ${voices.filter((v) => v.kind === 'taunt').map((v) => v.id).join(', ')}`);
      }
      this.progressNow = () => {
        const m = this.game.match();
        if (!m) return 0.9;
        const stocks = m.setup.stocks;
        const lost = m.state.fighters.reduce((n, f) => n + (stocks - Math.max(0, f.stocks)), 0);
        return 0.15 + 0.7 * Math.min(1, lost / Math.max(1, (m.state.fighters.length * stocks) / 2));
      };
      await this.fight(() => false, 4 * 60 * 1000);
      if (this.game.match()?.state.over) await this.results().catch(() => null);
      else await this.quitFromPause('main');
      if (currentScreen() === 'results') await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu').catch(() => null);
      for (let n = 2; n <= matches; n++) {
        t.event('voice-match', `match ${n} of ${matches}, 3 stocks, back to back`);
        await this.screen('main');
        await this.startVersus(3);
        await this.matchLive();
        await this.fight(() => false, 4 * 60 * 1000);
        if (this.game.match()?.state.over) await this.results().catch(() => null);
        else await this.quitFromPause('main');
        if (currentScreen() === 'results') await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu').catch(() => null);
      }
      t.metric('voiceMatches', matches);
      vw.finish({ phone });

      const byWho = new Map<string, Set<string>>();
      for (const v of voices) {
        if (!byWho.has(v.who)) byWho.set(v.who, new Set());
        byWho.get(v.who)!.add(v.kind);
      }
      const pair = [String(this.options.fighter || 'exit-punk'), String(this.options.foe || 'break')];
      for (const who of pair) {
        const kinds = byWho.get(who) ?? new Set();
        for (const need of ['effort', 'hurt', 'ko'] as const) {
          if (!kinds.has(need)) t.problem('bug', `${who}: no ${need} bark logged in this fight`);
          else t.event(`has-${need}`, `${who} played a ${need}`);
        }
        // Preflight: every Season 1 take file for this fighter must exist (404s fail even if no bark fired).
        {
          const nEffort = SEASON_ONE.includes(who) ? 3 : 2;
          const ids = [
            `fighter.${who}.ko`,
            `fighter.${who}.taunt`,
            ...Array.from({ length: nEffort }, (_, i) => `fighter.${who}.effort.${i}`),
            ...[0, 1].map((i) => `fighter.${who}.hurt.${i}`),
          ];
          for (const lid of ids) {
            const line = VOICE.lines.find((x) => x.id === lid);
            if (!line?.audio) t.problem('bug', `${lid}: missing from voice catalog`);
            else if (!(await exists(line.audio))) t.problem('bug', `${who}: voice file missing (404): ${line.audio}`);
          }
        }
      }
      t.metric('voiceEfforts', voices.filter((v) => v.kind === 'effort').length);
      t.metric('voiceHurts', voices.filter((v) => v.kind === 'hurt').length);
      t.metric('voiceKos', voices.filter((v) => v.kind === 'ko').length);
      t.metric('voiceTaunts', voices.filter((v) => v.kind === 'taunt').length);
      t.event('fighter-voice-summary', `${voices.length} barks: ${[...byWho.entries()].map(([w, k]) => `${w}[${[...k].join(',')}]`).join('; ')}`);
    } finally {
      vw.stop();
      window.removeEventListener('dod:fighter-voice', onVoice);
      unlocks().clear();
      for (const id of savedUnlocks) unlocks().add(id);
      saveUnlocks(unlocks());
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * The victory stage (ui/victory.ts, victory.ts): a Versus 1v1 (options fighter / foe, default Exit Punk vs Kaelen) played twice.
   * Round 1: the results open on the winner on a lit podium playing a clip (`victory-stage`), the group's fanfare plays
   * (`victory-fanfare`: the group of content/fighters.json `fanfare`, its file on disk), the loser shows in a dim inset
   * (`victory-loser`), the camera pushes in (`victory-push`) with confetti (`victory-confetti`), Rematch is on screen and
   * tappable within 3 s (`victory-rematch`), the panel slides in (`victory-panel`) with the podium beside it on a landscape
   * phone and every button 44 px tall (`victory-fit`). Round 2: a tap on the stage skips the pose (`victory-skip`).
   * On a phone every tap is a touch pointer event (390x844 turned to 844x390). Metric `victoryMs` (results open to Rematch).
   */
  async victoryRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('victory');
    }
    this.logViewport(touch && this.isPhone());
    if (typeof this.options.fighter !== 'string') this.options.fighter = 'exit-punk';
    if (typeof this.options.foe !== 'string') this.options.foe = 'kaelen';
    type V = { group: string; fanfare: string; hasFanfare: boolean; winner: string; loser: string | null };
    const opened: { v: V; at: number }[] = [];
    const fanfares: { id: string; file: string | null; played: boolean }[] = [];
    const clips: { role: string; clip: string | null }[] = [];
    const panels: { why: string; ms: number }[] = [];
    const on = (type: string, fn: (d: any) => void) => {
      const f = (e: Event) => fn((e as CustomEvent).detail);
      window.addEventListener(type, f);
      return () => window.removeEventListener(type, f);
    };
    const offs = [
      on('dod:victory', (d) => opened.push({ v: d, at: performance.now() })),
      on('dod:fanfare', (d) => fanfares.push(d)),
      on('dod:victory-clip', (d) => clips.push(d)),
      on('dod:victory-panel', (d) => panels.push(d)),
    ];
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const onScreen = (r: DOMRect | null) => !!r && r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    try {
      await this.toMainMenu();
      await this.startVersus(1);
      for (let round = 1; round <= 2; round++) {
        t.progress(0.1 + 0.4 * (round - 1));
        const before = opened.length;
        await this.fight(() => false, 6 * 60 * 1000);
        await this.screen('results', 30000);
        await t.until(() => opened.length > before, 5000, 'the victory stage to open').catch(() => null);
        const o = opened[opened.length - 1];
        const stage = this.q('#results-body .victory');
        if (!o || opened.length <= before || !stage) {
          t.problem('bug', `round ${round}: the results screen opened with no victory stage`);
          break;
        }
        const t0 = o.at;
        // The podium: a lit stage, the winner playing a clip on the plinth.
        await t.until(() => clips.some((c) => c.role === 'winner'), 6000, 'the winner clip').catch(() => null);
        const winClip = clips.filter((c) => c.role === 'winner').pop();
        const sprite = this.q('#results-body .vic-winner .vic-sprite');
        const sr = rect(this.q('#results-body .vic-winner'));
        if (!this.q('#results-body .vic-plinth') || !this.q('#results-body .vic-beam')) t.problem('bug', `round ${round}: the podium has no plinth or no light`);
        else if (!winClip?.clip || !sprite || !onScreen(sr)) t.problem('bug', `round ${round}: the winner is not playing a clip on the podium (${winClip?.clip ?? 'no clip'}, ${sr ? `${Math.round(sr.width)}x${Math.round(sr.height)}` : 'no box'})`);
        else t.event('victory-stage', `round ${round}: ${o.v.winner} on the lit podium playing "${winClip.clip}" (${o.v.group}), ${Math.round(sr!.width)}x${Math.round(sr!.height)} px`);
        // The fanfare: the fighter's group, a file that exists.
        const f = fanfares[fanfares.length - 1];
        const group = FIGHTERS_DATA.find((x) => x.id === o.v.winner)?.fanfare ?? '';
        const file = SOUNDS.find((x) => x.id === o.v.fanfare)?.file;
        if (o.v.group !== group) t.problem('bug', `round ${round}: ${o.v.winner} won with group "${o.v.group}", content/fighters.json says "${group}"`);
        else if (!f || f.id !== o.v.fanfare || !f.played || !file) t.problem('bug', `round ${round}: the ${o.v.group} fanfare (${o.v.fanfare}) did not play${file ? '' : ' (no sound made yet)'}`);
        else if (!(await exists(file))) t.problem('bug', `round ${round}: fanfare file missing (404): ${file}`);
        else t.event('victory-fanfare', `round ${round}: ${o.v.group} fanfare ${o.v.fanfare} from ${file}`);
        // The loser: dim, in an inset, sulking.
        const inset = this.q('#results-body .vic-inset');
        const ir = rect(inset);
        if (!inset || !onScreen(ir) || inset.dataset.mood !== 'sulking') t.problem('bug', `round ${round}: no loser inset sulking on screen`);
        else t.event('victory-loser', `round ${round}: ${o.v.loser} in the inset (${clips.filter((c) => c.role === 'loser').pop()?.clip ?? 'still'}), ${Math.round(ir!.width)}x${Math.round(ir!.height)} px, mood ${inset.dataset.mood}`);
        // The push-in and the confetti.
        const cam = this.q('#results-body .vic-cam');
        const scaleOf = () => new DOMMatrixReadOnly(getComputedStyle(cam!).transform).a;
        const s1 = scaleOf();
        await t.wait(700);
        const s2 = scaleOf();
        const confetti = Number(stage.dataset.confetti ?? 0);
        if (!(s2 > s1)) t.problem('bug', `round ${round}: the camera is not pushing in (scale ${s1.toFixed(3)} -> ${s2.toFixed(3)})`);
        else t.event('victory-push', `round ${round}: camera push-in ${s1.toFixed(3)} -> ${s2.toFixed(3)}`);
        if (confetti < 1) t.problem('bug', `round ${round}: no confetti on the stage`);
        else t.event('victory-confetti', `round ${round}: ${confetti} pieces in the air, colour ${getComputedStyle(stage).getPropertyValue('--slot').trim()}`);
        if (round === 1) {
          // Rematch within 3 s of the results opening: on screen, 44 px, nothing over it.
          const rematch = this.button('#results-actions', 'Rematch');
          const rb = rect(rematch ?? null);
          const ms = Math.round(performance.now() - t0);
          const mid = rb ? document.elementFromPoint(rb.left + rb.width / 2, rb.top + rb.height / 2) : null;
          if (!rematch || !onScreen(rb) || rb!.height < 44 || (rematch as HTMLButtonElement).disabled || !mid || !rematch.contains(mid)) t.problem('bug', `round ${round}: Rematch is not tappable ${ms} ms after the results opened`);
          else if (ms > 3000) t.problem('bug', `round ${round}: Rematch took ${ms} ms to be tappable`);
          else {
            t.event('victory-rematch', `round ${round}: Rematch tappable ${ms} ms after the results opened (${Math.round(rb!.width)}x${Math.round(rb!.height)} px)`);
            t.metric('victoryMs', ms);
          }
          // The panel slides in; the podium and the panel side by side on a landscape phone; every button 44 px.
          await t.until(() => panels.length > 0 && this.q('#results-body .results-row')?.dataset.phase === 'panel', 5000, 'the results panel').catch(() => null);
          await t.wait(500);
          const pr = rect(this.q('#results-body .results-panel'));
          const vr = rect(stage);
          const landscape = innerWidth > innerHeight;
          const small = Math.min(innerWidth, innerHeight) <= 560;
          const btns = [...document.querySelectorAll<HTMLElement>('#results-actions button')].map((b) => b.getBoundingClientRect());
          const short = btns.filter((b) => b.height < 44 || b.width < 44);
          if (!pr || !vr || !onScreen(vr) || pr.right > innerWidth + 1 || pr.width < 100) t.problem('bug', `round ${round}: the panel did not slide in beside the podium at ${innerWidth}x${innerHeight}`);
          else if (small && landscape && vr.right > pr.left + 1) t.problem('bug', `round ${round}: at ${innerWidth}x${innerHeight} the podium is not left of the panel`);
          else if (short.length || !btns.length || btns.some((b) => b.bottom > innerHeight + 1 || b.right > innerWidth + 1)) t.problem('bug', `round ${round}: result buttons are under 44 px or off screen at ${innerWidth}x${innerHeight}`);
          else t.event('victory-fit', `round ${round}: podium ${Math.round(vr.width)}x${Math.round(vr.height)} left, panel ${Math.round(pr.width)}x${Math.round(pr.height)} right, ${btns.length} buttons all >= 44 px, at ${innerWidth}x${innerHeight}`);
          t.event('victory-panel', `round ${round}: panel in ${panels[panels.length - 1]?.ms} ms (${panels[panels.length - 1]?.why})`);
          this.checkClipping('results with victory stage', this.q('#results'));
          await this.click(() => this.button('#results-actions', 'Rematch'), 'Rematch');
        } else {
          // Any input skips the pose: a tap on the stage brings the panel at once.
          const row = this.q('#results-body .results-row');
          if (row?.dataset.phase !== 'pose') {
            t.event('victory-skip', `round ${round}: panel was already in (${panels[panels.length - 1]?.why})`);
          } else {
            const n = panels.length;
            await this.tap(() => this.q('#results-body .victory'), 'the victory stage');
            await t.until(() => panels.length > n, 1000, 'the pose to skip').catch(() => null);
            if (panels[panels.length - 1]?.why !== 'input') t.problem('bug', `round ${round}: a tap on the stage did not skip the pose`);
            else t.event('victory-skip', `round ${round}: a tap skipped the pose after ${panels[panels.length - 1].ms} ms`);
          }
        }
      }
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu').catch(() => null);
    } finally {
      for (const off of offs) off();
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * Win quotes (content/voice.json winQuotes, winQuote.ts, ui/quoteCaption.ts): a Versus 1v1 between two story rivals
   * (options fighter / foe, default Exit Punk vs Kaelen), played twice (Rematch). On each results screen the winner's quote
   * must play as a recorded take (`dod:win-quote-play`) with a typed-on caption of the same words (`quote-caption`), the
   * matchup quote when the loser is the winner's rival (`quote-matchup`), never the quote the same fighter played last
   * (`quote-repeat`), and at 844x390 the caption fits in two lines inside the screen with Rematch visible and uncovered
   * (`quote-fit`, `quote-rematch`). On a phone every tap is a touch pointer event. Events `quote-voice`, `quote-caption`,
   * `quote-matchup`, `quote-repeat`, `quote-fit`, `quote-rematch`; metric `winQuotes`.
   */
  async winQuoteRun(): Promise<void> {
    const t = this.t;
    const touch = this.options.input === 'touch' || this.options.at === 'phone' || this.options.at === 'phone-turned' || this.isPhone();
    if (touch && this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      this.logViewport(true);
      return this.touchMatchTurned('win-quote');
    }
    this.logViewport(touch && this.isPhone());
    if (typeof this.options.fighter !== 'string') this.options.fighter = 'exit-punk';
    if (typeof this.options.foe !== 'string') this.options.foe = 'kaelen';
    type Q = { id: string; text: string; audio: string | null; kind: string; winner: string; loser: string | null; losers: string[] };
    const picks: Q[] = [];
    const played: string[] = [];
    const typed: string[] = [];
    const onPick = (e: Event) => picks.push((e as CustomEvent).detail as Q);
    const onPlay = (e: Event) => played.push(String((e as CustomEvent).detail?.id));
    const onTyped = (e: Event) => typed.push(String((e as CustomEvent).detail?.id));
    window.addEventListener('dod:win-quote', onPick);
    window.addEventListener('dod:win-quote-play', onPlay);
    window.addEventListener('dod:win-quote-typed', onTyped);
    if (touch) {
      this.useTap = true;
      forceTouchUi(true);
    }
    const lastBy = new Map<string, string>();
    try {
      await this.toMainMenu();
      await this.startVersus(1);
      for (let round = 1; round <= 2; round++) {
        t.progress(0.1 + 0.4 * (round - 1));
        await this.fight(() => false, 6 * 60 * 1000);
        await this.screen('results', 30000);
        const q = picks[picks.length - 1];
        if (!q) {
          t.problem('bug', `round ${round}: the results screen had no win quote`);
          break;
        }
        // The caption: typed on, then the whole line.
        await t.until(() => typed.includes(q.id) || !!this.q('#results-body .win-quote[data-state="done"]'), 8000, 'the quote caption to finish typing').catch(() => null);
        const cap = this.q('#results-body .win-quote');
        const words = cap?.getAttribute('aria-label') ?? '';
        if (!cap || words !== q.text || !cap.textContent?.includes(q.text)) t.problem('bug', `round ${round}: the results caption "${cap?.textContent ?? ''}" is not the quote "${q.text}"`);
        else t.event('quote-caption', `round ${round}: ${q.winner} says "${q.text}" (${q.kind}, ${q.id}), caption typed on`);
        // Voiced: a played take whose file is there.
        await t.until(() => played.includes(q.id), 9000, 'the quote to play').catch(() => null);
        if (!q.audio) t.problem('bug', `round ${round}: "${q.id}" has no recorded take (voice file not made yet)`);
        else if (!played.includes(q.id)) t.problem('bug', `round ${round}: "${q.id}" did not play on the results screen`);
        else if (!(await exists(q.audio))) t.problem('bug', `round ${round}: voice file missing (404): ${q.audio}`);
        else t.event('quote-voice', `round ${round}: ${q.id} played from ${q.audio}`);
        // The matchup quote when the loser is the winner's rival; never the previous quote.
        const rivalQuote = VOICE.winQuotes?.[q.winner]?.vs[q.losers[0]];
        const prev = lastBy.get(q.winner);
        if (rivalQuote && rivalQuote.id !== prev) {
          if (q.kind !== 'rival' || q.id !== rivalQuote.id) t.problem('bug', `round ${round}: ${q.winner} beat their rival ${q.losers[0]} but said ${q.id}, not ${rivalQuote.id}`);
          else t.event('quote-matchup', `round ${round}: ${q.winner} beat rival ${q.losers[0]} with the matchup quote`);
        }
        if (prev === q.id) t.problem('bug', `round ${round}: ${q.winner} said ${q.id} twice in a row`);
        else if (prev) t.event('quote-repeat', `round ${round}: ${q.winner} said ${q.id}, last time ${prev}: no repeat`);
        lastBy.set(q.winner, q.id);
        // Fit: two lines at most, inside the screen, Rematch visible and not under the caption.
        const lh = parseFloat(getComputedStyle(cap!).lineHeight) || parseFloat(getComputedStyle(cap!).fontSize) * 1.25;
        const box = cap!.getBoundingClientRect();
        const lines = Math.round(box.height / lh);
        const rematch = this.button('#results-actions', 'Rematch') ?? this.button('#results-actions', 'Main menu');
        const rb = rematch?.getBoundingClientRect();
        const inside = box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1;
        if (lines > 2) t.problem('bug', `round ${round}: the quote caption runs ${lines} lines at ${innerWidth}x${innerHeight} (two at most)`);
        else if (!inside) t.problem('bug', `round ${round}: the quote caption is not inside the screen at ${innerWidth}x${innerHeight}`);
        else t.event('quote-fit', `round ${round}: caption ${lines} line(s), ${Math.round(box.width)}x${Math.round(box.height)} px at ${innerWidth}x${innerHeight}`);
        if (!rb || rb.width < 44 || rb.height < 44 || rb.bottom > innerHeight + 1 || rb.right > innerWidth + 1 || rb.top < 0) t.problem('bug', `round ${round}: Rematch is not fully on screen at ${innerWidth}x${innerHeight}`);
        else if (rb.top < box.bottom && rb.bottom > box.top && rb.left < box.right && rb.right > box.left) t.problem('bug', `round ${round}: the quote caption covers Rematch`);
        else t.event('quote-rematch', `round ${round}: Rematch visible at ${Math.round(rb.left)},${Math.round(rb.top)} ${Math.round(rb.width)}x${Math.round(rb.height)}, clear of the caption`);
        this.checkClipping('results with quote', this.q('#results'));
        if (round < 2) await this.click(() => this.button('#results-actions', 'Rematch'), 'Rematch');
      }
      t.metric('winQuotes', picks.length);
      await this.click(() => this.button('#results-actions', 'Main menu'), 'Main menu').catch(() => null);
    } finally {
      window.removeEventListener('dod:win-quote', onPick);
      window.removeEventListener('dod:win-quote-play', onPlay);
      window.removeEventListener('dod:win-quote-typed', onTyped);
      if (touch) {
        this.useTap = false;
        forceTouchUi(false);
      }
    }
    t.progress(1);
    t.finish('done');
  }

  /**
   * Pre-fight exchange (content/intros.json, ui/scene.ts playExchange): a Versus match between a listed rival pair
   * (options fighter / foe, default Exit Punk vs Kaelen). Round 1: a tap skips the exchange once its first line shows
   * (must end within 300 ms) and the caption fits in two lines inside the screen. Round 2 (the same match again) plays
   * out: both voiced lines, the camera on each speaker, the listener's taunt, 6 s at most. On a 390x844 phone it is
   * turned to 844x390 and every press is a touch pointer event.
   */
  async introExchange(): Promise<void> {
    const t = this.t;
    if (this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      return this.touchMatchTurned('intro-exchange');
    }
    this.logViewport(this.phoneScenario());
    type X = { id: string; phase: string; at: number; index?: number; who?: string; text?: string; audio?: string; focus?: number; skipped?: boolean; ms?: number };
    const seen: X[] = [];
    const onX = (e: Event) => {
      const d = (e as CustomEvent).detail as X;
      seen.push(d);
      t.event(`exchange-${d.phase}`, `${d.id} ${d.who ? `${d.who}: "${d.text}" ` : ''}at ${d.at} ms${d.focus !== undefined ? ` camera on ${d.focus}` : ''}${d.ms !== undefined ? ` (${d.ms} ms${d.skipped ? ', skipped' : ''})` : ''}`);
    };
    window.addEventListener('dod:exchange', onX);
    const savedUnlocks = [...unlocks()];
    for (const id of [...SEASON_ONE, String(this.options.fighter || ''), String(this.options.foe || '')]) if (LOCKABLE.has(id)) unlocks().add(id);
    saveUnlocks(unlocks());
    try {
      if (!this.options.fighter) this.options.fighter = 'exit-punk';
      if (!this.options.foe) this.options.foe = 'kaelen';
      const a = String(this.options.fighter);
      const b = String(this.options.foe);
      const pair = pairFor(a, b);
      if (!pair) t.problem('bug', `${a} and ${b} are not a listed rival pair in content/intros.json`);
      t.metric('exchangePairs', PAIRS.length);
      t.event('exchange-data', `${PAIRS.length} rival pairs, each two voiced lines`);
      if (PAIRS.length < 32 || PAIRS.some((p) => p.lines.length !== 2 || p.lines.some((l) => !l.audio))) t.problem('bug', 'content/intros.json needs 32 pairs with two voiced lines each');
      for (const l of pair?.lines ?? []) if (!(await exists(l.audio))) t.problem('bug', `exchange voice file missing (404): ${l.audio}`);

      await this.toMainMenu();
      await this.startVersus(2);
      // Round 1: skip it with a tap.
      await t.until(() => seen.some((x) => x.phase === 'line'), 60000, 'the first exchange line');
      await t.wait(600);
      this.checkExchangeCaption();
      const touch = matchMedia('(pointer: coarse)').matches;
      const x = innerWidth / 2;
      const y = innerHeight * 0.35;
      const target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body;
      const sentAt = performance.now();
      const init = { pointerType: touch ? 'touch' : 'mouse', pointerId: touch ? 61 : 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
      t.log('tap anywhere to skip the exchange');
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      await t.until(() => seen.some((q) => q.phase === 'end'), 2000, 'the exchange to end after the tap').catch(() => null);
      const skipMs = performance.now() - sentAt;
      const end1 = seen.find((q) => q.phase === 'end');
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      t.metric('exchangeSkipMs', Math.round(skipMs));
      if (!end1) t.problem('bug', 'a tap did not skip the exchange');
      else if (!end1.skipped) t.problem('bug', 'the exchange ended by itself instead of by the tap');
      else if (skipMs > 300) t.problem('bug', `a tap took ${Math.round(skipMs)} ms to skip the exchange (max 300)`);
      else t.event('exchange-skip', `skipped ${Math.round(skipMs)} ms after the tap`);
      await this.matchLive();

      // Round 2: the same fight again, played out.
      seen.length = 0;
      const setup = this.game.match()!.setup;
      void this.game.startMatch(setup);
      await t.until(() => seen.some((q) => q.phase === 'start'), 30000, 'the exchange to start again');
      await t.until(() => seen.some((q) => q.phase === 'end'), 9000, 'the exchange to end');
      const lines = seen.filter((q) => q.phase === 'line');
      const end = seen.find((q) => q.phase === 'end')!;
      const taunt = seen.find((q) => q.phase === 'taunt');
      if (lines.length !== 2) t.problem('bug', `the exchange played ${lines.length} lines, not 2`);
      else {
        if (lines[0].focus === lines[1].focus) t.problem('bug', 'the camera stayed on one fighter for both lines');
        if (lines.some((l) => !l.audio?.includes('/audio/voice/intro.'))) t.problem('bug', 'an exchange line has no voice take');
        t.event('exchange-lines', `${lines.map((l) => `${l.who}: "${l.text}"`).join(' / ')}`);
      }
      if (!taunt) t.problem('bug', 'the listener did not play their taunt');
      t.metric('exchangeMs', end.ms ?? 0);
      if ((end.ms ?? 0) > 6000) t.problem('bug', `the exchange lasted ${end.ms} ms (max 6000)`);
      if (end.skipped) t.problem('bug', 'the exchange was cut short with no input');
      await this.matchLive();
      await this.quitFromPause('main');
    } finally {
      window.removeEventListener('dod:exchange', onX);
      unlocks().clear();
      for (const id of savedUnlocks) unlocks().add(id);
      saveUnlocks(unlocks());
    }
    t.progress(1);
    t.finish('done');
  }

  /** The exchange caption is on screen, inside the window, in at most two lines. */
  private checkExchangeCaption(): void {
    const sub = this.q('#scene-sub');
    const text = this.q('#scene-text');
    if (!sub || sub.hidden || !text) return this.t.problem('bug', 'no exchange caption on screen');
    const r = sub.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(text).lineHeight) || parseFloat(getComputedStyle(text).fontSize) * 1.2;
    const lines = Math.round(text.getBoundingClientRect().height / lh);
    const inside = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    this.t.metric('exchangeCaptionLines', lines);
    if (lines > 2) this.t.problem('bug', `the exchange caption runs to ${lines} lines (max 2)`);
    if (!inside) this.t.problem('bug', `the exchange caption is off screen (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight})`);
    else this.t.event('exchange-caption', `"${text.textContent}" in ${lines} line(s) at ${innerWidth}x${innerHeight}`);
  }

  /**
   * The match intro (campaign/intro.ts, ui/matchIntro.ts, renderer introBegin) and the stage select's live previews
   * (ui/stagePreview.ts). Stage select: each of the stages shows a canvas that pans (its pan changes between samples)
   * and is not blank. Round 1 plays a Versus match's intro out: it starts within 3 s of the VS card, the camera flies
   * in (wide to the fight framing, eased: no step over 25 units/s), the stage-name lower third shows inside the window,
   * each fighter enters with the entrance their story gives them (Season 1: its own; the rest: the spotlight drop), the
   * touch controls are hidden and fade in as it ends, ROUND START follows. Round 2: a tap skips it within 300 ms; round 3
   * (desktop): a key does. The online scenario checks no intro plays there. On a 390x844 phone it is turned to 844x390
   * and every press is a touch pointer event; fps on Low is sampled during the intro (45 wanted).
   */
  async matchIntro(): Promise<void> {
    const t = this.t;
    if (this.options.at !== 'phone-turned' && innerHeight > innerWidth && Math.min(innerWidth, innerHeight) <= 560) {
      return this.touchMatchTurned('match-intro');
    }
    this.logViewport(this.phoneScenario());
    type I = { phase: string; ms?: number; t: number; who?: string; kind?: string; slot?: number; skipped?: boolean; stage?: string; name?: string; voiced?: boolean; kinds?: string[]; totalMs?: number };
    const seen: I[] = [];
    const onI = (e: Event) => seen.push({ ...((e as CustomEvent).detail as I), t: performance.now() });
    const slams: { text: string; t: number }[] = [];
    const onSlam = (e: Event) => slams.push({ text: (e as CustomEvent).detail.text, t: performance.now() });
    let timingAt = 0;
    const onTiming = () => { timingAt = performance.now(); };
    window.addEventListener('dod:match-intro', onI);
    window.addEventListener('dod:slam', onSlam);
    window.addEventListener('dod:scene-timing', onTiming);
    const touch = matchMedia('(pointer: coarse)').matches;
    const savedUnlocks = [...unlocks()];
    for (const id of SEASON_ONE) if (LOCKABLE.has(id)) unlocks().add(id);
    saveUnlocks(unlocks());
    try {
      const s1 = Object.keys(SEASON_ONE_ENTRANCES);
      t.metric('season1Entrances', new Set(Object.values(SEASON_ONE_ENTRANCES)).size);
      t.event('intro-data', `${s1.length} Season 1 fighters, ${new Set(Object.values(SEASON_ONE_ENTRANCES)).size} different entrances: ${s1.map((id) => `${id}=${SEASON_ONE_ENTRANCES[id]}`).join(', ')}`);
      if (s1.length !== 13 || new Set(Object.values(SEASON_ONE_ENTRANCES)).size !== 13) t.problem('bug', 'the 13 Season 1 fighters do not each have their own entrance');
      // Season 1 fighter vs another (spotlight) one when the seed allows: Exit Punk (the skateboard) against a newer fighter.
      if (!this.options.fighter) this.options.fighter = this.options.seed % 2 ? 'exit-punk' : 'shutup-bot';
      if (!this.options.foe) this.options.foe = 'wallit';
      await this.toMainMenu();

      // The stage select: live previews.
      this.onStages = (cards) => this.checkStagePreviews(cards);
      // Round 1: the intro plays out.
      const samples: { ms: number; d: number; x: number; fps: number }[] = [];
      let lowerOk = false;
      let lowerInside = false;
      let touchHidden: boolean | null = null;
      this.onVersus = async () => {
        await t.until(() => seen.some((x) => x.phase === 'start'), 60000, 'the match intro to start');
        const start = seen.find((x) => x.phase === 'start')!;
        const gap = timingAt ? start.t - timingAt : 0;
        t.metric('introStartMs', Math.round(gap));
        t.event('intro-start', `the intro began ${Math.round(gap)} ms after the VS card (${start.kinds?.join(', ')})`);
        if (gap > 3000) t.problem('bug', `the intro began ${Math.round(gap)} ms after the VS card (max 3000)`);
        while (!seen.some((x) => x.phase === 'end')) {
          const st = this.game.introStats?.();
          const g = this.game.gfxStats?.();
          if (st?.active) samples.push({ ms: st.ms, d: st.camDist, x: st.camX, fps: g?.fpsNow ?? 0 });
          const lower = this.q('#intro-lower');
          if (lower && st && st.ms > 700 && st.ms < 2200 && !lowerOk) {
            const r = lower.getBoundingClientRect();
            const name = lower.querySelector('.intro-stage')?.textContent ?? '';
            lowerInside = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
            lowerOk = lower.classList.contains('in') && name.length > 0;
          }
          const btn = document.querySelector<HTMLElement>('.touch > *');
          if (btn && touchHidden === null && st && st.ms > 400 && st.ms < 2500) touchHidden = Number(getComputedStyle(btn).opacity) < 0.05;
          await t.wait(40);
        }
      };
      await this.startVersus(2);
      const start = seen.find((x) => x.phase === 'start')!;
      const end = seen.find((x) => x.phase === 'end')!;
      const card = seen.find((x) => x.phase === 'card');
      const entrances = seen.filter((x) => x.phase === 'entrance');
      // Criterion 1: the fly-in and the stage name card.
      if (!card) t.problem('bug', 'no stage-name card in the intro');
      else {
        t.event('intro-card', `stage card "${card.name}" ${Math.round(card.t - start.t)} ms into the intro${card.voiced ? ', announcer call played' : ', caption only'}`);
        if (card.t - start.t > 600) t.problem('bug', `the stage card came ${Math.round(card.t - start.t)} ms into the intro (max 600)`);
      }
      if (!lowerOk) t.problem('bug', 'the stage-name lower third was not showing mid-intro');
      else if (!lowerInside) t.problem('bug', `the stage-name lower third is off screen at ${innerWidth}x${innerHeight}`);
      else t.event('intro-lower-third', `lower third inside the window at ${innerWidth}x${innerHeight}`);
      if (samples.length >= 4) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        let back = 0;
        for (let i = 1; i < samples.length; i++) back = Math.max(back, samples[i].d - samples[i - 1].d);
        t.metric('introCamFrom', Number(first.d.toFixed(2)));
        t.metric('introCamTo', Number(last.d.toFixed(2)));
        t.event('intro-camera', `camera distance ${first.d.toFixed(1)} → ${last.d.toFixed(1)} over ${Math.round(last.ms - first.ms)} ms (${samples.length} samples)`);
        if (first.d - last.d < 2) t.problem('bug', `the camera did not fly in: distance ${first.d.toFixed(1)} → ${last.d.toFixed(1)}`);
        if (back > 0.05) t.problem('bug', `the fly-in pulled back by ${back.toFixed(2)} (it should only come in)`);
        const st = this.game.introStats?.();
        if (st) {
          t.metric('introCamPeakSpeed', Number(st.maxSpeed.toFixed(1)));
          if (st.maxSpeed > 25) t.problem('bug', `the fly-in moved at ${st.maxSpeed.toFixed(1)} units/s at its fastest (a snap; max 25)`);
        }
      } else t.problem('bug', `the intro camera was sampled ${samples.length} times`);
      // Criterion 2: entrances.
      const expectCast = [String(this.options.fighter), String(this.options.foe)];
      t.metric('introEntrances', entrances.length);
      for (const e of entrances) t.event('intro-entrance', `${e.who} enters: ${e.kind} (${Math.round(e.t - start.t)} ms in)`);
      if (entrances.length !== 2) t.problem('bug', `${entrances.length} entrances played, not 2`);
      for (const who of expectCast) {
        const got = entrances.find((e) => e.who === who);
        if (!got) t.problem('bug', `${who} made no entrance`);
        else if (got.kind !== entranceKind(who)) t.problem('bug', `${who} entered with ${got.kind}, not ${entranceKind(who)}`);
      }
      const stats = this.game.introStats?.();
      t.event('intro-beats', `${stats?.beats ?? 0} beats read at the end (sparks, shakes, thuds)`);
      // 3 s, played to its end, not skipped.
      t.metric('introMs', end.ms ?? 0);
      if (end.skipped) t.problem('bug', 'the intro was skipped with no input');
      if ((end.ms ?? 0) < 2700 || (end.ms ?? 0) > 3600) t.problem('bug', `the intro lasted ${end.ms} ms (3000 wanted)`);
      // ROUND START follows it.
      await t.until(() => slams.some((q) => q.text === 'Round start' && q.t >= end.t - 50), 4000, 'ROUND START').catch(() => null);
      const rs = slams.find((q) => q.text === 'Round start' && q.t >= end.t - 50);
      if (!rs) t.problem('bug', 'ROUND START did not follow the intro');
      else t.event('intro-round-start', `ROUND START ${Math.round(rs.t - end.t)} ms after the intro ended`);
      // Touch controls: hidden during it, back after it.
      if (touch || document.querySelector('.touch')) {
        const btn = document.querySelector<HTMLElement>('.touch > *');
        if (btn) {
          await t.wait(500);
          const after = Number(getComputedStyle(btn).opacity);
          t.event('intro-touch-controls', `touch controls ${touchHidden ? 'hidden during the intro' : 'visible during the intro'}, opacity ${after.toFixed(2)} after`);
          if (touchHidden === false) t.problem('bug', 'the touch controls were showing during the intro');
          if (after < 0.2) t.problem('bug', 'the touch controls did not fade back in after the intro');
        }
      }
      const fps = samples.map((x) => x.fps).filter((v) => v > 0);
      if (fps.length) {
        const avg = Math.round(fps.reduce((a, b) => a + b, 0) / fps.length);
        const q = this.game.gfxStats?.()?.quality;
        t.metric('introFps', avg);
        t.event('intro-fps', `average ${avg} fps during the intro (${fps.length} samples, quality ${q})`);
        if (this.phoneScenario() && avg < 45) t.problem('warning', `average ${avg} fps during the intro on a phone (want at least 45)`);
      }
      await this.matchLive();

      // Round 2: a tap skips it.
      const skipTest = async (how: 'tap' | 'key'): Promise<void> => {
        seen.length = 0;
        void this.game.startMatch(this.game.match()!.setup);
        await t.until(() => seen.some((x) => x.phase === 'start'), 40000, 'the intro to start again');
        await t.wait(800);
        const sentAt = performance.now();
        let target: HTMLElement | null = null;
        let init: PointerEventInit = {};
        if (how === 'tap') {
          const x = innerWidth / 2;
          const y = innerHeight * 0.4;
          target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body;
          init = { pointerType: touch ? 'touch' : 'mouse', pointerId: touch ? 71 : 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
          t.log(`${touch ? 'tap' : 'click'} anywhere to skip the intro`);
          target.dispatchEvent(new PointerEvent('pointerdown', init));
        } else {
          t.log('press a key to skip the intro');
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true }));
        }
        await t.until(() => seen.some((q) => q.phase === 'end'), 2000, 'the intro to end after the input').catch(() => null);
        const ms = Math.round(performance.now() - sentAt);
        const e = seen.find((q) => q.phase === 'end');
        if (how === 'tap') target?.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        else window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ', key: 'j', bubbles: true }));
        t.metric(how === 'tap' ? 'introSkipTapMs' : 'introSkipKeyMs', ms);
        if (!e) t.problem('bug', `a ${how} did not skip the intro`);
        else if (!e.skipped) t.problem('bug', `the intro ended by itself, not by the ${how}`);
        else if (ms > 300) t.problem('bug', `a ${how} took ${ms} ms to skip the intro (max 300)`);
        else t.event(`intro-skip-${how}`, `skipped ${ms} ms after the ${how}`);
        await this.matchLive();
      };
      await skipTest('tap');
      if (!touch) await skipTest('key');
      await this.quitFromPause('main');
    } finally {
      this.onStages = null;
      this.onVersus = null;
      window.removeEventListener('dod:match-intro', onI);
      window.removeEventListener('dod:slam', onSlam);
      window.removeEventListener('dod:scene-timing', onTiming);
      unlocks().clear();
      for (const id of savedUnlocks) unlocks().add(id);
      saveUnlocks(unlocks());
    }
    t.progress(1);
    t.finish('done');
  }

  /** The stage select's tiles each pan: a canvas with layers drawn, its pan changing between samples, and not blank. */
  private async checkStagePreviews(cards: HTMLElement[]): Promise<void> {
    const t = this.t;
    const total = cards.length;
    let moving = 0;
    for (const card of cards) {
      const id = card.dataset.stage ?? '?';
      const canvas = card.querySelector<HTMLCanvasElement>('canvas.stage-preview');
      if (!canvas) {
        t.problem('bug', `stage select: the ${id} tile has no live preview`);
        continue;
      }
      card.scrollIntoView({ block: 'center', inline: 'center' });
      await t.until(() => Number(canvas.dataset.layers ?? 0) >= 1 && Number(canvas.dataset.frames ?? 0) > 0, 12000, `the ${id} preview to draw`).catch(() => null);
      const pans: number[] = [];
      const frames: number[] = [];
      for (let i = 0; i < 3; i++) {
        pans.push(Number(canvas.dataset.pan ?? NaN));
        frames.push(Number(canvas.dataset.frames ?? 0));
        await t.wait(330);
      }
      const ctx = canvas.getContext('2d');
      const colours = new Set<string>();
      if (ctx) {
        for (let i = 0; i < 48; i++) {
          const px = ctx.getImageData(Math.floor(((i % 8) + 0.5) * (canvas.width / 8)), Math.floor((Math.floor(i / 8) + 0.5) * (canvas.height / 6)), 1, 1).data;
          colours.add(`${px[0] >> 4},${px[1] >> 4},${px[2] >> 4}`);
        }
      }
      const moved = Math.max(...pans) - Math.min(...pans) > 0.05 && frames[2] > frames[0];
      const r = canvas.getBoundingClientRect();
      if (!moved) t.problem('bug', `stage select: the ${id} preview does not move (pan ${pans.map((p) => p.toFixed(2)).join(', ')})`);
      else if (colours.size < 4) t.problem('bug', `stage select: the ${id} preview is blank (${colours.size} colours)`);
      else if (r.width < 40 || r.height < 20) t.problem('bug', `stage select: the ${id} preview is ${Math.round(r.width)}x${Math.round(r.height)}`);
      else {
        moving++;
        t.event('stage-preview', `${id}: ${canvas.dataset.layers} layers, pan ${pans.map((p) => p.toFixed(2)).join(' → ')}, ${colours.size} colours`);
      }
    }
    cards[0]?.scrollIntoView({ block: 'center' });
    t.metric('stagePreviews', moving);
    t.event('stage-previews', `${moving} of ${total} stage tiles show a moving preview`);
    if (total < 9) t.problem('bug', `stage select offers ${total} stages (9 expected)`);
  }

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
    const vw = new VoiceWatch(t);
    try {
      await this.toMainMenu();
      t.progress(0.03);
      vw.start();
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
      vw.finish();
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
      vw.stop();
      window.removeEventListener('dod:commentary', onCall);
    }
    t.progress(1);
    t.finish('done');
  }

  async voiceCaptions(): Promise<void> {
    const t = this.t;
    const back = localStorage.getItem(SOUND_KEY);
    const slide = (id: string, percent: number) => {
      const input = this.q(id) as HTMLInputElement;
      input.value = String(percent);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      t.add('interactions');
    };
    await this.screen('title', 30000);
    await this.tapToPlay();
    await this.tap(() => this.q('#btn-start'), 'Press start');
    await this.screen('main');
    await this.tap(() => this.q('[data-go="settings"]'), 'Settings');
    await t.until(settingsShowing, 3000, 'Settings to open');
    if (!soundSettings().on) await this.tap(() => this.q('#sound-switch'), 'Sound on');
    // 1: three separate sliders, handles 44 px, panel inside the window.
    const ids = ['#vol-music', '#vol-sfx', '#vol-voice'];
    const rects = ids.map((id) => this.q(id)?.getBoundingClientRect());
    if (rects.some((r) => !r)) t.problem('bug', 'Settings is missing one of the Music, Effects, Voice sliders');
    for (const [i, r] of rects.entries()) {
      if (!r) continue;
      if (r.height < 44) t.problem('bug', `${ids[i]} handle is ${Math.round(r.height)} px tall, under 44`);
      if (r.left < 0 || r.right > innerWidth) t.problem('bug', `${ids[i]} runs off the screen`);
    }
    t.event('sliders', ids.map((id, i) => `${id} ${Math.round(rects[i]?.width ?? 0)}x${Math.round(rects[i]?.height ?? 0)}`).join(', '));
    if (document.documentElement.scrollWidth > innerWidth + 1) t.problem('bug', 'Settings scrolls sideways');
    await t.wait(300);
    slide('#vol-voice', 0);
    slide('#vol-sfx', 80);
    await t.wait(400);
    const g = audio.busGains();
    if (g.voice > 0.001 || g.sfx < 0.1) t.problem('bug', `Voice 0 should silence voices but not effects (voice ${g.voice}, sfx ${g.sfx})`);
    else t.event('voice-zero', `voice bus ${g.voice.toFixed(2)}, effects bus ${g.sfx.toFixed(2)}`);
    // 2: captions off is saved (and read back the way a reload reads it).
    await this.tap(() => this.q('#captions-switch'), 'Captions off');
    await t.wait(300);
    const saved = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null') as { captions?: boolean } | null;
    if (saved?.captions !== false || readSoundSettings().captions !== false || !document.body.classList.contains('captions-off')) t.problem('bug', 'Captions off did not save or apply');
    else t.event('captions-off-saved', JSON.stringify(saved));
    // 3: sound muted, story lines still show.
    await this.tap(() => this.q('#sound-switch'), 'Sound off');
    await t.wait(300);
    if (document.body.classList.contains('captions-off')) t.problem('bug', 'With sound off the story captions are still hidden');
    else t.event('captions-with-sound-off', 'captions show with sound off');
    await this.tap(() => this.q('#sound-switch'), 'Sound on');
    await this.tap(() => this.q('#captions-switch'), 'Captions on');
    await this.tap(() => this.q('#settings-done'), 'Done');
    if (back === null) localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, back);
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
      const cta = prompt.querySelector('.tap-cta')?.getBoundingClientRect();
      const pitch = prompt.querySelector('.tap-pitch')?.textContent?.trim() ?? '';
      const art = prompt.querySelector('.tap-art img')?.getBoundingClientRect();
      if (!pitch || !art || art.width < 40) t.problem('bug', `the Tap to play card has no pitch line or fighter art ${where}`);
      if (!cta || cta.height < 44 || cta.width < 44 || cta.left < 0 || cta.right > innerWidth || cta.bottom > innerHeight) t.problem('bug', `the Play button is under 44 px or off screen ${where}`);
      const bd = prompt.querySelector('.tap-backdrop img')?.getBoundingClientRect();
      if (!bd || bd.width < innerWidth - 1 || bd.height < innerHeight - 1) t.problem('bug', `the Tap to play key-art backdrop does not fill the screen ${where}`);
      else t.event('key-art-backdrop', `roster key art fills ${Math.round(bd.width)}x${Math.round(bd.height)} behind the card ${where}`);
      const copy = prompt.querySelector('.tap-copy')?.getBoundingClientRect();
      if (cta && copy && innerWidth < 700 && innerWidth < innerHeight && cta.width < Math.min(copy.width, 420) - 2) t.problem('bug', `the Play button is not full width of the card ${where} (${Math.round(cta.width)} of ${Math.round(copy.width)})`);
      if (document.documentElement.scrollWidth > innerWidth + 1) t.problem('bug', `the Tap to play card scrolls sideways ${where}`);
      t.event('guest-card', `pitch "${pitch}", Play as guest ${cta ? Math.round(cta.width) + 'x' + Math.round(cta.height) : 'missing'}, art ${art ? Math.round(art.width) + 'x' + Math.round(art.height) : 'missing'} ${where}`);
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
      const init = { pointerType: touchDevice() ? 'touch' : 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: x, clientY: y };
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

    /** What the landing page tells a new player is true (counts from the game's own data) and fits the window. */
    const checkLanding = async () => {
      const d = doc()!;
      const w = frame.contentWindow!;
      const text = (sel: string) => [...d.querySelectorAll<HTMLElement>(sel)].map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      const facts = text('.facts li');
      const cards = text('.feature');
      const shown = [...facts, ...cards].join(' | ');
      const og = d.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ?? '';
      const desc = d.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '';
      const want = { fighters: CHARACTERS.length, stages: STAGES.length, episodes: CHAPTERS.length, seasons: SEASONS.length };
      t.event('landing-want', JSON.stringify(want));
      const has = (hay: string, re: RegExp, what: string) => {
        if (!re.test(hay)) t.problem('bug', `the landing page does not say ${what}`);
      };
      has(facts.join(' | '), new RegExp(`\\b${want.fighters} fighters, ${want.stages} stages`), `${want.fighters} fighters, ${want.stages} stages in the facts`);
      has(facts.join(' | '), new RegExp(`\\b${want.seasons}-season.*\\b${want.episodes}\\b.*episodes`), `${want.episodes} episodes across ${want.seasons} seasons in the facts`);
      has(facts.join(' | '), /online/i, 'online with ratings in the facts');
      has(facts.join(' | '), /phone/i, 'phone / touch in the facts');
      has(cards.join(' | '), new RegExp(`\\b${want.episodes} episodes across ${want.seasons} seasons`), `${want.episodes} episodes across ${want.seasons} seasons in a feature card`);
      has(og + ' ' + desc, new RegExp(`\\b${want.fighters} fighters`), `${want.fighters} fighters in the share card and description`);
      has(og + ' ' + desc, new RegExp(`\\b${want.stages} stages`), `${want.stages} stages in the share card and description`);
      if (/\bcoming\b|one stage|eight chapters|room codes/i.test(shown + ' ' + og + ' ' + desc)) t.problem('bug', 'the landing page still carries a stale claim (Coming, one stage, eight chapters or room codes)');
      if (d.querySelector('.soon')) t.problem('bug', 'a Coming tag is still on the landing page');
      if (/<!--|dod:/.test(og + desc + d.querySelector('picture img')?.getAttribute('alt'))) t.problem('bug', 'a generator marker leaked into a meta tag or alt text');
      t.event('landing-facts', `${facts.length} facts, ${cards.length} feature cards: ${shown.slice(0, 300)}`);

      // Fit: no sideways scroll, no clipped text, facts and cards in one column on a phone, Play above the fold.
      d.documentElement.scrollTop = 0;
      await t.wait(300);
      const root = d.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) t.problem('bug', `the landing page scrolls sideways (${root.scrollWidth} wide in ${root.clientWidth})`);
      const clipped = [...d.querySelectorAll<HTMLElement>('.facts li, .feature, .feature h2, .feature p, .kicker, .logo, .logo span, .tagline, .cta-row a')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (e.scrollWidth > e.clientWidth + 1 || r.right > w.innerWidth + 1 || r.left < -1);
      });
      if (clipped.length) t.problem('bug', `landing text is clipped or runs off the screen (${clipped.map((e) => e.tagName.toLowerCase() + '.' + e.className).slice(0, 3).join(', ')})`);
      const phone = w.innerWidth <= 520;
      const col = (sel: string) => new Set([...d.querySelectorAll<HTMLElement>(sel)].map((e) => Math.round(e.getBoundingClientRect().left)));
      if (phone) {
        if (col('.facts li').size !== 1) t.problem('bug', `the facts are not in one column at ${w.innerWidth}px`);
        if (col('.feature').size !== 1) t.problem('bug', `the feature cards are not in one column at ${w.innerWidth}px`);
      }
      const playBtn = d.querySelector<HTMLElement>('.landing-copy .play');
      const pr = playBtn?.getBoundingClientRect();
      if (!pr) t.problem('bug', 'no Play button in the landing hero');
      else {
        if (pr.bottom > w.innerHeight || pr.top < 0) t.problem('bug', `the Play button is below the fold (bottom ${Math.round(pr.bottom)} of ${w.innerHeight})`);
        if (pr.height < 44 || pr.width < 44) t.problem('bug', `the Play button is ${Math.round(pr.width)}x${Math.round(pr.height)}, under 44x44`);
      }
      const factsBottom = d.querySelector('.facts')?.getBoundingClientRect().bottom ?? 0;
      t.metric('landingFactsBottom', Math.round(factsBottom));
      t.metric('landingPlayBottom', Math.round(pr?.bottom ?? 0));
      t.event('landing-fit', `${w.innerWidth}x${w.innerHeight}${touchDevice() ? ' touch' : ''}: Play bottom ${Math.round(pr?.bottom ?? 0)}, facts bottom ${Math.round(factsBottom)}, no sideways scroll, ${phone ? 'one column' : 'wide layout'}`);
      await t.wait(1500);
    };

    try {
      await loaded('/', 'the landing page');
      await checkLanding();
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
export interface Pad { stick(sx: number, sy: number): void; special(on: boolean): void; button(name: 'attack' | 'shield' | 'jump', on: boolean): void; release(): void }
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
const REBIND_RUN_KEY = 'hawkes.playtest.rebind';
const REBIND_KEY = 'dod.bindings';
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
