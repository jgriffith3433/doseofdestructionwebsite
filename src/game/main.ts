// Page wiring: the screen flow, the fixed 60 Hz match loop, the HUD, and the
// campaign's scene-fight-scene rhythm.

import { CHARACTERS, MOVE } from './sim/characters.ts';
import { audio } from './audio.ts';
import { ACT } from './sim/state.ts';
import { STAGES } from './sim/stage.ts';
import { GAMEPAD_HELP, KEYBOARD_HELP, listenKeyboard, onKey, pausePressed, readLocal } from './input/devices.ts';
import { PLAYER_COLORS, Renderer } from './render/renderer.ts';
import { Match, type MatchSetup } from './match.ts';
import { CHAPTERS, loadProgress, saveProgress, type Chapter } from './campaign/story.ts';
import { $, formatTime, h, largeUrl, thumbUrl } from './ui/dom.ts';
import { back, currentScreen, go, listenMenuKeys, onBack, pollMenuPad, syncPad } from './ui/screens.ts';
import { TEAM_COLORS, openSelect, type VersusConfig } from './ui/select.ts';
import { openCampaign, openStages, playDialogue, playVersus, showResults, type ResultAction } from './ui/views.ts';

const TICK_MS = 1000 / 60;

type Phase = 'idle' | 'ready' | 'play' | 'pause';

const canvas = $<HTMLCanvasElement>('stage');
const renderer = new Renderer(canvas);
renderer.onSound = (id) => audio.sfx(id);
listenKeyboard();
listenMenuKeys(() => phase === 'play' || phase === 'ready');

let match: Match | null = null;
let phase: Phase = 'idle';
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
      if (to === 'campaign') openCampaignScreen();
      else if (to === 'versus') openVersus();
      else if (to === 'training') openTraining();
      else if (to === 'howto') go('howto');
      else if (to === 'settings') go('settings');
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
  onBack('settings', () => go('main', spotlight));

  $('btn-resume').addEventListener('click', () => setPaused(false));
  $('btn-restart').addEventListener('click', () => {
    setPaused(false);
    if (match) startMatch(match.setup, false);
  });
  $('btn-quit').addEventListener('click', () => {
    setPaused(false);
    endMatch();
    if (chapter) openCampaignScreen();
    else go('main', spotlight);
  });
  onKey('KeyH', () => {
    if (match) renderer.debug = !renderer.debug;
  });
  onKey('KeyM', () => {
    const muted = audio.toggleMute();
    if (match) banner(muted ? 'Muted' : 'Sound on');
  });

  const fill = (id: string, rows: [string, string][]) =>
    $(id).replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  fill('keys-kb', KEYBOARD_HELP);
  fill('keys-pad', GAMEPAD_HELP);
}

let spotIndex = Math.floor(Math.random() * CHARACTERS.length);
function spotlight(): void {
  const c = CHARACTERS[spotIndex % CHARACTERS.length];
  $<HTMLImageElement>('main-spot-img').src = largeUrl(c.id);
  $('main-spot-name').textContent = c.name;
}
setInterval(() => {
  if (currentScreen() !== 'main') return;
  spotIndex++;
  const img = $<HTMLImageElement>('main-spot-img');
  img.classList.remove('swap');
  void img.offsetWidth;
  img.classList.add('swap');
  spotlight();
}, 4000);

let lastSelect: 'versus' | 'training' = 'versus';

function openVersus(): void {
  lastSelect = 'versus';
  chapter = null;
  go('select', () =>
    openSelect({
      mode: 'versus',
      config: versus,
      onDone: (cfg) => {
        versus = cfg;
        saveVersus();
        go('stages', () => openStages(pickStage, stageChoice));
      },
    }),
  );
}

function openTraining(): void {
  lastSelect = 'training';
  chapter = null;
  go('select', () =>
    openSelect({
      mode: 'training',
      config: training,
      onDone: (cfg) => {
        training = cfg;
        go('stages', () => openStages(pickStage, stageChoice));
      },
    }),
  );
}

function pickStage(stage: number): void {
  stageChoice = stage;
  const cfg = lastSelect === 'training' ? training : versus;
  const setup: MatchSetup = {
    mode: lastSelect,
    stage,
    stocks: cfg.stocks,
    rules: { timeLimit: cfg.time * 60 * 60 },
    slots: cfg.slots.map((s) => ({ ...s, team: cfg.teams ? (s.team ?? 0) : undefined })),
  };
  startMatch(setup, lastSelect === 'versus');
}

// ------------------------------------------------------------- campaign

function openCampaignScreen(): void {
  chapter = null;
  go('campaign', () =>
    openCampaign(progress, playChapter, () => {
      progress.clear();
      saveProgress(progress);
      openCampaignScreen();
    }),
  );
}

async function playChapter(c: Chapter): Promise<void> {
  chapter = c;
  const n = CHAPTERS.indexOf(c) + 1;
  const scene = playDialogueScreen(c.intro, `Chapter ${n} · ${c.title}`);
  await scene;
  startMatch({ ...c.fight, title: `Chapter ${n} · ${c.title}`, subtitle: c.hint }, true);
}

async function playDialogueScreen(lines: Chapter['intro'], title: string): Promise<void> {
  let scene: Promise<void> = Promise.resolve();
  await go('dialogue', () => {
    scene = playDialogue(lines, title);
  });
  await scene;
}

async function chapterCleared(c: Chapter): Promise<void> {
  const n = CHAPTERS.indexOf(c) + 1;
  await playDialogueScreen(c.outro, `Chapter ${n} · ${c.title}`);
  progress.add(c.id);
  saveProgress(progress);
  openCampaignScreen();
}

// ------------------------------------------------------------------ match

