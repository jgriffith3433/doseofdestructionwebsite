// Stage select, the VS splash, the end-of-match screen and the campaign map. Story scenes play in the
// arena (scene.ts).

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES, type StageDef } from '../sim/stage.ts';
import type { Match, MatchSetup } from '../match.ts';
import { CHAPTERS, SEASONS, isOpen, seasonCleared, seasonOpen, type Chapter } from '../campaign/story.ts';
import { DIFFICULTIES, DIFFICULTY_LABEL, DIFFICULTY_NOTE, difficulty, easyCleared, setDifficulty } from '../campaign/difficulty.ts';
import { PLAYER_COLORS, prefetchStage } from '../render/renderer.ts';
import { TEAM_COLORS } from './select.ts';
import { $, formatTime, h, kids, pct, portraitSize, portraitUrl, thumbUrl } from './dom.ts';
import type { ModeStage } from '../modes.ts';
import { audio } from '../audio.ts';
import { lookChip, paintImage } from './lookUi.ts';
import { currentWinQuote } from '../winQuote.ts';
import { quoteCaption } from './quoteCaption.ts';
import { victoryStage } from './victory.ts';
import { stagePreview } from './stagePreview.ts';
import { hintText } from './teach.ts';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ------------------------------------------------------------- stage select

/** A small side-on drawing of a stage, made from its real geometry. */
export function stageThumb(stage: StageDef): SVGElement {
  const w = 320;
  const hgt = 150;
  // Frame the platforms with some air around them, not the whole blast zone.
  const left = Math.min(...stage.platforms.map((p) => p.x1 - (p.motion?.ax ?? 0))) - 160;
  const right = Math.max(...stage.platforms.map((p) => p.x2 + (p.motion?.ax ?? 0))) + 160;
  const sx = w / (right - left);
  const x = (v: number) => (v - left) * sx;
  const y = (v: number) => hgt * 0.68 - v * sx;
  const root = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'stage-thumb', 'aria-hidden': 'true' });
  const grad = svg('radialGradient', { id: `sky-${stage.id}`, cx: '50%', cy: '75%', r: '75%' });
  grad.append(
    svg('stop', { offset: '0%', 'stop-color': stage.theme.sky[0] }),
    svg('stop', { offset: '100%', 'stop-color': stage.theme.sky[2] }),
  );
  const defs = svg('defs', {});
  defs.append(grad);
  root.append(defs, svg('rect', { width: w, height: hgt, fill: `url(#sky-${stage.id})` }));
  for (const p of stage.platforms) {
    if (p.solid) {
      const d = (p.depth ?? 90) * sx;
      root.append(svg('rect', { x: x(p.x1), y: y(p.y), width: (p.x2 - p.x1) * sx, height: d, fill: stage.theme.body }));
      root.append(svg('rect', { x: x(p.x1), y: y(p.y) - 1, width: (p.x2 - p.x1) * sx, height: 3, fill: stage.theme.edge }));
    } else {
      root.append(svg('rect', { x: x(p.x1), y: y(p.y) - 1, width: (p.x2 - p.x1) * sx, height: 3, rx: 1, fill: stage.theme.thinEdge }));
      if (p.motion) {
        // Show the range a moving platform travels.
        const cx = x((p.x1 + p.x2) / 2);
        const cy = y(p.y);
        root.append(
          svg('line', {
            x1: cx - p.motion.ax * sx, y1: cy + p.motion.ay * sx, x2: cx + p.motion.ax * sx, y2: cy - p.motion.ay * sx,
            stroke: stage.theme.thinEdge, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.6,
          }),
        );
      }
    }
  }
  return root;
}

/**
 * The stage select: the stages a mode offers (content/modes.json), in its order.
 * `onPrep(stage, immediate)` builds the Babylon stage + fighters while the player browses
 * (images via prefetchStage first), so startMatch's wipe into VS isn't blocked by showStage.
 * The focused card is prepped immediately; later focus/hover can debounce.
 */
