// Page wiring: menus, the fixed 60 Hz loop, the HUD, and results.

import { CHARACTERS } from './sim/characters.ts';
import { NO_INPUT } from './sim/input.ts';
import { ACT, newGame, type GameState } from './sim/state.ts';
import { step } from './sim/step.ts';
import { Bot } from './ai/bot.ts';
import { GAMEPAD_HELP, KEYBOARD_HELP, listenKeyboard, onKey, pausePressed, readLocal } from './input/devices.ts';
import { PLAYER_COLORS, Renderer } from './render/renderer.ts';

const TICK_MS = 1000 / 60;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface MatchConfig {
  char: number;
  bots: number;
  level: number;
  stocks: number;
}

type Mode = 'menu' | 'loading' | 'ready' | 'play' | 'pause' | 'results';

const canvas = $<HTMLCanvasElement>('stage');
const renderer = new Renderer(canvas);
listenKeyboard();

let mode: Mode = 'menu';
let config: MatchConfig = loadConfig();
let state: GameState | null = null;
let bots: (Bot | null)[] = [];
let readyFrames = 0;
let acc = 0;
let last = performance.now();
let shownOver = false;

// ------------------------------------------------------------------ menu

function buildMenu(): void {
  const roster = $('roster');
  CHARACTERS.forEach((ch, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fighter-card';
    card.setAttribute('aria-pressed', String(i === config.char));
    card.innerHTML = `<img src="/characters/img/${ch.art}" alt=""><strong></strong><span></span>`;
    card.querySelector('strong')!.textContent = ch.name;
    card.querySelector('span')!.textContent = ch.blurb;
    card.addEventListener('click', () => {
      config.char = i;
      roster.querySelectorAll('.fighter-card').forEach((c, j) => c.setAttribute('aria-pressed', String(j === i)));
    });
    card.addEventListener('dblclick', () => startMatch());
    roster.appendChild(card);
  });

  const level = $<HTMLSelectElement>('opt-level');
  for (let i = 1; i <= 9; i++) level.add(new Option(`Level ${i}`, String(i)));
  level.value = String(config.level);
  $<HTMLSelectElement>('opt-bots').value = String(config.bots);
  $<HTMLSelectElement>('opt-stocks').value = String(config.stocks);

  const fillHelp = (id: string, rows: [string, string][]) => {
    const dl = $(id);
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
  };
  fillHelp('keys-kb', KEYBOARD_HELP);
  fillHelp('keys-pad', GAMEPAD_HELP);

  $('btn-fight').addEventListener('click', () => startMatch());
  $('btn-resume').addEventListener('click', () => setMode('play'));
  $('btn-quit').addEventListener('click', () => setMode('menu'));
  $('btn-rematch').addEventListener('click', () => startMatch());
  $('btn-menu').addEventListener('click', () => setMode('menu'));
  onKey('KeyH', () => (renderer.debug = !renderer.debug));
}

function readMenu(): void {
  config = {
    char: config.char,
    bots: Number($<HTMLSelectElement>('opt-bots').value),
    level: Number($<HTMLSelectElement>('opt-level').value),
    stocks: Number($<HTMLSelectElement>('opt-stocks').value),
  };
  try {
    localStorage.setItem('dod-match', JSON.stringify(config));
  } catch {
    // Storage can be blocked; the menu just won't remember choices.
  }
}

function loadConfig(): MatchConfig {
  const fallback: MatchConfig = { char: 0, bots: 1, level: 5, stocks: 3 };
  try {
    const saved = JSON.parse(localStorage.getItem('dod-match') ?? 'null');
    if (saved && typeof saved === 'object') {
      const c = { ...fallback, ...saved };
      if (c.char >= 0 && c.char < CHARACTERS.length) return c;
    }
  } catch {
    // Ignore unreadable storage.
  }
  return fallback;
}

function setMode(next: Mode): void {
  mode = next;
  $('menu').hidden = next !== 'menu';
  $('pause').hidden = next !== 'pause';
  $('results').hidden = next !== 'results';
  $('loading').hidden = next !== 'loading';
  $('hud').hidden = !(next === 'play' || next === 'pause' || next === 'ready');
  if (next === 'menu') {
    state = null;
    ($('btn-fight') as HTMLButtonElement).focus();
  }
  if (next === 'play') canvas.focus();
}

// ----------------------------------------------------------------- match

