// The victory stage at the top of the results screen: the winner on a lit podium playing a pose clip in their colour look, a slow
// camera push-in, confetti and sparks in their colour, the loser in a dim inset, the group's 5 s fanfare (victory.ts). The results
// panel slides in after PANEL_AT_MS, or at once on any input (which also cuts the fanfare). Presentation only.
//
// The in-match spark pool (render/renderer.ts) is Babylon meshes on the match canvas, which is gone by now: the same look
// (a soft round spark, gravity, fade) is drawn here on a 2D canvas over the stage.

import { CHARACTERS } from '../sim/characters.ts';
import { audio } from '../audio.ts';
import { loadAnimSet, type AnimSet } from '../render/anims.ts';
import { lookOf, recolorUrl } from '../looks.ts';
import { h, largeUrl } from './dom.ts';
import { paintImage } from './lookUi.ts';
import {
  LOSER_CLIPS, PANEL_AT_MS, WINNER_CLIPS, clipIndex, fanfareFor, makeConfetti, pickPoseClip, pushScale, rng, stepConfetto, victoryHop,
  type ClipInfo, type Confetto,
} from '../victory.ts';

export interface VictoryOptions {
  winnerChar: number;
  winnerLook: number;
  winnerColor: string;
  winnerName: string;
  /** The beaten fighter for the inset (undefined: no inset). */
  loserChar?: number;
  loserLook?: number;
  loserName?: string;
  /** The typed win quote under the podium. */
  caption?: HTMLElement | null;
}

export interface Victory {
  el: HTMLElement;
  /** Starts the clips, confetti, fanfare and the panel timer. `row` is the element whose data-phase flips pose -> panel. */
  start(row: HTMLElement): void;
}

/** What the last stage is doing (the playtest reads it through `dod:victory`). */
let cancelLast: (() => void) | null = null;
/** True while a fanfare is still playing; results music waits for it. */
let fanfarePlaying = false;
const endWaiters: (() => void)[] = [];

/** Results music (the loop) once the fanfare is over; at once when there was none. */
export function startResultsMusic(): void {
  if (!fanfarePlaying) {
    audio.playMusic('music-results');
    return;
  }
  audio.playMusic(null);
  endWaiters.push(() => audio.playMusic('music-results'));
}

function fanfareOver(): void {
  fanfarePlaying = false;
  for (const f of endWaiters.splice(0)) f();
}

/** A sprite element showing a clip's sheet (recoloured by the look), stepped by `tick`. */
function spriteFor(char: number, look: number, wanted: string[], role: string, color: string): { el: HTMLElement; tick: (ms: number) => void; ready: Promise<string | null> } {
  const still = h('img', { alt: '', class: 'vic-still' }) as HTMLImageElement;
  paintImage(still, largeUrl(CHARACTERS[char].id), char, look);
  const el = h('div', { class: `vic-fighter vic-${role}`, style: `--slot:${color}` }, still);
  let clip: (ClipInfo & { cols: number; rows: number }) | null = null;
  let sprite: HTMLElement | null = null;
  const ready = loadAnimSet(CHARACTERS[char].id).then((set: AnimSet | null) => {
    if (!set) return null;
    const pick = pickPoseClip(set.clips, wanted);
    if (!pick || !el.isConnected) return null;
    const c = pick.clip;
    const s = h('div', { class: 'vic-sprite' });
    s.style.aspectRatio = `${c.fw} / ${c.fh}`;
    const sheet = `${set.base}${c.file}?v=${set.version}`;
    s.style.backgroundImage = `url(${sheet})`;
    if (look > 0) void recolorUrl(sheet, lookOf(char, look)).then((u) => { if (s.isConnected) s.style.backgroundImage = `url(${u})`; });
    s.style.backgroundSize = `${c.cols * 100}% ${c.rows * 100}%`;
    still.replaceWith(s);
    sprite = s;
    clip = c;
    return pick.key;
  });
  const tick = (ms: number) => {
    if (!clip || !sprite) return;
    const i = clipIndex(clip, ms);
    const x = clip.cols > 1 ? ((i % clip.cols) / (clip.cols - 1)) * 100 : 0;
    const y = clip.rows > 1 ? (Math.floor(i / clip.cols) / (clip.rows - 1)) * 100 : 0;
    sprite.style.backgroundPosition = `${x}% ${y}%`;
  };
  return { el, tick, ready };
}

