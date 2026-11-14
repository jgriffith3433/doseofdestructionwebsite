// Page wiring: the screen flow, the fixed 60 Hz match loop, the HUD, and the
// campaign's scene-fight-scene rhythm.

// First: analytics (Hawkes Analytics, analytics.ts) marks the load start and stamps the build.
import { bootFail, bootReady, bootStep, pressHandled } from './boot.ts';
import * as analytics from './analytics.ts';
import { CHARACTERS, MOVE } from './sim/characters.ts';
import { addWin, lookCount, lookOpen, preferredLook } from './looks.ts';
import { openReplayPicker } from './ui/replayPicker.ts';
import { audio, tapState, type Spatial } from './audio.ts';
import type { VoiceKind } from './voiceDirector.ts';
import { panFromScreen } from './roomAudio.ts';
import { Commentator, introCall, suddenDeathCall, type Call } from './commentary.ts';
import { graphics, onGraphics, setGraphics } from './graphics.ts';
import { TEXT_SIZES, onTextSize, setTextSize, textSize } from './textSize.ts';
import { colourVision, onColourVision, setColourVision, shapeOf } from './colourVision.ts';
import { flashMode, onScreenShake, reduceMotion, setFlashMode, setReduceMotion, setShakeLevel, shakeLevel, shakeScale, type FlashMode } from './hitFeel.ts';
import { onTouchSettings, touchUiForced, setTouchSettings, touchSettings } from './touchSettings.ts';
import { rumble, rumbleHit } from './rumble.ts';
import { onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';
import { ACT, hashState } from './sim/state.ts';
import { STAGES } from './sim/stage.ts';
import { openRebind, backRebind, wireRebind, onRebind } from './ui/rebind.ts';
import { onBindings } from './input/bindings.ts';
import { onShieldMode, setShieldActive, setShieldMode, shieldMode, releaseShieldLatch } from './input/shieldMode.ts';
import { initTouchControls, showTouchControls, touchDevice } from './input/touch.ts';
import { keyboardHelp, gamepadHelp, padFamily, TOUCH_HELP, listenKeyboard, onKey, pausePressedBy, padSlot, readLocal, readHumans, assignDevices, tauntPressed } from './input/devices.ts';
import { damageColor, damageShake, hitGain, hitTier } from './hitFeel.ts';
import { clearMarkers, markerLog, markerRects, safeInsets, updateMarkers, type MarkerIn } from './ui/offscreen.ts';
import { clearTags, tagLog, tagRects, tagText, updateTags, type TagIn } from './ui/tags.ts';
import { PLAYER_COLORS, Renderer, prefetchFighters, prefetchStage } from './render/renderer.ts';
import { Match, type MatchSetup, type SlotSetup } from './match.ts';
import { DUMMY_MODES, DUMMY_PERCENTS } from './ai/trainingDummy.ts';
import { applyResult as applyAutoResult, levelNote, loadAutoLevel } from './ai/autoLevel.ts';
import type { SimEvent } from './sim/step.ts';
import { ruleLabel, takeoverLines } from './campaign/takeover.ts';
import { LESSON_TITLE, campaignBlurb, doneLessons, markLessonDone, nextLesson, type LessonId } from './campaign/lessons.ts';
import { clearLosses, difficulty, foeLevels, markCleared, offerEasy, recordLoss, setDifficulty, withDifficulty, DIFFICULTY_LABEL, type Difficulty } from './campaign/difficulty.ts';
import { gradeEpisode, scoreEpisode } from './campaign/grade.ts';
import { earnReward, onVariantChange, setVariant } from './campaign/rewards.ts';
import { CHAPTERS, isUnlocked, loadProgress, recordStars, recordBest, loadStars, saveStars, saveBests, saveProgress, storyCard, unlockFor, type Chapter } from './campaign/story.ts';
import { stagesFor, type ModeStage } from './modes.ts';
import { $, formatTime, h, headUrl, installPressFeedback, largeUrl, thumbUrl } from './ui/dom.ts';
import { back, currentScreen, focusFirst, go, listenMenuKeys, onBack, onPanelBack, pollMenuPad, setMenuOwner, syncPad } from './ui/screens.ts';
import { TEAM_COLORS, openSelect, type VersusConfig } from './ui/select.ts';
import { openCampaign, openStages, playVersus, setResultActions, showResults, type ResultAction } from './ui/views.ts';
import { clearRematchPanel, renderRematch } from './ui/rematch.ts';
import { startResultsMusic } from './ui/victory.ts';
import { planIntro } from './campaign/intro.ts';
import { playMatchIntro } from './ui/matchIntro.ts';
import { FX } from './sim/fixed.ts';
import { playColdOpen, playExchange, playScene, skipScene, type SceneCard, type SceneLine, type SceneStage } from './ui/scene.ts';
import { chunkLine, chunkTimes } from './campaign/sceneText.ts';
import { exchangeFor, markExchangeSeen, seenExchanges, type Exchange } from './campaign/intros.ts';
import type { MatchWatcher } from './playtest/dod.ts';
import { NO_INPUT } from './sim/input.ts';
import { step, SUDDEN_HOLD } from './sim/step.ts';
import { stageIndex } from './sim/stage.ts';
import type { GameState } from './sim/state.ts';
import { ReplayPlayer, saveReplay, type Replay } from './replay.ts';
import { emit as replayEmit, openReplayBar, type ReplayBar } from './ui/replayBar.ts';
import { HighlightPlayer, loadHighlight, nextChapterId, recapApplies, recapId, saveHighlight, teaseId } from './campaign/highlight.ts';
import { playSegment, type SegmentEnv, type Showcase } from './ui/segment.ts';
// Online code is never imported here: it loads after boot through the loader (a failure there can't stop the game).
import type { OnlineFight, FightEnd } from './net/fight.ts';
import type { Found, OnlineSetup } from './net/matchmaker.ts';
import { bootOnline, onlineApi, onlineReady } from './net/loader.ts';
import { switching } from './ui/screens.ts';
import { initRotatePrompt, rotateShowing, rotateSuppressed, suppressRotate } from './ui/rotate.ts';
import { Teacher } from './ui/teach.ts';
import { DAILY_POOL, dailyEpisode, dailyScore, dailySetup, liveStreak, msToNext, recordClear, type DailyEpisode } from './campaign/daily.ts';
import { dailyDate, loadDaily, saveDaily } from './campaign/dailyStore.ts';
import { fillBoard, renderDailyCard, renderDailyResults, setCountdown } from './ui/daily.ts';
import { TOURS, TOUR_LENGTH, loadTours, tourFor, markTourCleared, tourEnding, tourIntro, tourSetup, type Tour } from './campaign/tour.ts';
import { ENDINGS as TOUR_ENDINGS, endingFor, type Ending } from './campaign/endings.ts';
import { playEnding } from './ui/ending.ts';
import { openingSeen, openingShowing, playOpening } from './ui/opening.ts';
import { renderEndings } from './ui/extras.ts';
import { renderTourChoice, renderTourSelect, tourBanner } from './ui/tour.ts';
import { VOICE } from './audio.ts';
import { clearWinQuote, pickWinQuote, type WinQuote } from './winQuote.ts';
import { PILOT_CHAPTER, PILOT_KAELEN, isFirstVisit, markPilotSeen, pilotState } from './campaign/firstVisit.ts';

const TICK_MS = 1000 / 60;

// 'wait': an online match is loaded here and waits for the other player's page.
/** 'scene': a live story scene (ui/scene.ts) is playing in the arena; the sim waits. */
type Phase = 'idle' | 'wait' | 'ready' | 'play' | 'pause' | 'scene';

const canvas = $<HTMLCanvasElement>('stage');
bootStep('module', 'Starting the engine');
let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
  onVariantChange(() => renderer.regrade());
} catch (err) {
  console.error('[dod-boot] the renderer could not start', err);
  bootFail('Your browser could not start the game graphics (WebGL).');
  throw err;
}
bootStep('engine', 'Engine ready');
renderer.onSound = (id) => audio.sfx(id);
renderer.onSynth = (kind) => audio.synth(kind);
listenKeyboard();
initTouchControls(() => pauseKey(), true);
initRotatePrompt();
listenMenuKeys(() => phase === 'play' || phase === 'ready' || phase === 'wait');

let match: Match | null = null;
let phase: Phase = 'idle';
/** The online fight running `match`, or null for a local match. */
let fight: OnlineFight | null = null;
let readyFrames = 0;
let readyStart = 0;
/** How long (ms) the Ready count may wait at its last beat for the stage art to load. */
const READY_ART_WAIT_MS = 8000;
const READY_ART_FRAMES = 49;
let acc = 0;
let last = performance.now();
let shownOver = false;
/** The announcer and Blog Man for the running match (versus and campaign; not training or online). */
let commentator: Commentator | null = null;
let introPending: Call | null = null;
let chapter: Chapter | null = null;
/** On-stage teaching prompts for the pilot fight and How to play (ui/teach.ts). */
let teacher: Teacher | null = null;
let stageChoice = 0;
let versus: VersusConfig = loadVersus();
let training: VersusConfig = {
  slots: [{ char: versus.slots[0].char, cpu: null }, { char: (versus.slots[0].char + 1) % CHARACTERS.length, cpu: 0 }],
  stocks: 1,
  time: 0,
  teams: false,
};
const progress = loadProgress();
// Playtest hooks (playtest/dod.ts). Outside a playtest: no seed, normal speed, no watchers.
let playtestSeed: number | null = null;
let simSpeed = 1;
const matchWatchers = new Set<MatchWatcher>();

// ------------------------------------------------------------ saved choices

function loadVersus(): VersusConfig {
  const fallback: VersusConfig = {
    slots: [{ char: CHARACTERS.findIndex((c) => c.id === 'exit-punk'), cpu: null, team: 0 }, { char: CHARACTERS.findIndex((c) => c.id === 'break'), cpu: 5, team: 1 }],
    stocks: 3,
    time: 0,
    teams: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem('dod-versus') ?? 'null');
    const valid =
      saved &&
      Array.isArray(saved.slots) &&
      saved.slots.length >= 2 &&
      saved.slots.length <= 4 &&
      saved.slots[0].cpu === null &&
      saved.slots.every((s: { char: number }) => s.char >= 0 && s.char < CHARACTERS.length);
    if (valid) return { ...fallback, ...saved };
  } catch {
    // Unreadable storage: use the defaults.
  }
  return fallback;
}

function saveVersus(): void {
  try {
    localStorage.setItem('dod-versus', JSON.stringify(versus));
  } catch {
    // Storage can be blocked; choices then last only for this visit.
  }
}

// ------------------------------------------------------------- menu flow

function startPressed(): void {
  audio.line('announcer.title');
  go('main', spotlight);
}

let shownPadFamily = '';
/** The controls lists; the pad one is named for the family of whichever pad last gave input (refilled when it changes). */
function fillControlLists(): void {
  const fill = (id: string, rows: [string, string][]) =>
    $(id).replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  shownPadFamily = padFamily();
  fill('keys-kb', keyboardHelp());
  fill('keys-pad', gamepadHelp());
  fill('keys-touch', TOUCH_HELP);
  fill('ctl-kb', keyboardHelp());
  fill('ctl-pad', gamepadHelp());
  fill('ctl-touch', TOUCH_HELP);
}

function wireMenus(): void {
  $('btn-start').addEventListener('click', () => {
    if (pressHandled()) return; // Game/index.html took this press while the engine loaded and carries it out in bootReady
    startPressed();
  });
  // Every button press in a menu clicks: on pointer down (with the pressed state, ui/dom.ts), so it sounds with the press, not
  // after the release; a key or pad press has no pointer down, so its click plays it. The click that follows a pointer-down
  // sound on the same control is not played again.
  let downSound: { el: HTMLElement; at: number } | null = null;
  installPressFeedback((el) => {
    downSound = { el, at: performance.now() };
    audio.sfx('ui-select');
  });
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button, a');
    if (!el) return;
    if (downSound && downSound.el === el && performance.now() - downSound.at < 2000) {
      downSound = null;
      return;
    }
    audio.sfx('ui-select');
  });
  wireSettings();
  document.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const to = b.dataset.go;
      if (to === 'online' || to === 'profile') analytics.feature(to === 'online' ? 'find_match' : 'profile_open');
      if (to === 'campaign') openCampaignScreen();
      else if (to === 'tour') openTourScreen();
      else if (to === 'extras') openExtras();
      else if (to === 'versus') openVersus();
      else if (to === 'training') openTraining();
      else if (to === 'howto') startHowToPlay();
      else if (to === 'howto2') startHowToPlay('defence');
      else if (to === 'howto3') startHowToPlay('recovery');
      else if (to === 'controls') go('howto');
      else if (to === 'settings') openSettings();
      else if (to === 'online') onlineCall('find match', (o) => o.findMatch());
      else if (to === 'invite') onlineCall('invite a friend', (o) => o.inviteFriend());
      else if (to === 'profile') onlineCall('profile', (o) => o.openProfile());
      else if (to === 'leaderboard') go('leaderboard', () => onlineCall('leaderboard', (o) => o.renderBoard()));
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((b) =>
    b.addEventListener('click', () => back()),
  );
  onBack('main', () => go('title'));
  onBack('select', () => go('main', spotlight));
  onBack('stages', () => (lastSelect === 'training' ? openTraining() : openVersus()));
  onBack('campaign', () => go('main', spotlight));
  onBack('tour', () => go('main', spotlight));
  onBack('extras', () => go('main', spotlight));
  onBack('howto', () => go('main', spotlight));
  wirePilot();
  onBack('leaderboard', () => go('main', spotlight));
  // Pause (a pad's B, Backspace) resumes; the results step out through their last button (Main menu, Campaign map, Quit).
  onBack('match', () => { if (phase === 'pause') pauseKey(); });
  onBack('results', () => ([...document.querySelectorAll<HTMLButtonElement>('#results-actions button')].pop())?.click());

  $('btn-resume').addEventListener('click', () => setPaused(false));
  $('btn-restart').addEventListener('click', () => {
    setPaused(false);
    if (match) {
      analytics.matchEnd(match, 'restart');
      startMatch(match.setup, false);
    }
  });
  wireTrainingOptions();
  $('btn-pause-settings').addEventListener('click', () => openSettings());
  $('btn-pause-controls').addEventListener('click', () => openControlsPanel(true));
  $('btn-controls-close').addEventListener('click', () => openControlsPanel(false));
  $('btn-quit').addEventListener('click', () => {
    if (fight) {
      // Online: leaving is a forfeit; the results come from the fight's end.
      $('pause').hidden = true;
      phase = 'play';
      fight.forfeit();
      return;
    }
    setPaused(false);
    if (match) {
      analytics.quitToMenu(match, chapter ? 'campaign' : 'main');
      analytics.matchEnd(match, 'quit', { reason: 'pause_quit' });
    }
    const touring = inTour();
    endMatch();
    if (touring && tourRun) {
      analytics.tour('quit', { fighter: tourRun.tour.fighter, fight: tourRun.index + 1 });
      openTourScreen();
    } else if (chapter) openCampaignScreen();
    else go('main', spotlight);
  });
  onKey('KeyH', () => {
    if (match) renderer.debug = !renderer.debug;
  });
  onKey('KeyM', () => {
    const on = audio.toggleSound();
    analytics.setting('sound', on, 'key_m');
    if (match) banner(on ? 'Sound on' : 'Sound off');
  });

  fillControlLists();
}

/** Free Training (not a How to play lesson): the combo readout and the dummy options in Pause are on. */
function trainingFree(m: Match | null): m is Match {
  return !!m && m.setup.mode === 'training' && !m.setup.teach && !m.setup.online;
}

/** Pause → Training: the dummy's behaviour, its CPU level and its percent (Reset is 0). Built once; synced each time Pause opens. */
function wireTrainingOptions(): void {
  const modes = $('to-modes');
  for (const { id, label } of DUMMY_MODES) {
    modes.appendChild(
      h('button', { type: 'button', class: 'secondary', 'data-dummy': id, 'aria-pressed': 'false', onclick: () => {
        if (!trainingFree(match)) return;
        match.setDummyMode(id);
        analytics.feature('training_dummy', { value: id });
        syncTrainingOptions();
      } }, label),
    );
  }
  const pcts = $('to-percents');
  for (const pct of DUMMY_PERCENTS) {
    pcts.appendChild(
      h('button', { type: 'button', class: 'secondary', 'data-percent': String(pct), onclick: () => {
        if (!trainingFree(match)) return;
        match.setDummyPercent(pct);
        analytics.feature('training_percent', { value: pct });
        updateHud(match);
      } }, pct === 0 ? 'Reset' : `${pct}%`),
    );
  }
  const level = (d: number) => () => {
    if (!trainingFree(match)) return;
    match.setDummyLevel(match.dummy.level + d);
    syncTrainingOptions();
  };
  $('to-level-down').addEventListener('click', level(-1));
  $('to-level-up').addEventListener('click', level(1));
}

