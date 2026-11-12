// Page wiring: the screen flow, the fixed 60 Hz match loop, the HUD, and the
// campaign's scene-fight-scene rhythm.

// First: analytics (Hawkes Analytics, analytics.ts) marks the load start and stamps the build.
import * as analytics from './analytics.ts';
import { CHARACTERS, MOVE } from './sim/characters.ts';
import { addWin } from './looks.ts';
import { audio, tapState } from './audio.ts';
import { Commentator, introCall, type Call } from './commentary.ts';
import { graphics, onGraphics, setGraphics } from './graphics.ts';
import { onScreenShake, screenShake, setScreenShake } from './hitFeel.ts';
import { onTouchSettings, touchUiForced, setTouchSettings, touchSettings, hitVibrate } from './touchSettings.ts';
import { onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';
import { ACT } from './sim/state.ts';
import { STAGES } from './sim/stage.ts';
import { initTouchControls, showTouchControls, touchDevice } from './input/touch.ts';
import { GAMEPAD_HELP, KEYBOARD_HELP, TOUCH_HELP, listenKeyboard, onKey, pausePressed, readLocal, tauntPressed } from './input/devices.ts';
import { installPerfMonitor } from './playtest/hawkes-perf.js';
import { damageColor, damageShake } from './hitFeel.ts';
import { clearMarkers, markerLog, markerRects, updateMarkers, type MarkerIn } from './ui/offscreen.ts';
import { PLAYER_COLORS, Renderer, prefetchFighters, prefetchStage } from './render/renderer.ts';
import { Match, type MatchSetup } from './match.ts';
import type { SimEvent } from './sim/step.ts';
import { CHAPTERS, isUnlocked, loadProgress, saveProgress, storyCard, unlockFor, type Chapter } from './campaign/story.ts';
import { stagesFor, type ModeStage } from './modes.ts';
import { $, formatTime, h, headUrl, largeUrl, thumbUrl } from './ui/dom.ts';
import { back, currentScreen, focusFirst, go, listenMenuKeys, onBack, onPanelBack, pollMenuPad, syncPad } from './ui/screens.ts';
import { TEAM_COLORS, openSelect, type VersusConfig } from './ui/select.ts';
import { openCampaign, openStages, playVersus, showResults, type ResultAction } from './ui/views.ts';
import { playColdOpen, playExchange, playScene, skipScene, type SceneCard, type SceneLine, type SceneStage } from './ui/scene.ts';
import { chunkLine, chunkTimes } from './campaign/sceneText.ts';
import { exchangeFor, markExchangeSeen, seenExchanges, type Exchange } from './campaign/intros.ts';
import { installDodPlaytest, type MatchWatcher } from './playtest/dod.ts';
import { NO_INPUT } from './sim/input.ts';
import { step } from './sim/step.ts';
import { stageIndex } from './sim/stage.ts';
import type { GameState } from './sim/state.ts';
import { HighlightPlayer, loadHighlight, nextChapterId, recapApplies, recapId, saveHighlight, teaseId } from './campaign/highlight.ts';
import { playSegment, type SegmentEnv, type Showcase } from './ui/segment.ts';
// Online code is never imported here: it loads after boot through the loader (a failure there can't stop the game).
import type { OnlineFight, FightEnd } from './net/fight.ts';
import type { Found } from './net/matchmaker.ts';
import { bootOnline, onlineApi } from './net/loader.ts';
import { switching } from './ui/screens.ts';
import { initRotatePrompt, rotateShowing } from './ui/rotate.ts';
import { Teacher } from './ui/teach.ts';
import { DAILY_POOL, dailyEpisode, dailyScore, dailySetup, liveStreak, msToNext, recordClear, type DailyEpisode } from './campaign/daily.ts';
import { dailyDate, loadDaily, saveDaily } from './campaign/dailyStore.ts';
import { fillBoard, renderDailyCard, renderDailyResults, setCountdown } from './ui/daily.ts';
import { TOURS, TOUR_LENGTH, loadTours, tourFor, markTourCleared, tourEnding, tourIntro, tourSetup, type Tour } from './campaign/tour.ts';
import { renderTourChoice, renderTourSelect, tourBanner } from './ui/tour.ts';
import { VOICE } from './audio.ts';
import { PILOT_CHAPTER, PILOT_KAELEN, isFirstVisit, markPilotSeen, pilotState } from './campaign/firstVisit.ts';

const TICK_MS = 1000 / 60;

// 'wait': an online match is loaded here and waits for the other player's page.
/** 'scene': a live story scene (ui/scene.ts) is playing in the arena; the sim waits. */
type Phase = 'idle' | 'wait' | 'ready' | 'play' | 'pause' | 'scene';

const canvas = $<HTMLCanvasElement>('stage');
const renderer = new Renderer(canvas);
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

function wireMenus(): void {
  $('btn-start').addEventListener('click', () => {
    audio.line('announcer.title');
    go('main', spotlight);
  });
  // Every button press in a menu clicks.
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, a')) audio.sfx('ui-select');
  });
  wireSettings();
  document.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const to = b.dataset.go;
      if (to === 'online' || to === 'profile') analytics.feature(to === 'online' ? 'find_match' : 'profile_open');
      if (to === 'campaign') openCampaignScreen();
      else if (to === 'tour') openTourScreen();
      else if (to === 'versus') openVersus();
      else if (to === 'training') openTraining();
      else if (to === 'howto') startHowToPlay();
      else if (to === 'controls') go('howto');
      else if (to === 'settings') openSettings();
      else if (to === 'online') onlineCall('find match', (o) => o.findMatch());
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
  onBack('howto', () => go('main', spotlight));
  wirePilot();
  onBack('leaderboard', () => go('main', spotlight));

  $('btn-resume').addEventListener('click', () => setPaused(false));
  $('btn-restart').addEventListener('click', () => {
    setPaused(false);
    if (match) {
      analytics.matchEnd(match, 'restart');
      startMatch(match.setup, false);
    }
  });
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

  const fill = (id: string, rows: [string, string][]) =>
    $(id).replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  fill('keys-kb', KEYBOARD_HELP);
  fill('keys-pad', GAMEPAD_HELP);
  fill('keys-touch', TOUCH_HELP);
  fill('ctl-kb', KEYBOARD_HELP);
  fill('ctl-pad', GAMEPAD_HELP);
  fill('ctl-touch', TOUCH_HELP);
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
      slots: cfg.slots.map((s) => ({ ...s, team: cfg.teams ? (s.team ?? 0) : undefined })),
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
  selectedAt = performance.now();
  const cfg = lastSelect === 'training' ? training : versus;
  analytics.stagePick(lastSelect, stage, random);
  const setup: MatchSetup = {
    mode: lastSelect,
    stage,
    stocks: cfg.stocks,
    // The mode's version of the stage can change its rules (a calm version with hazards off).
    rules: { ...entry.rules, timeLimit: cfg.time * 60 * 60 },
    slots: cfg.slots.map((s) => ({ ...s, team: cfg.teams ? (s.team ?? 0) : undefined })),
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
      openCampaignScreen();
    }, unlocked),
  );
}

