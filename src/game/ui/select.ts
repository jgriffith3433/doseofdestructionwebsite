// Character select, a broadcast set: a grid of every fighter's painted portrait (hover lift, slot-colour frame) beside a
// big render of the hovered fighter (idle, in their colour look, under the stage light: fighterRender.ts) with a name
// lower third and a tagline, a live special preview from the sim in an inset (specialsPreview.ts, specialSim.ts) and
// the stat bars behind a Details toggle. A pick plays the confirm pose, the fighter's voiced taunt and the announcer's
// name. Below it, the row of slots for you and up to three CPUs.

import { CHARACTERS, type CharacterDef } from '../sim/characters.ts';
import type { SlotSetup } from '../match.ts';
import { PLAYER_COLORS, prefetchFighters } from '../render/renderer.ts';
import { CHAPTERS, isUnlocked } from '../campaign/story.ts';
import { $, h, kids, largeUrl, portraitSize, portraitUrl, thumbUrl } from './dom.ts';
import { specialsPanel } from './specialsPreview.ts';
import { createFighterRender, prefetchIdles } from './fighterRender.ts';
import { swatchRow } from './lookUi.ts';
import { audio } from '../audio.ts';
import { hintText } from './teach.ts';
import { landOn, resetLanding } from './nameCall.ts';
import { currentScreen, setMenuPadRules } from './screens.ts';
import { pads, setPadClaims } from '../input/devices.ts';
import { TEAM_COLORS, SHAPE_GLYPH, shapeOf } from '../colourVision.ts';
import { loadAutoLevel } from '../ai/autoLevel.ts';
import { ownedOf, pickTitle, pickedTitle } from '../campaign/rewards.ts';
import { lookCount, lookOpen, openLook, preferredLook, rememberLook, separateLooks } from '../looks.ts';

export interface VersusConfig {
  slots: SlotSetup[];
  stocks: number;
  /** Minutes, 0 for none. */
  time: number;
  teams: boolean;
  /** Stage hazards in the fight (default on). */
  hazards?: boolean;
}

export { TEAM_COLORS };
const TEAM_NAMES = ['Red', 'Blue'];

// Stat bars compare each fighter with the rest of the roster.
const STATS: { label: string; of: (c: CharacterDef) => number }[] = [
  { label: 'Speed', of: (c) => c.walkSpeed },
  { label: 'Power', of: (c) => c.tuning.damage * c.tuning.knockback },
  { label: 'Weight', of: (c) => c.weight },
  { label: 'Air', of: (c) => c.airSpeed / 1000 + c.airJumps * 0.8 },
  { label: 'Reach', of: (c) => c.tuning.reach * (0.8 + c.height / 550) },
];
const RANGES = STATS.map((s) => {
  const v = CHARACTERS.map(s.of);
  return [Math.min(...v), Math.max(...v)];
});

export function statBars(c: CharacterDef): HTMLElement {
  return h(
    'dl',
    { class: 'stat-bars' },
    ...STATS.map((s, i) => {
      const [lo, hi] = RANGES[i];
      const k = hi > lo ? (s.of(c) - lo) / (hi - lo) : 0.5;
      return h(
        'div',
        {},
        h('dt', {}, s.label),
        h('dd', {}, h('span', { style: `width:${Math.round(12 + k * 88)}%` })),
      );
    }),
  );
}

/** Phones play with the on-screen controls only: no second person on one screen. */
const touchUi = (): boolean => document.body.classList.contains('touch-ui');

interface Options {
  mode: 'versus' | 'training';
  config: VersusConfig;
  onDone: (config: VersusConfig) => void;
}

/** The chapter that unlocks a fighter, for the "Locked" note. */
export function unlockedBy(id: string) {
  return CHAPTERS.find((c) => c.unlock === id);
}

/** Versus and online picks: a locked fighter can't be picked (training is open to everyone). */
const open = (i: number, training: boolean): boolean => training || isUnlocked(CHARACTERS[i].id);

/** Hold Back on a joined pad this long to leave its slot. */
export const LEAVE_HOLD_MS = 1000;
let joinRun = 0;

