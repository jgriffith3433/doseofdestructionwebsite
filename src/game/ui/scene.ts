// Live story scenes (studio quality rule 6e/6f/6g): an episode's intro and outro play in the arena, on the
// match screen, with the real fighters, instead of on a text screen. The camera eases between a wide shot and
// the speaker, fighters drop onto the stage one by one, the studio crowd reacts, voice takes play over ducked
// music, and the only text on screen is one short line at a time (campaign/sceneText.ts). The episode's story
// card is the show's lower third ("Tonight" / "Signing off"). Next moves on a line; Skip, Esc or Start ends it.

import { CHARACTERS } from '../sim/characters.ts';
import { chunkLine, chunkTimes } from '../campaign/sceneText.ts';
import type { ColdOpenBeat } from '../campaign/story.ts';
import type { SynthKind } from '../synth.ts';
import { $, headUrl } from './dom.ts';

export interface SceneLine {
  who: string;
  text: string;
  audio?: string | null;
}

export interface SceneCard {
  kicker: string;
  title: string;
  line: string;
}

/** What the scene drives: the arena camera and fighters, and the sound. main.ts wires these to its systems. */
export interface SceneStage {
  /** Fighters in the match: their sim id and character id (e.g. 'exit-punk'), player first. */
  cast: { id: number; who: string }[];
  direct(shot: { focus: number | null } | null): void;
  holdOffstage(id: number, held: boolean): void;
  arrive(id: number): void;
  cue(id: number): void;
  /** Optional: play the fighter's match taunt bark (cold opens). */
  taunt?(who: string): void;
  voice(url: string | null | undefined): void;
  stopVoice(): void;
  voiceMs(url: string | null | undefined): Promise<number | null>;
  synth(kind: SynthKind, level?: number): void;
  duck(on: boolean): void;
}

export interface SceneEnd {
  /** True when Skip (or Esc/Start) ended it. */
  skipped: boolean;
  /** The last line shown. */
  line: number;
  /** True when the story card was cut short with Next or Skip. */
  cardSkipped: boolean;
}

/** How long the story card holds by itself (Next or Skip ends it sooner). */
export const SCENE_CARD_MS = 4200;
/** Time between two fighters' arrivals. */
const ARRIVAL_GAP_MS = 650;

let active: { skip: () => void } | null = null;

/** Whether a story scene is playing. */
export function sceneShowing(): boolean {
  return active !== null;
}

/** Ends the scene that is playing, as Skip does (Esc or Start in main.ts). */
export function skipScene(): void {
  active?.skip();
}

/**
 * Plays a scene over the arena. `which` is 'intro' (before Ready: fighters arrive, card says Tonight) or
 * 'outro' (after Game!: card says Signing off). Resolves when it ends.
 */