async function playChapter(c: Chapter): Promise<void> {
  chapter = c;
  analytics.chapterPlayed(c);
  // The episode opens on "Previously on Dose of Destruction": the last episode's final KO, replayed under Blog Man's recap.
  await playRecap(c);
  if (chapter !== c) return;
  const n = CHAPTERS.indexOf(c) + 1;
  // The story card and scene take a while to read: the fight's fighters and arena load meanwhile.
  void prefetchFighters(c.fight.slots.map((s) => s.char));
  prefetchStage(c.fight.stage);
  renderer.setStage(c.fight.stage);
  renderer.setLooks(c.fight.slots.map((s) => s.look ?? 0));
  void renderer.setFighters(new Match({ ...c.fight, title: undefined, subtitle: undefined }, 1).state, true, 0);
  // The episode opens in the arena: the VS card, then the intro plays live with the fighters (ui/scene.ts).
  startMatch({ ...c.fight, title: `Chapter ${n} · ${c.title}`, subtitle: c.hint }, true, undefined, { chapter: c, which: 'intro' });
}

/** What a story scene plays: the chapter's intro (before Ready) or outro (after the episode is won). */
interface SceneCue {
  /** A campaign chapter's scene, or a Tour's (its own lines and card). */
  chapter?: Chapter;
  tour?: { lines: SceneLine[]; card: SceneCard; id: string };
  which: 'intro' | 'outro';
}