export function openStages(
  list: { index: number; entry: ModeStage }[],
  onPick: (stage: number, entry: ModeStage, random?: boolean) => void,
  chosen: number,
  onPrep?: (stage: number, immediate?: boolean) => void,
): void {
  const grid = $('stage-grid');
  const focus = list.some((x) => x.index === chosen) ? chosen : list[0]?.index;
  const prep = (index: number, immediate?: boolean) => {
    prefetchStage(index);
    onPrep?.(index, immediate);
  };
  if (focus !== undefined) prep(focus, true);
  void audio.preloadLines(list.map(({ index }) => `announcer.stage.${STAGES[index].id}`));
  grid.replaceChildren(
    ...list.map(({ index, entry }) => {
      const st = STAGES[index];
      return h(
        'button',
        { type: 'button', class: 'stage-card', 'data-stage': st.id, 'data-autofocus': index === focus || undefined, onclick: () => onPick(index, entry), onfocus: () => prep(index), onpointerenter: () => prep(index) },
        h('div', { class: 'stage-shot' }, stageThumb(st), stagePreview(st)),
        h('strong', {}, entry.name || st.name),
        h('span', {}, entry.blurb || st.blurb),
      );
    }),
    h(
      'button',
      { type: 'button', class: 'stage-card random', onclick: () => { const x = list[Math.floor(Math.random() * list.length)]; if (x) onPick(x.index, x.entry, true); } },
      h('b', {}, '?'),
      h('strong', {}, 'Random'),
      h('span', {}, 'Let the broadcast decide.'),
    ),
  );
}

// ---------------------------------------------------------------- versus

/** Fills the VS splash. Resolves when it has played or the player skips it. */
/** A picture of a fighter in the colour it plays in. */
function paintedImg(url: string, char: number, look: number, cls = ''): HTMLImageElement {
  const img = h('img', { alt: '', class: cls || undefined }) as HTMLImageElement;
  paintImage(img, url, char, look);
  return img;
}

/** Gap between two announcer calls on the VS card, and the most the calls may take (so the card is never held past its cap). */
const VS_GAP_MS = 60;
const VS_CALLS_MAX_MS = 3300;