function syncTrainingOptions(): void {
  const on = trainingFree(match);
  $('training-options').hidden = !on;
  $('pause').querySelector('.panel')!.classList.toggle('training', on);
  if (!on || !match) return;
  document.querySelectorAll<HTMLElement>('#to-modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dummy === match!.dummy.mode)));
  $('to-level-row').hidden = match.dummy.mode !== 'cpu';
  $('to-level').textContent = `CPU level ${match.dummy.level}`;
}

/** The key list as a panel over Pause ("All controls"); the same lists are the All controls screen in the menu. */
function openControlsPanel(open: boolean): void {
  $('controls-panel').hidden = !open;
  if (open) ($('btn-controls-close') as HTMLButtonElement).focus();
  else ($('btn-resume') as HTMLButtonElement).focus();
}

let spotIndex = Math.floor(Math.random() * CHARACTERS.length);
/** Large images already downloaded and decoded, so a swap never waits on the network. */
const spotImages = new Map<string, Promise<void>>();
function spotReady(id: string): Promise<void> {
  let p = spotImages.get(id);
  if (!p) {
    const im = new Image();
    im.src = largeUrl(id);
    p = im.decode().catch(() => undefined);
    spotImages.set(id, p);
  }
  return p;
}
let spotShown = -1;
let spotBusy = false;

/** Shows the current spotlight fighter: picture and name change together, once the picture is ready. */
async function spotlight(animate = false): Promise<void> {
  updateNextEpisode();
  updateLessonTicks();
  const blurb = document.getElementById('campaign-blurb');
  if (blurb) blurb.textContent = campaignBlurb();
  renderDaily();
  const i = spotIndex % CHARACTERS.length;
  const c = CHARACTERS[i];
  if (spotBusy || i === spotShown) return;
  spotBusy = true;
  await spotReady(c.id);
  spotBusy = false;
  if (spotIndex % CHARACTERS.length !== i) return;
  const img = $<HTMLImageElement>('main-spot-img');
  // Swap the picture and wait for it to decode before the caption changes, so the name never
  // sits under the previous fighter's art while the new file is still loading into the <img>.
  spotBusy = true;
  img.src = largeUrl(c.id);
  await img.decode().catch(() => undefined);
  spotBusy = false;
  if (spotIndex % CHARACTERS.length !== i) return;
  $('main-spot-name').textContent = c.name;
  img.dataset.fighter = c.id;
  spotShown = i;
  if (animate) {
    img.classList.remove('swap');
    void img.offsetWidth;
    img.classList.add('swap');
  }
  // Get the next one ready while this one is up.
  void spotReady(CHARACTERS[(i + 1) % CHARACTERS.length].id);
}
setInterval(() => {
  if (currentScreen() !== 'main' || spotBusy) return;
  spotIndex++;
  void spotlight(true);
}, 4000);

let lastSelect: 'versus' | 'training' = 'versus';

/**
 * The slots for a quick-play match. In versus, each CPU on Auto (the default; a manual level turns it off) plays at the
 * profile's Auto level (ai/autoLevel.ts), which a finished match moves. Training never uses it.
 */
function quickSlots(cfg: VersusConfig, mode: 'versus' | 'training'): SlotSetup[] {
  const level = loadAutoLevel();
  return cfg.slots.map((s) => {
    const base = { ...s, team: cfg.teams ? (s.team ?? 0) : undefined };
    if (mode !== 'versus' || s.cpu === null || s.cpu === 0 || s.auto === false) return { ...base, auto: undefined };
    return { ...base, cpu: level, auto: true };
  });
}

/** After a finished versus match with an Auto CPU: moves the saved level and returns the note for the Results, if it changed. */
function autoLevelAfter(m: Match): { from: number; to: number; text: string } | null {
  const setup = m.setup;
  if (setup.mode !== 'versus' || m.state.winner < 0 || !setup.slots.some((s) => s.auto)) return null;
  const me = m.state.fighters[m.player];
  const foes = m.state.fighters.filter((f) => setup.slots[f.id]?.cpu && setup.slots[f.id].cpu! > 0);
  if (!me || !foes.length) return null;
  const stocks = setup.stocks;
  const change = applyAutoResult({
    won: m.playerWon(),
    stocks,
    stocksLeft: me.stocks,
    foeStocksLost: foes.reduce((n, f) => n + Math.max(0, stocks - f.stocks), 0),
    dealt: m.stats[me.id].dealt,
  });
  window.dispatchEvent(new CustomEvent('dod:auto-level', { detail: { won: m.playerWon(), stocksLeft: me.stocks, from: change?.from ?? loadAutoLevel(), to: change?.to ?? loadAutoLevel(), changed: !!change } }));
  return change ? { ...change, text: levelNote(change.from, change.to) } : null;
}

/** A rematch plays at the level the last match left (Auto CPUs only). */
function rematchSetup(setup: MatchSetup): MatchSetup {
  if (!setup.slots.some((s) => s.auto)) return setup;
  const level = loadAutoLevel();
  return { ...setup, slots: setup.slots.map((s) => (s.auto ? { ...s, cpu: level } : s)) };
}

function openVersus(): void {
  lastSelect = 'versus';
  chapter = null;
  analytics.setMode('versus');
  go('select', () =>
    openSelect({
      mode: 'versus',
      config: versus,
      onDone: (cfg) => {
        versus = cfg;
        saveVersus();
        analytics.fighterPicks('versus', cfg.slots);
        // Both fighters are picked: fetch art and pre-build Babylon meshes while the stage is chosen.
        void prefetchFighters(cfg.slots.map((s) => s.char));
        go('stages', () => openStages(stagesFor('versus'), pickStage, stageChoice, prepStageSelect));
      },
    }),
  );
}

function openTraining(): void {
  lastSelect = 'training';
  chapter = null;
  analytics.setMode('training');
  go('select', () =>
    openSelect({
      mode: 'training',
      config: training,
      onDone: (cfg) => {
        training = cfg;
        analytics.fighterPicks('training', cfg.slots);
        void prefetchFighters(cfg.slots.map((s) => s.char));
        go('stages', () => openStages(stagesFor('training'), pickStage, stageChoice, prepStageSelect));
      },
    }),
  );
}

/** Stage Select prep: build the arena + fighter meshes so the VS wipe stays light. */
let prepTimer = 0;
let prepGen = 0;
function prepStageSelect(stage: number, immediate = false): void {
  prefetchStage(stage);
  window.clearTimeout(prepTimer);
  const gen = ++prepGen;
  const run = () => {
    if (gen !== prepGen || currentScreen() !== 'stages') return;
    renderer.setStage(stage);
    const cfg = lastSelect === 'training' ? training : versus;
    const setup: MatchSetup = {
      mode: lastSelect,
      stage,
      stocks: cfg.stocks,
      rules: { timeLimit: cfg.time * 60 * 60 },
      slots: quickSlots(cfg, lastSelect),
    };
    // keepStage: don't rebuild the arena we just set; clipWait 0: sheets finish later via warmTick.
    renderer.setLooks(setup.slots.map((s) => s.look ?? 0));
    void renderer.setFighters(new Match(setup, 1).state, true, 0);
  };
  // Focused card on open: run now so smoke finishes prep before the stage click.
  if (immediate) run();
  else prepTimer = window.setTimeout(run, 120);
}

function pickStage(stage: number, entry: ModeStage, random = false): void {
  stageChoice = stage;
  // Drop a pending debounce so it can't start a second build mid-wipe.
  window.clearTimeout(prepTimer);
  prepGen++;
  prefetchStage(stage);
  renderer.setStage(stage);
  renderer.regrade();
  selectedAt = performance.now();
  const cfg = lastSelect === 'training' ? training : versus;
  analytics.stagePick(lastSelect, stage, random);
  // The announcer shouts the stage's name (startMatch lets it finish before the VS card).
  void audio.call(`announcer.stage.${STAGES[stage].id}`);
  const setup: MatchSetup = {
    mode: lastSelect,
    stage,
    stocks: cfg.stocks,
    // The mode's version of the stage can change its rules (a calm version with hazards off).
    rules: { ...entry.rules, timeLimit: cfg.time * 60 * 60 },
    slots: quickSlots(cfg, lastSelect),
  };
  // Build (or no-op reuse) on the stages screen; startMatch drains the lock before the VS wipe.
  renderer.setLooks(setup.slots.map((s) => s.look ?? 0));
  void renderer.setFighters(new Match(setup, 1).state, true, 0);
  startMatch(setup, lastSelect === 'versus');
}

// ------------------------------------------------------------- campaign

function openCampaignScreen(unlocked?: string): Promise<void> {
  chapter = null;
  return go('campaign', () =>
    openCampaign(progress, playChapter, () => {
      progress.clear();
      saveProgress(progress);
      saveStars({});
      saveBests({});
      openCampaignScreen();
    }, unlocked, replayChapter),
  );
}

/** The fighter a cleared episode is being replayed as (index into CHARACTERS), or null for the story's Exit Punk. */
let replayAs: number | null = null;

/** "Replay as…" on a cleared episode's card: the picker of unlocked fighters, then the same episode with that fighter. */
function replayChapter(c: Chapter): void {
  openReplayPicker({
    title: c.title,
    chapter: c.id,
    current: c.fight.slots[0]?.char ?? 0,
    onPick: (char) => void playChapter(c, char),
  });
}

/** The episode's fight with the player's slot swapped for another fighter: foes, stage, objective and rules unchanged. */
function replayFight(fight: MatchSetup, char: number): MatchSetup {
  const slots = fight.slots.map((s) => ({ ...s }));
  const me = slots.findIndex((s) => s.cpu === null);
  if (me < 0) return fight;
  slots[me].char = char;
  let look = preferredLook(char);
  const clash = (l: number) => slots.some((o, i) => i !== me && o.char === char && (o.look ?? 0) === l);
  for (let k = 0; clash(look) && k < lookCount(char); k++) {
    look = (look + 1) % lookCount(char);
    if (!lookOpen(char, look)) look = 0;
  }
  slots[me].look = look;
  return { ...fight, slots };
}

async function playChapter(c: Chapter, as?: number): Promise<void> {
  replayAs = as ?? null;
  chapter = c;
  analytics.chapterPlayed(c);
  // The episode opens on "Previously on Dose of Destruction": the last episode's final KO, replayed under Blog Man's recap.
  await playRecap(c);
  if (chapter !== c) return;
  const n = CHAPTERS.indexOf(c) + 1;
  // The map's difficulty (campaign/difficulty.ts) shapes this episode's fight; Retry replays the setup it made.
  const fight = chapterFight(c, difficulty());
  // The story card and scene take a while to read: the fight's fighters and arena load meanwhile.
  void prefetchFighters(fight.slots.map((s) => s.char));
  prefetchStage(c.fight.stage);
  renderer.setStage(c.fight.stage);
  renderer.setLooks(fight.slots.map((s) => s.look ?? 0));
  void renderer.setFighters(new Match({ ...fight, title: undefined, subtitle: undefined }, 1).state, true, 0);
  // The episode opens in the arena: the VS card, then the intro plays live with the fighters (ui/scene.ts).
  startMatch({ ...fight, title: `Chapter ${n} · ${c.title}`, subtitle: c.hint }, true, undefined, { chapter: c, which: 'intro' });
}

/** The difficulty this episode is being played on (what its clear is badged with). */
let chapterDiff: Difficulty = 'normal';

/** An episode's fight on a difficulty; logs it (`dod:difficulty`) so the playtest can read the CPU level that was used. */
function chapterFight(c: Chapter, d: Difficulty, why: 'start' | 'offer' = 'start'): MatchSetup {
  chapterDiff = d;
  const base = replayAs === null ? c.fight : replayFight(c.fight, replayAs);
  const fight = withDifficulty(base, d);
  window.dispatchEvent(new CustomEvent('dod:difficulty', { detail: { phase: why, chapter: c.id, difficulty: d, cpuFrom: foeLevels(c.fight), cpuTo: foeLevels(fight) } }));
  if (replayAs !== null) {
    const foes = fight.slots.filter((s) => s.cpu !== null).map((s) => CHARACTERS[s.char].id);
    window.dispatchEvent(new CustomEvent('dod:replay-as', { detail: { phase: 'fight', chapter: c.id, fighter: CHARACTERS[replayAs].id, foes, stage: STAGES[fight.stage].id, objective: fight.objective ?? 'win', original: c.fight.slots.filter((s) => s.cpu !== null).map((s) => CHARACTERS[s.char].id) } }));
  }
  return fight;
}

/** "Try it on Easy?" accepted: Easy becomes the map's choice and the same episode starts again with the softer foes. */
function tryOnEasy(c: Chapter, m: Match): void {
  setDifficulty('easy');
  clearLosses();
  const fight = chapterFight(c, 'easy', 'offer');
  void startMatch({ ...fight, title: m.setup.title, subtitle: m.setup.subtitle }, false);
}

/** What a story scene plays: the chapter's intro (before Ready) or outro (after the episode is won). */
interface SceneCue {
  /** A campaign chapter's scene, or a Tour's (its own lines and card). */
  chapter?: Chapter;
  tour?: { lines: SceneLine[]; card: SceneCard; id: string };
  which: 'intro' | 'outro';
}

/** The arena, camera and sound a scene drives, for this match. The player stands first in the cast. */
function sceneStage(m: Match, kind: VoiceKind = 'scene'): SceneStage {
  const ids = m.state.fighters.map((f) => f.id);
  const order = m.player >= 0 ? [m.player, ...ids.filter((id) => id !== m.player)] : ids;
  return {
    cast: order.map((id) => ({ id, who: CHARACTERS[m.state.fighters[id].char].id })),
    direct: (shot) => renderer.direct(shot),
    holdOffstage: (id, held) => renderer.holdOffstage(id, held),
    arrive: (id) => renderer.arrive(id),
    cue: (id) => renderer.cue(id),
    taunt: (who) => audio.fighterVoice(who, 'taunt'),
    voice: (url) => audio.voice(url, kind),
    stopVoice: () => audio.stopVoice(),
    voiceMs: (url) => audio.voiceMs(url),
    synth: (kind, level) => audio.synth(kind, level),
    duck: (on) => audio.duck(on),
  };
}

/**
 * The pre-fight exchange for a match (content/intros.json): two fighters, in Versus every time and in the campaign the
 * first time their listed pair meets (`firstTimeOnly`). Not Training, online, a Tour or the daily episode.
 */
function exchangeFor2(m: Match, firstTimeOnly: boolean): Exchange | null {
  if (m.setup.slots.length !== 2 || m.setup.mode === 'training' || m.setup.mode === 'online') return null;
  const [a, b] = m.setup.slots.map((s) => CHARACTERS[s.char]);
  const ex = exchangeFor(a.id, b.id, a.role);
  if (firstTimeOnly && (ex.generic || seenExchanges().has(ex.id))) return null;
  return ex;
}

/** Plays a pre-fight exchange on the stage (phase 'scene'); the fighters are already standing there. */
async function runExchange(m: Match, ex: Exchange): Promise<void> {
  phase = 'scene';
  audio.playStageBed(STAGES[m.setup.stage].id);
  $('scene-next').focus();
  const end = await playExchange(sceneStage(m, 'banter'), ex.id, ex.lines);
  if (!ex.generic) markExchangeSeen(ex.id);
  analytics.scene(ex.id, { skipped: end.skipped, line: Math.max(0, end.lines - 1) }, ex.lines.length);
}

/**
 * The match intro (campaign/intro.ts, ui/matchIntro.ts): a 3 s fly-in from the stage's far layers to the fight, the stage's
 * name as the lower third (with the announcer's call when it is recorded), each fighter's entrance. Any input skips it.
 */
async function runMatchIntro(m: Match): Promise<void> {
  phase = 'scene';
  const st = STAGES[m.setup.stage];
  const plan = planIntro(m.state.fighters.map((ft) => ({ slot: ft.id, who: CHARACTERS[ft.char].id, x: ft.x / FX, color: PLAYER_COLORS[ft.id % PLAYER_COLORS.length] })), st.id);
  audio.playStageBed(st.id);
  renderer.onIntroBeat = (slot, who, fx) => {
    if (fx === 'taunt') audio.fighterVoice(who, 'taunt');
  };
  $('scene-next').focus();
  await playMatchIntro(
    {
      begin: (p) => renderer.introBegin(p),
      end: () => {
        renderer.introEnd();
        renderer.onIntroBeat = null;
      },
      stageCall: (id) => {
        const line = voiceLine(`announcer.stage.${id}`);
        if (!line?.audio) return false;
        void audio.call(`announcer.stage.${id}`);
        return true;
      },
      input: () => readLocal(),
    },
    plan,
    { id: st.id, name: st.name, blurb: st.blurb },
  );
}

/** Plays a chapter's intro or outro live in the arena (phase 'scene'), with its story card as the lower third. */
async function runScene(m: Match, cue: SceneCue): Promise<void> {
  if (cue.tour) {
    phase = 'scene';
    audio.playStageBed(STAGES[m.setup.stage].id);
    $('scene-next').focus();
    const end = await playScene(sceneStage(m), cue.which, cue.tour.lines, cue.tour.card);
    analytics.scene(`${cue.tour.id}.${cue.which}`, end, cue.tour.lines.length);
    return;
  }
  const c = cue.chapter!;
  const lines: SceneLine[] = cue.which === 'intro' ? c.intro : c.outro;
  if (cue.which === 'intro' && c.coldOpen?.length) {
    phase = 'scene';
    audio.playStageBed(STAGES[m.setup.stage].id);
    $('scene-next').focus();
    const end = await playColdOpen(sceneStage(m), c.coldOpen);
    analytics.scene(`${c.id}.cold-open`, { skipped: end.skipped, line: 0 }, c.coldOpen.length);
    return;
  }
  const card = storyCard(c, cue.which === 'intro' ? 'before' : 'after');
  phase = 'scene';
  audio.playStageBed(STAGES[m.setup.stage].id);
  $('scene-next').focus();
  const end = await playScene(sceneStage(m), cue.which, lines, card);
  analytics.scene(`${c.id}.card-${cue.which === 'intro' ? 'before' : 'after'}`, { skipped: end.cardSkipped, line: 0 }, 1);
  analytics.scene(`${c.id}.${cue.which}`, end, lines.length);
}

// ------------------------------------------------ the episode's bookends

/** The arena draws and advances this instead of the match while a replay, recap or tease plays (ui/segment.ts). */
let showcase: Showcase | null = null;
/** The tick (match frame) the replay of a won episode starts at, or -1. */
let bookendAt = -1;
/** A beat after Game! (the KO is on screen, the crowd has reacted) the replay cuts in: well inside a second of the KO. */
const BOOKEND_DELAY_TICKS = 40;

/** The chapter whose won match gets a replay, a tease and (next time) a recap: a campaign episode, not the pilot or the daily. */
function bookendChapter(m: Match): Chapter | null {
  if (m.setup.mode !== 'campaign' || m.setup.teach === 'pilot' || dailyRun?.setup === m.setup || !chapter) return null;
  return m.playerWon() ? chapter : null;
}

function segmentEnv(): SegmentEnv {
  return {
    showcase: (sc) => {
      showcase = sc;
    },
    events: (events) => {
      renderer.onEvents(events);
      replaySounds(events);
    },
    direct: (shot) => renderer.direct(shot),
    voice: (url) => audio.voice(url),
    stopVoice: () => audio.stopVoice(),
    voiceMs: (url) => audio.voiceMs(url),
    synth: (kind, level) => audio.synth(kind, level),
    duck: (on) => audio.duck(on),
  };
}

/** The sounds of a replayed hit and KO (no barks: Blog Man is talking over it). */
const HIT_SOUND = { light: 'hit-light', medium: 'hit-medium', heavy: 'hit-heavy' } as const;

function replaySounds(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'hit' && !e.shield) {
      audio.sfx(HIT_SOUND[hitTier(e.dmg)], { vary: true });
      if (e.dmg >= 130 && !events.some((k) => k.type === 'ko')) audio.crowd('ooh');
    } else if (e.type === 'ko') {
      audio.sfx('ko');
      audio.killSting();
      audio.crowd('roar');
    }
  }
}


// ------------------------------------------------ Watch replay (Results)

/** The replay on screen: the player (a fresh Match fed the recorded inputs), its control bar and the way back. */
let replayRun: { rotateWas: boolean; player: ReplayPlayer; bar: ReplayBar; hudFor: Match; back: () => void; ended: boolean; seq: number } | null = null;
let replaySeq = 0;

/** Keeps the finished match's replay with the profile (bounded) and returns the full one for Watch replay. */
function keepReplay(m: Match): Replay | null {
  if (m.setup.mode === 'training' || m.setup.teach === 'pilot') return null;
  const r = m.buildReplay();
  if (r) saveReplay(r);
  return r;
}

/** Adds Watch replay after the primary result button. `reshow` puts the same results back. */
function addWatchReplay(actions: (ResultAction & { disabled?: boolean })[], m: Match, reshow: () => void): void {
  const r = keepReplay(m);
  if (!r) return;
  actions.splice(Math.min(1, actions.length), 0, { label: 'Watch replay', run: () => void watchReplay(r, reshow) });
}

function endReplay(): void {
  const run = replayRun;
  if (!run) return;
  replayRun = null;
  run.bar.destroy();
  renderer.setFreeCamera(false);
  suppressRotate(run.rotateWas);
  audio.stopVoice();
  replayEmit('exit', { tick: run.player.tick });
}