/** The arena, camera and sound a scene drives, for this match. The player stands first in the cast. */
function sceneStage(m: Match): SceneStage {
  const ids = m.state.fighters.map((f) => f.id);
  const order = m.player >= 0 ? [m.player, ...ids.filter((id) => id !== m.player)] : ids;
  return {
    cast: order.map((id) => ({ id, who: CHARACTERS[m.state.fighters[id].char].id })),
    direct: (shot) => renderer.direct(shot),
    holdOffstage: (id, held) => renderer.holdOffstage(id, held),
    arrive: (id) => renderer.arrive(id),
    cue: (id) => renderer.cue(id),
    taunt: (who) => audio.fighterVoice(who, 'taunt'),
    voice: (url) => audio.voice(url),
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
  const end = await playExchange(sceneStage(m), ex.id, ex.lines);
  if (!ex.generic) markExchangeSeen(ex.id);
  analytics.scene(ex.id, { skipped: end.skipped, line: Math.max(0, end.lines - 1) }, ex.lines.length);
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
function replaySounds(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'hit' && !e.shield) {
      audio.sfx(e.dmg < 70 ? 'hit-light' : e.dmg < 130 ? 'hit-medium' : 'hit-heavy', { vary: true });
      if (e.dmg >= 130) audio.crowd('ooh');
    } else if (e.type === 'ko') {
      audio.sfx('ko');
      audio.crowd('roar');
    }
  }
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
  progress.add(c.id);
  saveProgress(progress);
  analytics.chapterCleared(c, firstTime, progress);
  // The hero this episode unlocks (once): the map says so.
  await openCampaignScreen(unlockFor(c) ?? undefined);
  // Back on the map, the episode over: the stars card.
  if (currentScreen() === 'campaign') analytics.askAfterEpisode(c);
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
    // The foe gloats over the Continue or Quit choice, in their own recorded win line.
    const gloat = r.tour.fights[r.index].foes[0];
    window.setTimeout(() => audio.line(`fighter.${gloat}.win`), 1200);
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
  await go('main', spotlight);
}

