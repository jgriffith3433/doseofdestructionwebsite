// The episode's bookends (docs/story.md "Previously and Next time"): the replay of the final KO, "Next time on Dose of
// Destruction" and "Previously on Dose of Destruction". Each is one segment on the arena, with the show's lower third
// (tag, episode title), the logo bug, Blog Man's voiced line as one short caption, and the letterbox. Any key, click,
// tap or pad button skips the segment at once (Esc and Start too, through registerSceneSkip); the caller carries on
// with the next thing. The playtest reads `dod:segment` events (kind, phase, at, ms, skipped).

import type { SimEvent } from '../sim/step.ts';
import type { GameState } from '../sim/state.ts';
import type { SynthKind } from '../synth.ts';
import { chunkLine, chunkTimes } from '../campaign/sceneText.ts';
import { $, headUrl } from './dom.ts';
import { registerSceneSkip } from './scene.ts';

/** Something the arena draws and advances by itself: a highlight being replayed, or the next episode's cast standing by. */
export interface Showcase {
  state: GameState;
  advance(dtMs: number): SimEvent[];
  /** True once it has played to its end (a replay). Without it the segment runs for `holdMs`. */
  done?(): boolean;
  /** True while the final hit plays in slow motion. */
  slowed?(): boolean;
}

/** What a segment drives: main.ts wires these to the renderer and the sound. */
export interface SegmentEnv {
  /** Draw and advance this instead of the match (null hands the arena back). */
  showcase(sc: Showcase | null): void;
  events(events: SimEvent[]): void;
  direct(shot: { focus: number | null } | null): void;
  voice(url: string | null | undefined): void;
  stopVoice(): void;
  voiceMs(url: string | null | undefined): Promise<number | null>;
  synth(kind: SynthKind, level?: number): void;
  duck(on: boolean): void;
}

export interface SegmentOpts {
  kind: 'replay' | 'recap' | 'tease';
  /** The lower third: its tag ("Replay", "Previously on Dose of Destruction"), kicker and the episode title. */
  tag: string;
  kicker: string;
  title: string;
  /** Blog Man's line: shown as one short caption, voiced if it has a take. */
  line?: { id: string; text: string; audio?: string | null };
  showcase: Showcase;
  /** The fighter the camera is on in each cut (null: wide). One cut when omitted: the fight's own camera. */
  cuts?: (number | null)[];
  /** How long a segment without a replay plays at least, ms. */
  holdMs?: number;
  /** Extra facts for the playtest's `start` event (the stage shown, the episode). */
  info?: Record<string, unknown>;
}

export interface SegmentEnd {
  skipped: boolean;
  ms: number;
}

/** The longest a segment plays, whatever it is waiting for. */
export const SEGMENT_MAX_MS = 6500;
/** A press this soon after a segment starts is the press that ended the one before: it does not skip. */
const ARM_MS = 180;
/** After the replay (or the voice) ends, the picture holds this long before the next thing. */
const HOLD_AFTER_MS = 450;

let playing = false;

/** Whether a segment is on. */
export function segmentShowing(): boolean {
  return playing;
}

