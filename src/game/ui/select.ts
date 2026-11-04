// Character select: a grid of every fighter, a large preview with stat bars,
// and a row of slots for you and up to three CPUs.

import { CHARACTERS, type CharacterDef } from '../sim/characters.ts';
import type { SlotSetup } from '../match.ts';
import { PLAYER_COLORS } from '../render/renderer.ts';
import { CHAPTERS, isUnlocked } from '../campaign/story.ts';
import { $, h, kids, largeUrl, thumbUrl } from './dom.ts';

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
      img = h('img', { src: largeUrl(c.id), alt: '' }) as HTMLImageElement;
      img.decoding = 'async';
      img.onerror = () => {
        img!.onerror = null;
        img!.src = thumbUrl(c.id);
      };
      portraits.set(c.id, img);
    }
    return img;
  };
  CHARACTERS.forEach(portrait);

  // Roster and slot thumbnails: one kept, preloaded <img> per fighter (cloned into tiles and slots),
  // so the grid never shows empty boxes. A tile stays a dark silhouette placeholder until its image
  // has loaded (`.loaded`), and falls back to the large portrait if the thumbnail fails.
  const thumbs = new Map<string, HTMLImageElement>();
  const thumb = (c: CharacterDef): HTMLImageElement => {
    let src = thumbs.get(c.id);
    if (!src) {
      src = new Image();
      src.decoding = 'async';
      src.onerror = () => {
        src!.onerror = null;
        src!.src = largeUrl(c.id);
      };
      src.src = thumbUrl(c.id);
      thumbs.set(c.id, src);
    }
    const img = h('img', { alt: '', draggable: 'false' }) as HTMLImageElement;
    const mark = () => img.classList.add('loaded');
    img.onerror = () => {
      img.onerror = null;
      img.src = largeUrl(c.id);
    };
    img.onload = mark;
    img.src = src.currentSrc || src.src;
    if (img.complete && img.naturalWidth > 0) mark();
    return img;
  };
  CHARACTERS.forEach(thumb);

  const showPreview = (c: CharacterDef) => {
    const by = !open(CHARACTERS.indexOf(c), training) ? unlockedBy(c.id) : undefined;
    preview.replaceChildren(
      portrait(c),
      h('p', { class: 'kicker' }, by ? `Locked · clear ${by.title} in the campaign` : c.role),
      h('h3', {}, c.name),
      h('p', { class: 'blurb' }, c.blurb),
      statBars(c),
    );
  };

  const assign = (char: number) => {
    if (!open(char, training)) return;
    cfg.slots[active].char = char;
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
          onfocus: () => showPreview(c),
          onmouseenter: () => showPreview(c),
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
      h('button', { type: 'button', class: 'primary fight', onclick: () => onDone(cfg) }, training ? 'Train' : 'Fight'),
    ));
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
