// Maps tab: the stage's dynamic parts. Events (things the stage does on its
// own), zones (regions that hurt, push, float or drown fighters), hazards
// (moving things that hit), what platforms and art do during events, and
// what reacts to KOs, hits and events. Drawn on the editor canvas, dragged
// there, and edited in the inspector. The sim side is in stageMath.ts/step.ts.

import { hazardAt, secs, type LayerReact, type Platform, type StageDef, type StageEffect, type StageEvent, type StageHazard, type StageLayer, type StageZone } from '../../game/sim/stageMath.ts';
import { h } from '../../game/ui/dom.ts';
import { field, numberInput, select, textInput } from '../ui.ts';

export type DynSel = { kind: 'zone'; index: number } | { kind: 'hazard'; index: number } | { kind: 'event'; index: number };
export type DynDrag =
  | { kind: 'zone'; index: number; part: 'body' | 'corner'; wx: number; wy: number; start: StageZone }
  | { kind: 'hazard'; index: number; point: number };

export interface DynCtx {
  changed: () => void;
  rerender: () => void;
  select: (s: DynSel) => void;
  sounds: string[];
}

const ZONE_COLORS: Record<StageZone['kind'], string> = {
  damage: '#b84cff',
  wind: '#d9c38a',
  water: '#3f9cff',
  gravity: '#7ee2a0',
};
const ZONE_HELP: Record<StageZone['kind'], string> = {
  damage: 'Hurts anyone inside on a tick (fog, lava, spikes, a cursed mist). Give it knockback to throw them out.',
  wind: 'Pushes anyone inside (a gust, a dust storm, a fan). Grounded fighters feel half.',
  water: 'Fighters inside swim: floaty, slow, and every jump is another stroke.',
  gravity: 'Lighter (under 100) or heavier (over 100) inside: low-gravity space, a heavy pull.',
};

// ------------------------------------------------------------- references

/** The event ids, for pickers. warn: also 'warn:<id>' entries. */
function eventChoices(st: StageDef, opts: { none?: string; warn?: boolean } = {}): [string, string][] {
  const out: [string, string][] = [['', opts.none ?? 'Always']];
  for (const e of st.events ?? []) {
    out.push([e.id, `During ${e.name || e.id}`]);
    if (opts.warn) out.push([`warn:${e.id}`, `While ${e.name || e.id} warns`]);
  }
  return out;
}

/** What effects and reactions can listen for. */
export function momentChoices(st: StageDef, ambient: boolean): [string, string][] {
  const out: [string, string][] = [['ko', 'On a KO'], ['hit', 'On a hit'], ['start', 'At the start'], ['end', 'At the end (finale)']];
  if (ambient) out.push(['ambient', 'Every few seconds']);
  for (const e of st.events ?? []) {
    const n = e.name || e.id;
    out.push([`warn:${e.id}`, `${n}: warning`], [`event:${e.id}`, `${n}: starts`], [`eventEnd:${e.id}`, `${n}: ends`]);
  }
  return out;
}

/** Renames an event everywhere the stage names it. */
function renameEvent(st: StageDef, from: string, to: string): void {
  const swap = (v: string | undefined) => {
    if (!v) return v;
    if (v === from) return to;
    for (const p of ['warn:', 'event:', 'eventEnd:']) if (v === p + from) return p + to;
    return v;
  };
  for (const z of st.zones ?? []) z.during = swap(z.during);
  for (const hz of st.hazards ?? []) hz.during = swap(hz.during);
  for (const p of st.platforms) {
    p.offDuring = swap(p.offDuring);
    p.onlyDuring = swap(p.onlyDuring);
  }
  for (const l of st.layers ?? []) {
    l.showDuring = swap(l.showDuring);
    l.hideDuring = swap(l.hideDuring);
    for (const r of l.reacts ?? []) r.on = swap(r.on)!;
  }
  for (const fx of st.effects ?? []) fx.on = swap(fx.on)!;
}

// ------------------------------------------------------------------ canvas

type ToScreen = (x: number, y: number) => [number, number];

/** A stand-in clock for the editor: every event runs back to back, so hazards show their paths moving. */
function editorClock(st: StageDef, frame: number) {
  const evs = st.events ?? [];
  return { frame, evPhase: evs.map(() => 2), evTimer: evs.map((e) => { const d = Math.max(1, secs(e.duration, 1)); return d - (frame % d); }) };
}