async function watchReplay(r: Replay, back: () => void): Promise<void> {
  const player = new ReplayPlayer(r);
  const setup = player.match.setup;
  await go('match', async () => {
    endMatch();
    $('hud').hidden = true;
    audio.stopVoice();
    await arenaFor(setup.stage, setup.slots.map((x) => x.look ?? 0), player.state, 4000);
    audio.playStageBed(STAGES[setup.stage].id);
    buildHud(player.match);
    renderer.render(player.state);
  });
  const seq = ++replaySeq;
  const exit = (): void => {
    if (!replayRun || replayRun.seq !== seq) return;
    endReplay();
    back();
  };
  const note = (phase: string): void => replayEmit(phase, { speed: player.speed, paused: player.paused, camera: player.camera, tick: player.tick, total: player.totalTicks });
  const bar = openReplayBar(
    {
      total: () => player.totalTicks,
      tick: () => player.tick,
      paused: () => player.paused || player.done,
      speed: () => player.speed,
      camera: () => player.camera,
      togglePause: () => {
        if (player.done) { player.restart(); player.paused = false; replayRun!.ended = false; } else player.togglePause();
        note('pause');
      },
      setSpeed: (sp) => { player.setSpeed(sp); note('speed'); },
      toggleCamera: () => {
        renderer.setFreeCamera(player.toggleCamera() === 'free');
        note('camera');
      },
      back: (sec) => { player.seek(player.tick - sec * 60); replayRun!.ended = false; note('seek'); },
      exit,
      pan: (dx, dy) => { const k = renderer.freeCameraState().d * 0.0016; renderer.panFreeCamera(-dx * k, dy * k); },
      zoom: (st) => renderer.panFreeCamera(0, 0, st * 1.5),
    },
    canvas,
  );
  // The replay shows in portrait too: the bar sits along the bottom of a 390x844 phone (the Rotate prompt would cover it).
  const rotateWas = rotateSuppressed();
  suppressRotate(true);
  replayRun = { rotateWas, player, bar, hudFor: player.match, back, ended: false, seq };
  note('start');
}

/** One frame of the replay: advance by wall time at the chosen speed, draw, keep the HUD on the replayed match. */
function replayFrame(dtMs: number, draw: boolean): void {
  const run = replayRun;
  if (!run) return;
  const p = run.player;
  const { events } = p.advance(dtMs);
  if (events.length) {
    renderer.onEvents(events);
    replaySounds(events);
  }
  if (run.hudFor !== p.match) {
    run.hudFor = p.match;
    buildHud(p.match);
  }
  updateHud(p.match);
  if (p.done && !run.ended) {
    run.ended = true;
    const s = p.state;
    replayEmit('end', {
      winner: s.winner, stocks: s.fighters.map((f) => f.stocks), percents: s.fighters.map((f) => f.percent),
      want: p.replay.result.winner, wantStocks: p.replay.result.stocks, hash: hashState(s), wantHash: p.replay.result.hash,
      tick: p.tick, total: p.totalTicks,
    });
  }
  run.bar.update();
  if (draw) renderer.render(p.state);
}