/** How to play: the same prompted fight in Training against a dummy, with no setup screens. */
function startHowToPlay(): void {
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
      teach: 'training',
      title: 'How to play',
      slots: [{ char: ep, cpu: null }, { char: dummy, cpu: 0 }],
    },
    false,
  );
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
    await renderer.whenFightersIdle();
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
    warm = loading.then(() => nextFrame()).then(() => nextFrame()).then(async () => {
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
    renderer.onLoadProgress = null;
    bar.remove();
    void splash;
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
  const readyUnderWipe = !f && !intro && !versusExchange;
  await go('match', () => {
    window.dispatchEvent(new CustomEvent('dod:scene-timing', { detail: { selectToVs: fromSelect, vsToMatch: vsMs, vsHoldMs, warmUpMs, selectToMatch: pickedAt === null ? null : performance.now() - pickedAt, withVersus } }));
    // The canvas may have changed size while menus were up.
    renderer.engine.resize();
    match = m;
    teacher = setup.teach ? new Teacher({ scripted: setup.teach === 'training' }) : null;
    if (teacher) teacher.onChange = (step, state) => window.dispatchEvent(new CustomEvent('dod:teach', { detail: { step, state, mode: setup.teach } }));
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
  if (versusExchange) {
    await runExchange(m, versusExchange);
    if (match !== m) return;
    beginReady(m);
    return;
  }
  if (!readyUnderWipe) beginReady(m);
}

function beginReady(m: Match): void {
  const setup = m.setup;
  analytics.matchStart(m, chapter);
  endPilotBoot();
  phase = 'ready';
  readyFrames = 0;
  readyStart = performance.now();
  banner('Ready');
  renderer.stageEvent('start');
  audio.line('announcer.ready');
  commentator = setup.mode === 'versus' || setup.mode === 'campaign' ? new Commentator(m.state) : null;
  introPending = (commentator && (chapter ? introCall(chapter.id) : dailyRun?.setup === setup ? introCall(dailyRun.ep.blogChapter) : null)) || null;
  audio.playStageBed(STAGES[setup.stage].id);
  audio.setMusicIntensity(audio.shouldBeIntense(m.state.fighters));
  lastActions = m.state.fighters.map((f) => f.action);
  crowdStocksBefore = m.state.fighters.map((f) => f.stocks);
  canvas.focus();
}

function endMatch(): void {
  skipScene();
  // A match left any other way than its end, a restart or Quit (another match starting over it) ends its level here.
  if (match) analytics.matchEnd(match, 'quit', { reason: 'left' });
  // Leaving an online match any other way (another match starting) is a forfeit.
  if (fight && fight.phase !== 'done') fight.forfeit();
  fight = null;
  teacher?.end();
  teacher = null;
  $('pilot-menu').hidden = true;
  $('net-status').hidden = true;
  match = null;
  phase = 'idle';
  showTouchControls(false);
  $('hud').hidden = true;
  clearMarkers();
  $('match-top').hidden = true;
  $('pause').hidden = true;
  renderer.debug = false;
}

/** Esc, Start or the on-screen pause button in a match: closes Settings if it is open, else pauses or resumes. */
function pauseKey(): void {
  if (!match || phase === 'idle') return;
  // Esc or Start in a story scene skips it.
  if (phase === 'scene') return skipScene();
  if (!$('controls-panel').hidden) openControlsPanel(false);
  else if (settingsOpen()) closeSettings();
  else setPaused(phase !== 'pause');
}

function setPaused(paused: boolean): void {
  if (!match) return;
  if (!paused && settingsOpen()) closeSettings();
  if (!paused) $('controls-panel').hidden = true;
  // Online the match can't stop: the menu opens over it and your fighter stands still meanwhile.
  if (fight && phase !== 'play' && phase !== 'pause') return;
  if (paused && phase !== 'pause') analytics.paused(match);
  phase = paused ? 'pause' : 'play';
  $('pause').hidden = !paused;
  $('btn-restart').hidden = !!fight;
  $('pause').querySelector('h2')!.textContent = fight ? 'Menu (the match goes on)' : 'Paused';
  if (paused) {
    $('btn-quit').textContent = fight ? 'Leave match (you lose)' : inTour() ? 'Quit to Tour' : chapter ? 'Quit to campaign' : 'Quit to menu';
    ($('btn-resume') as HTMLButtonElement).focus();
    syncPad();
  } else {
    canvas.focus();
  }
}

let lastActions: number[] = [];
/** Stocks snapshot before each KO batch, for crowd comeback cheers (mirrors commentary). */
let crowdStocksBefore: number[] = [];
let startToken = 0;

function tick(m: Match): void {
  afterTick(m, m.tick(readLocal()));
}

/** One online tick: the rollback runs zero, one or (after a late input) several frames. */
function onlineTick(m: Match, f: OnlineFight): void {
  afterTick(m, f.tick(phase === 'pause' || rotateShowing() ? NO_INPUT : readLocal()));
}

function afterTick(m: Match, events: SimEvent[]): void {
  renderer.onEvents(events);
  analytics.matchEvents(m, events);
  for (const w of matchWatchers) w(m, events);
  for (const e of events) {
    if (e.type === 'hit' && !e.shield) {
      bumpHud(e.victim, e.dmg, m.state.fighters[e.victim]?.percent ?? 0);
      // Phone feel: a light buzz when you land a hit (Settings → Vibrate, where supported).
      if (m.player >= 0 && e.attacker === m.player) hitVibrate(e.dmg >= 130 ? 18 : 12);
    } else if (e.type === 'ko' && m.player >= 0 && (e.by === m.player || e.victim === m.player)) {
      // Heavier pulse on a KO you deal or take, still behind the same Settings switch.
      hitVibrate(e.by === m.player ? 28 : 22);
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
  if (s.over && !shownOver) {
    shownOver = true;
    renderer.stageEvent('end');
    banner(s.timedOut ? 'Time!' : 'Game!');
    audio.line(s.timedOut ? 'announcer.time' : 'announcer.game');
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
const VOICE_SPECIALS: ReadonlySet<number> = new Set([MOVE.NSPECIAL, MOVE.SSPECIAL, MOVE.UPB, MOVE.DSPECIAL]);

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
  for (const e of events) {
    switch (e.type) {
      case 'hit':
        if (e.shield) audio.sfx('hit-shield', { vary: true });
        else {
          audio.sfx(e.dmg < 70 ? 'hit-light' : e.dmg < 130 ? 'hit-medium' : 'hit-heavy', { vary: true });
          // Heavy hits: the studio crowd gasps (ooh). Medium/heavy: the victim's hurt bark.
          if (e.dmg >= 130) audio.crowd('ooh');
          if (e.dmg >= 70) audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'hurt');
        }
        break;
      case 'hurt':
        // Stage damage (hazards, damage zones) lands with a hit sound like any other hit.
        audio.sfx(e.dmg < 70 ? 'hit-light' : 'hit-medium', { vary: true });
        if (e.dmg >= 70) audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'hurt');
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
        } else if (e.kind === 'flicker') audio.synth('thud', 0.6);
        else audio.synth('alarm', 0.9);
        break;
      case 'ko': {
        audio.sfx('ko');
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
        audio.fighterVoice(CHARACTERS[m.state.fighters[e.victim].char].id, 'ko');
        break;
      }
      case 'grab':
        // The grab clasps (a shielded one cracks through the guard too); a held fighter's shield stays whole.
        audio.synth('grab', 1);
        if (e.shield) audio.sfx('hit-shield', { vary: true });
        break;
      case 'throw':
        audio.synth('whoosh', 0.7);
        audio.sfx(e.kind === 2 ? 'hit-heavy' : 'hit-medium', { vary: true });
        break;
      case 'grab-break':
        audio.synth('whoosh', 0.35);
        break;
      case 'counter':
        // A counter rings out: a shield-bright hit and a sting.
        audio.sfx('hit-shield');
        audio.synth('sting', 0.5);
        break;
      case 'jump':
        audio.sfx('jump', { vary: true });
        break;
      case 'land':
        audio.landSfx();
        break;
      case 'ledge':
        audio.sfx('ledge', { vary: true });
        break;
      case 'shieldbreak':
        audio.sfx('shield-break');
        break;
      case 'respawn':
        audio.sfx('respawn');
        break;
    }
  }
  // Swings and dodges start on a change of action, which the sim does not report.
  m.state.fighters.forEach((f, i) => {
    if (f.action !== lastActions[i]) {
      if (f.action === ACT.ATTACK) {
        audio.sfx(SMASHES.has(f.move) || f.move === MOVE.SSPECIAL || f.move === MOVE.DSPECIAL ? 'swing-heavy' : 'swing-light', { vary: true });
        // Smash and special effort barks (1.5 s cooldown + no overlap, inside audio.fighterVoice).
        if (SMASHES.has(f.move) || VOICE_SPECIALS.has(f.move)) {
          audio.fighterVoice(CHARACTERS[f.char].id, 'effort');
        }
      } else if (f.action === ACT.ROLL || f.action === ACT.SPOTDODGE || f.action === ACT.AIRDODGE) audio.sfx('dodge', { vary: true });
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
  const shake = $('shake-switch');
  shake.setAttribute('aria-checked', String(screenShake()));
  shake.textContent = screenShake() ? 'On' : 'Off';
  const g = graphics();
  const flip = (id: string, on: boolean, text: string) => {
    $(id).setAttribute('aria-checked', String(on));
    $(id).textContent = text;
  };
  flip('quality-switch', g.quality === 'high', g.quality === 'high' ? 'High' : 'Low');
  flip('glow-switch', g.glow, g.glow ? 'On' : 'Off');
  flip('fps-switch', g.fps, g.fps ? 'On' : 'Off');
  for (const k of ['music', 'sfx'] as const) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    input.value = String(Math.round(s[k] * 100));
    $(`vol-${k}-value`).textContent = `${input.value}%`;
  }
  // Touch size, opacity and vibrate: only where there are touch controls.
  $('settings-touch').hidden = !(touchDevice() || touchUiForced());
  const t = touchSettings();
  for (const [k, v] of [['size', t.size], ['opacity', t.opacity]] as const) {
    $<HTMLInputElement>(`touch-${k}`).value = String(v);
    $(`touch-${k}-value`).textContent = `${v}%`;
  }
  const vib = $('vibrate-switch');
  vib.setAttribute('aria-checked', String(t.vibrate));
  vib.textContent = t.vibrate ? 'On' : 'Off';
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

function wireSettings(): void {
  renderSettings();
  onSoundSettings(renderSettings);
  const from = () => (match ? 'pause' : 'menu');
  onScreenShake(() => renderSettings());
  $('shake-switch').addEventListener('click', () => {
    setScreenShake(!screenShake());
    analytics.setting('shake', screenShake(), from());
  });
  analytics.graphics(graphics());
  onGraphics((g) => {
    renderSettings();
    analytics.graphics(g);
  });
  $('quality-switch').addEventListener('click', () => {
    setGraphics({ quality: graphics().quality === 'high' ? 'low' : 'high' });
    analytics.setting('quality', graphics().quality, from());
  });
  $('glow-switch').addEventListener('click', () => {
    setGraphics({ glow: !graphics().glow });
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
  for (const k of ['music', 'sfx'] as const) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    input.addEventListener('input', () => setSoundSettings({ [k]: Number(input.value) / 100 }));
    // Where the slider was let go, not every step of the drag.
    input.addEventListener('change', () => analytics.setting(k, Number(input.value), from()));
  }
  // A hit at the new level, so the slider is heard as it lets go.
  $('vol-sfx').addEventListener('change', () => audio.sfx('hit-medium'));
  onTouchSettings(renderSettings);
  for (const k of ['size', 'opacity'] as const) {
    const input = $<HTMLInputElement>(`touch-${k}`);
    input.addEventListener('input', () => setTouchSettings({ [k]: Number(input.value) }));
    input.addEventListener('change', () => analytics.setting(`touch_${k}`, Number(input.value), from()));
  }
  $('vibrate-switch').addEventListener('click', () => {
    setTouchSettings({ vibrate: !touchSettings().vibrate });
    analytics.setting('touch_vibrate', touchSettings().vibrate, from());
  });
  $('settings-done').addEventListener('click', () => closeSettings());
}

// Menus play the menu loop; matches pick their stage's loop when they start.
const MENU_SCREENS = new Set(['title', 'main', 'select', 'stages', 'campaign', 'tour', 'howto', 'leaderboard']);
setInterval(() => {
  const s = currentScreen();
  if (s && MENU_SCREENS.has(s)) audio.playMusic('music-menu');
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

/** The slots that won a finished match (a team's, or the single winner). */
function winningSlots(m: Match): number[] {
  const s = m.state;
  if (s.winnerTeam >= 0) return s.fighters.filter((f) => f.team === s.winnerTeam).map((f) => f.id);
  return s.winner >= 0 ? [s.winner] : [];
}

function showFinish(m: Match, won: boolean, c: Chapter | null): void {
  phase = 'idle';
  // Training has no winner; a campaign loss or a CPU's win credits nobody.
  const newLooks = m.setup.mode === 'training' ? [] : creditWins(m, winningSlots(m));
  analytics.matchEnd(m, won ? 'complete' : 'death');
  const actions: ResultAction[] = [];
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
    if (won) actions.push({ label: 'Continue', primary: true, run: () => chapterCleared(c) });
    else actions.push({ label: 'Retry', primary: true, run: () => startMatch(m.setup, false) });
    actions.push({ label: 'Campaign map', run: () => openCampaignScreen() });
  } else {
    actions.push({ label: 'Rematch', primary: true, run: () => startMatch(m.setup, false) });
    actions.push({ label: 'Change fighters', run: () => openVersus() });
    actions.push({ label: 'Main menu', run: () => go('main', spotlight) });
  }
  void go('results', () => {
    endMatch();
    if (tourRun?.setup === m.setup && !won) {
      showResults(m, actions, undefined, newLooks);
      renderTourChoice({ tour: tourRun.tour, index: tourRun.index, fight: tourRun.tour.fights[tourRun.index], continues: tourRun.continues, onContinue: () => tourContinue(), onQuit: () => { analytics.tour('quit', { fighter: tourRun!.tour.fighter, fight: tourRun!.index + 1 }); void openTourScreen(); } });
    } else showResults(m, actions, undefined, newLooks);
    if (tourRun?.setup === m.setup && won) $('results-body').prepend(tourBanner(tourRun.tour, tourRun.continues));
    if (dailyRun?.setup === m.setup && m.setup.mode === 'campaign') dailyFinished(m, dailyRun.ep, won);
    audio.playMusic('music-results');
  }).then(() => askOnResults(m));
  const winner = m.state.fighters[m.state.winner];
  // The Tour's closing win line already played over the final KO.
  if (winner && !(tourRun?.setup === m.setup && won)) setTimeout(() => audio.line(`fighter.${CHARACTERS[winner.char].id}.win`), 900);
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
  el.hidden = !text || currentScreen() !== 'match';
  el.classList.toggle('waiting', !!waiting);
  if (el.textContent !== text) el.textContent = text;
}

const ENDINGS: Record<FightEnd['reason'], (opp: string, won: boolean) => { headline: string; note?: string }> = {
  game: (opp, won) => ({ headline: won ? 'You win' : `${opp} wins` }),
  time: (opp, won) => ({ headline: won ? 'You win on time' : `${opp} wins on time` }),
  forfeit: (opp, won) => (won ? { headline: 'You win', note: `${opp} left the match.` } : { headline: 'You left the match', note: `${opp} takes the win.` }),
  disconnect: (opp) => ({ headline: 'Connection lost', note: `The link to ${opp} dropped. The win is yours.` }),
  desync: () => ({ headline: 'Match void', note: 'The two games fell out of step (a desync). It has been reported. Queue again for a fresh match.' }),
  'no-start': (opp) => ({ headline: 'Match void', note: `${opp}'s game never started. Back to the queue whenever you like.` }),
};

/** The online fight ended (any reason): results, then back to the lobby with Queue again. */
async function onlineEnded(m: Match, f: OnlineFight, end: FightEnd): Promise<void> {
  onlineCall('match over', (o) => o.onlineParts()?.mm.matchOver());
  if (match === m) phase = 'idle';
  $('pause').hidden = true;
  if (settingsOpen()) closeSettings();
  const won = end.winner === f.slot;
  const ending = ENDINGS[end.reason](f.opponent, won);
  const voided = end.reason === 'desync' || end.reason === 'no-start';
  analytics.matchEnd(m, voided || (end.reason === 'forfeit' && !won) ? 'quit' : won ? 'complete' : 'death', { reason: end.reason });
  // A game that ended in the sim has had its Game! banner; an early end gets its own.
  if (end.reason !== 'game' && end.reason !== 'time') banner(end.reason === 'desync' || end.reason === 'no-start' ? 'Void' : won ? 'You win' : 'Left');
  for (let i = 0; i < 40 && switching(); i++) await new Promise((r) => setTimeout(r, 50));
  const actions: ResultAction[] = [
    {
      label: 'Queue again',
      primary: true,
      run: () => {
        void go('main', spotlight).then(() => onlineCall('find match', (o) => o.findMatch()));
      },
    },
    { label: 'Main menu', run: () => go('main', spotlight) },
  ];
  const newLooks = won && !voided ? creditWins(m, [f.slot]) : [];
  await go('results', () => {
    endMatch();
    showResults(m, actions, { ...ending, winner: end.winner >= 0 ? end.winner : undefined }, newLooks);
    onlineCall('rating change', (o) => o.showRatingChange(end, f.slot));
    audio.playMusic('music-results');
  });
  if (!voided) askOnResults(m);
  const winner = m.state.fighters[end.winner];
  if (winner) setTimeout(() => audio.line(`fighter.${CHARACTERS[winner.char].id}.win`), 900);
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

/** A commentary call: spoken if it has a take, and captioned one short line at a time (and announced to the playtest). */
function broadcast(c: Call): void {
  audio.line(c.id);
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
      { class: `hud-card${online ? ' online' : ''}`, style: `--player:${slotColor(m, f.id)}` },
      h('img', { src: thumbUrl(ch.id), alt: '' }),
      avatar && avatar !== ch.id ? h('img', { class: 'hud-avatar', src: headUrl(avatar), alt: '' }) : null,
      h('div', { class: 'hud-pct' }),
      h('div', { class: 'hud-meta' }, h('span', { class: 'hud-name' }, m.label(f.id)), h('span', { class: 'hud-stocks' })),
    );
    hud.appendChild(card);
    hudCache.push({ pct: -1, stocks: -1 });
  }
  hud.hidden = false;
  const limit = m.state.rules.timeLimit;
  $('timer').hidden = limit <= 0;
  const objective = $('objective');
  const shown = m.setup.objective === 'survive' || m.setup.objective === 'ko' || m.setup.objective === 'quota' || m.setup.objective === 'streak';
  objective.hidden = !shown;
  objective.textContent = 'Survive';
  objective.classList.toggle('count', m.setup.objective === 'ko' || m.setup.objective === 'quota' || m.setup.objective === 'streak');
  hudKos = -1;
  hudQuota = -1;
  hudStreak = -1;
  $('match-top').hidden = limit <= 0 && !shown;
  updateHud(m);
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
  if (s.rules.timeLimit > 0) $('timer').textContent = formatTime(s.rules.timeLimit - s.frame);
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
  const { amp, pop } = damageShake(dmg, tenths);
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

  if (match && phase !== 'idle' && pausePressed()) pauseKey();
  // Taunt is presentation-only (T / D-pad up): not packed into sim input, so rollback never sees it.
  if (match && phase === 'play' && tauntPressed()) {
    const me = match.player >= 0 ? match.state.fighters[match.player] : null;
    if (me) audio.fighterVoice(CHARACTERS[me.char].id, 'taunt');
  }
  if (phase !== 'play' && phase !== 'ready' && !showcase) pollMenuPad(now);

  if (match && phase === 'ready') {
    // Offline, Ready waits (up to READY_ART_WAIT_MS) for the stage pictures, so "Go!" never opens on a black arena.
    if (!fight && readyFrames >= READY_ART_FRAMES && renderer.stageArtPending() && performance.now() - readyStart < READY_ART_WAIT_MS) {
      acc = 0;
    }
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      if (++readyFrames === 50) {
        banner('Go!');
        audio.line('announcer.go');
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
    while (acc >= TICK_MS && steps < 5 * simSpeed && phase === 'play' && match) {
      acc -= TICK_MS;
      tick(match);
      steps++;
    }
  } else {
    acc = 0;
  }
  if (fight) showNetStatus(fight);

  if (showcase && currentScreen() === 'match') {
    // A replay, recap or tease (ui/segment.ts) is on the arena: it advances itself and is drawn instead of the match.
    showcase.advance(dtReal);
    if (showcase && draw) renderer.render(showcase.state);
  } else if (draw && match && currentScreen() === 'match') {
    renderer.render(match.state);
    drawEdgeMarkers(match);
    // The teaching prompt rides above the player's head, and is hidden while paused or in a scene.
    if (teacher) {
      const me = match.state.fighters[match.player];
      teacher.place(me && phase === 'play' ? renderer.fighterScreen(me) : null);
    }
  }
}

/** Edge bubbles for fighters out of view: the portrait, an arrow at them, bigger the nearer the blast line. */
function drawEdgeMarkers(m: Match): void {
  const list: MarkerIn[] = [];
  if (phase === 'play' || phase === 'pause') {
    for (const f of m.state.fighters) {
      const e = renderer.fighterEdge(f);
      if (!e?.off) continue;
      const avatar = m.setup.online?.avatars[f.id];
      list.push({ id: f.id, x: e.x, y: e.y, gap: e.gap, color: slotColor(m, f.id), portrait: headUrl(avatar || CHARACTERS[f.char].id) });
    }
  }
  updateMarkers(list);
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
const playtestChapter = CHAPTERS.find((c) => c.id === params.get('chapter'));
// First visit (campaign/firstVisit.ts): nothing saved, so Tap to play is the way into Season 1 Episode 1. It is decided at
// the tap (a playtest clears storage first), and the backdrop under the prompt is only for a visit that starts clean.
if (isFirstVisit()) document.body.classList.add('pilot-boot');
if (!playtestChapter && !params.has('play')) {
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

// The perf readout (hawkes-perf.js) for playtest reports: the helper reads window.hawkesPerf.snapshot(). The scene
// isn't a page global here, so hand it over; the monitor itself is only built at the first read (a playtest),
// so players never run it.
(window as unknown as { hawkesPerf: { snapshot(): unknown } }).hawkesPerf = {
  snapshot: () => installPerfMonitor(renderer.scene).snapshot(),
};

// The Hawkes playtest contract (window.hawkesPlaytest). Idle until the runner
// starts a scenario or the URL has ?playtest=<id>.
installDodPlaytest({
  match: () => match,
  phase: () => phase,
  setSeed: (seed) => (playtestSeed = seed),
  setSpeed: (speed) => (simSpeed = Math.max(1, Math.min(4, speed))),
  watch: (w) => {
    matchWatchers.add(w);
    return () => matchWatchers.delete(w);
  },
  startMatch: (setup) => startMatch(setup, false),
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
  hitFxStats: (reset) => renderer.hitFxStats(reset),
  flipStats: (reset) => renderer.flipStats(reset),
  camFxStats: (reset) => renderer.camFxStats(reset),
  trailStats: (reset) => renderer.trailStats(reset),
  reactFxStats: (reset) => renderer.reactFxStats(reset),
  markerStats: () => ({ ...markerLog, rects: markerRects() }),
  gfxStats: () => renderer.gfxStats(),
  postStats: () => renderer.postStats(),
  lookStats: () => renderer.lookStats(),
  aliveStats: () => renderer.aliveStats(),
  musicBedStats: () => audio.bedStats(),
});

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