export function drawDynamics(ctx: CanvasRenderingContext2D, st: StageDef, toScreen: ToScreen, zoom: number, sel: DynSel | null, frame: number): void {
  ctx.font = '11px Segoe UI, sans-serif';
  (st.zones ?? []).forEach((z, i) => {
    const [x1, y1] = toScreen(z.x1, z.y2);
    const [x2, y2] = toScreen(z.x2, z.y1);
    const c = ZONE_COLORS[z.kind];
    const on = sel?.kind === 'zone' && sel.index === i;
    ctx.fillStyle = `${c}${on ? '38' : '1f'}`;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeStyle = on ? '#ffd15a' : `${c}cc`;
    ctx.lineWidth = on ? 2 : 1.2;
    if (z.during) ctx.setLineDash([6, 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    if (z.kind === 'wind' && z.force) {
      // Arrows the way it blows.
      const [fx, fy] = z.force;
      const len = Math.min(40, Math.hypot(fx, fy) * 0.25 + 10);
      const a = Math.atan2(-fy, fx);
      ctx.strokeStyle = `${c}aa`;
      for (let gx = x1 + 30; gx < x2 - 10; gx += 90) {
        for (let gy = y1 + 30; gy < y2 - 10; gy += 90) {
          const ex = gx + Math.cos(a) * len;
          const ey = gy + Math.sin(a) * len;
          ctx.beginPath();
          ctx.moveTo(gx, gy);
          ctx.lineTo(ex, ey);
          ctx.lineTo(ex - Math.cos(a - 0.5) * 7, ey - Math.sin(a - 0.5) * 7);
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - Math.cos(a + 0.5) * 7, ey - Math.sin(a + 0.5) * 7);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = c;
    ctx.fillText(`${z.kind}${z.during ? ` · during ${z.during}` : ''}${z.kind === 'damage' ? ` · ${z.damage ?? 1}%` : ''}`, x1 + 5, y1 + 13);
    if (on) {
      ctx.fillStyle = '#ffd15a';
      ctx.fillRect(x2 - 5, y2 - 5, 10, 10);
    }
  });
  const clock = editorClock(st, frame);
  (st.hazards ?? []).forEach((hz, i) => {
    const on = sel?.kind === 'hazard' && sel.index === i;
    const pts = hz.path.map((p) => toScreen(p.x, p.y));
    ctx.strokeStyle = on ? '#ffd15a' : 'rgba(255, 74, 58, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach(([x, y], n) => (n ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (!hz.during && pts.length > 2) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach(([x, y], n) => {
      ctx.fillStyle = on ? '#ffd15a' : '#ff4a3a';
      ctx.fillRect(x - 4, y - 4, 8, 8);
      if (on) ctx.fillText(String(n + 1), x + 6, y - 6);
    });
    const at = hazardAt(st, clock, hz);
    if (at) {
      const [hx, hy] = toScreen(at.x / 1000, at.y / 1000);
      ctx.fillStyle = 'rgba(255, 74, 58, 0.35)';
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(3, hz.r * zoom), 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts[0]) {
      ctx.fillStyle = '#ff8a7a';
      ctx.fillText(`hazard ${hz.id}${hz.during ? ` · during ${hz.during}` : ''}`, pts[0][0] + 8, pts[0][1] + 16);
    }
  });
}

/** A label under platforms that events switch. */
export function platformTag(p: Platform): string | null {
  if (p.offDuring) return `gone during ${p.offDuring}`;
  if (p.onlyDuring) return `only during ${p.onlyDuring}`;
  return null;
}

export function hitDynamics(st: StageDef, sx: number, sy: number, wx: number, wy: number, toScreen: ToScreen, sel: DynSel | null, bodies: boolean): DynDrag | null {
  const near = (ax: number, ay: number, d = 8) => Math.abs(sx - ax) <= d && Math.abs(sy - ay) <= d;
  // Hazard points first (small), the selected hazard's before the rest.
  const hazards = (st.hazards ?? []).map((hz, i) => ({ hz, i })).sort((a, b) => Number(sel?.kind === 'hazard' && b.i === sel.index) - Number(sel?.kind === 'hazard' && a.i === sel.index));
  for (const { hz, i } of hazards) {
    for (let n = 0; n < hz.path.length; n++) {
      const [px, py] = toScreen(hz.path[n].x, hz.path[n].y);
      if (near(px, py)) return { kind: 'hazard', index: i, point: n };
    }
  }
  const zones = st.zones ?? [];
  if (sel?.kind === 'zone' && zones[sel.index]) {
    const z = zones[sel.index];
    const [cx, cy] = toScreen(z.x2, z.y1);
    if (near(cx, cy)) return { kind: 'zone', index: sel.index, part: 'corner', wx, wy, start: { ...z } };
  }
  if (!bodies) return null;
  // Smallest zone first, so one inside another can still be picked.
  const order = zones.map((z, i) => ({ z, i })).sort((a, b) => (a.z.x2 - a.z.x1) * (a.z.y2 - a.z.y1) - (b.z.x2 - b.z.x1) * (b.z.y2 - b.z.y1));
  for (const { z, i } of order) {
    if (wx >= z.x1 && wx <= z.x2 && wy >= z.y1 && wy <= z.y2) return { kind: 'zone', index: i, part: 'body', wx, wy, start: { ...z } };
  }
  return null;
}

export function dragDynamics(st: StageDef, d: DynDrag, wx: number, wy: number, snap: (v: number) => number): void {
  if (d.kind === 'hazard') {
    const p = st.hazards![d.index].path[d.point];
    p.x = snap(wx);
    p.y = snap(wy);
    return;
  }
  const z = st.zones![d.index];
  const s = d.start;
  if (d.part === 'body') {
    const dx = snap(wx - d.wx);
    const dy = snap(wy - d.wy);
    z.x1 = s.x1 + dx;
    z.x2 = s.x2 + dx;
    z.y1 = s.y1 + dy;
    z.y2 = s.y2 + dy;
  } else {
    z.x2 = Math.max(z.x1 + 20, snap(wx));
    z.y1 = Math.min(z.y2 - 20, snap(wy));
  }
}

// --------------------------------------------------------------- inspector

const num = (v: number | undefined, set: (v: number | undefined) => void, ctx: DynCtx, attrs: Record<string, number | string> = {}) =>
  numberInput(v ?? null, (n) => { set(n ?? undefined); ctx.changed(); }, { step: 1, ...attrs });

export function eventsCard(st: StageDef, ctx: DynCtx): HTMLElement {
  const evs = (st.events ??= []);
  const row = (e: StageEvent, i: number) => {
    const t = e.trigger ?? 'timer';
    const id = textInput(e.id, () => {});
    id.addEventListener('change', () => {
      const next = id.value.toLowerCase().replace(/[^a-z0-9-]/g, '') || e.id;
      if (next !== e.id && !evs.some((x) => x.id === next)) {
        renameEvent(st, e.id, next);
        e.id = next;
      }
      ctx.changed();
      ctx.rerender();
    });
    return h('div', { class: 'effect-row' },
      h('div', { class: 'row' },
        h('strong', {}, e.name || e.id),
        h('span', { class: 'spacer' }),
        select<'timer' | 'ko' | 'hit'>([['timer', 'On a timer'], ['ko', 'When someone is KO’d'], ['hit', 'When someone is hit']], t, (v) => { e.trigger = v === 'timer' ? undefined : v; ctx.changed(); ctx.rerender(); }),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => { evs.splice(i, 1); ctx.changed(); ctx.rerender(); } }, '×')),
      h('div', { class: 'form' },
        field('Id', id, { sub: 'Zones, hazards, platforms and art name it' }),
        field('Name', textInput(e.name ?? '', (v) => { e.name = v || undefined; ctx.changed(); })),
        t === 'timer' ? field('Every, from (s)', num(e.every?.[0], (v) => { e.every = v === undefined ? undefined : [v, Math.max(v, e.every?.[1] ?? v)]; }, ctx, { min: 1, step: 1 }), { sub: 'Blank: only once' }) : null,
        t === 'timer' ? field('to (s)', num(e.every?.[1], (v) => { if (v !== undefined) e.every = [Math.min(e.every?.[0] ?? v, v), v]; }, ctx, { min: 1, step: 1 })) : null,
        t === 'timer' ? field('First after (s)', num(e.first, (v) => (e.first = v), ctx, { min: 0, step: 1 }), { sub: 'Blank: a random wait' }) : null,
        t !== 'timer' ? field('Chance (%)', num(e.chance, (v) => (e.chance = v), ctx, { min: 1, max: 100, placeholder: 100 })) : null,
        field('Warning (s)', num(e.warn, (v) => (e.warn = v), ctx, { min: 0, step: 0.5, placeholder: 0 }), { sub: 'Time to see it coming' }),
        field('Lasts (s)', num(e.duration, (v) => (e.duration = v ?? 0), ctx, { min: 0, step: 0.5 })),
      ));
  };
  return h('div', { class: 'card' },
    h('h3', {}, 'Stage events'),
    h('p', { class: 'hint' }, 'Things the stage does on its own: a storm, a hawk swooping, panels turning. Each warns, runs and ends; zones, hazards, platforms, art and effects can follow it. Fire them in the 3D preview.'),
    evs.length ? h('div', {}, ...evs.map(row)) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        let n = evs.length + 1;
        while (evs.some((e) => e.id === `event-${n}`)) n++;
        evs.push({ id: `event-${n}`, every: [15, 25], warn: 2, duration: 6 });
        ctx.changed();
        ctx.rerender();
      } }, '+ Event')),
  );
}