/** A fight's cast standing on their stage, idling: what the tease cuts to. */
function idleShowcase(setup: MatchSetup): Showcase {
  const state = new Match({ ...setup, title: undefined, subtitle: undefined }, 1).state;
  const idle = state.fighters.map(() => NO_INPUT);
  for (let i = 0; i < 150; i++) step(state, idle);
  let acc = 0;
  return {
    state,
    advance: (dt) => {
      acc += dt / TICK_MS;
      while (acc >= 1) {
        acc -= 1;
        step(state, idle);
      }
      return [];
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Puts a stage and its fighters on the arena for a segment (ready within `limitMs`, whatever is still loading finishes behind it). */
async function arenaFor(stage: number, looks: number[], state: GameState, limitMs: number): Promise<void> {
  prefetchStage(stage);
  void prefetchFighters(state.fighters.map((f) => f.char));
  renderer.setStage(stage);
  renderer.setLooks(looks);
  await Promise.race([renderer.setFighters(state, true, 1500).catch(() => undefined), wait(limitMs)]);
}

/** Blog Man's line by id, as a segment caption (text always, voice when it is recorded). */
const blogLine = (id: string): { id: string; text: string; audio?: string | null } | undefined => {
  const l = voiceLine(id);
  return l ? { id, text: l.text, audio: l.audio } : undefined;
};

/**
 * A won episode's ending, from the moment of the KO: the replay of the final KO (the last hit at 25%, the lower third,
 * the logo bug), the outro scene, then "Next time on Dose of Destruction" with Blog Man's tease over two cuts of the
 * next episode, then the results. Every segment is skippable and the results always come.
 */
async function episodeEnd(m: Match, c: Chapter): Promise<void> {
  phase = 'scene';
  clearMarkers();
  clearTags();
  const hl = m.highlight;
  if (hl) {
    hl.chapter = c.id;
    hl.looks = m.setup.slots.map((x) => x.look ?? 0);
    saveHighlight(hl);
    // The save keeps it for the next episode's recap. The replay itself runs through the same sim.
    await playSegment(segmentEnv(), {
      kind: 'replay',
      tag: 'Replay',
      kicker: `${storyCard(c, 'after').kicker} \u00b7 final KO`,
      title: c.title,
      showcase: new HighlightPlayer(hl),
      info: { chapter: c.id, stage: hl.stage, hit: hl.hit, ko: hl.ko, inputs: hl.inputs.length },
    });
  }
  if (match !== m) return;
  if (c.outro.length) await runScene(m, { chapter: c, which: 'outro' });
  if (match !== m) return;
  await playTease(m, c);
  if (match === m) showFinish(m, true, c);
}

/** "Next time on Dose of Destruction": Blog Man's tease over two quick cuts of the next episode's stage and fighters. */
async function playTease(m: Match, c: Chapter): Promise<void> {
  const nextId = nextChapterId(c.id);
  const next = nextId ? CHAPTERS.find((x) => x.id === nextId) ?? null : null;
  const id = teaseId(c.id);
  const here = next ?? c;
  const show = idleShowcase(here.fight);
  await Promise.all([audio.preloadLines([id], 2500), arenaFor(here.fight.stage, here.fight.slots.map((x) => x.look ?? 0), show.state, 3500)]);
  if (match !== m) return;
  const line = blogLine(id);
  // The last episode has no next one: it signs off on its own stage.
  await playSegment(segmentEnv(), {
    kind: 'tease',
    tag: 'Next time on Dose of Destruction',
    kicker: next ? storyCard(next, 'before').kicker : 'The end of the series',
    title: next ? next.title : "That's a wrap",
    line,
    showcase: show,
    cuts: [null, show.state.fighters.length > 1 ? 1 : 0],
    holdMs: 3000,
    info: { chapter: c.id, next: next?.id ?? null, stage: STAGES[here.fight.stage].id, voiced: !!line?.audio },
  });
}

/**
 * "Previously on Dose of Destruction": the saved highlight of the last episode's final KO, replayed on its own stage
 * under Blog Man's recap, before the next episode's VS card. Skippable; nothing happens when there is no saved KO.
 */
async function playRecap(c: Chapter): Promise<void> {
  const hl = loadHighlight();
  if (!recapApplies(hl, c.id)) return;
  const prev = CHAPTERS.find((x) => x.id === hl.chapter);
  if (!prev) return;
  const id = recapId(prev.id);
  const player = new HighlightPlayer(hl);
  await go('match', async () => {
    endMatch();
    chapter = c;
    $('hud').hidden = true;
    await Promise.all([audio.preloadLines([id], 2500), arenaFor(stageIndex(hl.stage), hl.looks, hl.start, 4000)]);
    audio.playStageBed(hl.stage);
    renderer.render(player.state);
  });
  if (chapter !== c) return;
  await playSegment(segmentEnv(), {
    kind: 'recap',
    tag: 'Previously on Dose of Destruction',
    kicker: storyCard(prev, 'after').kicker,
    title: prev.title,
    line: blogLine(id),
    showcase: player,
    info: { chapter: prev.id, opens: c.id, stage: hl.stage, voiced: !!blogLine(id)?.audio },
  });
}

async function chapterCleared(c: Chapter): Promise<void> {
  // The outro already played in the arena after Game! (finish).
  const firstTime = !progress.has(c.id);
  markCleared(c.id, chapterDiff);
  clearLosses();
  progress.add(c.id);
  saveProgress(progress);
  analytics.chapterCleared(c, firstTime, progress);
  // The hero this episode unlocks (once): the map says so.
  await openCampaignScreen(unlockFor(c) ?? undefined);
  // Back on the map, the episode over: the stars card.
  if (currentScreen() === 'campaign' && replayAs === null) analytics.askAfterEpisode(c);
}

// ------------------------------------------------------------------ tour

/** The Tour being played: the fighter's route, the fight (zero-based) and its setup (the object marks the match). */
let tourRun: { tour: Tour; index: number; setup: MatchSetup; continues: number } | null = null;
/** Playtest setup shortcut (hooks.tourSkipTo): after this many fights are won, the run jumps to the fight at index `to`. */
let tourSkip: { after: number; to: number } | null = null;

/** The match on screen is a Tour fight. */
const inTour = (): boolean => !!tourRun && !!match && tourRun.setup === match.setup;

function tourEvent(phase: string, detail: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent('dod:tour', { detail: { phase, ...detail } }));
}

/** An existing recorded line by id (content/voice.json), for scenes. */
const voiceLine = (id: string): { text: string; audio?: string | null } | undefined => VOICE.lines.find((l) => l.id === id);

const tourAudio = (tour: Tour, index: number): (string | undefined)[] => [
  ...tourIntro(tour, index, voiceLine).lines.map((l) => l.audio ?? undefined),
  ...(index === tour.fights.length - 1 ? tourEnding(tour, voiceLine).lines.map((l) => l.audio ?? undefined) : []),
];

function openTourScreen(): Promise<void> {
  tourRun = null;
  chapter = null;
  return go('tour', () => {
    renderTourSelect(loadTours(), { open: (id) => isUnlocked(id), onPlay: playTour });
    tourEvent('select', { cleared: [...loadTours()] });
  });
}

/** Extras: the Endings gallery; a tap on an open slot replays that ending. */
function openExtras(): Promise<void> {
  return go('extras', () => {
    renderEndings(loadTours(), (e: Ending) => void playEnding(e, { replay: true }));
    $('btn-opening').onclick = () => void playOpening({ replay: true });
    window.dispatchEvent(new CustomEvent('dod:ending', { detail: { phase: 'gallery', slots: TOUR_ENDINGS.length, cleared: [...loadTours()] } }));
  });
}

function playTour(tour: Tour): void {
  tourRun = { tour, index: 0, setup: tourSetup(tour, 0), continues: 0 };
  analytics.setMode('campaign');
  analytics.tour('start', { fighter: tour.fighter, rival: tour.rival });
  tourEvent('start', { fighter: tour.fighter });
  startTourFight(true);
}

/** Starts the run's current fight: the VS card, the foe's line in the arena, Ready, Go. */
function startTourFight(withScene: boolean): void {
  const r = tourRun;
  if (!r) return;
  chapter = null;
  r.setup = tourSetup(r.tour, r.index);
  void prefetchFighters(r.setup.slots.map((s) => s.char));
  prefetchStage(r.setup.stage);
  tourEvent('fight', { fighter: r.tour.fighter, fight: r.index + 1, of: TOUR_LENGTH, twist: r.tour.fights[r.index].twist, foes: r.tour.fights[r.index].foes, stage: r.tour.fights[r.index].stage, cpu: r.tour.fights[r.index].cpu });
  const intro = tourIntro(r.tour, r.index, voiceLine);
  void startMatch(r.setup, true, undefined, withScene ? { tour: { ...intro, id: `tour.${r.tour.fighter}.${r.index + 1}` }, which: 'intro' } : undefined);
}

/** A lost fight's Continue: the same fight again (no VS card, no scene). */
function tourContinue(): void {
  const r = tourRun;
  if (!r) return;
  r.continues++;
  analytics.tour('continue', { fighter: r.tour.fighter, fight: r.index + 1, continues: r.continues });
  tourEvent('continue', { fighter: r.tour.fighter, fight: r.index + 1, continues: r.continues });
  r.setup = tourSetup(r.tour, r.index);
  void startMatch(r.setup, false);
}

/** A Tour fight is over. A win goes straight on to the next fight; the last win plays the ending; a loss offers Continue or Quit. */
async function tourFinish(m: Match, won: boolean): Promise<void> {
  const r = tourRun!;
  const last = r.index >= r.tour.fights.length - 1;
  if (!won) {
    analytics.tour('lost', { fighter: r.tour.fighter, fight: r.index + 1 });
    // The foe gloats over the Continue or Quit choice: the results' win quote (showFinish) is their line.
    tourEvent('lost', { fighter: r.tour.fighter, fight: r.index + 1 });
    showFinish(m, false, null);
    return;
  }
  analytics.matchEnd(m, 'complete');
  analytics.tour('fight', { fighter: r.tour.fighter, fight: r.index + 1 });
  tourEvent('won', { fighter: r.tour.fighter, fight: r.index + 1 });
  if (!last) {
    r.index = tourSkip && r.index + 1 >= tourSkip.after && tourSkip.to > r.index + 1 ? tourSkip.to : r.index + 1;
    tourSkip = null;
    startTourFight(true);
    return;
  }
  // The ending: the fighter's own win line over the final KO, the closing card. The Tour is marked cleared as it starts.
  const first = markTourCleared(r.tour.fighter);
  analytics.tour('clear', { fighter: r.tour.fighter, first, continues: r.continues });
  tourEvent('clear', { fighter: r.tour.fighter, first, continues: r.continues });
  phase = 'scene';
  await audio.preloadUrls(tourAudio(r.tour, r.index));
  if (match !== m) return;
  await runScene(m, { tour: { ...tourEnding(r.tour, voiceLine), id: `tour.${r.tour.fighter}.ending` }, which: 'outro' });
  // Then the fighter's own painted ending: the picture, the narrated line, the sting and "Tour complete".
  const ending = endingFor(r.tour.fighter);
  if (match === m && ending) {
    await audio.preloadUrls([ending.audio]);
    await playEnding(ending);
  }
  if (match === m) showFinish(m, true, null);
}

// -------------------------------------------------------------- the pilot

/** Open Mic as the first fight: Kaelen tuned to be beaten (ai/bot.ts pilotFight), prompts on the stage, no VS card. */
function pilotChapter(): Chapter | null {
  const c = CHAPTERS.find((x) => x.id === PILOT_CHAPTER);
  if (!c) return null;
  const kaelen = CHARACTERS.findIndex((x) => x.id === 'kaelen');
  return {
    ...c,
    fight: {
      ...c.fight,
      teach: 'pilot',
      slots: c.fight.slots.map((sl) => (sl.cpu !== null && sl.char === kaelen ? { ...sl, ...PILOT_KAELEN } : sl)),
    },
  };
}

/** Tap to play with nothing saved: straight into the cold open of Season 1 Episode 1, under the title logo. */
function startPilot(): void {
  const c = pilotChapter();
  if (!c) return;
  chapter = c;
  analytics.setMode('campaign');
  analytics.chapterPlayed(c);
  const logo = $('pilot-logo');
  document.body.classList.add('pilot-boot');
  logo.classList.remove('over-shot', 'gone');
  void prefetchFighters(c.fight.slots.map((s) => s.char));
  prefetchStage(c.fight.stage);
  renderer.setStage(c.fight.stage);
  // The logo is the loading screen; once the cold open's first shot is up it turns to a title over that shot.
  const onScene = new MutationObserver(() => {
    if ($('scene').hidden) return;
    onScene.disconnect();
    logo.classList.add('over-shot');
    window.setTimeout(() => logo.classList.add('gone'), 3200);
    window.setTimeout(endPilotBoot, 4000);
  });
  onScene.observe($('scene'), { attributes: true, attributeFilter: ['hidden'] });
  void startMatch({ ...c.fight, title: `Chapter 1 · ${c.title}`, subtitle: c.hint }, false, undefined, { chapter: c, which: 'intro' });
  // After startMatch has cleared the last match (it ends it first), the small Menu link stays up through the scene and the fight.
  $('pilot-menu').hidden = false;
}

/** The title logo and its backdrop come down. */
function endPilotBoot(): void {
  document.body.classList.remove('pilot-boot');
}

function wirePilot(): void {
  // The small Menu link: opts out of the pilot (the flag is set, so the next visit is the usual flow too).
  $('pilot-menu').addEventListener('click', () => {
    markPilotSeen('menu');
    if (match) analytics.matchEnd(match, 'quit', { reason: 'pilot_menu' });
    endMatch();
    chapter = null;
    endPilotBoot();
    void go('main', spotlight);
  });
}

/** The pilot is won: Open Mic is cleared, Kaelen joins the card, and the main menu opens on "Next episode". */
async function pilotCleared(c: Chapter): Promise<void> {
  const firstTime = !progress.has(c.id);
  progress.add(c.id);
  saveProgress(progress);
  unlockFor(c);
  markPilotSeen('won');
  analytics.chapterCleared(c, firstTime, progress);
  chapter = null;
  analytics.setMode('main');
  // TV order: the pilot is the cold open, then the opening titles, once (Extras > Opening replays them).
  if (!openingSeen()) await playOpening();
  await go('main', spotlight);
}

/** How to play: the same prompted fight in Training against a dummy, with no setup screens. Lesson 2 ('defence'): grab, throw, roll, spot-dodge. Lesson 3 ('recovery'): the four specials, fast fall, the way back to the ledge. */
function startHowToPlay(lesson: 'training' | 'defence' | 'recovery' = 'training'): void {
  chapter = null;
  analytics.setMode('training');
  const ep = CHARACTERS.findIndex((x) => x.id === 'exit-punk');
  const dummy = CHARACTERS.findIndex((x) => x.id === 'kaelen');
  const stage = Math.max(0, STAGES.findIndex((x) => x.id === 'city-top'));
  void startMatch(
    {
      mode: 'training',
      stage,
      stocks: 1,
      rules: {},
      teach: lesson,
      title: lesson === 'defence' ? 'How to play 2' : lesson === 'recovery' ? 'How to play 3' : 'How to play',
      slots: [{ char: ep, cpu: null }, { char: dummy, cpu: 0 }],
    },
    false,
  );
}

/** The ticks on the How to play menu items: a lesson done stays ticked after a reload (campaign/lessons.ts). */
function updateLessonTicks(): void {
  const done = doneLessons();
  const ids: Record<string, LessonId> = { howto: 'training', howto2: 'defence', howto3: 'recovery' };
  for (const [go, id] of Object.entries(ids)) {
    const btn = document.querySelector<HTMLElement>(`.menu-item[data-go="${go}"]`);
    if (!btn) continue;
    const on = done.has(id);
    btn.classList.toggle('lesson-done', on);
    btn.dataset.done = on ? '1' : '0';
    let tick = btn.querySelector<HTMLElement>('.lesson-tick');
    if (on && !tick) {
      tick = h('em', { class: 'lesson-tick', 'aria-label': 'Done' }, '✓ Done') as HTMLElement;
      btn.prepend(tick);
    } else if (!on && tick) tick.remove();
  }
}

function lessonCardOff(): void {
  document.getElementById('lesson-card')?.remove();
}

/** A finished lesson: the match stands still under a card with Next lesson (Fight a CPU after the last) and Back to menu. */
function lessonCard(id: LessonId): void {
  lessonCardOff();
  phase = 'pause';
  syncPad();
  const next = nextLesson(id);
  const leave = (then: () => void) => () => {
    lessonCardOff();
    if (match) analytics.matchEnd(match, 'quit', { reason: 'lesson_done' });
    endMatch();
    then();
  };
  const primary = h('button', { class: 'menu-item lesson-primary', type: 'button', 'data-lesson-next': next ?? 'fight' }, h('strong', {}, next ? 'Next lesson' : 'Fight a CPU'), h('span', {}, next ? LESSON_TITLE[next] : 'Straight into a real match.'));
  primary.addEventListener('click', leave(() => {
    if (next) startHowToPlay(next);
    else startCpuFight();
  }));
  const back = h('button', { class: 'menu-item quiet lesson-back', type: 'button' }, h('strong', {}, 'Back to menu'));
  back.addEventListener('click', leave(() => void go('main', spotlight)));
  const card = h('div', { id: 'lesson-card', class: 'lesson-card', role: 'dialog', 'aria-label': 'Lesson complete' }, h('h2', {}, 'Lesson complete'), h('p', {}, LESSON_TITLE[id]), primary, back);
  document.body.appendChild(card);
  audio.sfx('ui-select');
  primary.focus();
}

/** After the last lesson: a real 2-stock match against a CPU, no setup screens. */
function startCpuFight(): void {
  chapter = null;
  analytics.setMode('versus');
  const ep = CHARACTERS.findIndex((x) => x.id === 'exit-punk');
  const foe = CHARACTERS.findIndex((x) => x.id === 'kaelen');
  const stage = Math.max(0, STAGES.findIndex((x) => x.id === 'city-top'));
  void startMatch({ mode: 'versus', stage, stocks: 2, rules: {}, slots: [{ char: ep, cpu: null }, { char: foe, cpu: 3 }] }, true);
}

/** The Campaign button on the main menu says "Next episode" once the pilot is won and the player hasn't gone on yet. */
function updateNextEpisode(): void {
  const btn = document.querySelector<HTMLElement>('.menu-item[data-go="campaign"]');
  if (!btn) return;
  const idx = CHAPTERS.findIndex((x) => !progress.has(x.id));
  const fresh = pilotState() === 'won' && progress.size === 1 && progress.has(PILOT_CHAPTER) && idx > 0;
  btn.classList.toggle('next-episode', fresh);
  let tag = btn.querySelector<HTMLElement>('.next-tag');
  if (fresh && !tag) {
    tag = h('em', { class: 'next-tag' }, 'Next episode') as HTMLElement;
    btn.prepend(tag);
  }
  if (tag) tag.hidden = !fresh;
  const sub = btn.querySelector('span');
  if (sub) {
    if (fresh) {
      sub.dataset.was ??= sub.textContent ?? '';
      sub.textContent = `${CHAPTERS[idx].title}: ${CHAPTERS[idx].tagline}`;
    } else if (sub.dataset.was) sub.textContent = sub.dataset.was;
  }
}

// ------------------------------------------------------- tonight's episode

/** The episode being played (its setup object marks the match, so Play again and the results know it). */
let dailyRun: { ep: DailyEpisode; setup: MatchSetup } | null = null;
let dailyViewed = '';

function dailyEvent(phase: string, detail: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent('dod:daily', { detail: { phase, ...detail } }));
}

/** The card on the main menu: rebuilt each time the menu shows (and when the date turns over). */
function renderDaily(): void {
  const date = dailyDate();
  const ep = dailyEpisode(date, DAILY_POOL);
  const state = loadDaily();
  const streak = liveStreak(state, date);
  const blog = introCall(ep.blogChapter)?.text ?? '';
  renderDailyCard(ep, state, streak, blog, {
    onPlay: playDaily,
    onListen: () => {
      const id = `blog-man.intro.${ep.blogChapter}`;
      analytics.daily('listen', { date });
      void audio.preloadLines([id]).then(() => audio.line(id));
    },
  });
  setCountdown(msToNext(Date.now()));
  if (dailyViewed !== date) {
    dailyViewed = date;
    analytics.daily('view', { date, fighter: ep.player, stage: ep.stage, objective: ep.objective, twists: ep.twists.map((t) => t.kind).join('+'), streak });
  }
  dailyEvent('card', { date, ep, streak, best: state.best[date] ?? 0 });
}

// The countdown is text only (no request): once a second while the menu shows, and a new card when midnight UTC passes.
setInterval(() => {
  if (currentScreen() !== 'main') return;
  if ($('daily-card').dataset.date !== dailyDate()) renderDaily();
  else setCountdown(msToNext(Date.now()));
}, 1000);

function playDaily(): void {
  const date = dailyDate();
  const ep = dailyEpisode(date, DAILY_POOL);
  const setup = dailySetup(ep);
  dailyRun = { ep, setup };
  chapter = null;
  analytics.setMode('campaign');
  analytics.daily('play', { date, fighter: ep.player, stage: ep.stage, objective: ep.objective });
  void startMatch(setup, true);
}

/** The episode is over: score it, keep the streak, show both on the results and post the score (a better one only). */
function dailyFinished(m: Match, ep: DailyEpisode, won: boolean): void {
  const s = m.state;
  const me = s.fighters[m.player];
  const margin =
    ep.objective === 'ko' ? m.koCount() - m.koTarget : ep.objective === 'quota' ? Math.round(m.quotaDealt() / 10) - (ep.quota ?? 0) : ep.objective === 'streak' ? m.streakBest() - m.streakTarget : 0;
  const taken = Math.round((m.stats[m.player]?.taken ?? 0) / 10);
  const score = dailyScore(ep, { won, frames: s.frame, taken, stocksLeft: me?.stocks ?? 0, margin });
  const before = loadDaily();
  const after = won ? recordClear(before, ep.date, score) : before;
  if (won) saveDaily(after);
  const prevBest = before.best[ep.date] ?? 0;
  const newBest = won && score > prevBest;
  const best = after.best[ep.date] ?? 0;
  const streak = liveStreak(after, ep.date);
  const panel = renderDailyResults({
    ep,
    won,
    score,
    best,
    newBest,
    streak,
    longest: after.longest,
    breakdown: `${formatTime(s.frame)} played, ${taken}% taken.`,
  });
  const strip = $('results-body').querySelector('.results-strip');
  if (strip) strip.after(panel);
  else $('results-body').prepend(panel);
  // The night's verdict is heard, not only read: a sting and the crowd (a roar for a new best), or the crowd's groan.
  audio.synth(won ? 'cheer' : 'alarm', newBest ? 1 : 0.6);
  if (won) window.setTimeout(() => audio.synth('sting', 0.7), 350);
  analytics.daily('result', { date: ep.date, won, score, best, streak, taken, seconds: Math.round(s.frame / 60) });
  dailyEvent('result', { date: ep.date, won, score, best, streak, newBest });
  void import('./net/daily.ts').then(async (d) => {
    let mine: Awaited<ReturnType<typeof d.postDaily>> | undefined;
    if (best > 0) mine = newBest ? await d.postDaily(ep.date, score) : { ...d.selfEntry(best) };
    const board = await d.readDailyBoard(ep.date, mine);
    fillBoard(board, d.selfEntry(0).id, d.BOARD_SHOWN);
    analytics.daily('board', { date: ep.date, rank: board.rank, total: board.total, ok: board.ok });
    dailyEvent('board', { date: ep.date, rank: board.rank, total: board.total, ok: board.ok, posted: newBest });
  });
}

// ------------------------------------------------------------------ match

let selectedAt = 0;
/** The VS card is never on screen longer than this from the wipe into it before the match starts. */
const VS_HOLD_CAP_MS = 4000;
const nextFrame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
/** When the wipe into the VS card began, and how long the last warm-up took (null until it finishes). */
let vsStart = 0;
let warmUpMs: number | null = null;

async function startMatch(setup: MatchSetup, withVersus: boolean, online?: { seed: number; found: Found }, scene?: SceneCue): Promise<void> {
  endMatch();
  // A stage variant (campaign/rewards.ts) is a Versus and Training choice: the show, the Tour and online play the stage as it is.
  if (setup.mode !== 'versus' && setup.mode !== 'training') {
    setVariant(null);
    renderer.regrade();
  }
  // A newer start (an online match found meanwhile) wins over this one.
  const token = ++startToken;
  const stale = () => token !== startToken || (f !== null && f.phase === 'done');
  const seed = online ? online.seed : (playtestSeed ?? (Math.random() * 0x7fffffff) | 0);
  const m = new Match(setup, seed);
  renderer.setLooks(setup.slots.map((s) => s.look ?? 0));
  const net = online ? onlineApi() : null;
  const f: OnlineFight | null = online && net ? new net.OnlineFight(online.found, m) : null;
  if (f) {
    fight = f;
    f.onEnd = (end) => onlineEnded(m, f, end);
    f.onStart = () => {
      if (match === m && phase === 'wait') beginReady(m);
    };
  }
  const t0 = performance.now();
  const pickedAt = selectedAt && t0 - selectedAt < 30000 ? selectedAt : null;
  const fromSelect = pickedAt === null ? null : t0 - pickedAt;
  selectedAt = 0;
  void prefetchFighters(setup.slots.map((s) => s.char));
  prefetchStage(setup.stage);
  // Audio can start during the VS wipe; Babylon stage/fighter work must NOT — it starved the wipe
  // (vsWipeFps ~17) and the old race still waited on an 1.8 s clip cap (vsHoldMs ~6 s).
  const audioReady = Promise.all([
    audio.preloadMatch(STAGES[setup.stage].id, m.state.fighters.map((f) => CHARACTERS[f.char].id)),
    audio.preloadLines(chapter ? [`blog-man.intro.${chapter.id}`] : dailyRun?.setup === setup ? [`blog-man.intro.${dailyRun.ep.blogChapter}`] : []),
    audio.preloadUrls(chapter ? [...chapter.intro, ...chapter.outro].map((l) => l.audio) : tourRun?.setup === setup ? tourAudio(tourRun.tour, tourRun.index) : []),
  ]).catch((err) => console.error(err));

  warmUpMs = null;
  let fightersReady: Promise<void> = Promise.resolve();
  let warm: Promise<void> = Promise.resolve();

  if (withVersus) {
    let splash: Promise<void> = Promise.resolve();
    // Finish Stage Select prep on the stages screen so it can't starve the VS wipe (vsWipeFps).
    renderer.setStage(setup.stage);
    // The stage's name (just picked) plays out first, by its real length, so the VS calls don't cut it.
    const stageCall = new Promise<void>((r) => setTimeout(r, Math.min(1700, audio.callBusyMs())));
    await Promise.all([renderer.whenFightersIdle(), stageCall]);
    if (stale()) return;
    // Wipe into VS with only DOM + audio prefetch on the main thread.
    vsStart = performance.now();
    await go('versus', () => {
      splash = playVersus(setup);
    });
    if (stale()) return;
    // After the wipe: reuse pre-built meshes (clipWait 0); sheets finish via warmTick during Ready/Go.
    fightersReady = renderer.setFighters(m.state, false, 0).catch(() => renderer.setFighters(m.state, false, 0));
    const loading = Promise.all([fightersReady, audioReady]);
    // The warm-up (shader compiles, particle pools) never starts until the VS card has been painted, and runs
    // one scene render per animation frame (renderer.warmUp yields between them); it carries on behind the match intro.
    // It waits for the fighter meshes only, never for audio: a slow audio decode used to push the warm-up's first (synchronous,
    // shader-compiling) render late into the VS hold, where it blocked the main thread past the hold cap (6-14 s holds).
    warm = fightersReady.then(() => nextFrame()).then(() => nextFrame()).then(async () => {
      const w0 = performance.now();
      await renderer.warmUp(m.state);
      warmUpMs = Math.round(performance.now() - w0);
      window.dispatchEvent(new CustomEvent('dod:warm-up', { detail: { warmUpMs } }));
    }).catch((err) => console.error(err));
    const bar = document.createElement('div');
    bar.className = 'vs-progress';
    bar.innerHTML = '<div class="vs-progress-fill"></div>';
    const fill = bar.firstElementChild as HTMLElement;
    $('versus-body').append(bar);
    const set = (p: number) => { fill.style.width = `${Math.round(Math.min(1, p) * 100)}%`; };
    renderer.onLoadProgress = (done, total) => set(total ? (done / total) * 0.9 : 0);
    void loading.then(() => set(0.9));
    void warm.then(() => set(1));
    // Leave as soon as meshes exist; warm/audio continue under the match wipe and Ready countdown.
    await fightersReady;
    // The painted stage must be on screen when the wipe opens, not a clear-colour arena while its pictures load,
    // but the VS card is never held past VS_HOLD_CAP_MS from the wipe into it: what is still missing then
    // (stage pictures, clip sheets) finishes behind the match intro. The meshes themselves are mandatory.
    await renderer.stageArtReady(Math.max(0, VS_HOLD_CAP_MS - (performance.now() - vsStart)));
    // The VS card also stays up until the announcer has called both names in order (it ends itself, or on a tap), never
    // past the cap below.
    await Promise.race([splash, new Promise<void>((r) => setTimeout(r, Math.max(0, VS_HOLD_CAP_MS + 500 - (performance.now() - vsStart))))]);
    renderer.onLoadProgress = null;
    bar.remove();
    void warm;
    if (stale()) return;
  } else {
    renderer.setStage(setup.stage);
    fightersReady = renderer.setFighters(m.state, false, 30000).catch(() => renderer.setFighters(m.state, false, 30000));
    warm = Promise.all([fightersReady, audioReady]).then(() => renderer.warmUp(m.state)).catch((err) => console.error(err));
    // The loading screen stays up until the match's first frame is drawn (under the wipe).
    $('loading').hidden = false;
    await warm;
    if (stale()) return;
  }

  if (stale()) return;
  // An intro scene brings the fighters on itself: they wait in the wings from the first frame.
  const intro = !!scene && scene.which === 'intro' && (scene.tour ? true : scene.chapter!.intro.length > 0 || !!scene.chapter!.coldOpen?.length);
  for (const ft of m.state.fighters) renderer.holdOffstage(ft.id, intro);
  const vsMs = performance.now() - t0;
  const vsHoldMs = withVersus ? Math.round(performance.now() - vsStart) : null;
  // Ready ticks during the wipe-out (~280 ms), so vsHoldMs (to first play frame) stays under 3 s.
  const versusExchange = !f && !scene && setup.mode === 'versus' ? exchangeFor2(m, false) : null;
  // Every offline match with a VS card opens like a broadcast (a fly-in and the entrances); an episode's own scene,
  // Tonight's Episode (its leaderboard needs the same start for everyone), the pilot, Training and online matches skip it.
  const matchIntro = withVersus && !f && !intro && !scene && setup.mode !== 'training' && setup.mode !== 'online' && !setup.teach && dailyRun?.setup !== setup;
  const readyUnderWipe = !f && !intro && !versusExchange && !matchIntro;
  await go('match', () => {
    window.dispatchEvent(new CustomEvent('dod:scene-timing', { detail: { selectToVs: fromSelect, vsToMatch: vsMs, vsHoldMs, warmUpMs, selectToMatch: pickedAt === null ? null : performance.now() - pickedAt, withVersus } }));
    // The canvas may have changed size while menus were up.
    renderer.engine.resize();
    match = m;
    lessonCardOff();
    teacher = setup.teach ? new Teacher({ scripted: setup.teach === 'training', lesson: setup.teach === 'defence' || setup.teach === 'recovery' ? setup.teach : undefined }) : null;
    if (teacher) {
      const lessonId: LessonId = setup.teach === 'defence' || setup.teach === 'recovery' ? setup.teach : 'training';
      teacher.onComplete = () => {
        markLessonDone(lessonId);
        updateLessonTicks();
        // Let the "Lesson clear!" pop land, then the card.
        window.setTimeout(() => { if (match === m && phase === 'play') lessonCard(lessonId); }, 1300);
      };
      teacher.onChange = (step, state) => {
        // Lesson 2: the dummy starts walking up and swinging as the last step comes (the rolls need no foe).
        if (setup.teach === 'defence' && ((state === 'used' && step === 'rollR') || (state === 'shown' && step === 'dodge'))) m.dummySwings = true;
        // Lesson 3: after fast fall the dummy knocks the player off the edge; the ledge ends it.
        if (setup.teach === 'recovery' && state === 'used') {
          if (step === 'fastfall') m.knockLoop = 'armed';
          else if (step === 'ledge') {
            m.knockLoop = 'off';
            m.dummySwings = false;
          }
        }
        window.dispatchEvent(new CustomEvent('dod:teach', { detail: { step, state, mode: setup.teach } }));
      };
    }
    showTouchControls(true);
    buildHud(m);
    shownOver = false;
    readyFrames = 0;
    renderer.render(m.state);
    $('loading').hidden = true;
    if (readyUnderWipe) beginReady(m);
  });
  $('loading').hidden = true;
  if (match !== m) return;
  // Never present the arena while the stage's pictures are still loading (a black void with a stray wedge of
  // colour): the loading veil goes back up over the canvas until they are in, then the intro, scene or Ready start.
  await holdForStageArt(m);
  if (match !== m || stale()) return;
  renderer.setPresenting(true);
  if (f) {
    if (f.phase === 'done') return;
    // Both pages count Ready… Go! from when both have loaded.
    phase = 'wait';
    f.markLoaded();
    if (phase === 'wait' && f.phase === 'started') beginReady(m);
    return;
  }
  if (intro && scene) {
    await runScene(m, scene);
    // Something else (an online match found, Quit) took over during the scene.
    if (match !== m) return;
    // A campaign episode between a listed rival pair: the two trade a jab the first time.
    const jab = scene.chapter && scene.which === 'intro' && !scene.chapter.coldOpen?.length ? exchangeFor2(m, true) : null;
    if (jab) {
      await runExchange(m, jab);
      if (match !== m) return;
    }
    beginReady(m);
    return;
  }
  if (matchIntro) {
    await runMatchIntro(m);
    if (match !== m) return;
    if (!versusExchange) {
      beginReady(m);
      return;
    }
  }
  if (versusExchange) {
    await runExchange(m, versusExchange);
    if (match !== m) return;
    beginReady(m);
    return;
  }
  if (!readyUnderWipe) beginReady(m);
}

/** How long the match waits, after the wipe, for the stage's pictures before it shows the arena anyway (a failed picture is skipped, never waited for). */
const STAGE_ART_HOLD_MS = 8000;

/** Keeps the loading veil over the arena until every stage layer is loaded (or has failed), then lets two frames paint. */
async function holdForStageArt(m: Match): Promise<void> {
  if (!renderer.stageArtPending()) return;
  const veil = $('loading');
  veil.textContent = 'Loading the stage\u2026';
  veil.hidden = false;
  await renderer.stageArtReady(STAGE_ART_HOLD_MS);
  if (match === m) {
    renderer.render(m.state);
    await nextFrame();
    renderer.render(m.state);
  }
  veil.hidden = true;
  veil.textContent = 'Loading fighters\u2026';
}

/** The "Ready... FIGHT!" take that opened this Ready phase (its FIGHT is the Go), or null. */
let readyFightId: string | null = null;

function beginReady(m: Match): void {
  releaseShieldLatch();
  const setup = m.setup;
  analytics.matchStart(m, chapter);
  clearTakeover();
  endPilotBoot();
  phase = 'ready';
  readyFrames = 0;
  readyStart = performance.now();
  slam('Round start');
  renderer.stageEvent('start');
  // "Ready... FIGHT!" is one call (2 takes) that lands its FIGHT on the Go frame; without a take it is "Ready?" then "Go!".
  readyFightId = audio.pickLine('announcer.ready-fight');
  if (readyFightId) void audio.call(readyFightId);
  else audio.line('announcer.ready');
  airFlashed = false;
  commentator = setup.mode === 'versus' || setup.mode === 'campaign' ? new Commentator(m.state, Math.random, (id) => audio.voiceFresh(id)) : null;
  introPending = (commentator && (chapter ? introCall(chapter.id) : dailyRun?.setup === setup ? introCall(dailyRun.ep.blogChapter) : null)) || null;
  audio.playStageBed(STAGES[setup.stage].id);
  audio.setMusicIntensity(audio.shouldBeIntense(m.state.fighters));
  lastActions = m.state.fighters.map((f) => f.action);
  crowdStocksBefore = m.state.fighters.map((f) => f.stocks);
  canvas.focus();
}

function endMatch(): void {
  endReplay();
  releaseShieldLatch();
  skipScene();
  // A match left any other way than its end, a restart or Quit (another match starting over it) ends its level here.
  if (match) analytics.matchEnd(match, 'quit', { reason: 'left' });
  // Leaving an online match any other way (another match starting) is a forfeit.
  if (fight && fight.phase !== 'done') fight.forfeit();
  fight = null;
  teacher?.end();
  teacher = null;
  lessonCardOff();
  $('pilot-menu').hidden = true;
  $('net-status').hidden = true;
  match = null;
  phase = 'idle';
  renderer.setPresenting(false);
  showTouchControls(false);
  $('hud').hidden = true;
  $('training-readout').hidden = true;
  clearMarkers();
  clearTags();
  $('match-top').hidden = true;
  clearTakeover();
  $('pause').hidden = true;
  pauseOwner = null;
  setMenuOwner(null);
  renderer.debug = false;
}

/** Esc, Start or the on-screen pause button in a match: closes Settings if it is open, else pauses or resumes. */
function pauseKey(by?: number): void {
  if (!match || phase === 'idle') return;
  // Couch pause: while P2's menu is up, P1's Esc or Start does nothing (the on-screen button and mouse still work).
  if (phase === 'pause' && pauseOwner !== null && by !== undefined && by !== pauseOwner) return;
  // Esc or Start in a story scene skips it.
  if (phase === 'scene') return skipScene();
  if (document.getElementById('lesson-card')) return;
  if (!$('controls-panel').hidden) openControlsPanel(false);
  else if (settingsOpen()) closeSettings();
  else setPaused(phase !== 'pause', by);
}

/** The player slot whose pause is up on a couch match with 2+ people (null: solo, online, or not paused). */
let pauseOwner: number | null = null;

function setPaused(paused: boolean, by?: number): void {
  if (!match) return;
  if (!paused && settingsOpen()) closeSettings();
  if (!paused) $('controls-panel').hidden = true;
  // Online the match can't stop: the menu opens over it and your fighter stands still meanwhile.
  if (fight && phase !== 'play' && phase !== 'pause') return;
  if (paused && phase !== 'pause') analytics.paused(match);
  phase = paused ? 'pause' : 'play';
  $('pause').hidden = !paused;
  const couch = paused && !fight && match.setup.mode === 'versus' && match.humans >= 2;
  pauseOwner = couch ? by ?? 0 : null;
  setMenuOwner(pauseOwner, padSlot);
  showPauseOwner(pauseOwner);
  $('btn-restart').hidden = !!fight;
  $('pause').querySelector('h2')!.textContent = fight ? 'Menu (the match goes on)' : 'Paused';
  syncTrainingOptions();
  if (paused) {
    $('btn-quit').textContent = fight ? 'Leave match (you lose)' : inTour() ? 'Quit to Tour' : chapter ? 'Quit to campaign' : 'Quit to menu';
    ($('btn-resume') as HTMLButtonElement).focus();
    syncPad();
  } else {
    canvas.focus();
  }
}

/** "P2 paused" in P2's colour and shape, over the pause menu; gone for solo pause. */
function showPauseOwner(slot: number | null): void {
  const el = $('pause-owner');
  el.hidden = slot === null;
  if (slot === null || !match) return;
  const colour = slotColor(match, slot);
  el.style.setProperty('--player', colour);
  el.dataset.shape = shapeOf(slot);
  el.dataset.slot = String(slot);
  el.textContent = `P${slot + 1} paused`;
  (window as unknown as { __dodPause?: unknown }).__dodPause = { slot, text: el.textContent };
}

let lastActions: number[] = [];
/** Stocks snapshot before each KO batch, for crowd comeback cheers (mirrors commentary). */
let crowdStocksBefore: number[] = [];
let startToken = 0;

function tick(m: Match): void {
  // Two or more people on this machine: each device (keyboard, pad 1-4) drives its own fighter. Solo play is unchanged.
  const humans = m.setup.mode === 'versus' && !m.setup.online ? m.humans : 1;
  if (humans >= 2) {
    const [first, ...rest] = readHumans(humans);
    afterTick(m, m.tick(first, rest));
    return;
  }
  assignDevices(1);
  afterTick(m, m.tick(readLocal()));
}

/** One online tick: the rollback runs zero, one or (after a late input) several frames. */
function onlineTick(m: Match, f: OnlineFight): void {
  afterTick(m, f.tick(phase === 'pause' || rotateShowing() ? NO_INPUT : readLocal()));
}

function afterTick(m: Match, events: SimEvent[]): void {
  // Toggle shield lets go of its latch when the local fighter is no longer shielding (hit, broke, KO'd).
  const me = m.state.fighters[m.player];
  setShieldActive(!!me && (me.action === ACT.SHIELD || me.action === ACT.SHIELD_STUN));
  renderer.onEvents(events);
  analytics.matchEvents(m, events);
  for (const w of matchWatchers) w(m, events);
  for (const e of events) {
    if (e.type === 'sudden') suddenDeathMoment(m);
    if (e.type === 'hit' && !e.shield) {
      bumpHud(e.victim, e.dmg, m.state.fighters[e.victim]?.percent ?? 0);
      // Hands feel: the pad (and a phone) rumbles by hit weight for the player who landed or took it (Settings → Rumble).
      if (m.player >= 0 && (e.attacker === m.player || e.victim === m.player)) rumbleHit(e.dmg);
    } else if (e.type === 'ko' && m.player >= 0 && (e.by === m.player || e.victim === m.player)) {
      // The longest, hardest pulse on a KO you deal or take.
      rumble('ko');
    }
  }
  playEventSounds(m, events);
  updateHud(m);
  if (teacher && phase === 'play') teacher.tick(m, events);
  const s = m.state;
  // Layered stage bed: lift to intense on last stock or ≥100%, crossfade back if the threat clears.
  if (!s.over && phase !== 'scene') {
    audio.setMusicIntensity(audio.shouldBeIntense(s.fighters));
  }
  if (commentator && !s.over) {
    // Blog Man opens the episode just after Go! (his line has the booth to itself), then the announcer calls the fight.
    if (introPending && s.frame >= 75) {
      commentator.note(introPending, s.frame);
      broadcast(introPending);
      introPending = null;
    }
    if (!introPending) for (const c of commentator.onEvents(s, events)) broadcast(c);
  }
  if (!airFlashed && !s.over && phase === 'play' && events.some((e) => e.type === 'ko')) {
    airFlashed = true;
    airFlash();
  }
  if (s.over && !shownOver) {
    shownOver = true;
    renderer.stageEvent('end');
    slam(s.timedOut ? 'Time!' : 'Game!', true);
    // The final KO holds for half a second (offline; online the rollback keeps ticking) under the slam.
    if (!fight) freezeUntil = performance.now() + GAME_FREEZE_MS;
    const gameId = s.timedOut ? null : audio.pickLine('announcer.game');
    if (gameId) void audio.call(gameId);
    else audio.line(s.timedOut ? 'announcer.time' : 'announcer.game');
    // Final-KO sting only when a stock wipe closes the bout (not a quota/streak/ko chip win).
    const teamsLeft = new Set(s.fighters.filter((f) => f.stocks > 0).map((f) => f.team));
    if (!s.timedOut && teamsLeft.size <= 1) audio.finalKoSting();
    else audio.synth('cheer');
    // A won episode goes on to the replay of its final KO a moment after Game! (episodeEnd).
    if (!fight && bookendChapter(m)) bookendAt = s.frame + BOOKEND_DELAY_TICKS;
  }
  if (bookendAt >= 0 && s.frame >= bookendAt && phase === 'play') {
    bookendAt = -1;
    if (chapter) void episodeEnd(m, chapter);
  }
  // Online, the fight decides when it's over (on a frame both sides agree on): onlineEnded.
  if (s.over && s.endTimer === 0 && !fight) finish(m);
}

const SMASHES: ReadonlySet<number> = new Set([MOVE.FSMASH, MOVE.USMASH, MOVE.DSMASH]);
/** A sound made where a fighter stands: panned by its screen x (-0.8 to 0.8); `away` for a KO leaving the view. */
function at(simX: number, ko = false): Spatial {
  const x01 = renderer.screenX01(simX);
  const pan = panFromScreen(x01);
  return ko ? { pan, away: Math.min(1, Math.max(0, (Math.abs(x01 * 2 - 1) - 0.8) / 1.2)) } : { pan };
}

const VOICE_SPECIALS: ReadonlySet<number> = new Set([MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL]);

// ------------------------------------------------------------- the finale takeover
// The sim fires a 'takeover' broadcast (sim/step.ts) with the player's mood, and 45 frames later 'takeover-rule' when the
// rule has landed. This is what the player sees and hears: a 1 s RGB-split glitch and a cut sound, the Orchestrator's feed in
// a picture-in-picture (top left, clear of Pause and the touch controls) with his ghost on the stage screens, his lines for
// the state of the fight (campaign/takeover.ts), and the rule chip on the HUD with a sting.
const TAKEOVER_GLITCH_MS = 1000;
let takeoverTimers: number[] = [];
let takeoverSeq = 0;

function clearTakeover(): void {
  for (const t of takeoverTimers) clearTimeout(t);
  takeoverTimers = [];
  takeoverSeq++;
  document.querySelectorAll('.takeover-pip, .takeover-ghost, .rule-chip, .booth-orchestrator').forEach((el) => el.remove());
  document.body.classList.remove('takeover-glitch');
}

function endTakeover(): void {
  document.querySelector('.takeover-pip')?.classList.add('off');
  document.querySelector('.takeover-ghost')?.remove();
  takeoverTimers.push(window.setTimeout(() => document.querySelector('.takeover-pip')?.remove(), 600));
}

function startTakeover(m: Match, e: { index: number; mood?: number; hot?: number }): void {
  clearTakeover();
  const seq = takeoverSeq;
  const def = m.state.bc[e.index];
  const lines = takeoverLines(chapter?.season ?? 1, chapter?.id ?? 'encore', e.mood ?? 1, !!e.hot, !!def?.rule);
  renderer.glitch(TAKEOVER_GLITCH_MS);
  audio.synth('cut');
  audio.synth('alarm', 0.4);
  document.body.classList.add('takeover-glitch');
  takeoverTimers.push(window.setTimeout(() => document.body.classList.remove('takeover-glitch'), TAKEOVER_GLITCH_MS));
  const pip = h('div', { class: 'takeover-pip', 'data-takeover': 'on', 'data-mood': e.mood && e.mood < 0 ? 'behind' : 'ahead', 'data-hot': e.hot ? '1' : '0' },
    h('img', { src: headUrl('orchestrator'), alt: '' }),
    h('span', { class: 'takeover-live' }, 'LIVE · THE ORCHESTRATOR'));
  document.body.appendChild(pip);
  document.body.appendChild(h('img', { class: 'takeover-ghost', src: headUrl('orchestrator'), alt: '' }));
  const said: string[] = [];
  // His lines come one after another, each when the last has finished (a take's own length, else reading time).
  const next = (i: number): void => {
    if (seq !== takeoverSeq || i >= lines.ids.length) return;
    const id = lines.ids[i];
    const text = VOICE.lines.find((l) => l.id === id)?.text ?? '';
    void audio.line(id, 'banter');
    said.push(id);
    document.querySelector('.booth')?.remove();
    document.querySelector('.booth-orchestrator')?.remove();
    document.body.appendChild(h('div', { class: 'booth booth-orchestrator', 'data-line': id }, h('span', { class: 'booth-who' }, 'The Orchestrator'), h('span', { class: 'booth-text' }, text)));
    window.dispatchEvent(new CustomEvent('dod:takeover', { detail: { phase: 'line', id, text, index: i, mood: e.mood && e.mood < 0 ? 'behind' : 'ahead', hot: !!e.hot, chapter: chapter?.id ?? null, frame: m.state.frame } }));
    takeoverTimers.push(window.setTimeout(() => next(i + 1), Math.max(2600, text.split(/\s+/).length * 380 + 900)));
  };
  window.dispatchEvent(new CustomEvent('dod:takeover', { detail: { phase: 'start', mood: e.mood && e.mood < 0 ? 'behind' : 'ahead', hot: !!e.hot, chapter: chapter?.id ?? null, frame: m.state.frame, lines: lines.ids, rule: def?.rule ? ruleLabel(def.rule) : null } }));
  takeoverTimers.push(window.setTimeout(() => next(0), 450));
}

function showTakeoverRule(m: Match, index: number): void {
  const rule = m.state.bc[index]?.rule;
  if (!rule) return;
  const label = ruleLabel(rule);
  audio.synth('sting');
  audio.synth('thud', 0.7);
  document.querySelector('.rule-chip')?.remove();
  const chip = h('div', { class: 'rule-chip', 'data-rule': label }, h('small', {}, 'NEW RULE'), label);
  document.body.appendChild(chip);
  showBanner(`NEW RULE · ${label}`, 2600).className = 'bc-banner bc-hijack';
  window.dispatchEvent(new CustomEvent('dod:takeover', { detail: { phase: 'rule', rule: label, frame: m.state.frame, chapter: chapter?.id ?? null } }));
}

/** A broadcast caption over the match. */
function showBanner(text: string, ms: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bc-banner';
  el.textContent = text;
  el.dataset.bc = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

function playEventSounds(m: Match, events: ReturnType<Match['tick']>): void {
  // A killing blow gets the KO roar, not a gasp on top of it in the same frame.
  const koThisTick = events.some((k) => k.type === 'ko');
  for (const e of events) {
    switch (e.type) {
      case 'hit':
        if (e.shield) audio.sfx('hit-shield', { vary: true, at: at(e.x) });
        else {
          const tier = hitTier(e.dmg);
          // A special's own impact (its archetype's crack) layers on the generic hit. A light hit of a special
          // (each hit of a flurry) plays only the special's impact, so rapid hits don't stack two sounds each.
          const specialLayer = e.special ? audio.special('impact', e.special, CHARACTERS[m.state.fighters[e.attacker].char].id, at(e.x)) : false;
          if (!(specialLayer && tier === 'light')) audio.sfx(HIT_SOUND[tier], { vary: true, at: at(e.x), gain: hitGain(e.dmg) });
          // Heavy hits: the studio crowd gasps (ooh). Medium/heavy: the victim's hurt bark.
          if (e.dmg >= 130 && !koThisTick) audio.crowd('ooh');
          if (e.dmg >= 70) audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'hurt', at(m.state.fighters[e.victim].x));
        }
        break;
      case 'hurt':
        // Stage damage (hazards, damage zones) lands with a hit sound like any other hit.
        audio.sfx(HIT_SOUND[hitTier(e.dmg)], { vary: true, at: at(m.state.fighters[e.victim].x) });
        if (e.dmg >= 70) audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'hurt', at(m.state.fighters[e.victim].x));
        break;
      case 'stage':
        // The stage's events are heard: an alarm on the warning, a rush when it starts, a crowd reaction.
        if (e.phase === 'warn') audio.synth('alarm', 0.8);
        else if (e.phase === 'start') {
          audio.synth('whoosh');
          audio.synth('crowd', 0.6);
        } else audio.synth('whoosh', 0.4);
        break;
      case 'broadcast':
        if (e.phase === 'end') {
          if (e.kind === 'break') document.getElementById('brb')?.remove();
          if (e.kind === 'takeover') endTakeover();
          break;
        }
        if (e.kind === 'chant') {
          audio.synth('crowd', 1);
          audio.synth('cheer', 0.9);
          showBanner(`${CHARACTERS[m.state.fighters[e.who].char].name.toUpperCase()}! ${CHARACTERS[m.state.fighters[e.who].char].name.toUpperCase()}!`, 2500);
        } else if (e.kind === 'break') {
          audio.synth('sting');
          const b = showBanner("WE'LL BE RIGHT BACK", 1500);
          b.id = 'brb';
        } else if (e.kind === 'hijack') {
          audio.synth('alarm', 0.6);
          showBanner('RIVAL NETWORK · NOW BROADCASTING', 10000).className = 'bc-banner bc-hijack';
        } else if (e.kind === 'takeover') startTakeover(m, e);
        else if (e.kind === 'takeover-rule') showTakeoverRule(m, e.index);
        else if (e.kind === 'flicker') audio.synth('thud', 0.6);
        else audio.synth('alarm', 0.9);
        break;
      case 'ko': {
        audio.sfx('ko', { at: at(e.x, true) });
        audio.killSting(at(e.x, true));
        // Crowd: roar on every KO; rising cheer when the killer was behind and is now level-or-ahead.
        const before = crowdStocksBefore.length === m.state.fighters.length
          ? crowdStocksBefore
          : m.state.fighters.map((f) => f.stocks);
        const killer = e.by >= 0 && e.by !== e.victim ? e.by : -1;
        const stocks = m.state.fighters.map((f) => f.stocks);
        const rival = (i: number) => i !== killer && (m.state.fighters[i].team < 0 || m.state.fighters[i].team !== m.state.fighters[killer]?.team);
        const behind = killer >= 0 && before.some((n, i) => rival(i) && n > before[killer]);
        const level = killer >= 0 && stocks.every((n, i) => !rival(i) || n <= stocks[killer]);
        if (behind && level) audio.crowd('rising');
        else audio.crowd('roar');
        crowdStocksBefore = stocks;
        audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'ko', at(e.x, true));
        break;
      }
      case 'grab':
        // The grab clasps (a shielded one cracks through the guard too); a held fighter's shield stays whole.
        audio.synth('grab', 1);
        if (e.shield) audio.sfx('hit-shield', { vary: true, at: at(m.state.fighters[e.victim].x) });
        break;
      case 'throw':
        audio.synth('whoosh', 0.7);
        audio.sfx(e.kind === 2 ? 'hit-heavy' : 'hit-medium', { vary: true, at: at(m.state.fighters[e.victim].x) });
        break;
      case 'grab-break':
        audio.synth('whoosh', 0.35);
        break;
      case 'counter':
        // A counter rings out: a shield-bright hit and a sting.
        audio.sfx('hit-shield', { at: at(e.x) });
        audio.synth('sting', 0.5);
        break;
      case 'jump':
        audio.sfx('jump', { vary: true, at: at(e.x) });
        break;
      case 'land':
        audio.landSfx(null, at(e.x));
        break;
      case 'ledge':
        audio.sfx('ledge', { vary: true, at: at(e.x) });
        break;
      case 'ledge-option':
        window.dispatchEvent(new CustomEvent('dod:ledge', { detail: { option: e.option, id: e.id, frame: m.state.frame } }));
        // Each choice has its own cue; the jump already plays the jump sound from its own event, the attack's swing from its action.
        if (e.option === 'getup') {
          audio.synth('whoosh', 0.22);
          audio.sfx('land-soft', { vary: true, at: at(e.x) });
        } else if (e.option === 'roll') audio.synth('whoosh', 0.4);
        else if (e.option === 'attack') audio.synth('grab', 0.5);
        else if (e.option === 'drop') audio.synth('thud', 0.3);
        break;
      case 'shieldbreak':
        audio.sfx('shield-break', { at: at(e.x) });
        break;
      case 'respawn':
        audio.sfx('respawn', { at: at(e.x) });
        break;
    }
  }
  // Swings and dodges start on a change of action, which the sim does not report.
  m.state.fighters.forEach((f, i) => {
    if (f.action !== lastActions[i]) {
      if (f.action === ACT.ATTACK) {
        // A special plays its archetype's release (plus the fighter's accent) on its first frame, in place of the generic swing.
        const kind = VOICE_SPECIALS.has(f.move) ? CHARACTERS[f.char].moves[f.move].kind : undefined;
        if (!(kind && audio.special('release', kind, CHARACTERS[f.char].id, at(f.x)))) {
          audio.sfx(SMASHES.has(f.move) || f.move === MOVE.SSPECIAL || f.move === MOVE.DSPECIAL ? 'swing-heavy' : 'swing-light', { vary: true, at: at(f.x) });
        }
        // Smash and special effort barks (1.5 s cooldown + no overlap, inside audio.fighterVoice).
        if (SMASHES.has(f.move) || VOICE_SPECIALS.has(f.move)) {
          audio.fighterVoice(CHARACTERS[f.char].id, 'effort', at(f.x));
        }
      } else if (f.action === ACT.SHIELD) {
        // Raising the shield answers the press with a soft bubble-up, not silence.
        audio.synth('whoosh', 0.25);
      } else if (f.action === ACT.ROLL || f.action === ACT.SPOTDODGE || f.action === ACT.AIRDODGE || f.action === ACT.LEDGE_ROLL) audio.sfx('dodge', { vary: true, at: at(f.x) });
    }
    lastActions[i] = f.action;
  });
}

