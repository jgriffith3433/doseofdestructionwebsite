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
import { landOn, resetLanding } from './nameCall.ts';
import { currentScreen } from './screens.ts';
import { lookCount, lookOpen, openLook, preferredLook, rememberLook, separateLooks } from '../looks.ts';

export interface VersusConfig {
  slots: SlotSetup[];
  stocks: number;
  /** Minutes, 0 for none. */
  time: number;
  teams: boolean;
}

export const TEAM_COLORS = ['#ff5a1f', '#3fa7ff'];
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
  fixLooks();

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

  const assign = (char: number) => {
    if (!open(char, training)) return;
    void prefetchFighters([char]);
    cfg.slots[active].char = char;
    // A person gets the colour they last wore with this fighter; a CPU starts on Classic. Same fighter twice: the second moves on.
    cfg.slots[active].look = cfg.slots[active].cpu === null ? preferredLook(char) : 0;
    fixLooks();
    showPreview(CHARACTERS[char]);
    confirmPick(CHARACTERS[char]);
    // After you pick, move on to the next CPU so a whole match can be set from the grid.
    if (active < cfg.slots.length - 1) active++;
    renderSlots();
  };

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
          onfocus: () => { showPreview(c); land(c, i, true); if (open(i, training)) void prefetchFighters([i]); },
          onmouseenter: () => { showPreview(c); land(c, i); },
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
    slotFocus = -1;
    slotsEl.replaceChildren(
      ...kids(...cfg.slots.map((s, i) => {
        const c = CHARACTERS[s.char];
        const color = cfg.teams ? TEAM_COLORS[s.team ?? 0] : PLAYER_COLORS[i];
        const isCpu = s.cpu !== null;
        const label = !isCpu ? 'You' : s.cpu === 0 ? 'Dummy' : `CPU · Level ${s.cpu}`;
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
          isCpu &&
            h(
              'div',
              { class: 'slot-tools' },
              h('button', { type: 'button', 'aria-label': 'Lower level', onclick: () => level(i, -1) }, '−'),
              h('button', { type: 'button', 'aria-label': 'Raise level', onclick: () => level(i, 1) }, '+'),
              cfg.teams && h('button', { type: 'button', onclick: () => toggleTeam(i) }, TEAM_NAMES[s.team ?? 0]),
              !training && cfg.slots.length > 2 && h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => remove(i) }, '×'),
            ),
          !isCpu && cfg.teams && h('div', { class: 'slot-tools' }, h('button', { type: 'button', onclick: () => toggleTeam(i) }, TEAM_NAMES[s.team ?? 0])),
        );
      }),
      !training && cfg.slots.length < 4 && h('button', { type: 'button', class: 'slot add', onclick: addCpu }, '+ Add CPU'),
      h('button', { type: 'button', class: 'primary fight', onclick: () => { resetLanding(); fixLooks(); onDone(cfg); } }, training ? 'Train' : 'Fight'),
    ));
    markTiles();
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
    s.cpu = Math.max(min, Math.min(9, (s.cpu ?? 1) + d));
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
      rulesEl.replaceChildren(h('p', { class: 'hint' }, 'No stocks. Press H in the match to see hitboxes.'));
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
    );
  }

  showPreview(CHARACTERS[cfg.slots[0].char]);
  renderRules();
  renderSlots();
  // Menu focus starts on your current fighter's tile.
  (grid.children[cfg.slots[0].char] as HTMLElement | undefined)?.setAttribute('data-autofocus', '');
}