export function victoryStage(o: VictoryOptions): Victory {
  const group = fanfareFor(CHARACTERS[o.winnerChar].id);
  const win = spriteFor(o.winnerChar, o.winnerLook, WINNER_CLIPS, 'winner', o.winnerColor);
  const lose = o.loserChar !== undefined ? spriteFor(o.loserChar, o.loserLook ?? 0, LOSER_CLIPS, 'loser', '#8a8f99') : null;
  const canvas = h('canvas', { class: 'vic-confetti', 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const cam = h('div', { class: 'vic-cam' }, h('div', { class: 'vic-podium' }, win.el, h('div', { class: 'vic-plinth' }, h('b', {}, '1'))));
  const el = h(
    'section',
    { class: 'victory', 'aria-label': 'Victory', 'data-group': group.id, 'data-fanfare': group.sound, 'data-winner': CHARACTERS[o.winnerChar].id, style: `--slot:${o.winnerColor}` },
    h('div', { class: 'vic-beam', 'aria-hidden': 'true' }),
    cam,
    canvas,
    lose
      ? h('aside', { class: 'vic-inset', 'data-mood': 'sulking', 'aria-label': `${o.loserName ?? 'The loser'}, sulking` }, lose.el, h('span', {}, `${o.loserName ?? 'Loser'} · sulking`))
      : null,
    h('div', { class: 'vic-caption' }, h('p', { class: 'vic-name' }, o.winnerName, h('small', {}, group.name)), o.caption ?? null),
  );

  const start = (row: HTMLElement) => {
    cancelLast?.();
    row.dataset.phase = 'pose';
    const t0 = performance.now();
    let raf = 0;
    let dead = false;
    let parts: Confetto[] = [];
    const rand = rng(Math.floor(t0) % 9973);
    const ctx = canvas.getContext('2d');
    let last = t0;
    let nextBurst = 0;
    let stopFanfare: () => void = () => undefined;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    void win.ready.then((key) => window.dispatchEvent(new CustomEvent('dod:victory-clip', { detail: { role: 'winner', clip: key } })));
    if (lose) void lose.ready.then((key) => window.dispatchEvent(new CustomEvent('dod:victory-clip', { detail: { role: 'loser', clip: key } })));

    const frame = (now: number) => {
      if (dead) return;
      if (!el.isConnected) return finish('left');
      const ms = now - t0;
      win.tick(ms);
      lose?.tick(ms);
      cam.style.transform = reduced ? '' : `scale(${pushScale(ms).toFixed(4)})`;
      const hop = reduced ? 0 : victoryHop(ms, el.clientHeight * 0.06);
      win.el.style.transform = `translateY(${(-hop).toFixed(1)}px)`;
      if (ctx) {
        const w = (canvas.width = canvas.clientWidth);
        const hgt = (canvas.height = canvas.clientHeight);
        if (!reduced && ms >= nextBurst && ms < 4200) {
          parts.push(...makeConfetti(14, w, o.winnerColor, rand));
          nextBurst = ms + 260;
        }
        const dt = Math.min(0.05, (now - last) / 1000);
        parts = parts.filter((c) => stepConfetto(c, dt, hgt));
        for (const c of parts) {
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(c.rot);
          ctx.fillStyle = c.color;
          if (c.spark) {
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(0, 0, c.size, 0, Math.PI * 2);
            ctx.fill();
          } else ctx.fillRect(-c.size / 2, -c.size / 3, c.size, c.size * 0.66);
          ctx.restore();
        }
        el.dataset.confetti = String(parts.length);
      }
      last = now;
      raf = requestAnimationFrame(frame);
    };

    const toPanel = (why: string) => {
      if (row.dataset.phase === 'panel') return;
      row.dataset.phase = 'panel';
      window.dispatchEvent(new CustomEvent('dod:victory-panel', { detail: { why, ms: Math.round(performance.now() - t0) } }));
    };
    const onInput = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).repeat) return;
      toPanel('input');
      stopFanfare();
    };
    const timer = window.setTimeout(() => toPanel('time'), PANEL_AT_MS);
    // Let the opening frame land before a stray press can skip it.
    const arm = window.setTimeout(() => {
      window.addEventListener('keydown', onInput);
      window.addEventListener('pointerdown', onInput);
    }, 250);

    function finish(why: string): void {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearTimeout(arm);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('pointerdown', onInput);
      toPanel(why);
      stopFanfare();
      if (cancelLast === cancel) cancelLast = null;
    }
    const cancel = () => finish('replaced');
    cancelLast = cancel;

    // The fanfare: the group's 5 s take, if it is made; the results loop waits for it.
    if (audio.hasSound(group.sound)) {
      fanfarePlaying = true;
      const onEnd = () => {
        window.removeEventListener('dod:fanfare-end', onEnd);
        fanfareOver();
      };
      window.addEventListener('dod:fanfare-end', onEnd);
      stopFanfare = audio.fanfare(group.sound);
    }
    window.dispatchEvent(new CustomEvent('dod:victory', {
      detail: { group: group.id, fanfare: group.sound, hasFanfare: audio.hasSound(group.sound), winner: CHARACTERS[o.winnerChar].id, loser: o.loserChar !== undefined ? CHARACTERS[o.loserChar].id : null, color: o.winnerColor, look: o.winnerLook },
    }));
    raf = requestAnimationFrame(frame);
  };
  return { el, start };
}