export function playScene(stage: SceneStage, which: 'intro' | 'outro', lines: SceneLine[], card: SceneCard | null): Promise<SceneEnd> {
  const root = $('scene');
  const cardEl = $('scene-card');
  const sub = $('scene-sub');
  const head = $<HTMLImageElement>('scene-head');
  const whoEl = $('scene-who');
  const textEl = $('scene-text');
  const next = $<HTMLButtonElement>('scene-next');
  const skip = $<HTMLButtonElement>('scene-skip');

  return new Promise((resolve) => {
    let timer = 0;
    const arrivals: number[] = [];
    let line = -1;
    let chunk = 0;
    let chunks: string[] = [];
    let times: number[] = [];
    let cardUp = false;
    let cardSkipped = false;
    let ended = false;
    let step: () => void = () => {};

    const clearTimers = () => {
      clearTimeout(timer);
      for (const a of arrivals) clearTimeout(a);
      arrivals.length = 0;
    };
    const finish = (skipped: boolean) => {
      if (ended) return;
      ended = true;
      if (cardUp && skipped) cardSkipped = true;
      clearTimers();
      stage.stopVoice();
      stage.duck(false);
      // Anyone still waiting in the wings is on stage when play starts.
      for (const c of stage.cast) stage.holdOffstage(c.id, false);
      stage.direct(null);
      next.onclick = null;
      skip.onclick = null;
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('scene-on');
      cardEl.hidden = true;
      cardEl.classList.remove('card-up', 'card-down');
      sub.hidden = true;
      root.classList.remove('scene-in');
      root.hidden = true;
      root.removeAttribute('data-scene');
      root.removeAttribute('data-beat');
      active = null;
      resolve({ skipped, line: Math.max(0, Math.min(line, lines.length - 1)), cardSkipped });
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLButtonElement) return;
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        step();
      }
    };

    // ------------------------------------------------------------ beats

    const showChunk = () => {
      const l = lines[line];
      textEl.textContent = chunks[chunk];
      // Restart the line's entrance so each piece reads as new.
      sub.classList.remove('sub-in');
      void sub.offsetWidth;
      sub.classList.add('sub-in');
      root.dataset.beat = `line-${line}-${chunk}`;
      sub.dataset.who = l.who;
      timer = window.setTimeout(advanceChunk, times[chunk]);
    };
    const advanceChunk = () => {
      clearTimeout(timer);
      if (ended) return;
      if (++chunk < chunks.length) showChunk();
      else nextLine();
    };
    const nextLine = () => {
      clearTimeout(timer);
      if (ended) return;
      line++;
      if (line >= lines.length) return finish(false);
      const l = lines[line];
      const narrator = l.who === 'narrator';
      const ch = CHARACTERS.find((c) => c.id === l.who);
      const onStage = stage.cast.find((c) => c.who === l.who);
      // The speaker gets the camera; anyone not in the fight (the host, the narrator) is heard over a wide shot.
      stage.direct({ focus: onStage ? onStage.id : null });
      if (onStage) stage.cue(onStage.id);
      whoEl.textContent = narrator ? '' : (ch?.name ?? l.who);
      whoEl.hidden = narrator;
      head.hidden = narrator || !ch || !!onStage;
      if (ch && !onStage) head.src = headUrl(ch.id);
      sub.classList.toggle('narration', narrator);
      sub.hidden = false;
      next.textContent = line === lines.length - 1 ? (which === 'intro' ? 'Fight' : 'Continue') : 'Next';
      chunks = chunkLine(l.text);
      chunk = 0;
      stage.voice(l.audio);
      const shown = line;
      // Time the pieces from the take once it is decoded; a reading time stands in until then.
      times = chunkTimes(chunks, null);
      void stage.voiceMs(l.audio).then((ms) => {
        if (ms && shown === line && !ended) {
          times = chunkTimes(chunks, ms);
          clearTimeout(timer);
          timer = window.setTimeout(advanceChunk, times[chunk]);
        }
      });
      showChunk();
    };
    const endCard = () => {
      clearTimeout(timer);
      if (ended || !cardUp) return;
      cardUp = false;
      cardEl.classList.remove('card-up');
      cardEl.classList.add('card-down');
      // Fighters still on their way in land now.
      for (const a of arrivals) clearTimeout(a);
      arrivals.length = 0;
      for (const c of stage.cast) arriveOnce(c.id);
      stage.duck(true);
      nextLine();
    };
    const arrived = new Set<number>();
    const arriveOnce = (id: number) => {
      if (arrived.has(id)) return;
      arrived.add(id);
      stage.synth('whoosh', 0.7);
      stage.arrive(id);
    };

    step = () => {
      if (ended) return;
      if (cardUp) {
        cardSkipped = true;
        endCard();
      } else if (line >= 0) {
        // A press cuts the voice at the next line, like a player reading faster.
        if (chunk >= chunks.length - 1) stage.stopVoice();
        advanceChunk();
      }
    };
    const skipNow = () => finish(true);
    active = { skip: skipNow };

    next.onclick = step;
    skip.onclick = skipNow;
    window.addEventListener('keydown', onKey);
    document.body.classList.add('scene-on');
    root.dataset.scene = which;
    root.hidden = false;
    void root.offsetWidth;
    root.classList.add('scene-in');
    sub.hidden = true;
    textEl.textContent = '';

    // Opening: a wide shot of the stage, the crowd, the broadcast sting, the lower third.
    stage.direct({ focus: which === 'outro' ? (stage.cast[0]?.id ?? null) : null });
    if (which === 'intro') {
      for (const c of stage.cast) stage.holdOffstage(c.id, true);
      stage.synth('sting', 0.8);
      stage.synth('crowd', 0.8);
      stage.cast.forEach((c, i) => arrivals.push(window.setTimeout(() => arriveOnce(c.id), 700 + i * ARRIVAL_GAP_MS)));
    } else {
      stage.synth('cheer', 0.9);
    }
    if (card) {
      $('scene-card-tag').textContent = which === 'intro' ? 'Tonight' : 'Signing off';
      $('scene-card-kicker').textContent = card.kicker;
      $('scene-card-title').textContent = card.title;
      $('scene-card-line').textContent = card.line;
      cardEl.hidden = false;
      cardEl.classList.remove('card-down', 'card-up');
      void cardEl.offsetWidth;
      cardEl.classList.add('card-up');
      cardUp = true;
      root.dataset.beat = 'card';
      // Long enough for every fighter to land under it.
      const hold = Math.max(SCENE_CARD_MS, which === 'intro' ? 700 + stage.cast.length * ARRIVAL_GAP_MS + 900 : 0);
      timer = window.setTimeout(endCard, hold);
    } else {
      cardEl.hidden = true;
      const wait = which === 'intro' ? 700 + stage.cast.length * ARRIVAL_GAP_MS + 500 : 900;
      timer = window.setTimeout(() => {
        for (const c of stage.cast) arriveOnce(c.id);
        stage.duck(true);
        nextLine();
      }, wait);
    }
  });
}