export function playVersus(setup: MatchSetup): Promise<void> {
  const body = $('versus-body');
  const teams = setup.slots.some((s) => s.team !== undefined) && new Set(setup.slots.map((s) => s.team)).size > 1;
  const sides = teams ? [setup.slots.filter((s) => s.team === 0), setup.slots.filter((s) => s.team !== 0)] : setup.slots.map((s) => [s]);
  const stage = STAGES[setup.stage];

  body.replaceChildren(...kids(
    h('p', { class: 'vs-title' }, setup.title ?? 'Tonight’s main event'),
    h(
      'div',
      { class: `vs-row n${sides.length}` },
      ...sides.flatMap((side, i) => {
        const group = h(
          'div',
          { class: `vs-side ${i % 2 ? 'from-right' : 'from-left'}`, style: `--d:${i * 120}ms` },
          ...side.map((s) => {
            const slot = setup.slots.indexOf(s);
            const color = teams ? TEAM_COLORS[s.team ?? 0] : PLAYER_COLORS[slot];
            const c = CHARACTERS[s.char];
            return h(
              'figure',
              { class: 'vs-fighter', 'data-fighter': c.id, 'data-look': String(s.look ?? 0), style: `--slot:${color}` },
              paintedImg(portraitUrl(c.id, portraitSize()), s.char, s.look ?? 0, 'vs-portrait'),
              h(
                'figcaption',
                { class: 'vs-card' },
                h('span', s.cpu ? { class: 'vs-level', 'data-level': String(s.cpu), 'data-auto': s.auto ? '1' : '0' } : {}, setup.online ? setup.online.names[slot] : s.cpu === null ? 'You' : s.cpu === 0 ? 'Dummy' : `CPU · Level ${s.cpu}${s.auto ? ' · Auto' : ''}`),
                h('strong', {}, c.name),
                lookChip(s.char, s.look ?? 0),
              ),
              s.scale && s.scale > 100 ? h('em', { class: 'vs-tag' }, 'Giant') : null,
            );
          }),
        );
        return i < sides.length - 1 ? [group, h('div', { class: 'vs-mark', style: `--d:${i * 120 + 260}ms` }, 'VS')] : [group];
      }),
    ),
    h('p', { class: 'vs-stage' }, stage.name, setup.subtitle ? h('span', {}, hintText(setup.subtitle)) : null),
  ));

  // The announcer's lines load first, so the slam and the calls play on time, in order (not
  // all at once when the downloads land). The splash clock starts when they're ready.
  const calls = sides.map((side) => side[0]).filter(Boolean);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;
  const schedule = async () => {
    // Each call starts when the one before has finished, by the clip's real length; one call at a time (audio.call).
    const ids = calls.map((s) => `announcer.name.${CHARACTERS[s.char].id}`);
    const lens = await Promise.all(ids.map((id) => audio.lineMs(id)));
    const versusMs = await audio.lineMs('announcer.versus');
    // "Versus!" between the names only while the whole exchange still fits the VS card's time (two long names skip it).
    const withVersus = ids.length > 1 && 250 + lens.reduce((a, b) => a + b + VS_GAP_MS, 0) + (ids.length - 1) * (versusMs + VS_GAP_MS) <= VS_CALLS_MAX_MS;
    let at = 250;
    const cues: [number, string][] = [];
    for (let i = 0; i < ids.length; i++) {
      cues.push([at, ids[i]]);
      at += lens[i] + VS_GAP_MS;
      if (withVersus && i < ids.length - 1) {
        cues.push([at, 'announcer.versus']);
        at += versusMs + VS_GAP_MS;
      }
    }
    if (cancelled) return;
    timers.push(
      setTimeout(() => audio.sfx('vs-slam'), 300),
      ...cues.map(([t, id]) => setTimeout(() => void audio.call(id), t)),
      setTimeout(finish, Math.min(VS_CALLS_MAX_MS + 400, Math.max(2600, at + 350))),
    );
    window.dispatchEvent(new CustomEvent('dod:vs-calls', { detail: { ids: cues.map(([, id]) => id), at: cues.map(([t]) => t), withVersus } }));
    // Let the slam land before a key can skip it.
    timers.push(setTimeout(() => {
      window.addEventListener('keydown', finish);
      body.addEventListener('click', finish);
    }, 500));
  };

  let done = false;
  let resolveSplash: () => void = () => {};
  function finish(): void {
    if (done) return;
    done = true;
    cancelled = true;
    timers.forEach(clearTimeout);
    window.removeEventListener('keydown', finish);
    body.removeEventListener('click', finish);
    // Skipped or finished: a call still playing (or waiting) is cut with the card.
    if (audio.callBusyMs() > 0) audio.stopCall();
    resolveSplash();
  }
  // The 3 s VS cap can leave for the match before the splash clock ends: tear down listeners then.
  const versus = document.getElementById('versus');
  const stopIfLeft = () => {
    if (versus?.hidden || !body.isConnected) finish();
  };
  const leftWatch = versus ? new MutationObserver(stopIfLeft) : null;
  leftWatch?.observe(versus!, { attributes: true, attributeFilter: ['hidden'] });
  const splash = new Promise<void>((resolve) => {
    resolveSplash = () => { leftWatch?.disconnect(); resolve(); };
  });
  void audio.preloadLines([...calls.map((s) => `announcer.name.${CHARACTERS[s.char].id}`), 'announcer.versus']).then(schedule);
  return splash;
}

// --------------------------------------------------------------- results

interface Award {
  title: string;
  who: number;
  detail: string;
}

