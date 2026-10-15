// Story: the campaign, chapter by chapter (content/campaign.json). Each
// chapter is a scene before the fight, the fight (stage, fighters, rules)
// and a scene after. Edit the words here; voice them in the Voice tab, which
// shows a line as out of date once its text changes.

import type { ChapterEntry, Line } from '../../game/campaign/story.ts';
import type { StageDef } from '../../game/sim/stageMath.ts';
import { h, kids, thumbUrl } from '../../game/ui/dom.ts';
import { api, store } from '../api.ts';
import { attempt, field, numberInput, select, textInput, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

type Slot = ChapterEntry['fight']['slots'][number];

let root: HTMLElement;
let chapters: ChapterEntry[] = [];
let stages: StageDef[] = [];
let current = 0;
let dirty = false;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function changed(redraw = true): void {
  dirty = true;
  if (redraw) render();
  else {
    const b = root.querySelector<HTMLButtonElement>('[data-save]');
    if (b) b.disabled = false;
    const p = root.querySelector<HTMLElement>('[data-dirty]');
    if (p) p.hidden = false;
  }
}

async function load(): Promise<void> {
  [chapters, stages] = await Promise.all([api.content<ChapterEntry[]>('campaign'), api.content<StageDef[]>('stages')]);
  current = Math.min(current, Math.max(0, chapters.length - 1));
  dirty = false;
}

function problems(c: ChapterEntry): string[] {
  const out: string[] = [];
  if (!stages.some((s) => s.id === c.fight.stage)) out.push(`The stage "${c.fight.stage}" doesn't exist: the game falls back to the first stage.`);
  const fighters = new Set(store.fighters.map((f) => f.id));
  c.fight.slots.forEach((s, i) => { if (!fighters.has(s.char)) out.push(`Fighter ${i + 1} ("${s.char}") doesn't exist.`); });
  if (!c.fight.slots.some((s) => s.cpu === null)) out.push('Nobody is the player.');
  if (c.fight.slots.length < 2) out.push('A fight needs at least two fighters.');
  if (c.fight.objective === 'survive' && !c.fight.rules.timeLimit) out.push('"Survive" needs a time limit to survive.');
  if (chapters.filter((x) => x.id === c.id).length > 1) out.push(`Another chapter uses the id "${c.id}".`);
  for (const part of ['intro', 'outro'] as const) {
    c[part].forEach((l, i) => { if (!l.text.trim()) out.push(`${part === 'intro' ? 'Before' : 'After'} the fight, line ${i + 1} is empty.`); });
  }
  return out;
}

async function save(): Promise<void> {
  for (const c of chapters) {
    for (const part of ['intro', 'outro'] as const) c[part] = c[part].map((l) => ({ ...l, text: l.text.trim() }));
    for (const s of c.fight.slots) for (const k of ['team', 'scale', 'startPercent', 'stocks'] as const) if (s[k] === undefined || s[k] === null) delete s[k];
    if (!c.fight.objective || c.fight.objective === 'win') delete c.fight.objective;
  }
  if (await attempt(() => api.save('campaign', chapters), 'Story saved. Open game tabs reload.')) {
    dirty = false;
    render();
  }
}

function speakers(): [string, string][] {
  return [['narrator', 'Narrator'], ...store.fighters.map((f): [string, string] => [f.id, f.name])];
}

function voiceState(l: Line): ['ok' | 'warn' | 'bad', string] {
  if (!l.audio) return ['bad', 'not voiced'];
  if (l.take && l.take.text !== l.text.trim()) return ['warn', 'voice out of date'];
  return ['ok', 'voiced'];
}

function linesCard(c: ChapterEntry, part: 'intro' | 'outro'): HTMLElement {
  const lines = c[part];
  const row = (l: Line, i: number) => {
    const text = h('textarea', { rows: 2, style: 'min-height:44px' });
    text.value = l.text;
    text.addEventListener('input', () => { l.text = text.value; changed(false); });
    text.addEventListener('change', () => render());
    const [kind, label] = voiceState(l);
    const move = (by: number) => {
      const j = i + by;
      if (j < 0 || j >= lines.length) return;
      [lines[i], lines[j]] = [lines[j], lines[i]];
      changed();
    };
    return h('div', { class: 'story-line' },
      h('div', { class: 'row' },
        select<string>(speakers(), l.who, (v) => { l.who = v; changed(); }),
        h('span', { class: `badge ${kind}` }, label),
        l.audio ? h('button', { type: 'button', class: 'btn small', title: 'Play the recorded take', onclick: () => void new Audio(l.audio).play() }, '▶') : null,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn small', onclick: () => move(-1) }, '▲'),
        h('button', { type: 'button', class: 'btn small', onclick: () => move(1) }, '▼'),
        h('button', { type: 'button', class: 'btn small', title: 'A new line after this one', onclick: () => { lines.splice(i + 1, 0, { who: l.who, text: '' }); changed(); } }, '+'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { lines.splice(i, 1); changed(); } }, '×')),
      text);
  };
  return h('section', { class: 'card' },
    h('h3', {}, part === 'intro' ? 'Before the fight' : 'After the fight (when the player wins)', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${lines.length} line${lines.length === 1 ? '' : 's'}`)),
    lines.length ? h('div', { class: 'story-lines' }, ...lines.map(row)) : h('p', { class: 'hint' }, 'No lines: the fight starts straight away.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { lines.push({ who: lines[lines.length - 1]?.who ?? 'narrator', text: '' }); changed(); } }, '+ Line'),
      h('a', { class: 'btn small', href: '#voice' }, 'Voice these in the Voice tab')),
  );
}

function fightCard(c: ChapterEntry): HTMLElement {
  const f = c.fight;
  const rules = f.rules;
  const stageOpts: [string, string][] = stages.map((s) => [s.id, s.variantOf ? `${s.name} (variant of ${s.variantOf})` : s.name]);
  if (!stages.some((s) => s.id === f.stage)) stageOpts.unshift([f.stage, `${f.stage} (missing)`]);
  const fighterOpts: [string, string][] = store.fighters.map((x) => [x.id, x.name]);
  const roleOf = (s: Slot) => (s.cpu === null ? 'player' : s.cpu === 0 ? 'dummy' : String(s.cpu));
  const roles: [string, string][] = [['player', 'Player'], ['dummy', 'Dummy (stands still)'], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string] => [String(n), `CPU level ${n}`])];
  const slotRow = (s: Slot, i: number) => h('tr', {},
    h('td', {}, h('img', { src: thumbUrl(s.char), alt: '', style: 'width:28px;height:28px;object-fit:contain' })),
    h('td', {}, select<string>(fighterOpts, s.char, (v) => { s.char = v; changed(); })),
    h('td', {}, select<string>(roles, roleOf(s), (v) => { s.cpu = v === 'player' ? null : v === 'dummy' ? 0 : Number(v); changed(); })),
    h('td', {}, numberInput(s.team ?? null, (v) => { s.team = v ?? undefined; changed(false); }, { min: 0, max: 3, style: 'width:56px', title: 'Fighters on one team can’t hurt each other; the player’s side is 0' })),
    h('td', {}, numberInput(s.stocks ?? null, (v) => { s.stocks = v ?? undefined; changed(false); }, { min: 1, max: 9, style: 'width:56px', placeholder: String(f.stocks) })),
    h('td', {}, numberInput(s.scale ?? null, (v) => { s.scale = v ?? undefined; changed(false); }, { min: 50, max: 200, step: 5, style: 'width:64px', placeholder: '100' })),
    h('td', {}, numberInput(s.startPercent === undefined ? null : s.startPercent / 10, (v) => { s.startPercent = v === null ? undefined : Math.round(v * 10); changed(false); }, { min: 0, max: 300, style: 'width:64px', placeholder: '0' })),
    h('td', {}, h('button', { type: 'button', class: 'btn small danger', disabled: f.slots.length <= 2, onclick: () => { f.slots.splice(i, 1); changed(); } }, '×')));
  return h('section', { class: 'card' },
    h('h3', {}, 'The fight'),
    h('div', { class: 'form' },
      field('Stage', select<string>(stageOpts, f.stage, (v) => { f.stage = v; changed(); }), { sub: 'Any stage, mode lists or not' }),
      field('Stocks', numberInput(f.stocks, (v) => { if (v) { f.stocks = v; changed(false); } }, { min: 1, max: 9 })),
      field('Goal', select<string>([['win', 'Win the fight'], ['survive', 'Survive until time runs out']], f.objective ?? 'win', (v) => { f.objective = v as 'win' | 'survive'; changed(); })),
      field('Time limit (s)', numberInput(rules.timeLimit ? rules.timeLimit / 60 : null, (v) => { rules.timeLimit = v ? Math.round(v * 60) : undefined; changed(false); }, { min: 10, step: 10, placeholder: 'none' })),
      field('Gravity (%)', numberInput(rules.gravity ?? null, (v) => { rules.gravity = v ?? undefined; changed(false); }, { min: 10, max: 300, placeholder: '100' })),
      field('Damage (%)', numberInput(rules.damage ?? null, (v) => { rules.damage = v ?? undefined; changed(false); }, { min: 10, max: 300, placeholder: '100' })),
      field('Stage events', select<string>([['on', 'On'], ['off', 'Off']], rules.hazards === 0 ? 'off' : 'on', (v) => { rules.hazards = v === 'off' ? 0 : undefined; changed(false); }), { sub: 'Events, damage zones, hazards' }),
    ),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Fighter'), h('th', {}, 'Who plays'), h('th', {}, 'Team'), h('th', {}, 'Stocks'), h('th', {}, 'Size %'), h('th', {}, 'Starts at %'), h('th', {}, ''))),
      h('tbody', {}, ...f.slots.map(slotRow)))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', disabled: f.slots.length >= 4, onclick: () => { f.slots.push({ char: store.fighters[0]?.id ?? 'exit-punk', cpu: 3, team: 1 }); changed(); } }, '+ Fighter'),
      h('span', { class: 'hint' }, 'Up to four. The player is usually team 0 and the rest team 1; give an ally team 0 too.')),
  );
}

function chapterCard(c: ChapterEntry): HTMLElement {
  const id = textInput(c.id, () => {});
  id.addEventListener('change', () => {
    const next = slug(id.value) || c.id;
    if (next !== c.id && !chapters.some((x) => x.id === next)) {
      c.id = next;
      toast('Chapter id changed: players who cleared it will see it as not cleared.');
    }
    changed();
  });
  return h('section', { class: 'card' },
    h('h3', {}, `Chapter ${current + 1}`),
    h('div', { class: 'form' },
      field('Title', textInput(c.title, (v) => { c.title = v; changed(false); })),
      field('Id', id, { sub: 'Progress is saved by id' }),
      field('Tagline', textInput(c.tagline, (v) => { c.tagline = v; changed(false); }), { wide: true, sub: 'One line on the chapter map' }),
      field('Hint', textInput(c.hint, (v) => { c.hint = v; changed(false); }), { wide: true, sub: 'Shown before the fight: what it asks of the player' }),
    ),
  );
}

function newChapter(from?: ChapterEntry): void {
  const title = prompt('Chapter title?', from ? `${from.title} 2` : 'New chapter');
  if (!title) return;
  let id = slug(title) || 'chapter';
  for (let n = 2; chapters.some((c) => c.id === id); n++) id = `${slug(title)}-${n}`;
  const c: ChapterEntry = from
    ? { ...structuredClone(from), id, title }
    : {
        id, title, tagline: '', hint: '', intro: [{ who: 'narrator', text: '' }], outro: [],
        fight: { stage: stages[0]?.id ?? 'foundry', stocks: 2, rules: {}, slots: [{ char: 'exit-punk', cpu: null, team: 0 }, { char: store.fighters[1]?.id ?? 'kaelen', cpu: 3, team: 1 }] },
      };
  // New lines need new voice takes.
  if (from) for (const part of ['intro', 'outro'] as const) c[part] = c[part].map((l) => ({ who: l.who, text: l.text }));
  chapters.splice(current + 1, 0, c);
  current++;
  changed();
}

function render(): void {
  const c = chapters[current];
  const list = h('div', { class: 'side-list' }, ...chapters.map((ch, i) => {
    const foe = ch.fight.slots.find((s) => s.cpu !== null && s.team !== 0) ?? ch.fight.slots[1];
    const st = stages.find((s) => s.id === ch.fight.stage);
    const bad = problems(ch).length;
    return h('button', { type: 'button', class: `fighter-item${i === current ? ' active' : ''}`, onclick: () => { current = i; render(); } },
      foe ? h('img', { src: thumbUrl(foe.char), alt: '' }) : h('span', {}),
      h('div', {}, h('strong', {}, `${i + 1}. ${ch.title}`), h('span', {}, st?.name ?? `${ch.fight.stage}?`)),
      bad ? h('span', { class: 'badge warn', title: problems(ch).join('\n') }, '!') : null);
  }));
  const issues = c ? problems(c) : [];
  root.replaceChildren(...kids(
    h('aside', { class: 'side' },
      h('div', { class: 'side-head' },
        h('strong', {}, 'Chapters'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: () => newChapter() }, '+ New'),
          c ? h('button', { type: 'button', class: 'btn small', onclick: () => newChapter(c) }, 'Duplicate') : null,
          c ? h('button', { type: 'button', class: 'btn small', disabled: current === 0, onclick: () => { [chapters[current - 1], chapters[current]] = [chapters[current], chapters[current - 1]]; current--; changed(); } }, '▲') : null,
          c ? h('button', { type: 'button', class: 'btn small', disabled: current >= chapters.length - 1, onclick: () => { [chapters[current + 1], chapters[current]] = [chapters[current], chapters[current + 1]]; current++; changed(); } }, '▼') : null,
          c ? h('button', { type: 'button', class: 'btn small danger', onclick: () => { if (!confirm(`Delete chapter ${current + 1}, ${c.title}?`)) return; chapters.splice(current, 1); current = Math.max(0, current - 1); changed(); } }, 'Delete') : null)),
      list),
    h('div', { class: 'story-main' },
      h('div', { class: 'row' },
        h('h2', { style: 'margin:0' }, c ? `${current + 1}. ${c.title}` : 'No chapters'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'pill warn', 'data-dirty': '', hidden: !dirty }, 'Unsaved changes'),
        c ? h('button', { type: 'button', class: 'btn', title: 'Plays this chapter (scene, fight, scene) in the game, as saved', onclick: () => {
          if (dirty) toast('Save first: the game plays the saved story.', 'error');
          window.open(`/Game/?chapter=${encodeURIComponent(c.id)}`, 'dod-playtest');
        } }, 'Play chapter') : null,
        h('button', { type: 'button', class: 'btn', onclick: async () => { if (dirty && !confirm('Throw away unsaved story changes?')) return; await attempt(load); render(); } }, 'Revert'),
        h('button', { type: 'button', class: 'btn primary', 'data-save': '', disabled: !dirty, onclick: save }, 'Save story')),
      h('p', { class: 'hint' }, 'The story plays chapter by chapter: a scene, the fight, and a scene after a win. A chapter opens once every chapter before it is cleared.'),
      issues.length ? h('ul', { class: 'issues', style: 'margin:0;padding-left:16px' }, ...issues.map((p) => h('li', {}, p))) : null,
      c ? chapterCard(c) : null,
      c ? linesCard(c, 'intro') : null,
      c ? fightCard(c) : null,
      c ? linesCard(c, 'outro') : null,
    ),
  ));
}

export const storyTab: Tab = {
  async mount(el) {
    root = el;
    el.classList.add('story');
    await attempt(load);
    render();
    window.addEventListener('beforeunload', (e) => {
      if (dirty) e.preventDefault();
    });
  },
  async show() {
    // The Voice tab records takes into the same file; pick those up.
    if (!root || dirty) return;
    await attempt(load);
    render();
  },
};