// ---------------------------------------------------------------- settings

// Studio standard: Sound on/off, Music and Effects, saved in localStorage "hawkes.sound" and applied as they change.
// One panel, opened from the main menu and from Pause.

const settingsOpen = () => !$('settings').hidden;

function renderSettings(): void {
  const s = soundSettings();
  const sw = $('sound-switch');
  sw.setAttribute('aria-checked', String(s.on));
  sw.textContent = s.on ? 'On' : 'Off';
  $('settings-levels').dataset.off = String(!s.on);
  const mo = $('motion-switch');
  mo.setAttribute('aria-checked', String(reduceMotion()));
  mo.textContent = reduceMotion() ? 'On' : 'Off';
  const shake = $('shake-level') as HTMLInputElement;
  shake.value = String(shakeLevel());
  $('shake-level-value').textContent = `${shakeLevel()}%`;
  document.querySelectorAll<HTMLElement>('#flash-seg [data-fl]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fl === flashMode())));
  const sh = $('shield-switch');
  sh.setAttribute('aria-checked', String(shieldMode() === 'toggle'));
  sh.textContent = shieldMode() === 'toggle' ? 'Toggle' : 'Hold';
  const cv = $('colour-switch');
  cv.setAttribute('aria-checked', String(colourVision() === 'safe'));
  cv.textContent = colourVision() === 'safe' ? 'Colourblind-safe' : 'Standard';
  document.querySelectorAll<HTMLElement>('#textsize-seg [data-ts]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.ts) === textSize())));
  const g = graphics();
  const flip = (id: string, on: boolean, text: string) => {
    $(id).setAttribute('aria-checked', String(on));
    $(id).textContent = text;
  };
  flip('quality-switch', g.quality === 'high', g.quality === 'high' ? 'High' : 'Low');
  flip('glow-switch', g.glow, g.glow ? 'On' : 'Off');
  flip('fps-switch', g.fps, g.fps ? 'On' : 'Off');
  for (const k of ['music', 'sfx', 'voice'] as const) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    input.value = String(Math.round(s[k] * 100));
    $(`vol-${k}-value`).textContent = `${input.value}%`;
  }
  flip('captions-switch', s.captions, s.captions ? 'On' : 'Off');
  // Touch size and opacity: only where there are touch controls (Rumble shows everywhere).
  $('settings-touch').hidden = !(touchDevice() || touchUiForced());
  const t = touchSettings();
  for (const [k, v] of [['size', t.size], ['opacity', t.opacity]] as const) {
    $<HTMLInputElement>(`touch-${k}`).value = String(v);
    $(`touch-${k}-value`).textContent = `${v}%`;
  }
  const rum = $('rumble-switch');
  rum.setAttribute('aria-checked', String(t.vibrate));
  rum.textContent = t.vibrate ? 'On' : 'Off';
}

function openRebindScreen(): void {
  analytics.feature('rebind_open', { from: match ? 'pause' : 'menu' });
  $('settings').hidden = true;
  openRebind();
  onPanelBack(() => {
    if (backRebind()) closeRebindScreen();
  });
  focusFirst();
}

function closeRebindScreen(): void {
  $('settings').hidden = false;
  onPanelBack(closeSettings);
  $('rebind-open').focus();
  syncPad();
}

function openSettings(): void {
  analytics.feature('settings_open', { from: match ? 'pause' : 'menu' });
  renderSettings();
  // From Pause, the panel takes the pause menu's place until Done.
  $('pause').hidden = true;
  $('settings').hidden = false;
  onPanelBack(closeSettings);
  focusFirst();
}

function closeSettings(): void {
  if (!settingsOpen()) return;
  $('settings').hidden = true;
  onPanelBack(null);
  if (match && phase === 'pause') {
    $('pause').hidden = false;
    $('btn-pause-settings').focus();
    syncPad();
  } else {
    document.querySelector<HTMLElement>('#main [data-go="settings"]')?.focus();
  }
}

/** Captions off hides read-along text, except with sound off: then the story lines are the only way to follow. */
function applyCaptions(): void {
  const st = soundSettings();
  document.body.classList.toggle('captions-off', !st.captions && st.on);
}

function wireSettings(): void {
  renderSettings();
  applyCaptions();
  onSoundSettings(() => {
    renderSettings();
    applyCaptions();
  });
  const from = () => (match ? 'pause' : 'menu');
  onScreenShake(() => renderSettings());
  onColourVision(() => {
    renderSettings();
    // Cards already on screen (Pause in a match) take the new colours now; the rings follow at the next match.
    if (match) document.querySelectorAll<HTMLElement>('.hud-card').forEach((el, i) => el.style.setProperty('--player', slotColor(match!, i)));
  });
  onShieldMode(() => renderSettings());
  $('shield-switch').addEventListener('click', () => {
    setShieldMode(shieldMode() === 'toggle' ? 'hold' : 'toggle');
    analytics.setting('shield', shieldMode(), from());
  });
  onTextSize(() => renderSettings());
  document.querySelectorAll<HTMLElement>('#textsize-seg [data-ts]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = Number(b.dataset.ts);
      if (!(TEXT_SIZES as readonly number[]).includes(v)) return;
      setTextSize(v as (typeof TEXT_SIZES)[number]);
      analytics.setting('text_size', v, from());
    }),
  );
  $('colour-switch').addEventListener('click', () => {
    setColourVision(colourVision() === 'safe' ? 'standard' : 'safe');
    analytics.setting('colour_vision', colourVision(), from());
  });
  $('motion-switch').addEventListener('click', () => {
    setReduceMotion(!reduceMotion());
    analytics.setting('reduce_motion', reduceMotion(), from());
  });
  $('shake-level').addEventListener('input', (e) => {
    setShakeLevel(Number((e.target as HTMLInputElement).value));
  });
  $('shake-level').addEventListener('change', () => analytics.setting('shake', shakeLevel(), from()));
  document.querySelectorAll<HTMLElement>('#flash-seg [data-fl]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.fl as FlashMode;
      if (v !== 'full' && v !== 'soft' && v !== 'off') return;
      setFlashMode(v);
      analytics.setting('flashes', v, from());
    }),
  );
  analytics.graphics(graphics());
  onGraphics((g) => {
    renderSettings();
    analytics.graphics(g);
  });
  $('quality-switch').addEventListener('click', () => {
    setGraphics({ quality: graphics().quality === 'high' ? 'low' : 'high' }, true);
    analytics.setting('quality', graphics().quality, from());
  });
  $('glow-switch').addEventListener('click', () => {
    setGraphics({ glow: !graphics().glow }, true);
    analytics.setting('glow', graphics().glow, from());
  });
  $('fps-switch').addEventListener('click', () => {
    setGraphics({ fps: !graphics().fps });
    analytics.setting('fps', graphics().fps, from());
  });
  $('sound-switch').addEventListener('click', () => {
    setSoundSettings({ on: !soundSettings().on });
    analytics.setting('sound', soundSettings().on, from());
  });
  for (const k of ['music', 'sfx', 'voice'] as const) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    input.addEventListener('input', () => setSoundSettings({ [k]: Number(input.value) / 100 }));
    // Where the slider was let go, not every step of the drag.
    input.addEventListener('change', () => analytics.setting(k, Number(input.value), from()));
  }
  // A hit at the new level, so the slider is heard as it lets go.
  $('vol-sfx').addEventListener('change', () => audio.sfx('hit-medium'));
  $('captions-switch').addEventListener('click', () => {
    setSoundSettings({ captions: !soundSettings().captions });
    analytics.setting('captions', soundSettings().captions, from());
  });
  onTouchSettings(renderSettings);
  for (const k of ['size', 'opacity'] as const) {
    const input = $<HTMLInputElement>(`touch-${k}`);
    input.addEventListener('input', () => setTouchSettings({ [k]: Number(input.value) }));
    input.addEventListener('change', () => analytics.setting(`touch_${k}`, Number(input.value), from()));
  }
  $('rumble-switch').addEventListener('click', () => {
    setTouchSettings({ vibrate: !touchSettings().vibrate });
    analytics.setting('rumble', touchSettings().vibrate, from());
  });
  $('settings-done').addEventListener('click', () => closeSettings());
  $('rebind-open').addEventListener('click', () => openRebindScreen());
  wireRebind(closeRebindScreen);
  onRebind((kind, value) => {
    analytics.setting('rebind', kind, from());
    window.dispatchEvent(new CustomEvent('dod:rebind', { detail: { kind, value } }));
  });
  // The Controls pages show the player's actual bindings.
  onBindings(() => fillControlLists());
}