/**
 * A season premiere's cold open (content/campaign.json `coldOpen`): data-driven beats on the match stage, no story
 * card. Any key, click or tap (or Esc/Start) skips it straight to the fight. Resolves with whether it was skipped.
 */
export function playColdOpen(stage: SceneStage, beats: ColdOpenBeat[]): Promise<{ skipped: boolean; beats: number }> {
  const root = $('scene');
  const sub = $('scene-sub');
  const textEl = $('scene-text');
  const next = $<HTMLButtonElement>('scene-next');
  const skip = $<HTMLButtonElement>('scene-skip');
  $('scene-card').hidden = true;
  return new Promise((resolve) => {
    let timer = 0;
    let i = -1;
    let ended = false;
    const finish = (skipped: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      for (const c of stage.cast) stage.holdOffstage(c.id, false);
      stage.direct(null);
      next.onclick = null;
      skip.onclick = null;
      window.removeEventListener('keydown', onAny, true);
      root.removeEventListener('pointerdown', onAny, true);
      document.body.classList.remove('scene-on');
      sub.hidden = true;
      root.classList.remove('scene-in');
      root.hidden = true;
      root.removeAttribute('data-scene');
      root.removeAttribute('data-beat');
      active = null;
      resolve({ skipped, beats: Math.max(0, i + 1) });
    };
    const onAny = () => finish(true);
    const play = () => {
      if (ended) return;
      if (++i >= beats.length) return finish(false);
      const b = beats[i];
      root.dataset.beat = `cold-${i}`;
      const focus = b.camera === undefined || b.camera === null ? null : (stage.cast[b.camera]?.id ?? null);
      stage.direct({ focus });
      if (b.sting) stage.synth(b.sting, 0.8);
      if (b.crowd) stage.synth('crowd', 0.8);
      if (b.walk !== undefined && stage.cast[b.walk]) {
        stage.synth('whoosh', 0.7);
        stage.arrive(stage.cast[b.walk].id);
        // The taunt: the fighter's bounce once they land, plus their bark when they have one.
        if (b.taunt) {
          window.setTimeout(() => {
            if (ended) return;
            const c = stage.cast[b.walk!];
            stage.cue(c.id);
            stage.taunt?.(c.who);
          }, 900);
        }
      } else if (b.taunt && stage.cast[b.camera ?? 0]) {
        const c = stage.cast[b.camera ?? 0];
        stage.cue(c.id);
        stage.taunt?.(c.who);
      }
      if (b.caption) {
        textEl.textContent = b.caption;
        sub.dataset.who = 'narrator';
        sub.classList.add('narration');
        sub.hidden = false;
        sub.classList.remove('sub-in');
        void sub.offsetWidth;
        sub.classList.add('sub-in');
      } else sub.hidden = true;
      timer = window.setTimeout(play, b.ms);
    };
    active = { skip: () => finish(true) };
    next.onclick = onAny;
    skip.onclick = onAny;
    next.textContent = 'Fight';
    window.addEventListener('keydown', onAny, true);
    root.addEventListener('pointerdown', onAny, true);
    document.body.classList.add('scene-on');
    root.dataset.scene = 'cold-open';
    root.hidden = false;
    void root.offsetWidth;
    root.classList.add('scene-in');
    sub.hidden = true;
    textEl.textContent = '';
    for (const c of stage.cast) stage.holdOffstage(c.id, true);
    stage.duck(true);
    play();
  });
}

/** Longest a pre-fight exchange plays, ms (campaign/intros.ts EXCHANGE_MAX_MS). */
const EXCHANGE_MAX_MS = 6000;
const EXCHANGE_LINE_MIN_MS = 1100;
const EXCHANGE_LINE_MAX_MS = 2300;
const EXCHANGE_TAUNT_MS = 900;

export interface ExchangeEnd {
  skipped: boolean;
  /** How long it played, ms. */
  ms: number;
  /** Lines started (0 to 2). */
  lines: number;
}

/**
 * A pre-fight exchange (content/intros.json): the fighters are already on the stage. The camera eases onto the first
 * speaker with a lower-third caption (name and one short line), the other fighter answers, then the listener of the
 * answer plays their taunt (bounce and bark). 6 s at most; any key, click, tap or gamepad button skips it at once
 * (Esc and Start too, in main.ts). Resolves when it ends. The playtest reads `dod:exchange` events.
 */
