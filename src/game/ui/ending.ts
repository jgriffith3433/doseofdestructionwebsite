// A Tour's ending: the fighter's painted picture full screen with a slow push-in, two caption lines (the second narrated
// by Blog Man), the fighter's sting, then the "Tour complete" card with the colour they earned. 12-15 s; a tap, Enter,
// Space or Esc skips. The gallery (Extras) replays it. Rules and data: campaign/endings.ts.

import { audio } from '../audio.ts';
import { CHARACTERS, characterIndex } from '../sim/characters.ts';
import { lookOf, lookOpen, looksOf, swatchColor } from '../looks.ts';
import { ENDING_BEATS, type Ending } from '../campaign/endings.ts';
import { $, h } from './dom.ts';

export interface EndingResult {
  skipped: boolean;
  /** ms played. */
  ms: number;
}

let active = false;
export const endingShowing = (): boolean => active;

/** The best colour the fighter has open (the one the Tour's wins earned): its index, name and swatch. */
export function earnedLook(fighter: string): { index: number; name: string; color: string } {
  const char = characterIndex(fighter);
  let best = 0;
  for (let i = 0; i < looksOf(char).length; i++) if (lookOpen(char, i)) best = i;
  return { index: best, name: lookOf(char, best).name, color: swatchColor(char, best) };
}

const fire = (phase: string, detail: Record<string, unknown>): void => {
  window.dispatchEvent(new CustomEvent('dod:ending', { detail: { phase, ...detail } }));
};

/** Plays the ending over everything. `replay` is the gallery's: the card names the ending instead of the clear. */
export function playEnding(e: Ending, opts: { replay?: boolean; speed?: number } = {}): Promise<EndingResult> {
  const root = $('ending');
  const name = CHARACTERS.find((c) => c.id === e.fighter)?.name ?? e.fighter;
  const look = earnedLook(e.fighter);
  const speed = opts.speed ?? 1;
  const at = (ms: number): number => ms / speed;
  const total = ENDING_BEATS.end / speed;
  const cap = h('p', { class: 'ending-caption', id: 'ending-caption', 'aria-live': 'polite' });
  const img = h('img', { class: 'ending-art', id: 'ending-art', src: e.art, alt: `${name}'s ending` }) as HTMLImageElement;
  img.style.setProperty("--ending-ms", `${total}ms`);
  const card = h(
    'div',
    { class: 'ending-card', id: 'ending-card' },
    h('p', { class: 'kicker' }, opts.replay ? 'Ending' : 'Tour complete'),
    h('h2', {}, opts.replay ? name : `${name} clears the Tour`),
    h('p', { class: 'ending-look' }, h('i', { class: 'ending-swatch', style: `background:${look.color}` }), `Colour earned: ${look.name}`),
  );
  const skip = h('button', { type: 'button', class: 'ending-skip', id: 'ending-skip', 'aria-label': 'Skip the ending' }, 'Skip');
  root.replaceChildren(img, h('div', { class: 'ending-shade' }), cap, card, skip);
  root.hidden = false;
  root.classList.add('on');
  root.classList.remove('carded');
  active = true;
  const started = performance.now();
  fire('start', { fighter: e.fighter, replay: !!opts.replay, art: e.art, lines: e.lines, audio: e.audio ?? null });

  return new Promise((resolve) => {
    const timers: number[] = [];
    let done = false;
    const say = (n: 0 | 1): void => {
      cap.textContent = e.lines[n];
      cap.classList.remove('in');
      void cap.offsetWidth;
      cap.classList.add('in');
      fire('caption', { fighter: e.fighter, n: n + 1, text: e.lines[n], voiced: n === 1 && !!e.audio });
    };
    const finish = (skipped: boolean): void => {
      if (done) return;
      done = true;
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('pointerdown', onTap);
      audio.stopVoice();
      audio.duck(false);
      active = false;
      root.classList.remove('on', 'carded');
      root.hidden = true;
      root.replaceChildren();
      const ms = Math.round(performance.now() - started);
      fire('end', { fighter: e.fighter, replay: !!opts.replay, skipped, ms });
      resolve({ skipped, ms });
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (['Enter', ' ', 'Escape', 'Backspace'].includes(ev.key)) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
      }
    };
    const onTap = (): void => finish(true);
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', onTap);
    skip.focus({ preventScroll: true });
    audio.duck(true);
    timers.push(window.setTimeout(() => say(0), at(ENDING_BEATS.caption1)));
    timers.push(
      window.setTimeout(() => {
        say(1);
        audio.voice(e.audio);
      }, at(ENDING_BEATS.caption2)),
    );
    timers.push(
      window.setTimeout(() => {
        audio.duck(false);
        audio.synth('sting');
        audio.synth('cheer', 0.6);
        fire('sting', { fighter: e.fighter });
      }, at(ENDING_BEATS.sting)),
    );
    timers.push(
      window.setTimeout(() => {
        cap.classList.remove('in');
        root.classList.add('carded');
        fire('card', { fighter: e.fighter, look: look.name, color: look.color, replay: !!opts.replay });
      }, at(ENDING_BEATS.card)),
    );
    timers.push(window.setTimeout(() => finish(false), total));
  });
}