export function zonesCard(st: StageDef, ctx: DynCtx, center: { x: number; y: number }): HTMLElement {
  const zones = (st.zones ??= []);
  const add = (kind: StageZone['kind']) => {
    const z: StageZone = { kind, x1: Math.round(center.x - 200), x2: Math.round(center.x + 200), y1: Math.round(center.y - 150), y2: Math.round(center.y + 150) };
    if (kind === 'damage') Object.assign(z, { damage: 2, tick: 0.5 });
    if (kind === 'wind') z.force = [100, 0];
    if (kind === 'gravity') z.gravity = 50;
    zones.push(z);
    ctx.select({ kind: 'zone', index: zones.length - 1 });
    ctx.changed();
  };
  return h('div', { class: 'card' },
    h('h3', {}, 'Zones'),
    zones.length ? h('div', { class: 'layer-list' }, ...zones.map((z, i) => h('div', { class: 'layer-row' },
      h('span', { style: `width:10px;height:10px;border-radius:2px;background:${ZONE_COLORS[z.kind]}` }),
      h('button', { type: 'button', class: 'link', onclick: () => ctx.select({ kind: 'zone', index: i }) }, `${z.kind}${z.id ? ` · ${z.id}` : ''}`),
      h('span', { class: 'muted mono' }, z.during ? `during ${z.during}` : 'always')))) : h('p', { class: 'hint' }, 'Regions that hurt, push, float or drown fighters. Drag them on the canvas.'),
    h('div', { class: 'row' }, ...(['damage', 'wind', 'water', 'gravity'] as const).map((k) => h('button', { type: 'button', class: 'btn small', title: ZONE_HELP[k], onclick: () => add(k) }, `+ ${k}`))),
  );
}