export function openSelect({ mode, config, onDone }: Options): void {
  const cfg: VersusConfig = { ...config, slots: config.slots.map((s) => ({ ...s })) };
  let active = 0;
  const training = mode === 'training';
  // A saved setup can name a fighter that is still locked here: swap in one that is open.
  for (const s of cfg.slots) {
    if (!open(s.char, training)) s.char = Math.max(0, CHARACTERS.findIndex((_, i) => open(i, training) && !cfg.slots.some((o) => o.char === i)));
  }

  // Colours: yours must be open (wins unlock them); a CPU may wear any. A saved look that is not open any more falls back to Classic.
  const may = (slot: number, look: number): boolean => cfg.slots[slot].cpu !== null || lookOpen(cfg.slots[slot].char, look);
  const fixLooks = (): number[] => {
    for (const s of cfg.slots) s.look = s.cpu === null ? openLook(s.char, s.look ?? preferredLook(s.char)) : Math.min(Math.max(0, s.look ?? 0), lookCount(s.char) - 1);
    return separateLooks(cfg.slots, may);
  };
  let slotFocus = -1;
  const autoLevel = loadAutoLevel();
  fixLooks();

  // Joining: a pad pressing Start claims the next slot (replacing a CPU); holding Back on it for a second hands the slot back.
  // With two or more pads the first is player 1's (it drives the menu); one pad joins only once the keyboard has been used.
  const claims = new Map<number, number>(); // pad index -> slot
  // Each joined pad has its own cursor on the roster (the tile it is over) and a ready flag (it picked a fighter).
  // Player 1's cursor is the menu focus; the match starts when every joined player is ready and player 1 presses Fight.
  const cursors = new Map<number, HTMLElement>(); // slot -> tile
  const ready = new Set<number>();
  let p1Tile: HTMLElement | null = null;
  const padSlots = (): number[] => [...new Set(claims.values())].filter((i) => cfg.slots[i] && cfg.slots[i].cpu === null);
  const waitingOn = (): number[] => padSlots().filter((i) => !ready.has(i));
  let keyUsed = false;
  let promptShown = false;
  window.addEventListener('keydown', () => { keyUsed = true; }, { once: true });
  setPadClaims([]);
  const claimedPad = (p: Gamepad): boolean => claims.has(p.index);
  /** A pad that Start would put into a slot: not claimed, not player 1's own pad. */
  const joiner = (p: Gamepad): boolean => {
    const all = pads();
    if (all.length >= 2) return all[0].index !== p.index && !claims.has(p.index);
    return all.length === 1 && keyUsed && !claims.has(p.index);
  };
  const freeSlot = (): number => {
    const i = cfg.slots.findIndex((s, k) => k > 0 && s.cpu !== null);
    return i >= 0 ? i : cfg.slots.length < 4 ? cfg.slots.length : -1;
  };
  /** "Press Start to join" shows only when a second device is connected (a pad besides the keyboard, or a second pad). */
  const joinable = (): boolean => !training && !touchUi() && freeSlot() >= 0 && pads().some(joiner);
  const syncClaims = (): void => {
    const owners: number[] = [];
    cfg.slots.forEach((s, i) => {
      if (i > 0 && s.cpu === null) for (const [pad, slot] of claims) if (slot === i) owners.push(pad);
    });
    setPadClaims(owners);
  };
  const joinSlot = (padIndex: number): void => {
    let i = freeSlot();
    if (i < 0) return;
    if (i >= cfg.slots.length) {
      const used = new Set(cfg.slots.map((o) => o.char));
      const free = CHARACTERS.findIndex((_, k) => !used.has(k) && open(k, training));
      cfg.slots.push({ char: free < 0 ? 0 : free, cpu: null, team: cfg.slots.length % 2 });
      i = cfg.slots.length - 1;
    }
    const s = cfg.slots[i];
    s.cpu = null;
    s.auto = undefined;
    s.look = preferredLook(s.char);
    claims.set(padIndex, i);
    ready.delete(i);
    // The new cursor starts on the fighter the slot holds.
    const start = grid.querySelector<HTMLElement>(`.tile[data-fighter="${CHARACTERS[s.char].id}"]`);
    if (start) cursors.set(i, start);
    fixLooks();
    syncClaims();
    audio.sfx('ui-select');
    window.dispatchEvent(new CustomEvent('dod:select-join', { detail: { slot: i, pad: padIndex, joined: true, people: cfg.slots.filter((o) => o.cpu === null).length, at: performance.now() } }));
    renderSlots();
  };
  const leaveSlot = (padIndex: number): void => {
    const i = claims.get(padIndex);
    claims.delete(padIndex);
    if (i !== undefined) { cursors.delete(i); ready.delete(i); }
    if (i === undefined || !cfg.slots[i]) return;
    cfg.slots[i].cpu = autoLevel;
    cfg.slots[i].auto = true;
    syncClaims();
    window.dispatchEvent(new CustomEvent('dod:select-join', { detail: { slot: i, pad: padIndex, joined: false, people: cfg.slots.filter((o) => o.cpu === null).length, at: performance.now() } }));
    renderSlots();
  };
  const padState = new Map<number, { dir: string; at: number; a: boolean; b: boolean; x: boolean }>();
  /** One joined pad: the stick or D-pad moves its cursor, A picks (and readies), X cycles its colour, B un-readies. */
  const padCursor = (p: Gamepad, now: number): void => {
    const slot = claims.get(p.index);
    if (slot === undefined || !cfg.slots[slot]) return;
    const st = padState.get(p.index) ?? { dir: '', at: 0, a: false, b: false, x: false };
    padState.set(p.index, st);
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    let dx = (p.buttons[15]?.pressed ? 1 : 0) - (p.buttons[14]?.pressed ? 1 : 0);
    let dy = (p.buttons[13]?.pressed ? 1 : 0) - (p.buttons[12]?.pressed ? 1 : 0);
    if (!dx && Math.abs(ax) > 0.5 && Math.abs(ax) >= Math.abs(ay)) dx = Math.sign(ax);
    if (!dy && !dx && Math.abs(ay) > 0.5) dy = Math.sign(ay);
    const dir = `${dx},${dy}`;
    if ((dx || dy) && (dir !== st.dir || now - st.at > 230)) {
      st.at = dir !== st.dir ? now + 120 : now;
      moveCursor(slot, dx, dy);
    }
    st.dir = dir;
    const a = !!p.buttons[0]?.pressed;
    const b = !!p.buttons[1]?.pressed;
    const x = !!p.buttons[2]?.pressed;
    if (a && !st.a) pickAt(slot);
    if (b && !st.b && ready.has(slot)) {
      ready.delete(slot);
      audio.sfx('ui-back');
      window.dispatchEvent(new CustomEvent('dod:select-ready', { detail: { slot, ready: false, at: performance.now() } }));
      renderSlots();
    }
    if (x && !st.x) nextLook(slot);
    st.a = a;
    st.b = b;
    st.x = x;
  };

  if (mode === 'versus') {
    const run = ++joinRun;
    const startHeld = new Map<number, boolean>();
    const backSince = new Map<number, number>();
    let seen = false;
    setMenuPadRules({ skip: claimedPad, noStart: joiner });
    const loop = (): void => {
      if (run !== joinRun) return;
      const here = currentScreen() === 'select';
      if (here) seen = true;
      else if (seen) {
        setMenuPadRules(null);
        return;
      }
      if (here) {
        const now = performance.now();
        for (const p of pads()) {
          const start = !!p.buttons[9]?.pressed;
          if (start && !startHeld.get(p.index) && joiner(p)) joinSlot(p.index);
          startHeld.set(p.index, start);
          if (claims.has(p.index)) {
            padCursor(p, now);
            if (p.buttons[1]?.pressed || p.buttons[8]?.pressed) {
              const from = backSince.get(p.index) ?? now;
              backSince.set(p.index, from);
              if (now - from >= LEAVE_HOLD_MS) {
                backSince.delete(p.index);
                leaveSlot(p.index);
              }
            } else backSince.delete(p.index);
          }
        }
        for (const k of [...claims.keys()]) if (!pads().some((p) => p.index === k)) leaveSlot(k);
        if (joinable() !== promptShown) renderSlots();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  const preview = $('select-preview');
  const grid = $('select-grid');
  const slotsEl = $('select-slots');
  const rulesEl = $('select-rules');
  $('select-title').textContent = training ? 'Training' : 'Choose your fighters';

  // One portrait element per fighter, kept and preloaded, so hovering shows it at once
  // (a fresh <img> is blank until it loads). Falls back to the thumbnail if the large one fails.
  const portraits = new Map<string, HTMLImageElement>();
  const portrait = (c: CharacterDef): HTMLImageElement => {
    let img = portraits.get(c.id);
    if (!img) {
      img = h('img', { src: portraitUrl(c.id, portraitSize()), alt: '', class: 'select-portrait', 'data-portrait': c.id }) as HTMLImageElement;
      img.decoding = 'async';
      img.onerror = () => {
        img!.onerror = null;
        img!.src = largeUrl(c.id);
      };
      portraits.set(c.id, img);
    }
    return img;
  };
  CHARACTERS.forEach(portrait);

  // Roster and slot pictures: one kept, preloaded <img> per fighter (cloned into tiles and slots), the painted
  // 256 px portrait, so the grid never shows empty boxes. A tile stays a dark placeholder until its image
  // has loaded (`.loaded`), and falls back to the cutout thumbnail if the portrait fails.
  const thumbs = new Map<string, HTMLImageElement>();
  const thumb = (c: CharacterDef): HTMLImageElement => {
    let src = thumbs.get(c.id);
    if (!src) {
      src = new Image();
      src.decoding = 'async';
      src.onerror = () => {
        src!.onerror = null;
        src!.src = thumbUrl(c.id);
      };
      src.src = portraitUrl(c.id, 256);
      thumbs.set(c.id, src);
    }
    const img = h('img', { alt: '', draggable: 'false', 'data-portrait': c.id }) as HTMLImageElement;
    const mark = () => img.classList.add('loaded');
    img.onerror = () => {
      img.onerror = null;
      img.src = thumbUrl(c.id);
    };
    img.onload = mark;
    img.src = src.currentSrc || src.src;
    if (img.complete && img.naturalWidth > 0) mark();
    return img;
  };
  CHARACTERS.forEach(thumb);

  // The big render keeps one canvas for the whole screen; the preview is rebuilt around it for each fighter.
  const renderCanvas = h('canvas', { class: 'set-render', 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const render = createFighterRender(renderCanvas);
  prefetchIdles([CHARACTERS[cfg.slots[0].char], ...CHARACTERS.filter((_, i) => i !== cfg.slots[0].char)]);
  let detailsOn = false;
  let shownId = '';
  /** The colour the render wears: the active slot's own pick if it holds this fighter, else the one you last wore. */
  const lookFor = (i: number): number => {
    const s = cfg.slots.find((o) => o.char === i);
    return s ? s.look ?? 0 : preferredLook(i);
  };
  const showPreview = (c: CharacterDef) => {
    const i = CHARACTERS.indexOf(c);
    const locked = !open(i, training);
    const by = locked ? unlockedBy(c.id) : undefined;
    const details = h('button', { type: 'button', class: 'details-toggle', 'aria-pressed': String(detailsOn), onclick: () => {
      detailsOn = !detailsOn;
      preview.classList.toggle('details', detailsOn);
      details.setAttribute('aria-pressed', String(detailsOn));
    } }, 'Details');
    preview.classList.toggle('details', detailsOn);
    preview.classList.toggle('is-locked', locked);
    preview.replaceChildren(
      renderCanvas,
      h('div', { class: 'lower-third' }, portrait(c), h('div', { class: 'lt-text' },
        h('p', { class: 'kicker' }, by ? `Locked · clear ${by.title} in the campaign` : locked ? 'Locked' : c.role),
        h('h3', {}, c.name),
        h('p', { class: 'blurb' }, locked ? 'Clear the campaign episode to put them on the card.' : c.blurb),
      )),
      specialsPanel(c),
      details,
      statBars(c),
    );
    if (shownId !== c.id) {
      shownId = c.id;
      render.show(c, lookFor(i), locked);
      window.dispatchEvent(new CustomEvent('dod:select-preview', { detail: { id: c.id, locked, at: performance.now() } }));
    } else {
      render.show(c, lookFor(i), locked);
    }
  };

  // A pick: the confirm pose, the fighter's own taunt (else an effort shout), then the announcer says the name.
  let nameTimer: ReturnType<typeof setTimeout> | null = null;
  const confirmPick = (c: CharacterDef) => {
    render.confirm();
    audio.stopCall();
    if (nameTimer) clearTimeout(nameTimer);
    const voiced = audio.fighterVoice(c.id, 'taunt') || audio.fighterVoice(c.id, 'effort');
    window.dispatchEvent(new CustomEvent('dod:select-confirm', { detail: { id: c.id, voiced, at: performance.now() } }));
    nameTimer = setTimeout(() => {
      nameTimer = null;
      if (currentScreen() === 'select') void audio.call(nameId(c));
    }, voiced ? 900 : 150);
  };

  // The announcer: "Choose your fighter!" as the select opens, then each name as the cursor lands on a fighter (nameCall.ts).
  // A focus that the screen opening gives the first tile isn't a landing: only once the player has moved something, or the
  // screen has been up a moment (the pad moves focus without a key).
  const openedAt = performance.now();
  let moved = false;
  const markMoved = () => { moved = true; };
  window.addEventListener('keydown', markMoved, { once: true });
  window.addEventListener('pointerdown', markMoved, { once: true });
  const nameId = (c: CharacterDef) => `announcer.name.${c.id}`;
  resetLanding();
  void audio.preloadLines(['announcer.choose']).then(() => {
    if (!moved) void audio.call('announcer.choose');
  });
  void audio.preloadLines(CHARACTERS.map(nameId));
  void audio.preloadLines(CHARACTERS.map((c) => `fighter.${c.id}.taunt`));
  const land = (c: CharacterDef, i: number, viaFocus = false) => {
    if (!open(i, training)) return;
    if (viaFocus && !moved && performance.now() - openedAt < 800) return;
    moved = true;
    landOn(nameId(c));
  };
  // A finger dragged across the grid lands on the tile under it (a touch pointer stays on the tile it pressed).
  const tileUnder = (e: PointerEvent): HTMLElement | null =>
    (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.tile[data-fighter]') ?? null;
  const follow = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    const t = tileUnder(e);
    const i = CHARACTERS.findIndex((c) => c.id === t?.dataset.fighter);
    if (i < 0) return;
    showPreview(CHARACTERS[i]);
    land(CHARACTERS[i], i);
  };
  grid.onpointermove = follow;
  grid.onpointerup = follow;

  const assign = (char: number, who: number = active) => {
    if (!open(char, training)) return;
    void prefetchFighters([char]);
    cfg.slots[who].char = char;
    // A person gets the colour they last wore with this fighter; a CPU starts on Classic. Same fighter twice: the second moves on.
    cfg.slots[who].look = cfg.slots[who].cpu === null ? preferredLook(char) : 0;
    fixLooks();
    showPreview(CHARACTERS[char]);
    confirmPick(CHARACTERS[char]);
    // After you pick, move on to the next CPU so a whole match can be set from the grid (a joined pad's pick leaves that alone).
    if (who === active && active < cfg.slots.length - 1) active++;
    renderSlots();
  };

  // ---- The joined pads' cursors ----
  function p1Over(t: HTMLElement): void {
    p1Tile = t;
    if (claims.size) markCursors();
  }
  /** The nearest tile in a direction from the cursor's, by where the tiles really are (CSS order puts Random first and the locked last). */
  function moveCursor(slot: number, dx: number, dy: number): void {
    const from = cursors.get(slot);
    if (!from) return;
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
      if (t === from) return;
      const r = t.getBoundingClientRect();
      const tx = r.left + r.width / 2 - ax;
      const ty = r.top + r.height / 2 - ay;
      const along = dx ? tx * dx : ty * dy;
      const across = Math.abs(dx ? ty : tx);
      if (along < Math.min(r.width, r.height) * 0.4 || across > along * 1.2 + r.height * 0.5) return;
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = t; }
    });
    if (!best) return;
    cursors.set(slot, best);
    const c = CHARACTERS.find((o) => o.id === (best as HTMLElement).dataset.fighter);
    (best as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (c) showPreview(c);
    audio.sfx('ui-move');
    window.dispatchEvent(new CustomEvent('dod:select-cursor', { detail: { slot, fighter: c?.id ?? 'random', at: performance.now() } }));
    markCursors();
  }
  function pickAt(slot: number): void {
    const t = cursors.get(slot);
    if (!t) return;
    const ok = CHARACTERS.map((_, i) => i).filter((i) => open(i, training));
    const i = t.dataset.fighter ? CHARACTERS.findIndex((c) => c.id === t.dataset.fighter) : ok[Math.floor(Math.random() * ok.length)];
    if (i < 0 || !open(i, training)) return;
    assign(i, slot);
    ready.add(slot);
    const c = CHARACTERS[i];
    // Random lands the cursor on the fighter it picked.
    const own = grid.querySelector<HTMLElement>(`.tile[data-fighter="${c.id}"]`);
    if (own) cursors.set(slot, own);
    window.dispatchEvent(new CustomEvent('dod:select-ready', { detail: { slot, ready: true, fighter: c.id, look: cfg.slots[slot].look ?? 0, at: performance.now() } }));
    renderSlots();
  }
  function nextLook(slot: number): void {
    const s = cfg.slots[slot];
    const n = lookCount(s.char);
    for (let k = 1; k <= n; k++) {
      const look = ((s.look ?? 0) + k) % n;
      if (may(slot, look)) {
        s.look = look;
        rememberLook(s.char, look);
        fixLooks();
        if (CHARACTERS[s.char].id === shownId) render.setLook(s.look ?? 0);
        audio.sfx('ui-select');
        window.dispatchEvent(new CustomEvent('dod:select-look', { detail: { slot, look: s.look, at: performance.now() } }));
        renderSlots();
        return;
      }
    }
  }
  /** The coloured, shaped tokens over the tiles: one per human with a cursor (player 1's is the menu focus). */
  function markCursors(): void {
    grid.querySelectorAll('.cursor-tokens').forEach((e) => e.remove());
    if (!claims.size || training) return;
    const place = (slot: number, tile: HTMLElement | null) => {
      if (!tile) return;
      let box = tile.querySelector<HTMLElement>('.cursor-tokens');
      if (!box) { box = h('span', { class: 'cursor-tokens' }); tile.append(box); }
      const color = cfg.teams ? TEAM_COLORS[cfg.slots[slot].team ?? 0] : PLAYER_COLORS[slot];
      box.append(h('span', { class: `cursor-token${ready.has(slot) ? ' ready' : ''}`, 'data-slot': String(slot), 'data-shape': shapeOf(slot), style: `--c:${color}` }, `${SHAPE_GLYPH[shapeOf(slot)]} P${slot + 1}`));
    };
    place(0, p1Tile ?? (grid.querySelector(`.tile[data-fighter="${CHARACTERS[cfg.slots[0].char].id}"]`) as HTMLElement | null));
    for (const [slot, tile] of cursors) if (padSlots().includes(slot)) place(slot, tile);
  }

  grid.replaceChildren(
    ...CHARACTERS.map((c, i) =>
      h(
        'button',
        {
          type: 'button',
          class: open(i, training) ? 'tile' : 'tile locked',
          title: open(i, training) ? c.name : `${c.name} (locked)`,
          'aria-disabled': open(i, training) ? undefined : 'true',
          'data-fighter': c.id,
          onclick: () => assign(i),
          onfocus: (e: Event) => { p1Over(e.currentTarget as HTMLElement); showPreview(c); land(c, i, true); if (open(i, training)) void prefetchFighters([i]); },
          onmouseenter: (e: Event) => { p1Over(e.currentTarget as HTMLElement); showPreview(c); land(c, i); },
          // A tap on a phone: the preview (and its clip) follows the finger, not only the fighter picked.
          onpointerdown: () => { showPreview(c); land(c, i); },
        },
        thumb(c),
        h('span', {}, open(i, training) ? c.name : 'Locked'),
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'tile random',
        title: 'Random',
        onclick: () => {
          const ok = CHARACTERS.map((_, i) => i).filter((i) => open(i, training));
          assign(ok[Math.floor(Math.random() * ok.length)]);
        },
      },
      h('b', {}, '?'),
      h('span', {}, 'Random'),
    ),
  );

  function renderSlots(): void {
    const back = slotFocus;
    promptShown = joinable();
    slotFocus = -1;
    slotsEl.replaceChildren(
      ...kids(...cfg.slots.map((s, i) => {
        const c = CHARACTERS[s.char];
        const color = cfg.teams ? TEAM_COLORS[s.team ?? 0] : PLAYER_COLORS[i];
        const isCpu = s.cpu !== null;
        const auto = isCpu && !training && s.auto !== false;
        const label = !isCpu ? (i === 0 && cfg.slots.every((o, k) => k === 0 || o.cpu !== null) ? 'You' : `Player ${i + 1}`) : s.cpu === 0 ? 'Dummy' : auto ? `CPU · Auto · Level ${autoLevel}` : `CPU · Level ${s.cpu}`;
        return h(
          'div',
          { class: `slot${i === active ? ' active' : ''}`, style: `--slot:${color}` },
          h(
            'button',
            { type: 'button', class: 'slot-pick', onclick: () => { active = i; renderSlots(); }, 'aria-pressed': i === active },
            thumb(c),
            h('span', { class: 'slot-label' }, label),
            h('strong', {}, c.name),
          ),
          swatchRow({
            char: s.char,
            picked: s.look ?? 0,
            slot: i,
            allOpen: isCpu,
            pick: (look) => {
              s.look = look;
              if (!isCpu) rememberLook(s.char, look);
              slotFocus = i;
              fixLooks();
              if (CHARACTERS[s.char].id === shownId) render.setLook(s.look ?? 0);
              renderSlots();
            },
          }),
          // Titles earned in Seasons 8 to 10: one is worn on your VS card (campaign/rewards.ts).
          !isCpu && !training && i === 0 && ownedOf('title').length
            ? h(
                'div',
                { class: 'title-pick', role: 'radiogroup', 'aria-label': 'Title' },
                ...[null, ...ownedOf('title')].map((t) =>
                  h('button', { type: 'button', class: 'title-chip', role: 'radio', 'aria-checked': String((pickedTitle()?.id ?? null) === (t?.id ?? null)), 'data-title': t?.id ?? 'none', onclick: () => { pickTitle(t?.id ?? null); slotFocus = i; renderSlots(); } }, t?.name ?? 'No title'),
                ),
              )
            : null,
          isCpu &&
            h(
              'div',
              { class: 'slot-tools' },
              !training && !touchUi() && i > 0 && h('button', { type: 'button', class: 'human-toggle', title: 'A second person plays this fighter on their own controller', onclick: () => { s.cpu = null; s.auto = undefined; s.look = preferredLook(s.char); fixLooks(); renderSlots(); } }, 'Person'),
              !training && h('button', { type: 'button', class: 'auto-level', 'aria-pressed': String(auto), title: 'Auto: the level follows how you do', onclick: () => { s.auto = !auto; if (s.auto === false) s.cpu = autoLevel; renderSlots(); } }, 'Auto'),
              h('button', { type: 'button', 'aria-label': 'Lower level', onclick: () => level(i, -1) }, '−'),
              h('button', { type: 'button', 'aria-label': 'Raise level', onclick: () => level(i, 1) }, '+'),
              cfg.teams && h('button', { type: 'button', onclick: () => toggleTeam(i) }, TEAM_NAMES[s.team ?? 0]),
              !training && cfg.slots.length > 2 && h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => remove(i) }, '×'),
            ),
          isCpu && !training && i > 0 && joinable() && h('p', { class: 'join-prompt', role: 'status' }, 'Press Start to join'),
          !isCpu && i > 0 && [...claims.values()].includes(i) && h('p', { class: 'join-prompt joined', 'data-ready': String(ready.has(i)) }, ready.has(i) ? 'Ready · B to change' : 'Pick a fighter · A', ),
          !isCpu && (cfg.teams || i > 0) &&
            h(
              'div',
              { class: 'slot-tools' },
              i > 0 && h('button', { type: 'button', class: 'human-toggle', 'aria-pressed': 'true', title: 'Back to a CPU', onclick: () => { s.cpu = autoLevel; s.auto = true; renderSlots(); } }, 'Person'),
              cfg.teams && h('button', { type: 'button', onclick: () => toggleTeam(i) }, TEAM_NAMES[s.team ?? 0]),
              !training && i > 0 && cfg.slots.length > 2 && h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => remove(i) }, '×'),
            ),
        );
      }),
      !training && cfg.slots.length < 4 && h('button', { type: 'button', class: 'slot add', onclick: addCpu }, '+ Add CPU'),
      (() => {
        const wait = waitingOn();
        return h('button', { type: 'button', class: 'primary fight', disabled: wait.length > 0, 'data-waiting': wait.map((i) => `P${i + 1}`).join(' '), onclick: () => { if (waitingOn().length) return; resetLanding(); fixLooks(); onDone(cfg); } },
          training ? 'Train' : wait.length ? `Waiting for ${wait.map((i) => `P${i + 1}`).join(' + ')}` : 'Fight');
      })(),
    ));
    markTiles();
    markCursors();
    // Keep the keyboard on the row it was using after a colour pick redraws the slots.
    if (back >= 0) slotsEl.querySelector<HTMLElement>(`.swatches[data-slot="${back}"] .swatch.on`)?.focus();
  }

  /** The grid's frames: the active slot's colour on hover, and each picked fighter's tile in its slot's colour. */
  function markTiles(): void {
    const colour = (i: number) => (cfg.teams ? TEAM_COLORS[cfg.slots[i].team ?? 0] : PLAYER_COLORS[i]);
    grid.style.setProperty('--slot', colour(Math.min(active, cfg.slots.length - 1)));
    grid.querySelectorAll<HTMLElement>('.tile[data-fighter]').forEach((t, i) => {
      const si = cfg.slots.findIndex((o) => o.char === i);
      t.classList.toggle('picked', si >= 0);
      if (si >= 0) t.style.setProperty('--pick', colour(si));
      else t.style.removeProperty('--pick');
    });
  }

  function level(i: number, d: number): void {
    const s = cfg.slots[i];
    const min = training ? 0 : 1;
    // A manual level always wins: moving it takes the slot off Auto, starting from the level Auto had.
    const from = !training && s.auto !== false ? autoLevel : s.cpu ?? 1;
    s.cpu = Math.max(min, Math.min(9, from + d));
    if (!training) s.auto = false;
    renderSlots();
  }

  function toggleTeam(i: number): void {
    cfg.slots[i].team = cfg.slots[i].team === 1 ? 0 : 1;
    renderSlots();
  }

  function remove(i: number): void {
    cfg.slots.splice(i, 1);
    active = Math.min(active, cfg.slots.length - 1);
    renderSlots();
  }

  function addCpu(): void {
    const used = new Set(cfg.slots.map((s) => s.char));
    const free = CHARACTERS.findIndex((_, i) => !used.has(i) && open(i, training));
    cfg.slots.push({ char: free < 0 ? 0 : free, cpu: cfg.slots[cfg.slots.length - 1]?.cpu || 5, team: cfg.slots.length % 2 });
    active = cfg.slots.length - 1;
    renderSlots();
  }

  function renderRules(): void {
    if (training) {
      rulesEl.replaceChildren(h('p', { class: 'hint' }, hintText('No stocks. Press {hitbox} in the match to see hitboxes.')));
      return;
    }
    const times = [0, 3, 5, 7];
    rulesEl.replaceChildren(
      h(
        'div',
        { class: 'rule' },
        h('span', {}, 'Stocks'),
        h('button', { type: 'button', 'aria-label': 'Fewer stocks', onclick: () => { cfg.stocks = Math.max(1, cfg.stocks - 1); renderRules(); } }, '−'),
        h('b', {}, String(cfg.stocks)),
        h('button', { type: 'button', 'aria-label': 'More stocks', onclick: () => { cfg.stocks = Math.min(9, cfg.stocks + 1); renderRules(); } }, '+'),
      ),
      h(
        'div',
        { class: 'rule' },
        h('span', {}, 'Time'),
        h(
          'button',
          { type: 'button', class: 'value', onclick: () => { cfg.time = times[(times.indexOf(cfg.time) + 1) % times.length]; renderRules(); } },
          cfg.time ? `${cfg.time}:00` : 'Off',
        ),
      ),
      h(
        'div',
        { class: 'rule' },
        h('span', {}, 'Teams'),
        h('button', { type: 'button', class: 'value', onclick: () => { cfg.teams = !cfg.teams; renderRules(); renderSlots(); } }, cfg.teams ? 'On' : 'Off'),
      ),
      h(
        'div',
        { class: 'rule', 'data-rule': 'hazards' },
        h('span', {}, 'Hazards'),
        h(
          'button',
          { type: 'button', class: 'value', 'aria-pressed': String(cfg.hazards !== false), onclick: () => { cfg.hazards = cfg.hazards === false; renderRules(); } },
          cfg.hazards === false ? 'Off' : 'On',
        ),
      ),
    );
  }

  showPreview(CHARACTERS[cfg.slots[0].char]);
  renderRules();
  renderSlots();
  // Menu focus starts on your current fighter's tile.
  (grid.children[cfg.slots[0].char] as HTMLElement | undefined)?.setAttribute('data-autofocus', '');
}