// Menus play the menu loop; matches pick their stage's loop when they start.
const MENU_SCREENS = new Set(['title', 'main', 'select', 'stages', 'campaign', 'tour', 'extras', 'howto', 'leaderboard']);
setInterval(() => {
  const s = currentScreen();
  if (openingShowing()) return;
  if (s && MENU_SCREENS.has(s)) audio.playMusic(s === 'title' ? 'music-title' : 'music-menu');
  else if (s === 'versus') audio.playMusic(null);
}, 300);

function finish(m: Match): void {
  phase = 'idle';
  const won = m.playerWon();
  const c = chapter;
  if (tourRun?.setup === m.setup && match === m) return void tourFinish(m, won);
  // A won episode signs off in the arena first: the outro plays live, then the results.
  if (m.setup.mode === 'campaign' && c && won && c.outro.length && match === m) {
    void runScene(m, { chapter: c, which: 'outro' }).then(() => {
      if (match === m) showFinish(m, won, c);
    });
    return;
  }
  showFinish(m, won, c);
}

/** A win with each fighter a person played to victory (any mode): counts toward its colour unlocks. Returns the new colours' names. */
function creditWins(m: Match, winners: number[]): string[] {
  const out: string[] = [];
  for (const i of winners) {
    const slot = m.setup.slots[i];
    if (!slot || slot.cpu !== null || slot.remote) continue;
    out.push(...addWin(CHARACTERS[slot.char].id));
  }
  return out;
}

/**
 * Picks the winner's quote for this match (winQuote.ts) and tells the playtest (`dod:win-quote`). `ending` is a Tour's last win,
 * whose own win line already played over the final KO: that line is the quote.
 */
function announceWinQuote(m: Match, winnerSlot: number, ending: boolean): WinQuote | null {
  const w = m.state.fighters[winnerSlot];
  clearWinQuote();
  if (!w) return null;
  const winner = CHARACTERS[w.char].id;
  const team = m.state.winnerTeam >= 0 ? m.state.fighters.filter((f) => f.team === m.state.winnerTeam).map((f) => f.id) : [winnerSlot];
  const losers = m.state.fighters.filter((f) => !team.includes(f.id)).map((f) => CHARACTERS[f.char].id);
  const q = pickWinQuote(VOICE, winner, losers, Math.random, ending ? `fighter.${winner}.win` : undefined);
  window.dispatchEvent(new CustomEvent('dod:win-quote', { detail: { id: q.id, text: q.text, audio: q.audio, kind: q.kind, winner: q.winner, loser: q.loser, losers } }));
  return q;
}

/**
 * The announcer on the results: "The winner is..." and the winner's name (or "No contest!" with no winner), then the winner's
 * quote. Starts 900 ms after the screen opens; each call waits for the one before, and leaving the screen cuts them (a quote
 * with no take is only the caption).
 */
function playResultCalls(m: Match, winnerSlot: number, quote: WinQuote | null, voided = false): void {
  const w = voided ? undefined : m.state.fighters[winnerSlot];
  const ids = w ? ['announcer.winner-is', `announcer.name.${CHARACTERS[w.char].id}`] : ['announcer.no-contest'];
  setTimeout(async () => {
    window.dispatchEvent(new CustomEvent('dod:result-call', { detail: { ids, winner: w ? CHARACTERS[w.char].id : null } }));
    const finished = await audio.callEach(ids, 150);
    if (!finished || !quote) return;
    audio.line(quote.id);
    window.dispatchEvent(new CustomEvent('dod:win-quote-play', { detail: { id: quote.id, audio: quote.audio } }));
  }, 900);
}

/** The slots that won a finished match (a team's, or the single winner). */
function winningSlots(m: Match): number[] {
  const s = m.state;
  if (s.winnerTeam >= 0) return s.fighters.filter((f) => f.team === s.winnerTeam).map((f) => f.id);
  return s.winner >= 0 ? [s.winner] : [];
}

/** A campaign result's difficulty lines: the small Easy badge on a clear, or the producer's "Try it on Easy?" after the third loss. */
function difficultyNotes(won: boolean, offer: boolean): void {
  const at = document.querySelector('#results-body .results-hero > div');
  if (!at) return;
  if (won && chapterDiff === 'easy') at.append(h('p', { class: 'easy-badge', 'data-difficulty': 'easy' }, 'Easy'));
  if (!won && offer) {
    at.append(h('p', { class: 'easy-offer', role: 'status' }, h('b', {}, 'Try it on Easy?'), ' Softer foes, they start at 30%. Stars still count.'));
    window.dispatchEvent(new CustomEvent('dod:difficulty', { detail: { phase: 'offer-shown', chapter: chapter?.id ?? '', difficulty: chapterDiff, label: DIFFICULTY_LABEL.easy } }));
  }
}

/** A won episode's grade (campaign/grade.ts): graded from the match, the best kept in the save, and told to the playtest. */
function episodeGrade(m: Match, c: Chapter) {
  const me = m.state.fighters[m.player];
  const start = m.setup.slots[m.player]?.stocks ?? m.setup.stocks;
  const g = gradeEpisode({ won: true, objective: m.setup.objective, stocksStart: start, stocksLeft: me?.stocks ?? 0, frames: m.state.frame, damageTaken: (m.stats[m.player]?.taken ?? 0) / 10, par: c.par });
  const before = loadStars()[c.id] ?? 0;
  const best = recordStars(c.id, g.stars);
  const kos = m.stats[m.player]?.kos ?? 0;
  const sc = scoreEpisode({ kos, dealt: (m.stats[m.player]?.dealt ?? 0) / 10, taken: (m.stats[m.player]?.taken ?? 0) / 10, frames: m.state.frame, par: c.par });
  const rec = recordBest(c.id, { score: sc.total, frames: m.state.frame });
  const out = { ...g, best, improved: g.stars > before && before > 0, score: sc.total, parts: sc.parts, frames: m.state.frame, bestScore: rec.best.score, bestFrames: rec.best.frames, beat: rec.beat };
  window.dispatchEvent(new CustomEvent('dod:episode-score', { detail: { chapter: c.id, score: sc.total, frames: m.state.frame, bestScore: rec.best.score, bestFrames: rec.best.frames, beat: rec.beat, had: !!rec.before } }));
  window.dispatchEvent(new CustomEvent('dod:episode-grade', { detail: { chapter: c.id, stars: g.stars, best, par: c.par, seconds: Math.round(m.state.frame / 60), stocksLost: start - (me?.stocks ?? 0), steps: g.steps } }));
  return out;
}

/** A won Season 8-10 episode's reward (campaign/rewards.ts): earned and kept, told to the playtest, shown as the unlock banner. */
function episodeReward(c: Chapter) {
  const r = earnReward(c);
  if (r) window.dispatchEvent(new CustomEvent('dod:reward', { detail: { chapter: c.id, reward: r.id, kind: r.kind, name: r.name } }));
  return r;
}

function showFinish(m: Match, won: boolean, c: Chapter | null): void {
  phase = 'idle';
  // Training has no winner; a campaign loss or a CPU's win credits nobody.
  const newLooks = m.setup.mode === 'training' ? [] : creditWins(m, winningSlots(m));
  const levelChange = autoLevelAfter(m);
  analytics.matchEnd(m, won ? 'complete' : 'death');
  const actions: ResultAction[] = [];
  let easyOffer = false;
  let campaignResult = false;
  if (m.setup.teach === 'pilot' && c) {
    // The pilot's result: a win opens the main menu on "Next episode"; a loss is a retry (Kaelen is built to lose).
    if (won) actions.push({ label: 'Continue', primary: true, run: () => pilotCleared(c) });
    else actions.push({ label: 'Retry', primary: true, run: () => startMatch(m.setup, false) });
    actions.push({ label: 'Main menu', run: () => { markPilotSeen('left'); chapter = null; return go('main', spotlight); } });
  } else if (tourRun?.setup === m.setup) {
    // A lost fight: Continue plays it again, Quit goes back to the Tour list. The final win: the Tour list, with its mark.
    const r = tourRun;
    if (won) actions.push({ label: 'Tour list', primary: true, run: () => openTourScreen() });
    else actions.push({ label: 'Continue', primary: true, run: () => tourContinue() });
    if (won) actions.push({ label: 'Main menu', run: () => { tourRun = null; return go('main', spotlight); } });
    else actions.push({ label: 'Quit', run: () => { analytics.tour('quit', { fighter: r.tour.fighter, fight: r.index + 1 }); return openTourScreen(); } });
  } else if (dailyRun?.setup === m.setup) {
    actions.push({ label: won ? 'Beat your score' : 'Try again', primary: true, run: () => startMatch(m.setup, false) });
    actions.push({ label: 'Main menu', run: () => go('main', spotlight) });
  } else if (m.setup.mode === 'campaign' && c) {
    campaignResult = true;
    if (won) actions.push({ label: 'Continue', primary: true, run: () => chapterCleared(c) });
    else {
      // The third loss in a row on one episode: the producer offers the easier setup (campaign/difficulty.ts).
      recordLoss(c.id);
      easyOffer = offerEasy(c.id);
      if (easyOffer) actions.push({ label: 'Try it on Easy', primary: true, run: () => tryOnEasy(c, m) });
      actions.push({ label: 'Retry', primary: !easyOffer, run: () => startMatch(m.setup, false) });
    }
    actions.push({ label: 'Campaign map', run: () => openCampaignScreen() });
  } else {
    actions.push({ label: 'Rematch', primary: true, run: () => startMatch(rematchSetup(m.setup), false) });
    actions.push({ label: 'Change fighters', run: () => openVersus() });
    actions.push({ label: 'Main menu', run: () => go('main', spotlight) });
  }
  // The winner's quote, picked before the screen opens so the caption and the voice are the same line.
  const quote = announceWinQuote(m, m.state.winner, tourRun?.setup === m.setup && won);
  const grade = m.setup.mode === 'campaign' && c && won && !dailyRun && !tourRun ? episodeGrade(m, c) : undefined;
  const reward = m.setup.mode === 'campaign' && c && won && !dailyRun && !tourRun ? episodeReward(c) : null;
  // Watch replay: the whole match from its recorded inputs (not on the Tour's lost-fight choice, which has its own panel).
  const tourLost = tourRun?.setup === m.setup && !won;
  if (!tourLost) {
    addWatchReplay(actions, m, () => void go('results', () => {
      endMatch();
      showResults(m, actions, undefined, [], levelChange ?? undefined, grade, reward);
      if (campaignResult) difficultyNotes(won, easyOffer);
      if (tourRun?.setup === m.setup && won) $('results-body').prepend(tourBanner(tourRun.tour, tourRun.continues));
      startResultsMusic();
    }));
  }
  void go('results', () => {
    endMatch();
    if (tourRun?.setup === m.setup && !won) {
      showResults(m, actions, undefined, newLooks);
      renderTourChoice({ tour: tourRun.tour, index: tourRun.index, fight: tourRun.tour.fights[tourRun.index], continues: tourRun.continues, onContinue: () => tourContinue(), onQuit: () => { analytics.tour('quit', { fighter: tourRun!.tour.fighter, fight: tourRun!.index + 1 }); void openTourScreen(); } });
    } else {
      showResults(m, actions, undefined, newLooks, levelChange ?? undefined, grade, reward);
      if (campaignResult) difficultyNotes(won, easyOffer);
    }
    if (tourRun?.setup === m.setup && won) $('results-body').prepend(tourBanner(tourRun.tour, tourRun.continues));
    if (dailyRun?.setup === m.setup && m.setup.mode === 'campaign') dailyFinished(m, dailyRun.ep, won);
    startResultsMusic();
  }).then(() => askOnResults(m));
  // The Tour's closing win line already played over the final KO.
  if (!(tourRun?.setup === m.setup && won) && m.setup.mode !== 'training') playResultCalls(m, m.state.winner, quote);
  syncPad();
}