export function zoneCard(st: StageDef, z: StageZone, index: number, ctx: DynCtx): HTMLElement {
  const n = (key: 'x1' | 'x2' | 'y1' | 'y2') => num(z[key], (v) => { if (v !== undefined) z[key] = v; }, ctx);
  return h('div', { class: 'card' },
    h('h3', {}, `Zone · ${z.kind}`),
    h('p', { class: 'hint' }, ZONE_HELP[z.kind]),
    h('div', { class: 'form' },
      field('Kind', select<StageZone['kind']>(['damage', 'wind', 'water', 'gravity'], z.kind, (v) => { z.kind = v; ctx.changed(); ctx.rerender(); })),
      field('When', select<string>(eventChoices(st), z.during ?? '', (v) => { z.during = v || undefined; ctx.changed(); })),
      field('Left', n('x1')), field('Right', n('x2')), field('Bottom', n('y1')), field('Top', n('y2')),
      z.kind === 'damage' ? field('Damage (%)', num(z.damage, (v) => (z.damage = v), ctx, { min: 0, step: 0.5, placeholder: 1 }), { sub: 'Each tick' }) : null,
      z.kind === 'damage' ? field('Tick (s)', num(z.tick, (v) => (z.tick = v), ctx, { min: 0.1, step: 0.1, placeholder: 0.5 })) : null,
      z.kind === 'damage' ? field('Knockback', num(z.knock, (v) => (z.knock = v), ctx, { min: 0, placeholder: 0 }), { sub: '0 none, 40 a shove, 80 strong' }) : null,
      z.kind === 'damage' ? field('Angle', num(z.angle, (v) => (z.angle = v), ctx, { step: 15, placeholder: 90 }), { sub: '90 is up' }) : null,
      z.kind === 'wind' ? field('Push x', num(z.force?.[0], (v) => (z.force = [v ?? 0, z.force?.[1] ?? 0]), ctx, { step: 10 }), { sub: 'Units per second; 120 is strong' }) : null,
      z.kind === 'wind' ? field('Push y', num(z.force?.[1], (v) => (z.force = [z.force?.[0] ?? 0, v ?? 0]), ctx, { step: 10 })) : null,
      z.kind === 'water' || z.kind === 'gravity' ? field('Gravity (%)', num(z.gravity, (v) => (z.gravity = v), ctx, { min: 0, step: 5, placeholder: z.kind === 'water' ? 35 : 100 })) : null,
      field('Id', textInput(z.id ?? '', (v) => { z.id = v || undefined; ctx.changed(); }), { sub: 'Optional, for notes' }),
    ),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => { st.zones!.splice(index, 1); ctx.changed(); ctx.rerender(); } }, 'Delete')),
  );
}