export function playExchange(stage: SceneStage, id: string, lines: SceneLine[]): Promise<ExchangeEnd> {
  const root = $('scene');
  const sub = $('scene-sub');
  const head = $<HTMLImageElement>('scene-head');
  const whoEl = $('scene-who');
  const textEl = $('scene-text');
  const next = $<HTMLButtonElement>('scene-next');
  const skip = $<HTMLButtonElement>('scene-skip');
  $('scene-card').hidden = true;
  const t0 = performance.now();
  const emit = (phase: string, detail: Record<string, unknown> = {}) =>
    window.dispatchEvent(new CustomEvent('dod:exchange', { detail: { id, phase, at: Math.round(performance.now() - t0), ...detail } }));

  return new Promise((resolve) => {
    let timer = 0;
    let cap = 0;
    let pad = 0;
    let i = -1;
    let ended = false;
    const finish = (skipped: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(cap);
      cancelAnimationFrame(pad);
      stage.stopVoice();
      stage.duck(false);
      stage.direct(null);
      next.hidden = false;
      skip.onclick = null;
      window.removeEventListener('keydown', onAny, true);
      window.removeEventListener('pointerdown', onAny, true);
      document.body.classList.remove('scene-on');
      sub.hidden = true;
      sub.classList.remove('exchange');
      root.classList.remove('scene-in');
      root.hidden = true;
      root.removeAttribute('data-scene');
      root.removeAttribute('data-beat');
      active = null;
      const ms = Math.round(performance.now() - t0);
      emit('end', { skipped, ms });
      resolve({ skipped, ms, lines: Math.max(0, Math.min(i + 1, lines.length)) });
    };
    const onAny = (e: Event) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent) e.preventDefault();
      finish(true);
    };
    const listenPad = () => {
      if (ended) return;
      for (const g of navigator.getGamepads?.() ?? []) if (g?.buttons.some((b) => b.pressed)) return finish(true);
      pad = requestAnimationFrame(listenPad);
    };
    /** The fighter a line's camera is on: its speaker if in the fight, else the first or second fighter by line. */
    const castFor = (n: number) => stage.cast.find((c) => c.who === lines[n].who) ?? stage.cast[Math.min(n, stage.cast.length - 1)];

    const taunt = () => {
      if (ended) return;
      // The listener of the answer: the other fighter than the one the camera was just on.
      const speaker = castFor(lines.length - 1);
      const listener = stage.cast.find((c) => c.id !== speaker?.id) ?? stage.cast[0];
      stage.direct({ focus: listener.id });
      stage.cue(listener.id);
      stage.taunt?.(listener.who);
      sub.hidden = true;
      root.dataset.beat = 'exchange-taunt';
      emit('taunt', { who: listener.who, focus: listener.id });
      timer = window.setTimeout(() => finish(false), EXCHANGE_TAUNT_MS);
    };
    const play = () => {
      if (ended) return;
      if (++i >= lines.length) return taunt();
      const l = lines[i];
      const speaker = castFor(i);
      const ch = CHARACTERS.find((c) => c.id === l.who);
      stage.direct({ focus: speaker.id });
      stage.cue(speaker.id);
      whoEl.textContent = ch?.name ?? (l.who === 'announcer' ? 'Announcer' : l.who);
      whoEl.hidden = false;
      head.hidden = true;
      sub.classList.remove('narration', 'sub-in');
      sub.classList.add('exchange');
      textEl.textContent = l.text;
      sub.hidden = false;
      void sub.offsetWidth;
      sub.classList.add('sub-in');
      sub.dataset.who = l.who;
      root.dataset.beat = `exchange-${i}`;
      stage.voice(l.audio);
      emit('line', { index: i, who: l.who, text: l.text, audio: l.audio, focus: speaker.id });
      const shown = i;
      const hold = (ms: number | null) => Math.min(EXCHANGE_LINE_MAX_MS, Math.max(EXCHANGE_LINE_MIN_MS, ms ? ms + 250 : 1500));
      timer = window.setTimeout(play, hold(null));
      void stage.voiceMs(l.audio).then((ms) => {
        if (ms && shown === i && !ended) {
          clearTimeout(timer);
          timer = window.setTimeout(play, hold(ms));
        }
      });
    };

    active = { skip: () => finish(true) };
    skip.onclick = () => finish(true);
    next.hidden = true;
    window.addEventListener('keydown', onAny, true);
    window.addEventListener('pointerdown', onAny, true);
    document.body.classList.add('scene-on');
    root.dataset.scene = 'exchange';
    root.hidden = false;
    void root.offsetWidth;
    root.classList.add('scene-in');
    sub.hidden = true;
    textEl.textContent = '';
    stage.duck(true);
    cap = window.setTimeout(() => finish(false), EXCHANGE_MAX_MS);
    pad = requestAnimationFrame(listenPad);
    emit('start', { lines: lines.length });
    play();
  });
}