function awards(m: Match): Award[] {
  const st = m.stats;
  const n = st.length;
  const all: (Award & { score: number })[] = [];
  const best = (score: (i: number) => number, min: number, title: string, detail: (i: number) => string) => {
    let top = -1;
    for (let i = 0; i < n; i++) if (score(i) >= min && (top < 0 || score(i) > score(top))) top = i;
    if (top >= 0) all.push({ title, who: top, detail: detail(top), score: score(top) });
  };
  best((i) => st[i].kos, 2, 'Closer', (i) => `${st[i].kos} KOs`);
  best((i) => st[i].biggestHit, 120, 'Heavy Hitter', (i) => `${pct(st[i].biggestHit)} in one hit`);
  best((i) => st[i].longestCombo, 3, 'Combo Artist', (i) => `${st[i].longestCombo}-hit combo`);
  best((i) => st[i].hitsShielded, 4, 'Iron Wall', (i) => `${st[i].hitsShielded} hits shielded`);
  best((i) => st[i].ledgeGrabs, 4, 'Edge Dweller', (i) => `${st[i].ledgeGrabs} ledge grabs`);
  best((i) => st[i].airtime / Math.max(1, m.state.frame), 0.45, 'Never Lands', (i) => `${Math.round((st[i].airtime / Math.max(1, m.state.frame)) * 100)}% in the air`);
  best((i) => st[i].selfDestructs, 1, 'Gravity Won', (i) => `${st[i].selfDestructs} self-destruct${st[i].selfDestructs > 1 ? 's' : ''}`);
  // Only when a survivor took well under half of what everyone else averaged.
  const avgTaken = st.reduce((n, x) => n + x.taken, 0) / Math.max(1, n);
  best(
    (i) => (m.state.fighters[i].stocks > 0 && st[i].taken < avgTaken * 0.45 ? 1e6 - st[i].taken : -1),
    0,
    'Untouchable',
    (i) => `took only ${pct(st[i].taken)}`,
  );
  // Prefer spreading awards across players.
  const out: Award[] = [];
  const used = new Set<number>();
  for (const a of all) if (!used.has(a.who) && out.length < 4) { out.push(a); used.add(a.who); }
  for (const a of all) if (out.length < 4 && !out.includes(a)) out.push(a);
  return out;
}