export function hazardsCard(st: StageDef, ctx: DynCtx, center: { x: number; y: number }): HTMLElement {
  const list = (st.hazards ??= []);
  return h('div', { class: 'card' },
    h('h3', {}, 'Hazards'),
    list.length ? h('div', { class: 'layer-list' }, ...list.map((hz, i) => h('div', { class: 'layer-row' },
      h('button', { type: 'button', class: 'link', onclick: () => ctx.select({ kind: 'hazard', index: i }) }, hz.id),
      h('span', { class: 'muted mono' }, hz.during ? `during ${hz.during}` : `loops ${hz.period ?? 4}s`)))) : h('p', { class: 'hint' }, 'Things that move along a path and hit: a hawk, a train, a swinging lamp. Drag their path points on the canvas.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
      let n = list.length + 1;
      while (list.some((x) => x.id === `hazard-${n}`)) n++;
      const y = Math.round(center.y + 80);
      list.push({ id: `hazard-${n}`, during: st.events?.[0]?.id, period: 6, path: [{ x: Math.round(center.x - 900), y: y + 200 }, { x: Math.round(center.x), y }, { x: Math.round(center.x + 900), y: y + 200 }], r: 50, dmg: 10, angle: 50, bkb: 40, kbg: 80 });
      ctx.select({ kind: 'hazard', index: list.length - 1 });
      ctx.changed();
    } }, '+ Hazard')),
  );
}

export function hazardCard(st: StageDef, hz: StageHazard, index: number, ctx: DynCtx): HTMLElement {
  const path = h('input', { type: 'text', value: hz.path.map((p) => `${p.x} ${p.y}`).join('; ') });
  path.addEventListener('change', () => {
    const pts = path.value.split(';').map((s) => s.trim().split(/[\s,]+/).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (pts.length) hz.path = pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }));
    ctx.changed();
    ctx.rerender();
  });
  const riders = (st.layers ?? []).filter((l) => l.follows === hz.id).map((l) => l.id);
  return h('div', { class: 'card' },
    h('h3', {}, `Hazard · ${hz.id}`),
    h('p', { class: 'hint' }, hz.during ? 'Crosses its path once, first point to last, while its event runs.' : 'Loops its path forever.'),
    h('div', { class: 'form' },
      field('Id', textInput(hz.id, (v) => {
        const next = v.toLowerCase().replace(/[^a-z0-9-]/g, '');
        for (const l of st.layers ?? []) if (l.follows === hz.id) l.follows = next;
        hz.id = next;
        ctx.changed();
      })),
      field('When', select<string>(eventChoices(st, { none: 'Always (loops)' }), hz.during ?? '', (v) => { hz.during = v || undefined; ctx.changed(); ctx.rerender(); })),
      !hz.during ? field('Loop (s)', num(hz.period, (v) => (hz.period = v), ctx, { min: 0.5, step: 0.5, placeholder: 4 })) : null,
      field('Radius', num(hz.r, (v) => (hz.r = v ?? 40), ctx, { min: 5 })),
      field('Damage (%)', num(hz.dmg, (v) => (hz.dmg = v ?? 0), ctx, { min: 0 })),
      field('Angle', num(hz.angle, (v) => (hz.angle = v ?? 45), ctx, { step: 5 }), { sub: 'Moving right; mirrored moving left' }),
      field('Base knockback', num(hz.bkb, (v) => (hz.bkb = v ?? 0), ctx, { min: 0 }), { sub: 'A strong smash is ~40' }),
      field('Growth', num(hz.kbg, (v) => (hz.kbg = v ?? 0), ctx, { min: 0 }), { sub: 'With damage; ~100 strong' }),
      field('Path', path, { wide: true, sub: 'x y; x y; … (or drag the points). Points are evenly spaced in time.' }),
    ),
    h('p', { class: 'hint' }, riders.length ? `Drawn by ${riders.join(', ')}.` : 'No art rides it yet (the game shows a red disc): set a layer’s "Rides hazard".'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { const last = hz.path[hz.path.length - 1] ?? { x: 0, y: 200 }; hz.path.push({ x: last.x + 200, y: last.y }); ctx.changed(); ctx.rerender(); } }, '+ Point'),
      h('button', { type: 'button', class: 'btn small', disabled: hz.path.length <= 1, onclick: () => { hz.path.pop(); ctx.changed(); ctx.rerender(); } }, '− Point'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => { st.hazards!.splice(index, 1); ctx.changed(); ctx.rerender(); } }, 'Delete')),
  );
}

