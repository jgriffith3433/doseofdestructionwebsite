// Stage select, the VS splash, the end-of-match screen, the campaign map and
// dialogue scenes.

import { CHARACTERS } from '../sim/characters.ts';
import { STAGES, type StageDef } from '../sim/stage.ts';
import type { Match, MatchSetup } from '../match.ts';
import { CHAPTERS, isOpen, type Chapter, type Line } from '../campaign/story.ts';
import { PLAYER_COLORS } from '../render/renderer.ts';
import { TEAM_COLORS } from './select.ts';
import { $, formatTime, h, kids, largeUrl, pct, thumbUrl } from './dom.ts';
import type { ModeStage } from '../modes.ts';
import { audio } from '../audio.ts';

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

/** The stage select: the stages a mode offers (content/modes.json), in its order. */
export function openStages(list: { index: number; entry: ModeStage }[], onPick: (stage: number, entry: ModeStage) => void, chosen: number): void {
  const grid = $('stage-grid');
  const focus = list.some((x) => x.index === chosen) ? chosen : list[0]?.index;
  grid.replaceChildren(
    ...list.map(({ index, entry }) => {
      const st = STAGES[index];
      return h(
        'button',
        { type: 'button', class: 'stage-card', 'data-autofocus': index === focus || undefined, onclick: () => onPick(index, entry) },
        stageThumb(st),
        h('strong', {}, entry.name || st.name),
        h('span', {}, entry.blurb || st.blurb),
      );
    }),
    h(
      'button',
      { type: 'button', class: 'stage-card random', onclick: () => { const x = list[Math.floor(Math.random() * list.length)]; if (x) onPick(x.index, x.entry); } },
      h('b', {}, '?'),
      h('strong', {}, 'Random'),
      h('span', {}, 'Let the broadcast decide.'),
    ),
  );
}

// ---------------------------------------------------------------- versus

/** Fills the VS splash. Resolves when it has played or the player skips it. */
export function playVersus(setup: MatchSetup): Promise<void> {
  const body = $('versus-body');
  const teams = setup.slots.some((s) => s.team !== undefined) && new Set(setup.slots.map((s) => s.team)).size > 1;
  const sides = teams ? [setup.slots.filter((s) => s.team === 0), setup.slots.filter((s) => s.team !== 0)] : setup.slots.map((s) => [s]);
  const stage = STAGES[setup.stage];

  body.replaceChildren(...kids(
    setup.title ? h('p', { class: 'vs-title' }, setup.title) : null,
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
              { class: 'vs-fighter', style: `--slot:${color}` },
              h('img', { src: largeUrl(c.id), alt: '' }),
              h('figcaption', {}, h('span', {}, s.cpu === null ? 'You' : s.cpu === 0 ? 'Dummy' : `CPU ${s.cpu}`), h('strong', {}, c.name)),
              s.scale && s.scale > 100 ? h('em', { class: 'vs-tag' }, 'Giant') : null,
            );
          }),
        );
        return i < sides.length - 1 ? [group, h('div', { class: 'vs-mark', style: `--d:${i * 120 + 260}ms` }, 'VS')] : [group];
      }),
    ),
    h('p', { class: 'vs-stage' }, stage.name, setup.subtitle ? h('span', {}, setup.subtitle) : null),
  ));

  // The slam lands with the VS mark, then the announcer calls each side.
  const calls = sides.map((side) => side[0]).filter(Boolean);
  const timers = [
    setTimeout(() => audio.sfx('vs-slam'), 300),
    ...calls.map((s, i) => setTimeout(() => {
      audio.line(`announcer.name.${CHARACTERS[s.char].id}`);
      if (i < calls.length - 1) setTimeout(() => audio.line('announcer.versus'), 650);
    }, 520 + i * 1300)),
  ];

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', finish);
      body.removeEventListener('click', finish);
      resolve();
    };
    // Let the slam land before a key can skip it.
    setTimeout(() => {
      window.addEventListener('keydown', finish);
      body.addEventListener('click', finish);
    }, 500);
    setTimeout(finish, setup.subtitle ? 3600 : 2600);
  });
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

export interface ResultAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export function showResults(m: Match, actions: ResultAction[]): void {
  const s = m.state;
  const teams = m.setup.slots.some((x) => x.team !== undefined) && new Set(m.setup.slots.map((x) => x.team)).size > 1;
  const colors = s.fighters.map((f, i) => (teams && m.setup.mode !== 'campaign' ? TEAM_COLORS[f.team < 0 ? 0 : f.team] : PLAYER_COLORS[i]));
  const order = [...s.fighters].sort((a, b) => {
    const aw = s.winnerTeam >= 0 ? a.team === s.winnerTeam : a.id === s.winner;
    const bw = s.winnerTeam >= 0 ? b.team === s.winnerTeam : b.id === s.winner;
    return Number(bw) - Number(aw) || b.stocks - a.stocks || m.stats[b.id].kos - m.stats[a.id].kos || a.percent - b.percent;
  });
  const winner = s.fighters[s.winner];
  const campaign = m.setup.mode === 'campaign';
  const won = m.playerWon();
  let headline = winner ? `${m.label(winner.id).split(' · ')[1]} wins` : 'No contest';
  if (campaign) headline = won ? 'Cleared' : 'Knocked out';
  else if (s.winnerTeam >= 0) headline = `${s.winnerTeam === 0 ? 'Red' : 'Blue'} team wins`;

