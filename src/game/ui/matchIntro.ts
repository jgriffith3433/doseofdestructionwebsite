// The match intro's screen side (campaign/intro.ts has the maths, render/renderer.ts draws the fly-in and the
// entrances): the stage-name lower third, the entering fighter's name strap, the announcer's stage call, and the
// input that skips it all. Any input skips, at once: a tap, a key, a pad button, Esc.

import { CHARACTERS } from '../sim/characters.ts';
import { $, h } from './dom.ts';
import { registerSceneSkip } from './scene.ts';
import type { IntroPlan } from '../campaign/intro.ts';

export interface IntroStage {
  id: string;
  name: string;
  blurb: string;
}

/** What the intro drives, wired by main.ts. */
export interface IntroEnv {
  begin(plan: IntroPlan): void;
  end(): void;
  /** The announcer's call for the stage, when that line is recorded; false when there is none (the caption stands alone). */
  stageCall(id: string): boolean;
  /** The local input bits (keyboard, pad, touch, the playtest's virtual pad): a new one skips. */
  input(): number;
}

export interface IntroEnd {
  skipped: boolean;
  ms: number;
  /** True when the announcer's stage call played. */
  called: boolean;
}

/** The lower third appears this long after the fly-in begins, and goes before the last entrance settles. */
const CARD_IN_MS = 200;
const CARD_OUT_MS = 2500;

let lower: HTMLElement | null = null;

function lowerThird(): HTMLElement {
  if (!lower) {
    lower = h(
      'div',
      { id: 'intro-lower', class: 'intro-lower', hidden: true, 'aria-live': 'polite' },
      h('p', { class: 'intro-tag' }, 'Tonight on Dose of Destruction'),
      h('h2', { class: 'intro-stage' }),
      h('p', { class: 'intro-blurb' }),
      h('p', { class: 'intro-who' }),
    );
    document.body.appendChild(lower);
  }
  return lower;
}

const detail = (d: Record<string, unknown>): void => {
  window.dispatchEvent(new CustomEvent('dod:match-intro', { detail: d }));
};

/** Plays the intro; resolves when it ends by itself or is skipped. */
export function playMatchIntro(env: IntroEnv, plan: IntroPlan, stage: IntroStage): Promise<IntroEnd> {
  const el = lowerThird();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const timers: number[] = [];
    let ended = false;
    let raf = 0;
    let lastInput = env.input();
    let called = false;

    const finish = (skipped: boolean): void => {
      if (ended) return;
      ended = true;
      for (const t of timers) clearTimeout(t);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      registerSceneSkip(null);
      document.body.classList.remove('intro-on');
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => {
        if (!document.body.classList.contains('intro-on')) el.hidden = true;
      }, 360);
      env.end();
      const ms = Math.round(performance.now() - t0);
      detail({ phase: 'end', skipped, ms, called });
      resolve({ skipped, ms, called });
    };
    const onPointer = (e: PointerEvent): void => {
      e.stopPropagation();
      detail({ phase: 'input', kind: e.pointerType || 'pointer', ms: Math.round(performance.now() - t0) });
      finish(true);
    };
    const onKey = (e: KeyboardEvent): void => {
      // A held key from the screen before (Enter on the stage card repeating) is not a new input.
      if (e.repeat) return;
      detail({ phase: 'input', kind: `key ${e.code}`, ms: Math.round(performance.now() - t0) });
      finish(true);
    };
    const poll = (): void => {
      if (ended) return;
      const now = env.input();
      if ((now & ~lastInput) !== 0) {
        detail({ phase: 'input', kind: 'pad', ms: Math.round(performance.now() - t0) });
        return finish(true);
      }
      lastInput = now;
      raf = requestAnimationFrame(poll);
    };

    el.querySelector('.intro-stage')!.textContent = stage.name;
    el.querySelector('.intro-blurb')!.textContent = stage.blurb;
    el.querySelector('.intro-who')!.textContent = '';
    el.classList.remove('in', 'out');
    el.hidden = false;
    document.body.classList.add('intro-on');
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    registerSceneSkip(() => finish(true));
    raf = requestAnimationFrame(poll);

    env.begin(plan);
    detail({ phase: 'start', stage: stage.id, totalMs: plan.totalMs, kinds: plan.entries.map((e) => `${e.who}:${e.kind}`) });
    timers.push(window.setTimeout(() => {
      el.classList.add('in');
      called = env.stageCall(stage.id);
      detail({ phase: 'card', stage: stage.id, name: stage.name, voiced: called, ms: Math.round(performance.now() - t0) });
    }, CARD_IN_MS));
    timers.push(window.setTimeout(() => el.classList.remove('in'), CARD_OUT_MS));
    for (const e of plan.entries) {
      timers.push(window.setTimeout(() => {
        const who = el.querySelector<HTMLElement>('.intro-who')!;
        who.textContent = CHARACTERS.find((c) => c.id === e.who)?.name ?? e.who;
        who.style.setProperty('--slot', e.color);
        who.classList.remove('pop');
        void who.offsetWidth;
        who.classList.add('pop');
        detail({ phase: 'entrance', who: e.who, kind: e.kind, slot: e.slot, ms: Math.round(performance.now() - t0) });
      }, e.startMs));
    }
    timers.push(window.setTimeout(() => finish(false), plan.totalMs));
  });
}