/** Platform: comes and goes with an event. */
export function platformEvents(st: StageDef, p: Platform, ctx: DynCtx): HTMLElement | null {
  if (!st.events?.length) return null;
  const mode = p.offDuring ? 'off' : p.onlyDuring ? 'only' : '';
  const ev = p.offDuring ?? p.onlyDuring ?? st.events[0].id;
  const set = (m: string, id: string) => {
    delete p.offDuring;
    delete p.onlyDuring;
    if (m === 'off') p.offDuring = id;
    if (m === 'only') p.onlyDuring = id;
    ctx.changed();
    ctx.rerender();
  };
  return h('div', { class: 'form' },
    field('With an event', select<string>([['', 'Always there'], ['off', 'Gone during'], ['only', 'Only during']], mode, (v) => set(v, ev)), { sub: 'Breaks, tilts away, extends…' }),
    mode ? field('Event', select<string>((st.events ?? []).map((e): [string, string] => [e.id, e.name || e.id]), ev, (v) => set(mode, v))) : null,
  );
}

/** Layer: loops, shows with events, rides hazards, reacts to moments. */
export function layerDynamics(st: StageDef, l: StageLayer, ctx: DynCtx): HTMLElement {
  const a = l.anim;
  const reacts = (l.reacts ??= []);
  const reactRow = (r: LayerReact, i: number) => h('div', { class: 'row' },
    select<string>(momentChoices(st, false), r.on, (v) => { r.on = v; ctx.changed(); }),
    select<LayerReact['kind']>([['hop', 'Hop'], ['flash', 'Flash'], ['shake', 'Shake'], ['spin', 'Spin'], ['tilt', 'Tilt (holds)'], ['tip', 'Tip over (holds)']], r.kind, (v) => { r.kind = v; ctx.changed(); }),
    numberInput(r.amount ?? null, (v) => { r.amount = v ?? undefined; ctx.changed(); }, { placeholder: 'amount', step: 5, style: 'width:70px' }),
    numberInput(r.seconds ?? null, (v) => { r.seconds = v ?? undefined; ctx.changed(); }, { placeholder: 's', step: 0.5, min: 0.1, style: 'width:56px' }),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => { reacts.splice(i, 1); ctx.changed(); ctx.rerender(); } }, '×'));
  return h('div', { class: 'card' },
    h('h3', {}, 'Moves and reacts'),
    h('div', { class: 'form' },
      field('Loop', select<string>([['', 'Still'], ['bob', 'Bob up and down'], ['sway', 'Sway (rocks)'], ['wave', 'Drift side to side'], ['pulse', 'Pulse (grows)'], ['spin', 'Spin'], ['scroll', 'Scroll the image']], a?.kind ?? '', (v) => {
        l.anim = v ? { kind: v as NonNullable<StageLayer['anim']>['kind'], amount: a?.amount, speed: a?.speed } : undefined;
        ctx.changed();
        ctx.rerender();
      })),
      a ? field('Amount', numberInput(a.amount ?? null, (v) => { a.amount = v ?? undefined; ctx.changed(); }, { step: 1 }), { sub: 'Units; degrees for sway and spin; % for pulse' }) : null,
      a ? field('Seconds per cycle', numberInput(a.speed ?? null, (v) => { a.speed = v ?? undefined; ctx.changed(); }, { step: 0.5, min: 0.1, placeholder: 2 })) : null,
      field('Shown', select<string>(eventChoices(st, { none: 'Always', warn: true }), l.showDuring ?? '', (v) => { l.showDuring = v || undefined; ctx.changed(); })),
      field('Hidden during', select<string>(eventChoices(st, { none: 'Never' }), l.hideDuring ?? '', (v) => { l.hideDuring = v || undefined; ctx.changed(); })),
      st.hazards?.length ? field('Rides hazard', select<string>([['', 'No'], ...st.hazards.map((hz): [string, string] => [hz.id, hz.id])], l.follows ?? '', (v) => { l.follows = v || undefined; ctx.changed(); }), { sub: 'Paint it facing right; it flips' }) : null,
    ),
    h('label', {}, 'Reacts'),
    ...reacts.map(reactRow),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { reacts.push({ on: 'ko', kind: 'hop' }); ctx.changed(); ctx.rerender(); } }, '+ Reaction'),
      h('span', { class: 'hint' }, 'A crowd hopping on KOs, a king tipping over, panels tilting while an event runs.')),
  );
}

