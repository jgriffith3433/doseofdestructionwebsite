// Watches the voice director during a playtest (voiceDirector.ts, audio.ts `voiceStats` / `voiceOnAir` / `duckDb`): logs every
// `dod:voice` take (speaker, id, start, end, cut or dropped), samples the music and effects level every 40 ms, and counts
// captions on screen. `finish` turns it into the acceptance criteria: 0 ms of two speakers beyond the 60 ms crossfade, music and
// effects at least 6 dB down while any voice plays and back within 0.5 s after, no commentary / announcer pool line twice inside
// 5 minutes, no fighter bark take twice in a row, never two captions at once.
import { audio } from '../audio.ts';
import type { Tracker } from './hawkes-playtest.js';

/** The caption surfaces: the booth (commentary), the scene's lower third, the win quote. */
const CAPTIONS = ['.booth', '.win-quote', '#scene-text'];

const visibleCaptions = (): string[] => {
  const out: string[] = [];
  for (const sel of CAPTIONS) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const root = el.closest<HTMLElement>('#scene');
      if (root && root.hidden) continue;
      if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05 && (el.textContent ?? '').trim()) out.push(sel);
    }
  }
  return out;
};

export class VoiceWatch {
  private timer = 0;
  private takes: { speaker: string; id: string; kind: string; start: number; end: number; cut: boolean; dropped: boolean; reason?: string }[] = [];
  /** The least ducked (highest dB) reading while a voice had been on the air for 120 ms. */
  private worstMusic = -99;
  private worstSfx = -99;
  private samplesUnderVoice = 0;
  private lastOnAir = 0;
  private recoverFrom = 0;
  private recoveries: number[] = [];
  private twoCaptions = 0;
  private captionSamples = 0;
  private readonly onVoice = (e: Event): void => {
    const d = (e as CustomEvent).detail as VoiceWatch['takes'][number];
    this.takes.push(d);
    if (d.dropped) this.t.event('voice-dropped', `${d.kind} ${d.id} (${d.speaker}): ${d.reason}`);
    else if (d.cut) this.t.event('voice-cut', `${d.kind} ${d.id} (${d.speaker}) cut at ${d.end}`);
  };

  private readonly t: Tracker;

  constructor(t: Tracker) {
    this.t = t;
  }

  start(): void {
    audio.resetVoice();
    this.takes = [];
    window.addEventListener('dod:voice', this.onVoice);
    this.timer = window.setInterval(() => this.sample(), 40);
  }

  private sample(): void {
    const now = performance.now();
    const caps = visibleCaptions();
    this.captionSamples++;
    if (caps.length > 1) {
      this.twoCaptions++;
      if (this.twoCaptions <= 3) this.t.problem('bug', `two captions on screen at once: ${caps.join(' + ')}`);
    }
    const on = audio.voiceOnAir();
    if (on) {
      if (this.recoverFrom) {
        // Another voice came in before the music was back: not a recovery to time.
        this.recoverFrom = 0;
      }
      this.lastOnAir = now;
      // The duck ramps down over 50 ms: judge it once the voice has been going for 120 ms and has 60 ms left.
      if (now - on.start >= 120 && on.end - now >= 60) {
        const d = audio.duckDb();
        this.samplesUnderVoice++;
        this.worstMusic = Math.max(this.worstMusic, d.music);
        this.worstSfx = Math.max(this.worstSfx, d.sfx);
      }
    } else if (this.lastOnAir) {
      if (!this.recoverFrom) this.recoverFrom = this.lastOnAir;
      // The take ended somewhere in the last 40 ms; time from there until music is within 1 dB of its level.
      const d = audio.duckDb();
      if (d.music > -1 && d.sfx > -1) {
        this.recoveries.push(now - Math.max(this.recoverFrom, this.endOfLast()));
        this.recoverFrom = 0;
        this.lastOnAir = 0;
      }
    }
  }

  private endOfLast(): number {
    const s = audio.voiceStats().takes;
    return s.length ? s[s.length - 1].end : 0;
  }

  /** Stops watching without reporting (a scenario that ended early). */
  stop(): void {
    window.clearInterval(this.timer);
    window.removeEventListener('dod:voice', this.onVoice);
  }

  /** Stops watching, reports metrics and problems. `criteria` picks what to hold the run to. */
  finish(opts: { repeats?: boolean; phone?: boolean } = {}): void {
    this.stop();
    const t = this.t;
    const st = audio.voiceStats();
    const maxRecover = this.recoveries.length ? Math.max(...this.recoveries) : 0;
    t.metric('voiceTakes', st.played);
    t.metric('voiceDropped', st.dropped);
    t.metric('voiceCut', st.cut);
    t.metric('voiceOverlapMs', Math.round(st.overBudgetMs));
    t.metric('voiceMaxOverlapMs', Math.round(st.maxOverlapMs));
    t.metric('voiceMaxWaitMs', Math.round(st.maxWaitMs));
    t.metric('voiceRepeats', st.repeats);
    t.metric('voiceBarkRepeats', st.barkRepeats);
    t.metric('voiceUnducked', st.unducked);
    t.metric('voiceDuckMusicDb', this.samplesUnderVoice ? Math.round(this.worstMusic * 10) / 10 : 0);
    t.metric('voiceDuckSfxDb', this.samplesUnderVoice ? Math.round(this.worstSfx * 10) / 10 : 0);
    t.metric('voiceRestoreMs', Math.round(maxRecover));
    t.metric('captionClashes', this.twoCaptions);
    t.event('voice-trace', `${st.played} takes (${st.cut} cut, ${st.dropped} dropped), ${st.overlaps} overlaps over the crossfade (${Math.round(st.overBudgetMs)} ms), longest wait ${Math.round(st.maxWaitMs)} ms`);
    if (!st.played) {
      t.problem('bug', 'no voice take played (is the sound on?)');
      return;
    }
    if (st.overBudgetMs > 0) t.problem('bug', `two different speakers overlapped for ${Math.round(st.overBudgetMs)} ms beyond the 60 ms crossfade (${st.overlaps} pairs)`);
    if (st.maxWaitMs > 650) t.problem('bug', `a take waited ${Math.round(st.maxWaitMs)} ms for the speaker ahead (limit 600)`);
    if (st.unducked > 0) t.problem('bug', `${st.unducked} voice take(s) started without ducking the music and effects`);
    if (this.samplesUnderVoice > 0) {
      if (this.worstMusic > -6) t.problem('bug', `music was only ${this.worstMusic.toFixed(1)} dB down under a voice (need at least 6 dB)`);
      if (this.worstSfx > -6) t.problem('bug', `effects were only ${this.worstSfx.toFixed(1)} dB down under a voice (need at least 6 dB)`);
    } else t.problem('warning', 'no voice lasted long enough to measure the duck');
    if (maxRecover > 500) t.problem('bug', `music and effects took ${Math.round(maxRecover)} ms to come back after a voice (limit 500)`);
    if (st.barkRepeats > 0) t.problem('bug', `a fighter bark take played twice in a row (${st.barkRepeats} times)`);
    if (opts.repeats !== false && st.repeats > 0) t.problem('bug', `${st.repeats} announcer / commentary line(s) repeated inside 5 minutes of play`);
    if (this.twoCaptions > 0) t.problem('bug', `${this.twoCaptions} samples had two captions on screen${opts.phone ? ' (844x390 touch)' : ''}`);
  }
}