async function startMatch(): Promise<void> {
  readMenu();
  setMode('loading');

  const setup = [{ char: config.char }];
  if (config.bots === 0) {
    setup.push({ char: (config.char + 1) % CHARACTERS.length });
  } else {
    // Opponents cycle through the rest of the roster.
    for (let i = 0; i < config.bots; i++) setup.push({ char: (config.char + 1 + i) % CHARACTERS.length });
  }
  const training = config.bots === 0;
  const seed = (Math.random() * 0x7fffffff) | 0;
  state = newGame(setup, training ? 99 : config.stocks, seed);
  bots = setup.map((_, i) => (i === 0 || training ? null : new Bot(i, config.level, seed + i * 7919)));

  try {
    await renderer.setFighters(state);
  } catch (err) {
    console.error(err);
  }
  buildHud(state);
  shownOver = false;
  readyFrames = 0;
  banner('Ready');
  setMode('ready');
}

function tick(s: GameState): void {
  const inputs = s.fighters.map((f, i) => (i === 0 ? readLocal() : (bots[i]?.think(s) ?? NO_INPUT)));
  const events = step(s, inputs);
  renderer.onEvents(events);
  for (const e of events) if (e.type === 'hit' && !e.shield) bumpHud(e.victim);
  updateHud(s);
  if (s.over && !shownOver) {
    shownOver = true;
    banner('Game!');
  }
  if (s.over && s.endTimer === 0) showResults(s);
}

function showResults(s: GameState): void {
  const winner = s.fighters[s.winner];
  $('results-title').textContent = winner ? `${playerLabel(winner.id)} wins` : 'No contest';
  const body = $('results-body');
  body.replaceChildren();
  const rows = [...s.fighters].sort((a, b) => b.stocks - a.stocks || b.kos - a.kos);
  for (const f of rows) {
    const tr = document.createElement('tr');
    const cells = [`${playerLabel(f.id)} · ${CHARACTERS[f.char].name}`, f.kos, f.falls, `${(f.damageDealt / 10).toFixed(1)}%`];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    tr.firstElementChild!.setAttribute('style', `color:${PLAYER_COLORS[f.id]}`);
    body.appendChild(tr);
  }
  setMode('results');
  ($('btn-rematch') as HTMLButtonElement).focus();
}

function playerLabel(id: number): string {
  if (id === 0) return 'You';
  return bots[id] ? `CPU ${id}` : 'Dummy';
}

function banner(text: string): void {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ------------------------------------------------------------------- HUD

const hudCache: { pct: number; stocks: number }[] = [];

function buildHud(s: GameState): void {
  const hud = $('hud');
  hud.replaceChildren();
  hudCache.length = 0;
  for (const f of s.fighters) {
    const ch = CHARACTERS[f.char];
    const card = document.createElement('div');
    card.className = 'hud-card';
    card.style.setProperty('--player', PLAYER_COLORS[f.id]);
    card.innerHTML = `<img src="/characters/img/${ch.art}" alt=""><div class="hud-pct"></div><div class="hud-meta"><span class="hud-name"></span><span class="hud-stocks"></span></div>`;
    card.querySelector('.hud-name')!.textContent = `${playerLabel(f.id)} · ${ch.name}`;
    hud.appendChild(card);
    hudCache.push({ pct: -1, stocks: -1 });
  }
  updateHud(s);
}

function updateHud(s: GameState): void {
  const cards = $('hud').children;
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
      const whole = Math.floor(f.percent / 10);
      pct.innerHTML = `${whole}<small>.${f.percent % 10}%</small>`;
      // White at 0%, through orange, to deep red past 150%.
      const k = Math.min(1, f.percent / 1500);
      pct.style.color = `rgb(${255}, ${Math.round(244 - k * 200)}, ${Math.round(232 - k * 220)})`;
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

  if (state && (mode === 'play' || mode === 'pause' || mode === 'ready') && pausePressed()) {
    if (mode === 'play') setMode('pause');
    else if (mode === 'pause') setMode('play');
  }

  if (state && mode === 'ready') {
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      if (++readyFrames === 50) {
        banner('Go!');
        setMode('play');
        break;
      }
    }
  } else if (state && mode === 'play') {
    let steps = 0;
    while (acc >= TICK_MS && steps < 5 && mode === 'play') {
      acc -= TICK_MS;
      tick(state);
      steps++;
    }
  } else {
    acc = 0;
  }

  if (state) renderer.render(state);
  else renderer.scene.render();
}

buildMenu();
setMode('menu');
if (import.meta.env.DEV) {
  // Lets a console (or a test driver) inspect the live match.
  // advance(n) runs n ticks without waiting on animation frames.
  const advance = (n: number) => {
    for (let i = 0; i < n && state; i++) {
      if (mode === 'ready') setMode('play');
      if (mode === 'play') tick(state);
    }
    if (state) renderer.render(state);
  };
  Object.assign(window, { dod: { get state() { return state; }, get mode() { return mode; }, renderer, advance } });
}
renderer.engine.runRenderLoop(frame);