/** Effect fields the dynamic kinds add. */
export function effectKinds(): [StageEffect['kind'], string][] {
  return [['firework', 'Firework'], ['burst', 'Burst'], ['shake', 'Camera shake'], ['embers', 'Embers'], ['splat', 'Paint splat (at the hit)'], ['dust', 'Dust cloud'], ['rain', 'Rain'], ['confetti', 'Confetti'], ['flash', 'Screen flash']];
}

export function effectExtras(e: StageEffect, ctx: DynCtx): HTMLElement | null {
  if (e.kind !== 'dust' && e.kind !== 'rain') return null;
  return field('Blows', select<string>([['1', 'Right'], ['-1', 'Left']], String(e.dir ?? 1), (v) => { e.dir = Number(v) === -1 ? -1 : undefined; ctx.changed(); }));
}

// ------------------------------------------------------------- save, check

const r = Math.round;
const tenth = (v: number) => Math.round(v * 10) / 10;

/** Rounds and trims the dynamic parts for saving (the sim reads integers; seconds may be tenths). */
export function cleanDynamics(s: StageDef, from: StageDef): void {
  const evs = (from.events ?? []).filter((e) => e.id);
  if (evs.length) {
    s.events = evs.map((e) => {
      const q: StageEvent = { id: e.id, duration: Math.max(0, tenth(e.duration ?? 0)) };
      if (e.name) q.name = e.name;
      if (e.trigger && e.trigger !== 'timer') q.trigger = e.trigger;
      if ((e.trigger ?? 'timer') === 'timer') {
        if (e.every) q.every = [Math.max(0.5, tenth(e.every[0])), Math.max(0.5, tenth(Math.max(e.every[0], e.every[1])))];
        if (e.first !== undefined) q.first = Math.max(0, tenth(e.first));
      } else if (e.chance !== undefined && e.chance < 100) q.chance = Math.max(1, r(e.chance));
      if (e.warn) q.warn = Math.max(0, tenth(e.warn));
      return q;
    });
  } else delete s.events;
  if (from.zones?.length) {
    s.zones = from.zones.map((z) => {
      const q: StageZone = { kind: z.kind, x1: r(Math.min(z.x1, z.x2)), x2: r(Math.max(z.x1, z.x2)), y1: r(Math.min(z.y1, z.y2)), y2: r(Math.max(z.y1, z.y2)) };
      if (z.id) q.id = z.id;
      if (z.during) q.during = z.during;
      if (z.kind === 'damage') {
        q.damage = tenth(z.damage ?? 1);
        if (z.tick !== undefined) q.tick = Math.max(0.1, tenth(z.tick));
        if (z.knock) q.knock = r(z.knock);
        if (z.knock && z.angle !== undefined) q.angle = r(z.angle);
      }
      if (z.kind === 'wind') q.force = [r(z.force?.[0] ?? 0), r(z.force?.[1] ?? 0)];
      if ((z.kind === 'water' || z.kind === 'gravity') && z.gravity !== undefined) q.gravity = Math.max(0, r(z.gravity));
      return q;
    });
  } else delete s.zones;
  if (from.hazards?.length) {
    s.hazards = from.hazards.filter((hz) => hz.id && hz.path.length).map((hz) => {
      const q: StageHazard = { id: hz.id, path: hz.path.map((p) => ({ x: r(p.x), y: r(p.y) })), r: Math.max(1, r(hz.r)), dmg: Math.max(0, r(hz.dmg)), angle: r(hz.angle), bkb: Math.max(0, r(hz.bkb)), kbg: Math.max(0, r(hz.kbg)) };
      if (hz.during) q.during = hz.during;
      else q.period = Math.max(0.5, tenth(hz.period ?? 4));
      return q;
    });
    if (!s.hazards.length) delete s.hazards;
  } else delete s.hazards;
}

