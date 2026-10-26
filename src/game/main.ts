// Page wiring: the screen flow, the fixed 60 Hz match loop, the HUD, and the
// campaign's scene-fight-scene rhythm.

// First: analytics (Hawkes Analytics, analytics.ts) marks the load start and stamps the build.
import * as analytics from './analytics.ts';
import { CHARACTERS, MOVE } from './sim/characters.ts';
import { audio, tapState } from './audio.ts';
import { onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';
import { ACT } from './sim/state.ts';
import { STAGES } from './sim/stage.ts';
import { initTouchControls, showTouchControls } from './input/touch.ts';
import { GAMEPAD_HELP, KEYBOARD_HELP, listenKeyboard, onKey, pausePressed, readLocal } from './input/devices.ts';
import { PLAYER_COLORS, Renderer } from './render/renderer.ts';
import { Match, type MatchSetup } from './match.ts';
import type { SimEvent } from './sim/step.ts';
import { CHAPTERS, loadProgress, saveProgress, type Chapter } from './campaign/story.ts';
import { stagesFor, type ModeStage } from './modes.ts';
import { $, formatTime, h, headUrl, largeUrl, thumbUrl } from './ui/dom.ts';
import { back, currentScreen, focusFirst, go, listenMenuKeys, onBack, onPanelBack, pollMenuPad, syncPad } from './ui/screens.ts';
import { TEAM_COLORS, openSelect, type VersusConfig } from './ui/select.ts';
import { openCampaign, openStages, playDialogue, playVersus, showResults, type ResultAction, type SceneEnd } from './ui/views.ts';
import { installDodPlaytest, type MatchWatcher } from './playtest/dod.ts';
import { NO_INPUT } from './sim/input.ts';
// Online code is never imported here: it loads after boot through the loader (a failure there can't stop the game).
import type { OnlineFight, FightEnd } from './net/fight.ts';
import type { Found } from './net/matchmaker.ts';
import { bootOnline, onlineApi } from './net/loader.ts';
import { switching } from './ui/screens.ts';

const TICK_MS = 1000 / 60;

// 'wait': an online match is loaded here and waits for the other player's page.
type Phase = 'idle' | 'wait' | 'ready' | 'play' | 'pause';

const canvas = $<HTMLCanvasElement>('stage');
const renderer = new Renderer(canvas);
renderer.onSound = (id) => audio.sfx(id);
listenKeyboard();
initTouchControls(() => pauseKey(), true);
listenMenuKeys(() => phase === 'play' || phase === 'ready' || phase === 'wait');

let match: Match | null = null;
let phase: Phase = 'idle';
/** The online fight running `match`, or null for a local match. */
let fight: OnlineFight | null = null;
let readyFrames = 0;
let acc = 0;
let last = performance.now();
let shownOver = false;
let chapter: Chapter | null = null;
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
      else if (to === 'versus') openVersus();
      else if (to === 'training') openTraining();
      else if (to === 'howto') go('howto');
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
  onBack('howto', () => go('main', spotlight));
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
    endMatch();
    if (chapter) openCampaignScreen();
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
  const i = spotIndex % CHARACTERS.length;
  const c = CHARACTERS[i];
  if (spotBusy || i === spotShown) return;
  spotBusy = true;
  await spotReady(c.id);
  spotBusy = false;
  if (spotIndex % CHARACTERS.length !== i) return;
  const img = $<HTMLImageElement>('main-spot-img');
  img.src = largeUrl(c.id);
  $('main-spot-name').textContent = c.name;
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
        go('stages', () => openStages(stagesFor('versus'), pickStage, stageChoice));
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
        go('stages', () => openStages(stagesFor('training'), pickStage, stageChoice));
      },
    }),
  );
}

function pickStage(stage: number, entry: ModeStage, random = false): void {
  stageChoice = stage;
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
  startMatch(setup, lastSelect === 'versus');
}

// ------------------------------------------------------------- campaign