  const hero = winner ?? s.fighters[0];
  $('results-body').replaceChildren(
    h(
      'header',
      { class: 'results-hero', style: `--slot:${colors[hero.id]}` },
      h('img', { src: largeUrl(CHARACTERS[hero.char].id), alt: '' }),
      h(
        'div',
        {},
        h('p', { class: 'kicker' }, s.timedOut ? 'Time' : 'Game', ' · ', formatTime(s.frame)),
        h('h2', {}, headline),
        campaign && m.setup.objective === 'survive' && h('p', {}, won ? 'You lasted the whole minute.' : 'They took you off the air.'),
      ),
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
            h('div', { class: 'who' }, h('strong', {}, m.label(f.id)), h('span', {}, f.stocks > 0 && f.stocks < 90 ? `${f.stocks} stock${f.stocks > 1 ? 's' : ''} left` : f.stocks >= 90 ? 'Training' : 'Out')),
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
  $('results-actions').replaceChildren(
    ...actions.map((a, i) =>
      h('button', { type: 'button', class: a.primary ? 'primary' : 'secondary', 'data-autofocus': i === 0 || undefined, onclick: a.run }, a.label),
    ),
  );
}

// -------------------------------------------------------------- campaign

export function openCampaign(done: Set<string>, onPlay: (chapter: Chapter) => void, onReset: () => void): void {
  const path = $('chapter-path');
  const nextIndex = CHAPTERS.findIndex((c) => !done.has(c.id));
  path.replaceChildren(
    ...CHAPTERS.map((c, i) => {
      const open = isOpen(i, done);
      const cleared = done.has(c.id);
      const status = cleared ? 'Cleared' : open ? 'Next' : 'Locked';
      const foe = c.fight.slots.find((s) => s.cpu !== null && s.team !== 0) ?? c.fight.slots[1];
      return h(
        'button',
        {
          type: 'button',
          class: `chapter ${cleared ? 'cleared' : open ? 'open' : 'locked'}`,
          disabled: !open,
          'data-autofocus': i === (nextIndex < 0 ? CHAPTERS.length - 1 : nextIndex) || undefined,
          onclick: () => onPlay(c),
        },
        h('span', { class: 'chapter-no' }, String(i + 1).padStart(2, '0')),
        h('img', { src: thumbUrl(CHARACTERS[foe.char].id), alt: '' }),
        h('strong', {}, open ? c.title : '???'),
        h('span', { class: 'chapter-tag' }, open ? c.tagline : 'Clear the chapter before it.'),
        h('em', { class: 'chapter-status' }, status, open ? ` · ${STAGES[c.fight.stage].name}` : ''),
      );
    }),
  );
  $('campaign-done').hidden = nextIndex >= 0;
  const reset = $<HTMLButtonElement>('btn-campaign-reset');
  reset.onclick = () => {
    if (confirm('Start the campaign over? Cleared chapters will be locked again.')) onReset();
  };
  reset.disabled = done.size === 0;
}

// --------------------------------------------------------------- dialogue

/** The characters on your side of the story stand on the left. */
const LEFT = new Set(['exit-punk', 'blog-man']);

/** Plays a scene line by line. Resolves when it ends or is skipped. */
export function playDialogue(lines: Line[], chapterTitle: string): Promise<void> {
  const left = $<HTMLImageElement>('dlg-left');
  const right = $<HTMLImageElement>('dlg-right');
  const name = $('dlg-name');
  const text = $('dlg-text');
  const next = $<HTMLButtonElement>('dlg-next');
  const skip = $<HTMLButtonElement>('dlg-skip');
  $('dlg-chapter').textContent = chapterTitle;
  let leftWho = '';
  let rightWho = '';
  // Seed each side with the first speaker who will stand there.
  for (const l of lines) {
    if (l.who === 'narrator') continue;
    if (LEFT.has(l.who) && !leftWho) leftWho = l.who;
    if (!LEFT.has(l.who) && !rightWho) rightWho = l.who;
  }

  const setPortrait = (img: HTMLImageElement, who: string) => {
    const c = CHARACTERS.find((x) => x.id === who);
    img.hidden = !c;
    if (c) img.src = largeUrl(c.id);
  };

  return new Promise((resolve) => {
    let i = -1;
    let timer = 0;
    let typing = false;
    const end = () => {
      clearInterval(timer);
      audio.stopVoice();
      next.onclick = null;
      skip.onclick = null;
      window.removeEventListener('keydown', onKey);
      resolve();
    };
    const finishTyping = () => {
      clearInterval(timer);
      typing = false;
      text.textContent = lines[i].text;
    };
    const advance = () => {
      if (typing) return finishTyping();
      i++;
      if (i >= lines.length) return end();
      const l = lines[i];
      const narrator = l.who === 'narrator';
      if (!narrator) {
        if (LEFT.has(l.who)) leftWho = l.who;
        else rightWho = l.who;
      }
      setPortrait(left, leftWho);
      setPortrait(right, rightWho);
      left.classList.toggle('speaking', !narrator && LEFT.has(l.who));
      right.classList.toggle('speaking', !narrator && !LEFT.has(l.who));
      audio.voice(l.audio);
      const c = CHARACTERS.find((x) => x.id === l.who);
      name.textContent = narrator ? '' : (c?.name ?? l.who);
      name.hidden = narrator;
      text.classList.toggle('narration', narrator);
      next.textContent = i === lines.length - 1 ? 'Continue' : 'Next';
      // Type the line out; a press finishes it, a second press moves on.
      let n = 0;
      typing = true;
      text.textContent = '';
      clearInterval(timer);
      timer = window.setInterval(() => {
        n += 2;
        text.textContent = l.text.slice(0, n);
        if (n >= l.text.length) finishTyping();
      }, 28);
    };
    const onKey = (e: KeyboardEvent) => {
      // A focused button already turns Enter and Space into a click, and the
      // menu keys turn J into one.
      if (document.activeElement instanceof HTMLButtonElement) return;
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        advance();
      }
    };
    next.onclick = advance;
    skip.onclick = end;
    window.addEventListener('keydown', onKey);
    advance();
  });
}
