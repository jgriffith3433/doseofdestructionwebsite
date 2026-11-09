// Live story scenes (studio quality rule 6e/6f/6g): an episode's intro and outro play in the arena, on the
// match screen, with the real fighters, instead of on a text screen. The camera eases between a wide shot and
// the speaker, fighters drop onto the stage one by one, the studio crowd reacts, voice takes play over ducked
// music, and the only text on screen is one short line at a time (campaign/sceneText.ts). The episode's story
// card is the show's lower third ("Tonight" / "Signing off"). Next moves on a line; Skip, Esc or Start ends it.

import { CHARACTERS } from '../sim/characters.ts';
import { chunkLine, chunkTimes } from '../campaign/sceneText.ts';
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