function openCampaignScreen(): Promise<void> {
  chapter = null;
  return go('campaign', () =>
    openCampaign(progress, playChapter, () => {
      progress.clear();
      saveProgress(progress);
      openCampaignScreen();
    }),
  );
}

async function playChapter(c: Chapter): Promise<void> {
  chapter = c;
  analytics.chapterPlayed(c);
  const n = CHAPTERS.indexOf(c) + 1;
  const scene = playDialogueScreen(c.intro, `Chapter ${n} · ${c.title}`, `${c.id}.intro`);
  await scene;
  // A match found during the scene has taken over.
  if (fight || chapter !== c) return;
  startMatch({ ...c.fight, title: `Chapter ${n} · ${c.title}`, subtitle: c.hint }, true);
}

async function playDialogueScreen(lines: Chapter['intro'], title: string, id: string): Promise<void> {
  let scene: Promise<SceneEnd> | null = null;
  await go('dialogue', () => {
    scene = playDialogue(lines, title);
  });
  if (scene) analytics.scene(id, await scene, lines.length);
}

async function chapterCleared(c: Chapter): Promise<void> {
  const n = CHAPTERS.indexOf(c) + 1;
  await playDialogueScreen(c.outro, `Chapter ${n} · ${c.title}`, `${c.id}.outro`);
  const firstTime = !progress.has(c.id);
  progress.add(c.id);
  saveProgress(progress);
  analytics.chapterCleared(c, firstTime, progress);
  await openCampaignScreen();
  // Back on the map, the episode over: the stars card.
  if (currentScreen() === 'campaign') analytics.askAfterEpisode(c);
}

// ------------------------------------------------------------------ match