async function startMatch(setup: MatchSetup, withVersus: boolean): Promise<void> {
  endMatch();
  const seed = (Math.random() * 0x7fffffff) | 0;
  const m = new Match(setup, seed);
  renderer.setStage(setup.stage);
  const loading = renderer.setFighters(m.state).catch((err) => console.error(err));

  if (withVersus) {
    let splash: Promise<void> = Promise.resolve();
    await go('versus', () => {
      splash = playVersus(setup);
    });
    await Promise.all([splash, loading]);
  } else {
    $('loading').hidden = false;
    await loading;
    $('loading').hidden = true;
  }

  await go('match', () => {
    // The canvas may have changed size while menus were up.
    renderer.engine.resize();
    match = m;
    buildHud(m);
    shownOver = false;
    readyFrames = 0;
    renderer.render(m.state);
  });
  if (match !== m) return;
  phase = 'ready';
  banner('Ready');
  renderer.stageEvent('start');
  audio.line('announcer.ready');
  audio.playMusic(`music-${STAGES[setup.stage].id}`);
  lastActions = m.state.fighters.map((f) => f.action);
  canvas.focus();
}

function endMatch(): void {
  match = null;
  phase = 'idle';
  $('hud').hidden = true;
  $('match-top').hidden = true;
  $('pause').hidden = true;
  renderer.debug = false;
}

function setPaused(paused: boolean): void {
  if (!match) return;
  phase = paused ? 'pause' : 'play';
  $('pause').hidden = !paused;
  if (paused) {
    $('btn-quit').textContent = chapter ? 'Quit to campaign' : 'Quit to menu';
    ($('btn-resume') as HTMLButtonElement).focus();
    syncPad();
  } else {
    canvas.focus();
  }
}

let lastActions: number[] = [];

function tick(m: Match): void {
  const events = m.tick(readLocal());
  renderer.onEvents(events);
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
  if (s.over && s.endTimer === 0) finish(m);
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

function wireSettings(): void {
  const keys = ['master', 'music', 'sfx', 'voice'] as const;
  for (const k of keys) {
    const input = $<HTMLInputElement>(`vol-${k}`);
    const out = $(`vol-${k}-value`);
    input.value = String(Math.round(audio.volumes[k] * 100));
    out.textContent = `${input.value}%`;
    input.addEventListener('input', () => {
      out.textContent = `${input.value}%`;
      audio.setVolumes({ [k]: Number(input.value) / 100 });
    });
    input.addEventListener('change', () => {
      if (k === 'sfx') audio.sfx('hit-medium');
      if (k === 'voice') audio.line('announcer.go');
    });
  }
}

// Menus play the menu loop; matches pick their stage's loop when they start.
const MENU_SCREENS = new Set(['title', 'main', 'select', 'stages', 'campaign', 'howto', 'settings']);
setInterval(() => {
  const s = currentScreen();
  if (s && MENU_SCREENS.has(s)) audio.playMusic('music-menu');
  else if (s === 'dialogue' || s === 'versus') audio.playMusic(null);
}, 300);

function finish(m: Match): void {
  phase = 'idle';
  const won = m.playerWon();
  const c = chapter;
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
  go('results', () => {
    endMatch();
    showResults(m, actions);
    audio.playMusic('music-results');
  });
  const winner = m.state.fighters[m.state.winner];
  if (winner) setTimeout(() => audio.line(`fighter.${CHARACTERS[winner.char].id}.win`), 900);
  syncPad();
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
  for (const f of m.state.fighters) {
    const ch = CHARACTERS[f.char];
    const card = h(
      'div',
      { class: 'hud-card', style: `--player:${slotColor(m, f.id)}` },
      h('img', { src: thumbUrl(ch.id), alt: '' }),
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
  objective.hidden = m.setup.objective !== 'survive';
  objective.textContent = 'Survive';
  $('match-top').hidden = limit <= 0 && m.setup.objective !== 'survive';
  updateHud(m);
}

function updateHud(m: Match): void {
  const s = m.state;
  const cards = $('hud').children;
  if (s.rules.timeLimit > 0) $('timer').textContent = formatTime(s.rules.timeLimit - s.frame);
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

function frame(): void {
  const now = performance.now();
  acc += Math.min(100, now - last);
  last = now;

  if (match && phase !== 'idle' && pausePressed()) setPaused(phase !== 'pause');
  if (phase !== 'play' && phase !== 'ready') pollMenuPad(now);

  if (match && phase === 'ready') {
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      if (++readyFrames === 50) {
        banner('Go!');
        audio.line('announcer.go');
        phase = 'play';
        break;
      }
    }
  } else if (match && phase === 'play') {
    let steps = 0;
    while (acc >= TICK_MS && steps < 5 && phase === 'play' && match) {
      acc -= TICK_MS;
      tick(match);
      steps++;
    }
  } else {
    acc = 0;
  }

  if (match && currentScreen() === 'match') renderer.render(match.state);
}

wireMenus();
renderer.engine.runRenderLoop(frame);

// Devtools playtests open /Game/?play&stage=pit&fighter=slice&vs=break&level=5
// (vs=dummy for a training dummy) and land straight in the match.
const params = new URLSearchParams(location.search);
if (params.has('play')) {
  const find = (id: string | null, fallback: number) => {
    const i = CHARACTERS.findIndex((c) => c.id === id);
    return i < 0 ? fallback : i;
  };
  const vs = params.get('vs') ?? 'dummy';
  const stage = Math.max(0, STAGES.findIndex((s) => s.id === params.get('stage')));
  const level = Number(params.get('level') ?? 5);
  const me = find(params.get('fighter'), 0);
  go('title').then(() =>
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
} else {
  go('title');
}

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
}