// ------------------------------------------------------------------ online

/** Runs `fn` with the online module if it loaded; an online failure is logged and never stops the game. */
function onlineCall(what: string, fn: (o: NonNullable<ReturnType<typeof onlineApi>>) => void): void {
  const o = onlineApi();
  if (!o) {
    console.error(`[dod-online] ${what}: online play isn't available on this page (see the earlier error)`);
    return;
  }
  try {
    fn(o);
  } catch (e) {
    console.error(`[dod-online] ${what} failed:`, e);
  }
}

/** The match-found countdown ran out: whatever is on ends and the online match loads. */
async function startOnlineMatch(found: Found): Promise<void> {
  const s = found.setup;
  // Out of any menu or panel first; a screen switch in progress finishes before ours starts.
  if (settingsOpen()) closeSettings();
  onlineCall('close profile', (o) => o.closeProfile());
  $('pause').hidden = true;
  chapter = null;
  for (let i = 0; i < 40 && switching(); i++) await new Promise((r) => setTimeout(r, 50));
  const setup: MatchSetup = {
    mode: 'online',
    stage: s.stage,
    stocks: s.stocks,
    rules: { ...s.rules, timeLimit: s.timeLimit },
    slots: s.chars.map((char, i) => ({ char, cpu: null, remote: i !== found.slot, look: s.looks?.[i] ?? 0 })),
    title: 'Online match',
    subtitle: `${s.names[0]} vs ${s.names[1]}`,
    online: { matchId: s.matchId, names: s.names, avatars: s.avatars, ids: s.ids },
  };
  await startMatch(setup, true, { seed: s.seed, found });
}

function showNetStatus(f: OnlineFight): void {
  const el = $('net-status');
  const waiting = f.phase === 'done' ? '' : f.waiting();
  const text = waiting || (phase === 'play' || phase === 'pause' ? f.netLine() : '');
  updateConnBars(f);
  el.hidden = !text || currentScreen() !== 'match';
  el.classList.toggle('waiting', !!waiting);
  el.classList.toggle('reconnecting', f.phase !== 'done' && !!f.reconnect);
  if (el.textContent !== text) el.textContent = text;
}

/** The plain line for how an online match ended (KO, time, sudden death, a quit, a drop) and how it was scored. */
const ENDINGS: Record<FightEnd['reason'], (opp: string, won: boolean, sudden: boolean) => { headline: string; note?: string }> = {
  game: (opp, won, sudden) => ({
    headline: won ? 'You win' : `${opp} wins`,
    note: sudden ? (won ? `Sudden death: your KO decided it.` : `Sudden death: ${opp}'s KO decided it.`) : won ? `KO: you took ${opp}'s last stock.` : `KO: ${opp} took your last stock.`,
  }),
  time: (opp, won) => ({ headline: won ? 'You win on time' : `${opp} wins on time`, note: won ? 'Time ran out with you ahead.' : `Time ran out with ${opp} ahead.` }),
  forfeit: (opp, won) => (won ? { headline: 'You win', note: `${opp} left the match. Rated as a quit.` } : { headline: 'You left the match', note: `${opp} takes the win. Rated as a quit.` }),
  disconnect: (opp, won) => (won ? { headline: 'Connection lost', note: `${opp} dropped and didn't rejoin in 10 seconds. The win is yours. Not rated as a quit: no rating change.` } : { headline: 'Connection lost', note: `You dropped and didn't rejoin in 10 seconds. ${opp} takes the match. Not rated as a quit: no rating change.` }),
  desync: () => ({ headline: 'Match void', note: 'The two games fell out of step (a desync). It has been reported. Queue again for a fresh match.' }),
  'no-start': (opp) => ({ headline: 'Match void', note: `${opp}'s game never started. Back to the queue whenever you like.` }),
};

/** The online fight ended (any reason): results, then back to the lobby with Queue again. */
async function onlineEnded(m: Match, f: OnlineFight, end: FightEnd): Promise<void> {
  // The room stays up for a rematch only after a finished game (the sim's end, or time); anything else closes it.
  const rematchable = (end.reason === 'game' || end.reason === 'time') && !f.found.room.closed;
  f.holdRoom = rematchable;
  clearRematchPanel();
  onlineCall('match over', (o) => o.onlineParts()?.mm.matchOver());
  if (match === m) phase = 'idle';
  $('pause').hidden = true;
  if (settingsOpen()) closeSettings();
  const won = end.winner === f.slot;
  const ending = ENDINGS[end.reason](f.opponent, won, end.sudden);
  const voided = end.reason === 'desync' || end.reason === 'no-start';
  analytics.matchEnd(m, voided || (end.reason === 'forfeit' && !won) ? 'quit' : won ? 'complete' : 'death', { reason: end.reason });
  // A game that ended in the sim has had its Game! banner; an early end gets its own.
  if (end.reason !== 'game' && end.reason !== 'time') banner(end.reason === 'desync' || end.reason === 'no-start' ? 'Void' : won ? 'You win' : 'Left');
  for (let i = 0; i < 40 && switching(); i++) await new Promise((r) => setTimeout(r, 50));
  // Rematch: after a finished game (not a quit, a lost link or a void) the room stays open for both to run it back.
  const o = onlineApi();
  const session = rematchable && o ? new o.Rematch({ room: f.found.room, slot: f.slot, prev: f.found.setup, winner: end.winner, char: f.found.setup.chars[f.slot], look: f.found.setup.looks?.[f.slot] ?? 0, opponent: f.opponent }) : null;
  const leave = () => {
    session?.decline();
    clearRematchPanel();
  };
  let actionsFor = (): (ResultAction & { disabled?: boolean })[] => {
    const live = session?.active ?? false;
    const out: (ResultAction & { disabled?: boolean })[] = [];
    if (live && session!.phase === 'open') out.push({ label: 'Rematch', primary: true, run: () => { analytics.feature('rematch', { value: 'press' }); session!.press(); } });
    else if (live && session!.phase === 'waiting') out.push({ label: 'Rematch', primary: true, disabled: true, run: () => {} });
    out.push({
      label: 'Queue again',
      primary: !out.length,
      run: () => {
        leave();
        void go('main', spotlight).then(() => onlineCall('find match', (x) => x.findMatch()));
      },
    });
    out.push({ label: 'Main menu', run: () => { leave(); return go('main', spotlight); } });
    return out;
  };
  const actions = actionsFor();
  const reshow = (): void => void go('results', () => {
    endMatch();
    showResults(m, actionsFor(), { ...ending, winner: end.winner >= 0 ? end.winner : undefined }, []);
    if (session) renderRematch(session);
    onlineCall('rating change', (o) => o.showRatingChange(end, f.slot));
    startResultsMusic();
  });
  // Online replays are the confirmed inputs only (net/rollback truncates a rolled-back tick before it is replaced).
  const replayAction = voided ? null : keepReplay(m);
  if (replayAction) {
    const orig = actionsFor;
    actionsFor = () => {
      const out = orig();
      out.splice(Math.min(1, out.length), 0, { label: 'Watch replay', run: () => void watchReplay(replayAction, reshow) });
      return out;
    };
    actions.splice(0, actions.length, ...actionsFor());
  }
  if (session) {
    let shown = '';
    const redraw = () => {
      if (currentScreen() !== 'results') return;
      renderRematch(session);
      const key = session.phase;
      if (key !== shown) {
        shown = key;
        setResultActions(actionsFor());
      }
    };
    session.on('phase', redraw);
    session.on('tick', redraw);
    session.on('draft', redraw);
    session.on('end', (e: { reason: string }) => {
      analytics.feature('rematch', { value: e.reason });
      clearWinQuote();
      redraw();
    });
    session.on('start', (setup: OnlineSetup) => {
      analytics.feature('rematch', { value: 'start' });
      clearRematchPanel();
      onlineCall('rematch', (x) => x.onlineParts()?.lobby.update({ status: 'in-match' }));
      void startOnlineMatch({ room: f.found.room, slot: f.slot, opponent: f.found.opponent, setup });
    });
  }
  const newLooks = won && !voided ? creditWins(m, [f.slot]) : [];
  clearWinQuote();
  const quote = voided ? null : announceWinQuote(m, end.winner, false);
  await go('results', () => {
    endMatch();
    showResults(m, actions, { ...ending, winner: end.winner >= 0 ? end.winner : undefined }, newLooks);
    if (session) renderRematch(session);
    onlineCall('rating change', (o) => o.showRatingChange(end, f.slot));
    startResultsMusic();
  });
  if (!voided) askOnResults(m);
  playResultCalls(m, end.winner, quote, voided);
  syncPad();
}

/** "How was that fight?" on a versus or online match's results, once they have settled in. Campaign fights get the
 * episode's card on the map instead. */
function askOnResults(m: Match): void {
  if (m.setup.mode !== 'versus' && m.setup.mode !== 'online') return;
  setTimeout(() => {
    if (currentScreen() === 'results' && !match) analytics.askAfterMatch(m);
  }, 900);
}

let airFlashed = false;

/** The show reacts to the first KO of a bout: the ON AIR bug flashes red over the arena with "First blood" and a sting. */
function airFlash(): void {
  document.querySelector('.air-flash')?.remove();
  const el = h('div', { class: 'air-flash', 'data-air': 'first-blood', 'aria-hidden': 'true' },
    h('i', { class: 'dot' }), h('b', {}, 'On air'), h('span', {}, 'First blood'));
  document.body.appendChild(el);
  audio.synth('sting', 0.6);
  window.setTimeout(() => el.remove(), 2200);
  window.dispatchEvent(new CustomEvent('dod:air-flash', { detail: { kind: 'first-blood' } }));
}

/** A commentary call: spoken if it has a take, and captioned one short line at a time (and announced to the playtest). */
function broadcast(c: Call): void {
  // The caption goes up when the take starts, and never for a take the voice director dropped (one speaker, one caption).
  const voiced = !!VOICE.lines.find((l) => l.id === c.id)?.audio && audio.state === 'running';
  if (!voiced) return showBooth(c);
  void audio.line(c.id, 'commentary').then((ms) => {
    if (ms) showBooth(c);
  });
}

function showBooth(c: Call): void {
  document.querySelector('.booth')?.remove();
  clearTimeout(boothTimer);
  const who = c.who === 'blog-man' ? 'Blog Man' : 'Announcer';
  const text = h('span', { class: 'booth-text' });
  const el = h('div', { class: `booth booth-${c.who}`, 'data-call': c.kind, 'data-line': c.id }, h('span', { class: 'booth-who' }, who), text);
  document.body.appendChild(el);
  const pieces = chunkLine(c.text);
  const times = chunkTimes(pieces, null);
  let i = 0;
  const show = () => {
    if (!el.isConnected) return;
    if (i >= pieces.length) return el.remove();
    text.textContent = pieces[i];
    boothTimer = window.setTimeout(show, times[i++]);
  };
  show();
  window.dispatchEvent(new CustomEvent('dod:commentary', { detail: c }));
}
let boothTimer = 0;

/** The GAME! freeze on the final KO. */
const GAME_FREEZE_MS = 500;
let freezeUntil = 0;

/** ROUND START / GAME!: big type punches in with a camera shake and a hit sound (the announcer's line follows). */
/** A dead-even time-out went to sudden death: the slam card, the alarm and sting, the announcer's call. */
function suddenDeathMoment(m: Match): void {
  document.body.classList.add('sudden-death');
  slam('Sudden death!', false, 'sudden');
  audio.synth('alarm', 0.8);
  audio.synth('sting', 1);
  audio.setMusicIntensity(true);
  broadcast(suddenDeathCall());
  window.dispatchEvent(new CustomEvent('dod:sudden-death', { detail: { at: Math.round(performance.now()), frame: m.state.frame, ids: m.state.fighters.filter((f) => f.suddenIn).map((f) => f.id) } }));
}

function slam(text: string, over = false, extra = ''): void {
  const el = h('div', { class: (over ? 'slam game' : 'slam') + (extra ? ` ${extra}` : '') }, text);
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  audio.sfx('vs-slam');
  if (!reduceMotion()) renderer.kick(over ? 0.7 : 0.4);
  window.dispatchEvent(new CustomEvent('dod:slam', { detail: { text, over, at: Math.round(performance.now()), freezeMs: over && !fight ? GAME_FREEZE_MS : 0 } }));
}