function chart(m: Match, colors: string[]): SVGElement {
  const w = 640;
  const hgt = 200;
  const pad = { l: 34, r: 10, t: 12, b: 24 };
  const frames = Math.max(60, m.state.frame);
  const top = Math.max(1500, ...m.timeline.flatMap((p) => p.percent)) * 1.08;
  const x = (f: number) => pad.l + (f / frames) * (w - pad.l - pad.r);
  const y = (p: number) => hgt - pad.b - (p / top) * (hgt - pad.t - pad.b);
  const root = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'chart', role: 'img', 'aria-label': 'Damage over the match for each fighter, with KOs marked.' });
  for (let p = 0; p <= top; p += 500) {
    root.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(p), y2: y(p), class: 'grid' }));
    const t = svg('text', { x: pad.l - 6, y: y(p) + 4, class: 'axis', 'text-anchor': 'end' });
    t.textContent = `${p / 10}%`;
    root.append(t);
  }
  const step = frames > 60 * 150 ? 3600 : frames > 60 * 50 ? 1800 : 600;
  for (let f = 0; f <= frames; f += step) {
    const t = svg('text', { x: x(f), y: hgt - 6, class: 'axis', 'text-anchor': 'middle' });
    t.textContent = formatTime(f);
    root.append(t);
  }
  m.state.fighters.forEach((_, i) => {
    const d = m.timeline.map((p, k) => `${k ? 'L' : 'M'}${x(p.frame).toFixed(1)},${y(p.percent[i]).toFixed(1)}`).join('');
    root.append(svg('path', { d, fill: 'none', stroke: colors[i], 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
  });
  for (const k of m.kos) {
    const cx = x(k.frame);
    const cy = y(k.percent);
    root.append(svg('circle', { cx, cy, r: 6, fill: '#100e0c', stroke: colors[k.victim], 'stroke-width': 2 }));
    root.append(svg('path', { d: `M${cx - 3},${cy - 3}L${cx + 3},${cy + 3}M${cx + 3},${cy - 3}L${cx - 3},${cy + 3}`, stroke: colors[k.victim], 'stroke-width': 2 }));
  }
  return root;
}

/** The 'ko' objective's results line: which way it ended. */
function koLine(m: Match, won: boolean): string {
  const n = m.koTarget;
  const got = Math.min(m.koCount(), n);
  if (won && got >= n) return `${n} KOs before the clock. That's the highlight reel.`;
  if (won) return 'Nobody left to knock out. The network will take it.';
  if (m.state.timedOut) return `Time ran out at ${got} of ${n} KOs. No highlights tonight.`;
  return `Out of stocks at ${got} of ${n} KOs. They cut to commercial.`;
}

/** The 'quota' objective's results line: which way it ended. */
function quotaLine(m: Match, won: boolean): string {
  const need = m.quotaTarget / 10;
  const got = Math.floor(Math.min(m.quotaDealt(), m.quotaTarget) / 10);
  if (won && got >= need) return `${need}% delivered before the clock. The sponsor is thrilled.`;
  if (won) return 'Nobody left to hit. The sponsor will take it.';
  if (m.state.timedOut) return `Time ran out at ${got} of ${need}%. The sponsor wants a refund.`;
  return `Out of stocks at ${got} of ${need}%. The sponsor pulled the ad.`;
}

/** The 'streak' objective's results line: which way it ended. */
function streakLine(m: Match, won: boolean): string {
  const need = m.streakTarget;
  const got = Math.min(m.streakBest(), need);
  if (won && got >= need) return `${need} clean hits in a row before the clock. That one goes in the supercut.`;
  if (won) return 'Nobody left to hit. The editor will make do.';
  if (m.state.timedOut) return `Time ran out at a best streak of ${got} of ${need}. Nothing for the supercut.`;
  return `Out of stocks at a best streak of ${got} of ${need}. The editor cut around you.`;
}

export interface ResultAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

/** `online`: an online match's ending, which can come before the sim's (a forfeit, a lost link, a desync). */
export function showResults(m: Match, actions: ResultAction[], online?: { headline: string; note?: string; winner?: number }, unlocked: string[] = [], levelChange?: { from: number; to: number; text: string }): void {
  const s = m.state;
  const teams = m.setup.slots.some((x) => x.team !== undefined) && new Set(m.setup.slots.map((x) => x.team)).size > 1;
  const colors = s.fighters.map((f, i) => (teams && m.setup.mode !== 'campaign' ? TEAM_COLORS[f.team < 0 ? 0 : f.team] : PLAYER_COLORS[i]));
  const order = [...s.fighters].sort((a, b) => {
    const aw = s.winnerTeam >= 0 ? a.team === s.winnerTeam : a.id === s.winner;
    const bw = s.winnerTeam >= 0 ? b.team === s.winnerTeam : b.id === s.winner;
    return Number(bw) - Number(aw) || b.stocks - a.stocks || m.stats[b.id].kos - m.stats[a.id].kos || a.percent - b.percent;
  });
  const look = (i: number) => m.setup.slots[i]?.look ?? 0;
  const winner = s.fighters[s.winner];
  const campaign = m.setup.mode === 'campaign';
  const won = m.playerWon();
  let headline = winner ? `${m.label(winner.id).split(' · ')[1]} wins` : 'No contest';
  if (campaign) headline = won ? 'Cleared' : 'Knocked out';
  else if (s.winnerTeam >= 0) headline = `${s.winnerTeam === 0 ? 'Red' : 'Blue'} team wins`;
  if (online) headline = online.headline;

  const hero = (online?.winner !== undefined ? s.fighters[online.winner] : undefined) ?? winner ?? s.fighters[0];
  // The winner's quote (winQuote.ts), when this screen is for a finished match with a winner.
  const quote = currentWinQuote()?.winner === CHARACTERS[hero.char].id ? currentWinQuote() : null;
  // The summary strip: who won, how long it ran, how much damage the winner (or winning team) dealt.
  const side = s.winnerTeam >= 0 && !campaign ? s.fighters.filter((f) => f.team === s.winnerTeam) : [hero];
  const dealt = side.reduce((n, f) => n + m.stats[f.id].dealt, 0);
  const heroKos = side.reduce((n, f) => n + m.stats[f.id].kos, 0);
  const winnerName = !winner && !online ? 'No contest' : s.winnerTeam >= 0 && !campaign ? `${s.winnerTeam === 0 ? 'Red' : 'Blue'} team` : m.label(hero.id).split(' · ')[1] ?? CHARACTERS[hero.char].name;
  const stat = (key: string, label: string, value: string, slot?: string) =>
    h('div', { class: 'stat', 'data-stat': key, style: slot ? `--slot:${slot}` : undefined }, h('span', {}, label), h('strong', {}, value));
  const panel = h(
    'div',
    { class: 'results-panel' },
    h(
      'header',
      { class: 'results-hero', style: `--slot:${colors[hero.id]}` },
      paintedImg(portraitUrl(CHARACTERS[hero.char].id, portraitSize()), hero.char, look(hero.id), 'results-portrait'),
      h(
        'div',
        {},
        h('p', { class: 'kicker' }, s.timedOut ? 'Time' : 'Game', ' · ', formatTime(s.frame)),
        h('h2', {}, headline),
        h('p', { class: 'results-look' }, lookChip(hero.char, look(hero.id)), unlocked.length ? h('em', { class: 'look-new' }, `New colour: ${unlocked.join(', ')}`) : null),
        campaign && m.setup.objective === 'survive' && h('p', {}, won ? 'You lasted the whole minute.' : 'They took you off the air.'),
        m.setup.objective === 'ko' && h('p', { class: 'results-objective' }, koLine(m, won)),
        m.setup.objective === 'quota' && h('p', { class: 'results-objective' }, quotaLine(m, won)),
        m.setup.objective === 'streak' && h('p', { class: 'results-objective' }, streakLine(m, won)),
        online?.note && h('p', { class: 'results-note' }, online.note),
        levelChange && h('p', { class: 'results-note level-note', 'data-from': String(levelChange.from), 'data-to': String(levelChange.to) }, levelChange.text),
      ),
    ),
    h(
      'div',
      { class: 'results-strip', 'aria-label': 'Match summary' },
      stat('winner', 'Winner', winnerName, colors[hero.id]),
      stat('time', s.timedOut ? 'Time (clock ran out)' : 'Time', formatTime(s.frame)),
      stat('damage', 'Damage dealt', pct(dealt)),
      stat('kos', 'KOs', String(heroKos)),
    ),
    h(
      'section',
      { class: 'highlights', 'aria-label': 'Highlights' },
      h('h3', {}, 'Highlights'),
      m.kos.length
        ? h(
            'ol',
            { class: 'reel' },
            ...m.kos.slice(0, 6).map((k, i) =>
              h(
                'li',
                { style: `--slot:${colors[k.by >= 0 ? k.by : k.victim]}`, class: 'reel-item', 'data-ko': String(i + 1) },
                h('b', {}, formatTime(k.frame)),
                h('span', {}, k.by >= 0 ? `${CHARACTERS[s.fighters[k.by].char].name} KOs ${CHARACTERS[s.fighters[k.victim].char].name}` : `${CHARACTERS[s.fighters[k.victim].char].name} falls`),
                h('em', {}, `at ${pct(k.percent)}`),
              ),
            ),
          )
        : h('p', { class: 'results-note' }, 'No knockouts tonight. The cameras found nothing to replay.'),
    ),
    h(
      'div',
      { class: 'results-grid' },
      h(
        'section',
        { class: 'standings' },
        h('h3', {}, 'Standings'),
        ...order.map((f, rank) => {
          const st = m.stats[f.id];
          return h(
            'article',
            { class: 'standing', style: `--slot:${colors[f.id]}` },
            h('b', { class: 'rank' }, String(rank + 1)),
            h('img', { src: thumbUrl(CHARACTERS[f.char].id), alt: '' }),
            h('div', { class: 'who' }, h('strong', {}, m.label(f.id)), lookChip(f.char, look(f.id)), h('span', {}, f.stocks > 0 && f.stocks < 90 ? `${f.stocks} stock${f.stocks > 1 ? 's' : ''} left` : f.stocks >= 90 ? 'Training' : 'Out')),
            h(
              'dl',
              {},
              h('div', {}, h('dt', {}, 'KOs'), h('dd', {}, String(st.kos))),
              h('div', {}, h('dt', {}, 'Falls'), h('dd', {}, String(st.falls))),
              h('div', {}, h('dt', {}, 'Dealt'), h('dd', {}, pct(st.dealt))),
              h('div', {}, h('dt', {}, 'Taken'), h('dd', {}, pct(st.taken))),
              h('div', {}, h('dt', {}, 'Best hit'), h('dd', {}, pct(st.biggestHit))),
              h('div', {}, h('dt', {}, 'Combo'), h('dd', {}, String(st.longestCombo))),
            ),
          );
        }),
      ),
      h(
        'section',
        { class: 'story' },
        h('h3', {}, 'How it went'),
        chart(m, colors),
        h(
          'ul',
          { class: 'legend' },
          ...s.fighters.map((f, i) => h('li', { style: `--slot:${colors[i]}` }, CHARACTERS[f.char].name)),
        ),
        h(
          'ul',
          { class: 'awards' },
          ...awards(m).map((a) =>
            h('li', { style: `--slot:${colors[a.who]}` }, h('strong', {}, a.title), h('span', {}, CHARACTERS[s.fighters[a.who].char].name), h('em', {}, a.detail)),
          ),
        ),
      ),
    ),
  );
  // The victory stage (ui/victory.ts) opens first, with the winner on the podium and the beaten fighter in an inset; the panel
  // slides in after it (or on any input). A match with no winner has no stage.
  const loser = order.find((f) => !side.some((w) => w.id === f.id));
  const stage =
    winner || online?.winner !== undefined
      ? victoryStage({
          winnerChar: hero.char,
          winnerLook: look(hero.id),
          winnerColor: colors[hero.id],
          winnerName,
          loserChar: loser?.char,
          loserLook: loser ? look(loser.id) : 0,
          loserName: loser ? CHARACTERS[loser.char].name : undefined,
          caption: quote ? quoteCaption(quote) : null,
        })
      : null;
  const row = h('div', { class: `results-row${stage ? '' : ' no-stage'}`, 'data-phase': stage ? 'pose' : 'panel' }, stage?.el, panel);
  $('results-body').replaceChildren(row);
  stage?.start(row);
  setResultActions(actions);
}

/** The results' buttons (an online result swaps them as the rematch moves on). `disabled` actions are shown but dead. */
export function setResultActions(actions: (ResultAction & { disabled?: boolean })[]): void {
  $('results-actions').replaceChildren(
    ...actions.map((a, i) =>
      h('button', { type: 'button', class: a.primary ? 'primary' : 'secondary', 'data-autofocus': i === 0 || undefined, disabled: a.disabled, onclick: a.run }, a.label),
    ),
  );
}

// -------------------------------------------------------------- campaign

/** The season map's Easy / Normal / Hard choice (campaign/difficulty.ts): three thumb-size radio buttons, saved on a tap. */
function renderDifficulty(): void {
  const box = document.getElementById('difficulty');
  if (!box) return;
  const draw = () => {
    const now = difficulty();
    box.replaceChildren(
      h('span', { class: 'difficulty-label', id: 'difficulty-label' }, 'Difficulty'),
      h(
        'div',
        { class: 'difficulty-pick', role: 'radiogroup', 'aria-labelledby': 'difficulty-label' },
        ...DIFFICULTIES.map((d) =>
          h('button', {
            type: 'button',
            class: `difficulty-btn${d === now ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': String(d === now),
            'data-difficulty': d,
            onclick: () => {
              setDifficulty(d);
              window.dispatchEvent(new CustomEvent('dod:difficulty', { detail: { phase: 'pick', difficulty: d } }));
              draw();
              document.querySelector<HTMLElement>(`#difficulty [data-difficulty="${d}"]`)?.focus();
            },
          }, DIFFICULTY_LABEL[d]),
        ),
      ),
      h('span', { class: 'difficulty-note', id: 'difficulty-note' }, DIFFICULTY_NOTE[now]),
    );
  };
  draw();
}

export function openCampaign(done: Set<string>, onPlay: (chapter: Chapter) => void, onReset: () => void, unlocked?: string): void {
  const path = $('chapter-path');
  renderDifficulty();
  const easy = easyCleared();
  const nextIndex = CHAPTERS.findIndex((c) => !done.has(c.id));
  const focus = CHAPTERS[nextIndex < 0 ? CHAPTERS.length - 1 : nextIndex];
  const chapter = (c: Chapter, n: number) => {
    const i = CHAPTERS.indexOf(c);
    const open = isOpen(i, done);
    const cleared = done.has(c.id);
    const status = cleared ? 'Cleared' : open ? 'Next' : 'Locked';
    const foe = c.fight.slots.find((s) => s.cpu !== null && s.team !== 0) ?? c.fight.slots[1];
    // The first chapter of a locked season waits on the season before, not on a chapter.
    const why = n === 0 && c.season > 1 ? `Clear Season ${c.season - 1} to open it.` : 'Clear the chapter before it.';
    return h(
      'button',
      {
        type: 'button',
        class: `chapter ${cleared ? 'cleared' : open ? 'open' : 'locked'}`,
        'data-chapter': c.id,
        disabled: !open,
        'data-autofocus': c === focus || undefined,
        onclick: () => onPlay(c),
      },
      h('span', { class: 'chapter-no' }, String(n + 1).padStart(2, '0')),
      h('img', { src: thumbUrl(CHARACTERS[foe.char].id), alt: '' }),
      h('strong', {}, open ? c.title : '???'),
      h('span', { class: 'chapter-tag' }, open ? c.tagline : why),
      h('em', { class: 'chapter-status' }, status, open ? ` · ${STAGES[c.fight.stage].name}` : ''),
      cleared && easy.has(c.id) ? h('span', { class: 'easy-badge', 'data-difficulty': 'easy' }, 'Easy') : null,
    );
  };
  const fresh = unlocked ? CHARACTERS.find((c) => c.id === unlocked) : undefined;
  path.replaceChildren(...kids(
    fresh
      ? h(
          'p',
          { class: 'unlock-note', role: 'status', 'data-unlocked': fresh.id },
          h('img', { src: thumbUrl(fresh.id), alt: '' }),
          h('span', {}, h('b', {}, `${fresh.name} joins the card.`), ' Unlocked for Versus and online.'),
        )
      : null,
    ...SEASONS.map((s) => {
      const open = seasonOpen(s.number, done);
      const cleared = seasonCleared(s.number, done);
      return h(
        'section',
        { class: `season ${cleared ? 'cleared' : open ? 'open' : 'locked'}`, 'data-season': s.number },
        h(
          'header',
          { class: 'season-head' },
          h('h3', {}, `Season ${s.number}`),
          s.subtitle ? h('span', { class: 'season-sub' }, open ? s.subtitle : '???') : null,
          open ? null : h('em', { class: 'season-lock' }, `Locked · Clear Season ${s.number - 1} first`),
        ),
        h('div', { class: 'season-chapters' }, ...s.chapters.map(chapter)),
        cleared ? h('p', { class: 'season-end' }, s.end) : null,
      );
    }),
  ));
  const reset = $<HTMLButtonElement>('btn-campaign-reset');
  reset.onclick = () => {
    if (confirm('Start the campaign over? Cleared chapters will be locked again.')) onReset();
  };
  reset.disabled = done.size === 0;
}