/** Layer and platform fields to keep when saving. */
export function cleanLayerDynamics(q: StageLayer, l: StageLayer): void {
  if (l.anim?.kind) q.anim = { kind: l.anim.kind, ...(l.anim.amount ? { amount: tenth(l.anim.amount) } : {}), ...(l.anim.speed ? { speed: Math.max(0.1, tenth(l.anim.speed)) } : {}) };
  if (l.showDuring) q.showDuring = l.showDuring;
  if (l.hideDuring) q.hideDuring = l.hideDuring;
  if (l.follows) q.follows = l.follows;
  const reacts = (l.reacts ?? []).filter((x) => x.on && x.kind).map((x) => ({ on: x.on, kind: x.kind, ...(x.amount ? { amount: tenth(x.amount) } : {}), ...(x.seconds ? { seconds: tenth(x.seconds) } : {}) }));
  if (reacts.length) q.reacts = reacts;
}

export function cleanPlatformDynamics(q: Platform, p: Platform): void {
  if (p.offDuring) q.offDuring = p.offDuring;
  else if (p.onlyDuring) q.onlyDuring = p.onlyDuring;
}

export function dynamicIssues(st: StageDef): string[] {
  const out: string[] = [];
  const ids = new Set((st.events ?? []).map((e) => e.id));
  const bad = (what: string, id: string | undefined) => {
    if (!id) return;
    const bare = id.replace(/^(warn|event|eventEnd):/, '');
    if (['ko', 'hit', 'start', 'end', 'ambient'].includes(id)) return;
    if (!ids.has(bare)) out.push(`${what} names the event "${bare}", which this stage doesn't have.`);
  };
  st.platforms.forEach((p, i) => bad(`Platform ${i + 1}`, p.offDuring ?? p.onlyDuring));
  (st.zones ?? []).forEach((z, i) => bad(`Zone ${i + 1} (${z.kind})`, z.during));
  (st.hazards ?? []).forEach((hz) => bad(`Hazard ${hz.id}`, hz.during));
  for (const l of st.layers ?? []) {
    bad(`Layer ${l.id}`, l.showDuring);
    bad(`Layer ${l.id}`, l.hideDuring);
    for (const x of l.reacts ?? []) bad(`Layer ${l.id}'s reaction`, x.on);
    if (l.follows && !st.hazards?.some((hz) => hz.id === l.follows)) out.push(`Layer ${l.id} rides the hazard "${l.follows}", which this stage doesn't have.`);
  }
  for (const fx of st.effects ?? []) bad(`An effect (${fx.kind})`, fx.on);
  if (new Set((st.events ?? []).map((e) => e.id)).size !== (st.events ?? []).length) out.push('Two stage events share an id.');
  for (const e of st.events ?? []) {
    const t = e.trigger ?? 'timer';
    if (t === 'timer' && !e.every && e.first === undefined) out.push(`Event ${e.id} has no "every" or "first": it fires once, right at the start.`);
    if (t === 'timer' && e.every && e.every[0] < 5) out.push(`Event ${e.id} can come back within ${e.every[0]}s; that's hectic.`);
    const used = (st.zones ?? []).some((z) => z.during === e.id) || (st.hazards ?? []).some((hz) => hz.during === e.id) || st.platforms.some((p) => p.offDuring === e.id || p.onlyDuring === e.id)
      || (st.layers ?? []).some((l) => l.showDuring?.endsWith(e.id) || l.hideDuring === e.id || l.reacts?.some((x) => x.on.endsWith(`:${e.id}`)))
      || (st.effects ?? []).some((fx) => fx.on.endsWith(`:${e.id}`));
    if (!used) out.push(`Event ${e.id} doesn't change anything yet: give it a zone, hazard, platform, art or effect.`);
  }
  const b = st.blast;
  for (const hz of st.hazards ?? []) {
    if (hz.during) {
      const ev = st.events?.find((e) => e.id === hz.during);
      if (ev && ev.duration < 1) out.push(`Hazard ${hz.id} rides event ${ev.id}, which lasts under a second: it zips across.`);
    }
    if (hz.path.some((p) => p.x < b.left - 400 || p.x > b.right + 400 || p.y < b.bottom - 400 || p.y > b.top + 400)) out.push(`Hazard ${hz.id}'s path goes far past the blast zone.`);
  }
  const solids = st.platforms.map((p, i) => ({ p, i })).filter(({ p }) => p.solid);
  if (solids.length && solids.every(({ p }) => p.offDuring || p.onlyDuring)) out.push('Every solid platform comes and goes with events: there will be moments with nowhere to stand.');
  st.spawns.forEach((s, i) => {
    const under = st.platforms.find((p) => p.y === s.y && s.x >= p.x1 && s.x <= p.x2);
    if (under?.onlyDuring) out.push(`Spawn ${i + 1} stands on a platform that only exists during ${under.onlyDuring}.`);
  });
  return out;
}