async function startMatch(setup: MatchSetup, withVersus: boolean, online?: { seed: number; found: Found }): Promise<void> {
  endMatch();
  // A newer start (an online match found meanwhile) wins over this one.
  const token = ++startToken;
  const stale = () => token !== startToken || (f !== null && f.phase === 'done');
  const seed = online ? online.seed : (playtestSeed ?? (Math.random() * 0x7fffffff) | 0);
  const m = new Match(setup, seed);
  const net = online ? onlineApi() : null;
  const f: OnlineFight | null = online && net ? new net.OnlineFight(online.found, m) : null;
  if (f) {
    fight = f;
    f.onEnd = (end) => onlineEnded(m, f, end);
    f.onStart = () => {
      if (match === m && phase === 'wait') beginReady(m);
    };
  }
  renderer.setStage(setup.stage);
  // Everything the match shows and plays is loaded during the VS splash (or the loading
  // screen): clip sheets, stage art, sounds, music and voice lines. Nothing loads mid-fight.
  // Then the first frames are drawn behind the menus, so the switch to the match doesn't stall.
  const loading = Promise.all([
    renderer.setFighters(m.state).then(() => renderer.ready()),
    audio.preloadMatch(STAGES[setup.stage].id, m.state.fighters.map((f) => CHARACTERS[f.char].id)),
  ])
    .then(() => renderer.warmUp(m.state))
    .catch((err) => console.error(err));

  if (withVersus) {
    let splash: Promise<void> = Promise.resolve();
    await go('versus', () => {
      splash = playVersus(setup);
    });
    await Promise.all([splash, loading]);
    if (stale()) return;
  } else {
    // The loading screen stays up until the match's first frame is drawn (under the wipe).
    $('loading').hidden = false;
    await loading;
    if (stale()) return;
  }

  if (stale()) return;
  await go('match', () => {
    // The canvas may have changed size while menus were up.
    renderer.engine.resize();
    match = m;
    showTouchControls(true);
    buildHud(m);
    shownOver = false;
    readyFrames = 0;
    renderer.render(m.state);
    $('loading').hidden = true;
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
  beginReady(m);
}

function beginReady(m: Match): void {
  const setup = m.setup;
  analytics.matchStart(m, chapter);
  phase = 'ready';
  readyFrames = 0;
  banner('Ready');
  renderer.stageEvent('start');
  audio.line('announcer.ready');
  audio.playMusic(`music-${STAGES[setup.stage].id}`);
  lastActions = m.state.fighters.map((f) => f.action);
  canvas.focus();
}

function endMatch(): void {
  // A match left any other way than its end, a restart or Quit (another match starting over it) ends its level here.
  if (match) analytics.matchEnd(match, 'quit', { reason: 'left' });
  // Leaving an online match any other way (another match starting) is a forfeit.
  if (fight && fight.phase !== 'done') fight.forfeit();
  fight = null;
  $('net-status').hidden = true;
  match = null;
  phase = 'idle';
  showTouchControls(false);
  $('hud').hidden = true;
  $('match-top').hidden = true;
  $('pause').hidden = true;
  renderer.debug = false;
}

/** Esc, Start or the on-screen pause button in a match: closes Settings if it is open, else pauses or resumes. */
function pauseKey(): void {
  if (!match || phase === 'idle') return;
  if (settingsOpen()) closeSettings();
  else setPaused(phase !== 'pause');
}

function setPaused(paused: boolean): void {
  if (!match) return;
  if (!paused && settingsOpen()) closeSettings();
  // Online the match can't stop: the menu opens over it and your fighter stands still meanwhile.
  if (fight && phase !== 'play' && phase !== 'pause') return;
  if (paused && phase !== 'pause') analytics.paused(match);
  phase = paused ? 'pause' : 'play';
  $('pause').hidden = !paused;
  $('btn-restart').hidden = !!fight;
  $('pause').querySelector('h2')!.textContent = fight ? 'Menu (the match goes on)' : 'Paused';
  if (paused) {
    $('btn-quit').textContent = fight ? 'Leave match (you lose)' : chapter ? 'Quit to campaign' : 'Quit to menu';
    ($('btn-resume') as HTMLButtonElement).focus();
    syncPad();
  } else {
    canvas.focus();
  }
}

let lastActions: number[] = [];
let startToken = 0;

function tick(m: Match): void {
  afterTick(m, m.tick(readLocal()));
}

/** One online tick: the rollback runs zero, one or (after a late input) several frames. */
function onlineTick(m: Match, f: OnlineFight): void {
  afterTick(m, f.tick(phase === 'pause' ? NO_INPUT : readLocal()));
}

function afterTick(m: Match, events: SimEvent[]): void {
  renderer.onEvents(events);
  analytics.matchEvents(m, events);
  for (const w of matchWatchers) w(m, events);
  for (const e of events) if (e.type === 'hit' && !e.shield) bumpHud(e.victim);
  playEventSounds(m, events);
  updateHud(m);
  const s = m.state;
  if (s.over && !shownOver) {
    shownOver = true;
    renderer.stageEvent('end');
    banner(s.timedOut ? 'Time!' : 'Game!');
    audio.line(s.timedOut ? 'announcer.time' : 'announcer.game');
  }
  // Online, the fight decides when it's over (on a frame both sides agree on): onlineEnded.
  if (s.over && s.endTimer === 0 && !fight) finish(m);
}

const SMASHES: ReadonlySet<number> = new Set([MOVE.FSMASH, MOVE.USMASH, MOVE.DSMASH]);

function playEventSounds(m: Match, events: ReturnType<Match['tick']>): void {
  for (const e of events) {
    switch (e.type) {
      case 'hit':
        if (e.shield) audio.sfx('hit-shield', { vary: true });
        else audio.sfx(e.dmg < 70 ? 'hit-light' : e.dmg < 130 ? 'hit-medium' : 'hit-heavy', { vary: true });
        break;
      case 'ko':
        audio.sfx('ko');
        audio.line(`fighter.${CHARACTERS[m.state.fighters[e.victim].char].id}.ko`);
        break;
      case 'jump':
        audio.sfx('jump', { vary: true });
        break;
      case 'land':
        audio.sfx('land', { vary: true });
        break;
      case 'ledge':
        audio.sfx('ledge');
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
      if (f.action === ACT.ATTACK) audio.sfx(SMASHES.has(f.move) ? 'swing-heavy' : 'swing-light', { vary: true });
      else if (f.action === ACT.ROLL || f.action === ACT.SPOTDODGE || f.action === ACT.AIRDODGE) audio.sfx('dodge', { vary: true });
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
  for (const k of ['music', 'sfx'] as const) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    input.value = String(Math.round(s[k] * 100));
    $(`vol-${k}-value`).textContent = `${input.value}%`;
  }
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
  $('settings-done').addEventListener('click', () => closeSettings());
}

// Menus play the menu loop; matches pick their stage's loop when they start.
const MENU_SCREENS = new Set(['title', 'main', 'select', 'stages', 'campaign', 'howto', 'leaderboard']);
setInterval(() => {
  const s = currentScreen();
  if (s && MENU_SCREENS.has(s)) audio.playMusic('music-menu');
  else if (s === 'dialogue' || s === 'versus') audio.playMusic(null);
}, 300);

function finish(m: Match): void {
  phase = 'idle';
  const won = m.playerWon();
  const c = chapter;
  analytics.matchEnd(m, won ? 'complete' : 'death');
  const actions: ResultAction[] = [];
  if (m.setup.mode === 'campaign' && c) {
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
    showResults(m, actions);
    audio.playMusic('music-results');
  }).then(() => askOnResults(m));
  const winner = m.state.fighters[m.state.winner];
  if (winner) setTimeout(() => audio.line(`fighter.${CHARACTERS[winner.char].id}.win`), 900);
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
    slots: s.chars.map((char, i) => ({ char, cpu: null, remote: i !== found.slot })),
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
  await go('results', () => {
    endMatch();
    showResults(m, actions, { ...ending, winner: end.winner >= 0 ? end.winner : undefined });
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
  const shown = m.setup.objective === 'survive' || m.setup.objective === 'ko';
  objective.hidden = !shown;
  objective.textContent = 'Survive';
  objective.classList.toggle('count', m.setup.objective === 'ko');
  hudKos = -1;
  $('match-top').hidden = limit <= 0 && !shown;
  updateHud(m);
}

/** The KO count last shown on the 'ko' objective's chip. */
let hudKos = -1;

function updateHud(m: Match): void {
  const s = m.state;
  const cards = $('hud').children;
  if (s.rules.timeLimit > 0) $('timer').textContent = formatTime(s.rules.timeLimit - s.frame);
  if (m.setup.objective === 'ko' && hudKos !== m.koCount()) {
    hudKos = m.koCount();
    $('objective').textContent = `KOs ${Math.min(hudKos, m.koTarget)}/${m.koTarget}`;
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
      // White at 0%, through orange, to deep red past 150%.
      const k = Math.min(1, f.percent / 1500);
      pct.style.color = `rgb(255, ${Math.round(244 - k * 200)}, ${Math.round(232 - k * 220)})`;
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

function bumpHud(id: number): void {
  const pct = $('hud').children[id]?.querySelector('.hud-pct');
  if (!pct) return;
  pct.classList.remove('bump');
  void (pct as HTMLElement).offsetWidth;
  pct.classList.add('bump');
}

// ------------------------------------------------------------------ loop

function frame(draw = true): void {
  const now = performance.now();
  acc += Math.min(100, now - last) * (fight ? 1 : simSpeed);
  last = now;

  if (match && phase !== 'idle' && pausePressed()) pauseKey();
  if (phase !== 'play' && phase !== 'ready') pollMenuPad(now);

  if (match && phase === 'ready') {
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

  if (draw && match && currentScreen() === 'match') renderer.render(match.state);
}

wireMenus();
renderer.engine.runRenderLoop(() => frame());


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
  setCampaignProgress: (ids) => {
    const before = [...progress];
    progress.clear();
    for (const id of ids) progress.add(id);
    saveProgress(progress);
    return before;
  },
  fxStats: () => renderer.fxStats(),
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