function banner(text: string): void {
  const el = h('div', { class: 'banner' }, text);
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ------------------------------------------------------------------- HUD

const hudCache: { pct: number; stocks: number }[] = [];

function slotColor(m: Match, i: number): string {
  const s = m.setup.slots[i];
  const teams = m.setup.slots.some((x) => x.team !== undefined) && new Set(m.setup.slots.map((x) => x.team)).size > 1;
  return teams && m.setup.mode !== 'campaign' ? TEAM_COLORS[s.team ?? 0] : PLAYER_COLORS[i];
}

/** Four little bars beside a player's name: how many are lit is the link's quality (net/quality.ts `barsFor`). */
function connBars(): HTMLElement {
  const el = h('span', { class: 'conn-bars', 'data-bars': '0', role: 'img', 'aria-label': 'Connection: measuring' }, h('i'), h('i'), h('i'), h('i'));
  return el;
}

function updateConnBars(f: OnlineFight): void {
  const cards = $('hud').children;
  for (let i = 0; i < cards.length; i++) {
    const el = cards[i].querySelector<HTMLElement>('.conn-bars');
    if (!el) continue;
    const n = f.phase === 'done' ? 0 : f.barsOf(i);
    if (el.dataset.bars === String(n)) continue;
    el.dataset.bars = String(n);
    el.setAttribute('aria-label', n ? `Connection: ${n} of 4 bars` : 'Connection: measuring');
  }
}

function buildHud(m: Match): void {
  const hud = $('hud');
  hud.replaceChildren();
  hudCache.length = 0;
  const online = m.setup.online;
  for (const f of m.state.fighters) {
    const ch = CHARACTERS[f.char];
    const avatar = online?.avatars[f.id];
    const card = h(
      'div',
      { class: `hud-card${online ? ' online' : ''}`, style: `--player:${slotColor(m, f.id)}`, 'data-shape': shapeOf(f.id), 'data-slot': String(f.id) },
      h('img', { src: thumbUrl(ch.id), alt: '' }),
      avatar && avatar !== ch.id ? h('img', { class: 'hud-avatar', src: headUrl(avatar), alt: '' }) : null,
      h('div', { class: 'hud-pct' }),
      h('div', { class: 'hud-meta' }, h('span', { class: 'hud-name' }, m.label(f.id)), h('span', { class: 'hud-stocks' }), online ? connBars() : null),
    );
    hud.appendChild(card);
    hudCache.push({ pct: -1, stocks: -1 });
  }
  hud.hidden = false;
  const limit = m.state.rules.timeLimit;
  document.body.classList.remove('sudden-death');
  $('timer').classList.remove('sudden');
  $('timer').hidden = limit <= 0;
  const objective = $('objective');
  const shown = m.setup.objective === 'survive' || m.setup.objective === 'ko' || m.setup.objective === 'quota' || m.setup.objective === 'streak';
  objective.hidden = !shown;
  objective.textContent = 'Survive';
  objective.classList.toggle('count', m.setup.objective === 'ko' || m.setup.objective === 'quota' || m.setup.objective === 'streak');
  hudKos = -1;
  hudQuota = -1;
  hudStreak = -1;
  trainingShown = { seq: -1, count: -1, active: null, ko: null, dmg: -1 };
  $('training-readout').hidden = !trainingFree(m);
  $('match-top').hidden = limit <= 0 && !shown;
  updateHud(m);
}

/** What Training's combo readout last drew, so the DOM is only touched when a number changes. */
let trainingShown: { seq: number; count: number; active: boolean | null; ko: boolean | null; dmg: number } = { seq: -1, count: -1, active: null, ko: null, dmg: -1 };

const tenths = (n: number): string => `${Math.floor(n / 10)}.${n % 10}%`;

/** Training: the hits in the combo, its damage, the last hit's damage, and whether it ended in a KO. Stays up after the combo ends, until the next hit. */
function updateReadout(m: Match): void {
  const r = m.readout;
  const shown = trainingShown;
  if (shown.seq === r.seq && shown.count === r.count && shown.active === r.active && shown.ko === r.ko && shown.dmg === r.dmg) return;
  const el = $('training-readout');
  const count = el.querySelector<HTMLElement>('.tr-count')!;
  count.textContent = String(r.count);
  if (r.count !== shown.count && r.count > 0) {
    count.classList.remove('bump');
    void count.offsetWidth;
    count.classList.add('bump');
  }
  el.querySelector('.tr-unit')!.textContent = r.count === 1 ? 'HIT' : 'HIT COMBO';
  el.querySelector('.tr-dmg')!.textContent = tenths(r.dmg);
  el.querySelector('.tr-last')!.textContent = tenths(r.lastHit);
  const tag = el.querySelector<HTMLElement>('.tr-tag')!;
  tag.hidden = r.count < 2;
  tag.textContent = r.ko ? 'KO' : 'True combo';
  el.dataset.live = String(r.active);
  el.dataset.ko = String(r.ko);
  el.dataset.count = String(r.count);
  trainingShown = { seq: r.seq, count: r.count, active: r.active, ko: r.ko, dmg: r.dmg };
}

/** The KO count last shown on the 'ko' objective's chip. */
let hudKos = -1;
/** The whole percent last shown on the 'quota' objective's chip. */
let hudQuota = -1;
/** The clean streak (hits) last shown on the 'streak' objective's chip. */
let hudStreak = -1;

function updateHud(m: Match): void {
  const s = m.state;
  const cards = $('hud').children;
  if (s.sudden > 0) {
    const timer = $('timer');
    timer.hidden = false;
    timer.classList.add('sudden');
    $('match-top').hidden = false;
    timer.textContent = s.sudden > SUDDEN_HOLD ? 'Zone closing' : 'Sudden death';
  } else if (s.rules.timeLimit > 0) $('timer').textContent = formatTime(s.rules.timeLimit - s.frame);
  if (m.setup.objective === 'ko' && hudKos !== m.koCount()) {
    hudKos = m.koCount();
    $('objective').textContent = `KOs ${Math.min(hudKos, m.koTarget)}/${m.koTarget}`;
  }
  if (m.setup.objective === 'quota') {
    const got = Math.floor(Math.min(m.quotaDealt(), m.quotaTarget) / 10);
    if (hudQuota !== got) {
      hudQuota = got;
      $('objective').textContent = `Quota ${got}/${m.quotaTarget / 10}%`;
    }
  }
  if (m.setup.objective === 'streak') {
    const got = Math.min(m.streakNow(), m.streakTarget);
    if (hudStreak !== got) {
      hudStreak = got;
      $('objective').textContent = `Clean streak ${got}/${m.streakTarget}`;
    }
  }
  if (trainingFree(m)) updateReadout(m);
  for (const f of s.fighters) {
    const card = cards[f.id] as HTMLElement | undefined;
    const cache = hudCache[f.id];
    if (!card || !cache) continue;
    if (f.action === ACT.DEAD) {
      if (f.stocks > 0 && cache.pct !== -1) {
        cache.pct = -1;
        card.querySelector('.hud-pct')!.textContent = '—';
      }
    } else if (cache.pct !== f.percent) {
      cache.pct = f.percent;
      const pct = card.querySelector('.hud-pct') as HTMLElement;
      pct.innerHTML = `${Math.floor(f.percent / 10)}<small>.${f.percent % 10}%</small>`;
      // White at 0%, through orange, to red past 120% and deep red from 160%.
      pct.style.color = damageColor(f.percent);
    }
    if (cache.stocks !== f.stocks) {
      cache.stocks = f.stocks;
      const stocks = card.querySelector('.hud-stocks') as HTMLElement;
      stocks.replaceChildren();
      if (f.stocks > 9) stocks.textContent = '∞';
      else for (let i = 0; i < f.stocks; i++) stocks.appendChild(document.createElement('i'));
      card.classList.toggle('out', f.stocks <= 0);
    }
  }
}

/** A landed hit: the victim's damage number shakes (harder as it climbs) and pops on a heavy hit. */
function bumpHud(id: number, dmg = 0, tenths = 0): void {
  const pct = $('hud').children[id]?.querySelector<HTMLElement>('.hud-pct');
  if (!pct) return;
  const shaken = damageShake(dmg, tenths);
  // The number's own shake follows Screen shake, and its pop follows Reduce motion.
  const amp = shaken.amp * shakeScale();
  const pop = shaken.pop && !reduceMotion();
  pct.style.setProperty('--amp', `${amp.toFixed(1)}px`);
  pct.classList.remove('bump', 'pop');
  void pct.offsetWidth;
  pct.classList.add(pop ? 'pop' : 'bump');
  pct.dataset.hits = String(Number(pct.dataset.hits ?? 0) + 1);
  pct.dataset.pop = pop ? '1' : '0';
}

// ------------------------------------------------------------------ loop

function frame(draw = true): void {
  const now = performance.now();
  const dtReal = Math.min(100, now - last);
  // The kill cue's beat of slow motion (renderer.timeScale); online the sim must stay at 60 Hz, so only the camera and sound play there.
  acc += Math.min(100, now - last) * (fight ? 1 : simSpeed * (phase === 'play' ? renderer.timeScale() : 1));
  last = now;
  // Upright phone: the match waits under the Rotate prompt (online it can't stop, so the fighter just stands still).
  if (rotateShowing() && !fight) acc = 0;

  {
    const by = pausePressedBy();
    if (by !== null && match && phase !== 'idle') pauseKey(by);
  }
  // Taunt is presentation-only (T / D-pad up): not packed into sim input, so rollback never sees it.
  if (match && phase === 'play' && tauntPressed()) {
    const me = match.player >= 0 ? match.state.fighters[match.player] : null;
    if (me) audio.fighterVoice(CHARACTERS[me.char].id, 'taunt');
  }
  if (phase !== 'play' && phase !== 'ready' && !showcase) pollMenuPad(now);
  if (padFamily() !== shownPadFamily) fillControlLists();

  if (match && phase === 'ready') {
    // Offline, Ready waits (up to READY_ART_WAIT_MS) for the stage pictures, so "Go!" never opens on a black arena.
    if (!fight && readyFrames >= READY_ART_FRAMES && renderer.stageArtPending() && performance.now() - readyStart < READY_ART_WAIT_MS) {
      acc = 0;
    }
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      if (++readyFrames === 50) {
        banner('Go!');
        if (!readyFightId) audio.line('announcer.go');
        phase = 'play';
        fight?.beginPlay();
        break;
      }
    }
  } else if (match && fight && (phase === 'play' || phase === 'pause')) {
    // Online: always at 60 Hz (the playtest's speed-up would only run ahead of the other player).
    let steps = 0;
    while (acc >= TICK_MS && steps < 5 && match && fight) {
      acc -= TICK_MS;
      onlineTick(match, fight);
      steps++;
    }
  } else if (match && phase === 'play') {
    let steps = 0;
    if (performance.now() < freezeUntil) acc = 0;
    while (acc >= TICK_MS && steps < 5 * simSpeed && phase === 'play' && match) {
      acc -= TICK_MS;
      tick(match);
      steps++;
    }
  } else {
    acc = 0;
  }
  if (fight) showNetStatus(fight);

  if (replayRun && currentScreen() === 'match') {
    replayFrame(dtReal, draw);
  } else if (showcase && currentScreen() === 'match') {
    // A replay, recap or tease (ui/segment.ts) is on the arena: it advances itself and is drawn instead of the match.
    showcase.advance(dtReal);
    if (showcase && draw) renderer.render(showcase.state);
  } else if (draw && match && currentScreen() === 'match') {
    renderer.render(match.state);
    drawEdgeMarkers(match);
    // The teaching prompt rides above the player's head, and is hidden while paused or in a scene.
    if (teacher) {
      const me = match.state.fighters[match.player];
      // Lifted by the name tag's height so the two never sit on top of each other.
      const head = me && phase === 'play' ? renderer.fighterScreen(me) : null;
      teacher.place(head ? { ...head, y: head.y - 24 } : null);
    }
  }
}

/** Edge bubbles for fighters out of view: the portrait, an arrow at them, bigger the nearer the blast line. */
function drawEdgeMarkers(m: Match): void {
  const list: MarkerIn[] = [];
  const tags: TagIn[] = [];
  const live = phase === 'play' || phase === 'pause' || phase === 'ready';
  if (live) {
    for (const f of m.state.fighters) {
      const text = tagText(m.setup.slots, f.id, m.setup.online?.names[f.id]);
      const e = renderer.fighterEdge(f);
      if (e?.off && (phase === 'play' || phase === 'pause')) {
        const avatar = m.setup.online?.avatars[f.id];
        list.push({ id: f.id, x: e.x, y: e.y, gap: e.gap, color: slotColor(m, f.id), shape: shapeOf(f.id), portrait: headUrl(avatar || CHARACTERS[f.char].id), tag: text });
      } else if (e) {
        // On the stage: the tag rides above the head (the renderer's head point), moving with it.
        const head = renderer.fighterScreen(f);
        if (head) tags.push({ id: f.id, x: head.x, y: head.y, text, color: slotColor(m, f.id), shape: shapeOf(f.id) });
      }
    }
  }
  updateMarkers(list);
  let safe: ReturnType<typeof safeInsets> | null = null;
  let blocked: ReturnType<typeof safeInsets>[] = [];
  if (tags.length) {
    safe = safeInsets();
    for (const sel of ['.touch-stick', '.touch-buttons', '.touch-pause', '.hud-card', '#match-top']) {
      document.querySelectorAll(sel).forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) blocked.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
      });
    }
  }
  updateTags(tags, safe ?? { l: 0, t: 0, r: innerWidth, b: innerHeight }, blocked);
}

wireMenus();
// The canvas stays hidden (Game/index.html) until the first rendered frame, then fades in: the engine's default clear colour never shows.
let firstFrame = false;
// Fallback: if no frame renders, reveal anyway so the Title is never held behind opacity 0.
setTimeout(() => document.getElementById('stage')?.classList.add('ready'), 1500);
renderer.engine.runRenderLoop(() => {
  if (renderer.warming) renderer.warmTick();
  frame();
  if (!firstFrame) {
    firstFrame = true;
    bootStep('frame', 'First frame drawn');
    requestAnimationFrame(() => document.getElementById('stage')?.classList.add('ready'));
  }
});


// Devtools playtests open /Game/?play&stage=pit&fighter=slice&vs=break&level=5
// (vs=dummy for a training dummy) and land straight in the match.
const params = new URLSearchParams(location.search);
/** Resolves once the Tap to play prompt has been tapped and has faded. */
const tapped = (): Promise<void> =>
  new Promise((resolve) => {
    const prompt = document.getElementById('tap-to-play');
    if (!prompt || prompt.hidden || !tapState()) resolve();
    else document.addEventListener('dod:tapped', () => resolve(), { once: true });
  });
// Once the prompt has gone, the title's Press start takes the focus.
document.addEventListener('dod:tapped', () => focusFirst());
// The title screen is up: the game is playable (game_ready).
const titleUp = go('title').then(() => analytics.ready());
// Menus are wired and the title is up: a Press start pressed while loading goes on into the menu now.
titleUp.then(() => bootReady(startPressed));
const playtestChapter = CHAPTERS.find((c) => c.id === params.get('chapter'));
// First visit (campaign/firstVisit.ts): nothing saved, so Tap to play is the way into Season 1 Episode 1. It is decided at
// the tap (a playtest clears storage first), and the backdrop under the prompt is only for a visit that starts clean.
// An invite link (?invite=CODE) skips all of it: tap, then straight into that room's lobby.
const inviteCode = /^[A-Za-z0-9]{4,12}$/.test(params.get('invite') ?? '') ? (params.get('invite') as string).toUpperCase() : '';
if (isFirstVisit() && !inviteCode) document.body.classList.add('pilot-boot');
if (inviteCode && !playtestChapter && !params.has('play')) {
  titleUp
    .then(tapped)
    .then(() => go('main', spotlight))
    .then(() => onlineReady())
    .then((o) => o?.openInvite(inviteCode));
} else if (!playtestChapter && !params.has('play')) {
  titleUp.then(tapped).then(() => {
    if (isFirstVisit()) startPilot();
    else document.body.classList.remove('pilot-boot');
  });
}
if (playtestChapter) {
  // Devtools' Story tab: /Game/?chapter=<id> plays that chapter, scene to scene.
  // These wait for the tap, so the chapter starts with its sound.
  titleUp.then(tapped).then(() => playChapter(playtestChapter));
} else if (params.has('play')) {
  const find = (id: string | null, fallback: number) => {
    const i = CHARACTERS.findIndex((c) => c.id === id);
    return i < 0 ? fallback : i;
  };
  const vs = params.get('vs') ?? 'dummy';
  const stage = Math.max(0, STAGES.findIndex((s) => s.id === params.get('stage')));
  const level = Number(params.get('level') ?? 5);
  const me = find(params.get('fighter'), 0);
  titleUp.then(tapped).then(() =>
    startMatch(
      {
        mode: vs === 'dummy' ? 'training' : 'versus',
        stage,
        stocks: 3,
        rules: {},
        slots: [{ char: me, cpu: null }, { char: find(vs, (me + 1) % CHARACTERS.length), cpu: vs === 'dummy' ? 0 : level }],
      },
      false,
    ),
  );
}

// The Hawkes playtest contract (window.hawkesPlaytest). The harness (playtest/dod.ts and the hawkes-*.js helpers,
// ~600 KB) is a separate chunk that players never download: it loads with ?playtest=<id> in the URL, when the page is
// framed by the site's playtest bridge, or the first time a runner calls the contract. Until then window.hawkesPlaytest
// is a thin stand-in with the same shape (idle, not ready), so a runner that finds it and calls start() works as before.
const playtestHooks: Parameters<typeof import('./playtest/dod.ts').installDodPlaytest>[0] = {
  match: () => match,
  phase: () => phase,
  setSeed: (seed) => (playtestSeed = seed),
  setSpeed: (speed) => (simSpeed = Math.max(1, Math.min(4, speed))),
  watch: (w) => {
    matchWatchers.add(w);
    return () => matchWatchers.delete(w);
  },
  startMatch: (setup) => startMatch(setup, false),
  replayTick: () => (replayRun ? replayRun.player.tick : -1),
  quitMatch: () => {
    endMatch();
    return go('main', spotlight);
  },
  tourSkipTo: (after, to) => {
    tourSkip = { after, to };
  },
  tourChoicePreview: (fighter) => {
    const tour = tourFor(fighter) ?? TOURS[0];
    return go('results', () => {
      endMatch();
      renderTourChoice({ tour, index: tour.fights.length - 1, fight: tour.fights[tour.fights.length - 1], continues: 0, onContinue: () => {}, onQuit: () => void openTourScreen() });
    });
  },
  setCampaignProgress: (ids) => {
    const before = [...progress];
    progress.clear();
    for (const id of ids) progress.add(id);
    saveProgress(progress);
    return before;
  },
  fxStats: () => renderer.fxStats(),
  stageSeen: (reset) => renderer.stageSeen(reset),
  hitFxStats: (reset) => renderer.hitFxStats(reset),
  flipStats: (reset) => renderer.flipStats(reset),
  camFxStats: (reset) => renderer.camFxStats(reset),
  flashFxStats: (reset) => renderer.flashFxStats(reset),
  camTrace: (reset) => renderer.camTrace(reset),
  trailStats: (reset) => renderer.trailStats(reset),
  reactFxStats: (reset) => renderer.reactFxStats(reset),
  markerStats: () => ({ ...markerLog, rects: markerRects() }),
  tagStats: () => ({ ...tagLog, rects: tagRects() }),
  gfxStats: () => renderer.gfxStats(),
  autoStats: () => renderer.autoStats(),
  autoSetup: (o: { enabled?: boolean; slowMs?: number; reset?: boolean }) => renderer.autoSetup(o),
  introStats: () => renderer.introStats(),
  mixStats: () => audio.mixStats(),
  probeHit: (pan) => audio.sfx('hit-heavy', { vary: false, at: { pan } }),
  postStats: () => renderer.postStats(),
  lightStats: () => renderer.lightStats(),
  depthStats: () => renderer.depthStats(),
  readabilityProbe: (sets) => renderer.readabilityProbe(sets),
  styleStats: () => renderer.styleStats(),
  lookStats: () => renderer.lookStats(),
  ringShapes: () => renderer.ringShapes(),
  aliveStats: () => renderer.aliveStats(),
  musicBedStats: () => audio.bedStats(),
  audioCacheStats: () => audio.cacheStats(),
};

type PlaytestApi = { version: 1; product: string; scenarios(): unknown[]; start(id: string, o?: unknown): Promise<void>; stop(): void; state(): Record<string, unknown>; report(): Record<string, unknown> | null; input?(a: string, d: boolean): void };
{
  const w = window as unknown as { hawkesPlaytest?: PlaytestApi; hawkesPerf?: { snapshot(): unknown } };
  let real: PlaytestApi | null = null;
  let loading: Promise<PlaytestApi> | null = null;
  const load = (): Promise<PlaytestApi> =>
    (loading ??= Promise.all([import('./playtest/dod.ts'), import('./playtest/hawkes-perf.js')]).then(([m, { installPerfMonitor }]) => {
      m.installDodPlaytest(playtestHooks);
      // The perf readout for playtest reports: the helper reads window.hawkesPerf.snapshot(); the monitor is built at the first read.
      w.hawkesPerf = { snapshot: () => installPerfMonitor(renderer.scene).snapshot() };
      real = w.hawkesPlaytest as PlaytestApi; // the install replaced the stand-in
      return real;
    }));
  const stand: PlaytestApi = {
    version: 1,
    product: 'doseofdestruction',
    scenarios: () => [],
    start: (id, o) => load().then((api) => api.start(id, o)),
    stop: () => void (real ?? null)?.stop(),
    state: () => {
      if (real) return real.state();
      void load();
      return { ready: false, status: 'idle', fps: 0 };
    },
    report: () => (real ? real.report() : null),
    input: (a, d) => void (real ? real.input?.(a, d) : load().then((api) => api.input?.(a, d))),
  };
  w.hawkesPlaytest = stand;
  const framed = (() => {
    try { return window.parent !== window && !!(window.parent as unknown as { hawkesPlaytest?: unknown }).hawkesPlaytest; } catch { return false; }
  })();
  if (framed || /[?&]playtest\b/.test(location.search)) void load();
}

// Online is always on: the lobby is joined with no clicks (docs/online.md), but only now, after the game and the
// playtest hook are up, and each part on its own guard: nothing online can stop single player.
bootOnline((o) => {
  const step = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error(`[dod-online] ${what} failed (single player is unaffected):`, e);
    }
  };
  step('joining the lobby', () => o.startOnline());
  step('the online menus', () =>
    o.initOnlineUi({
      start: (found) => void startOnlineMatch(found),
      inOnlineMatch: () => !!fight,
    }),
  );
  step('the leaderboard', () => o.initLeaderboardUi());
  // An online match keeps running when its page gets no animation frames: a hidden tab, a minimised window, or a window
  // covered by another (Chrome stops frames for all three; J's two windows on one machine, 2026-10-26). Otherwise that
  // side stops sending inputs and the other player waits on it. Hawkes Net's background() runs the loop at 60 Hz,
  // unrendered, from a worker's clock while frames have stopped (docs/online.md, "A hidden page keeps playing").
  step('the background ticker', () => o.background(() => {
    if (fight) frame(false);
  }));
});
// Closing the tab mid-match tells the other player at once (they win) instead of after the link times out.
addEventListener('pagehide', () => {
  try {
    fight?.forfeit();
  } catch (e) {
    console.error('[dod-online] forfeit on leaving failed:', e);
  }
});

if (import.meta.env.DEV) {
  // advance(n) runs n ticks without waiting on animation frames, for test drivers.
  const advance = (n: number) => {
    for (let i = 0; i < n && match; i++) {
      if (phase === 'ready') phase = 'play';
      if (phase === 'play') tick(match);
    }
    if (match) renderer.render(match.state);
  };
  Object.assign(window, {
    dod: {
      get match() { return match; },
      get state() { return match?.state ?? null; },
      get phase() { return phase; },
      get screen() { return currentScreen(); },
      renderer,
      advance,
      startMatch,
      stages: STAGES,
    },
  });
}

if (import.meta.hot) {
  // Devtools saved a content file (a stage, a fighter, a sound): pick it up.
  import.meta.hot.on('dod:content', () => location.reload());
  // The dev server can't build the online chunk (e.g. its packages aren't installed): that's logged, and Vite's
  // full-screen error overlay, which would block the menus and the playtest's clicks, is taken down.
  import.meta.hot.on('vite:error', (payload: { err?: { message?: string; id?: string } }) => {
    const where = `${payload.err?.id ?? ''} ${payload.err?.message ?? ''}`;
    if (!/\/src\/game\/(net\/|ui\/online|ui\/leaderboard)|@noble\//.test(where)) return;
    console.error(`[dod-online] the dev server can't build online play (single player is unaffected): ${payload.err?.message ?? where}`);
    setTimeout(() => document.querySelectorAll('vite-error-overlay').forEach((el) => el.remove()), 0);
  });
}