export function playSegment(env: SegmentEnv, o: SegmentOpts): Promise<SegmentEnd> {
  const root = $('scene');
  const cardEl = $('scene-card');
  const bug = $('scene-bug');
  const sub = $('scene-sub');
  const head = $<HTMLImageElement>('scene-head');
  const whoEl = $('scene-who');
  const textEl = $('scene-text');
  const next = $<HTMLButtonElement>('scene-next');
  const skip = $<HTMLButtonElement>('scene-skip');
  const t0 = performance.now();
  const emit = (phase: string, detail: Record<string, unknown> = {}) =>
    window.dispatchEvent(new CustomEvent('dod:segment', { detail: { kind: o.kind, phase, at: Math.round(performance.now() - t0), ...detail } }));

  return new Promise((resolve) => {
    let ended = false;
    let cap = 0;
    let endTimer = 0;
    let pad = 0;
    let voiceEnd = 0;
    let voiceKnown = !o.line?.audio;
    let slowSeen = false;
    const timers: number[] = [];
    const armedAt = t0 + ARM_MS;

    const finish = (skipped: boolean) => {
      if (ended) return;
      ended = true;
      playing = false;
      clearTimeout(cap);
      clearTimeout(endTimer);
      for (const t of timers) clearTimeout(t);
      cancelAnimationFrame(pad);
      env.showcase(null);
      env.stopVoice();
      env.duck(false);
      env.direct(null);
      registerSceneSkip(null);
      window.removeEventListener('keydown', onInput, true);
      window.removeEventListener('pointerdown', onInput, true);
      next.hidden = false;
      document.body.classList.remove('scene-on');
      bug.hidden = true;
      cardEl.hidden = true;
      cardEl.classList.remove('card-up', 'card-down');
      sub.hidden = true;
      sub.classList.remove('segment');
      root.classList.remove('scene-in', 'slowmo');
      root.hidden = true;
      root.removeAttribute('data-scene');
      root.removeAttribute('data-beat');
      const ms = Math.round(performance.now() - t0);
      emit('end', { skipped, ms });
      resolve({ skipped, ms });
    };
    /** The segment's work is done: hold a moment, then end. */
    const settle = () => {
      if (ended || endTimer) return;
      if (!voiceKnown) return;
      const wait = Math.max(HOLD_AFTER_MS, voiceEnd - performance.now() + 200);
      endTimer = window.setTimeout(() => finish(false), wait);
    };
    function onInput(e: Event): void {
      if (performance.now() < armedAt) return;
      // The press belongs to this segment: nothing underneath reacts to it.
      e.stopPropagation();
      if (e instanceof KeyboardEvent) e.preventDefault();
      emit('input', { type: e.type });
      finish(true);
    }
    const pressed = (): boolean => [...(navigator.getGamepads?.() ?? [])].some((g) => g?.buttons.some((b) => b.pressed));
    let padHeld = pressed();
    const listenPad = () => {
      if (ended) return;
      const now = pressed();
      if (now && !padHeld && performance.now() >= armedAt) return finish(true);
      padHeld = now;
      pad = requestAnimationFrame(listenPad);
    };

    // The arena draws and advances the showcase (main.ts frame loop); the segment watches for its end and the slow part.
    const sc = o.showcase;
    env.showcase({
      state: sc.state,
      advance: (dt) => {
        const ev = sc.advance(dt);
        if (ev.length) env.events(ev);
        if (sc.slowed?.() && !slowSeen) {
          slowSeen = true;
          root.classList.add('slowmo');
          root.dataset.beat = 'slow';
          env.synth('whoosh', 0.6);
          emit('slow');
        } else if (slowSeen && !sc.slowed?.() && root.classList.contains('slowmo')) {
          root.classList.remove('slowmo');
          root.dataset.beat = 'tail';
        }
        if (sc.done?.()) settle();
        return ev;
      },
      done: sc.done,
      slowed: sc.slowed,
    });

    registerSceneSkip(() => {
      if (performance.now() >= armedAt) finish(true);
    });
    skip.onclick = null;
    next.hidden = true;
    window.addEventListener('keydown', onInput, true);
    window.addEventListener('pointerdown', onInput, true);
    pad = requestAnimationFrame(listenPad);
    playing = true;
    document.body.classList.add('scene-on');
    root.dataset.scene = o.kind === 'replay' ? 'highlight' : o.kind;
    root.dataset.beat = 'start';
    root.hidden = false;
    void root.offsetWidth;
    root.classList.add('scene-in');
    env.duck(true);

    // The logo bug and the lower third.
    $('scene-bug-tag').textContent = o.kind === 'replay' ? 'Replay' : o.kind === 'recap' ? 'Previously' : 'Next time';
    bug.hidden = false;
    $('scene-card-tag').textContent = o.tag;
    $('scene-card-kicker').textContent = o.kicker;
    $('scene-card-title').textContent = o.title;
    $('scene-card-line').textContent = '';
    cardEl.hidden = false;
    cardEl.classList.remove('card-down', 'card-up');
    void cardEl.offsetWidth;
    cardEl.classList.add('card-up');

    // Blog Man's line: one short caption, and his voice.
    const line = o.line;
    sub.hidden = true;
    if (line) {
      const pieces = chunkLine(line.text);
      let i = 0;
      let times = chunkTimes(pieces, null);
      let pieceTimer = 0;
      const show = () => {
        if (ended) return;
        textEl.textContent = pieces[i];
        sub.dataset.who = 'blog-man';
        sub.classList.remove('sub-in');
        void sub.offsetWidth;
        sub.classList.add('sub-in');
        if (++i < pieces.length) pieceTimer = window.setTimeout(show, times[i - 1]);
      };
      sub.classList.add('segment');
      sub.classList.remove('narration');
      whoEl.textContent = 'Blog Man';
      whoEl.hidden = false;
      head.src = headUrl('blog-man');
      head.hidden = false;
      sub.hidden = false;
      show();
      timers.push(pieceTimer);
      env.voice(line.audio);
      emit('line', { id: line.id, text: line.text, audio: line.audio ?? null });
      if (line.audio) {
        void env.voiceMs(line.audio).then((ms) => {
          if (ended) return;
          voiceKnown = true;
          if (ms) {
            voiceEnd = performance.now() + ms;
            times = chunkTimes(pieces, ms);
          }
          if (sc.done?.() || !o.showcase.done) settle();
        });
      }
    }

    // Cuts: the tease's two quick shots, split over the segment; a replay keeps the fight's own camera.
    if (o.cuts?.length) {
      const total = Math.max(o.holdMs ?? 2800, 1200);
      o.cuts.forEach((focus, n) => {
        timers.push(
          window.setTimeout(() => {
            if (ended) return;
            env.direct({ focus });
            env.synth(n === 0 ? 'sting' : 'whoosh', 0.6);
            root.dataset.beat = `cut-${n}`;
            emit('cut', { index: n, focus });
          }, (total / o.cuts!.length) * n),
        );
      });
    } else env.direct(null);

    // A segment with no replay plays for its hold; every segment has a ceiling.
    if (!sc.done) timers.push(window.setTimeout(settle, o.holdMs ?? 2800));
    cap = window.setTimeout(() => finish(false), SEGMENT_MAX_MS);
    emit('start', { title: o.title, tag: o.tag, cuts: o.cuts?.length ?? 0, ...o.info });
  });
}
