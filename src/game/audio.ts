// Sound effects, voice lines and music. The catalogs are authored in
// content/sounds.json and content/voice.json (the Sounds and Voice tabs in
// devtools.html); an entry with no file yet is simply silent.

import soundsJson from '../../content/sounds.json' with { type: 'json' };
import voiceJson from '../../content/voice.json' with { type: 'json' };
import { busLevel, onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';

export interface SoundEntry {
  id: string;
  group: string;
  /** The description a sound was (or will be) generated from. */
  text: string;
  loop: boolean;
  duration: number | null;
  influence: number;
  /** Playback level, 0 to 1. */
  volume: number;
  /** Path under /audio/, or null until one is made. */
  file: string | null;
  /** What the current file was made from, so devtools can flag stale takes. */
  take: { text: string; loop: boolean; duration: number | null; influence: number } | null;
}

export interface VoiceLine {
  id: string;
  group: string;
  /** 'announcer', 'narrator' or a fighter id. */
  who: string;
  text: string;
  audio: string | null;
  take: { text: string; voice: string } | null;
}

export interface VoiceCatalog {
  /** The ElevenLabs model every take is made with. */
  model?: string;
  /** ElevenLabs voice id per speaker. */
  voices: Record<string, string>;
  /** Who each speaker is cast as, and why, for devtools. */
  cast?: Record<string, { voice: string; about: string; why: string }>;
  lines: VoiceLine[];
}

export const SOUNDS = soundsJson as SoundEntry[];
export const VOICE = voiceJson as VoiceCatalog;

/** A tiny silent WAV: playing it once inside a tap puts iOS Safari's page audio on the media channel. */
const SILENCE_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

/** Set by the Tap to play prompt in Game/index.html, which may be tapped before this module loads. */
interface TapState {
  tapped: boolean;
  ctx: AudioContext | null;
  onTap: (() => void) | null;
}
export const tapState = (): TapState | undefined => (window as unknown as { __dodTap?: TapState }).__dodTap;

class AudioSystem {
  private ctx: AudioContext | null = null;
  private buses: Record<'master' | 'music' | 'sfx' | 'voice', GainNode> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** Downloaded but not yet decoded (decoding needs the AudioContext, which waits for a click). */
  private raw = new Map<string, Promise<ArrayBuffer | null>>();
  private soundById = new Map(SOUNDS.map((s) => [s.id, s]));
  private lineById = new Map(VOICE.lines.map((l) => [l.id, l]));
  private music: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantMusic: string | null = null;
  private speech: AudioBufferSourceNode | null = null;
  private silent: HTMLAudioElement | null = null;
  /** True once a gesture has started sound; after that it is taken back whenever the page is in front. */
  private unlocked = false;

  constructor() {
    onSoundSettings(() => this.applyVolumes());
  }

  /** 'running' once a tap has turned sound on; 'none' before that, or with no Web Audio. */
  get state(): string {
    return this.ctx?.state ?? 'none';
  }

  /** The music loop playing now (null for none, or before sound is on). */
  get musicPlaying(): string | null {
    return this.music?.id ?? null;
  }

  /** Sound on or off (the M key). Saved with the other settings. */
  toggleSound(): boolean {
    setSoundSettings({ on: !soundSettings().on });
    return soundSettings().on;
  }

  private applyVolumes(): void {
    if (!this.buses || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Effects covers the announcer and the fighters' voices too (the studio standard has two levels).
    this.buses.master.gain.setTargetAtTime(soundSettings().on ? 1 : 0, t, 0.02);
    this.buses.music.gain.setTargetAtTime(busLevel('music'), t, 0.02);
    this.buses.sfx.gain.setTargetAtTime(busLevel('sfx'), t, 0.02);
    this.buses.voice.gain.setTargetAtTime(busLevel('sfx'), t, 0.02);
  }

  /** Browsers only allow sound after a click or key press; call this from one. */
  unlock(): void {
    if (!this.ctx) {
      // iOS mutes Web Audio while the ringer switch is on silent unless the page plays as media.
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (session) session.type = 'playback';
      } catch {
        // Not supported: sound follows the ringer switch.
      }
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      // The Tap to play prompt starts a context itself when the tap comes before this module.
      this.ctx = tapState()?.ctx ?? new Ctx();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      const bus = () => {
        const g = this.ctx!.createGain();
        g.connect(master);
        return g;
      };
      this.buses = { master, music: bus(), sfx: bus(), voice: bus() };
      this.applyVolumes();
      // iOS marks the context 'interrupted' after a call, Siri or a lock: take it back once the page is in front.
      this.ctx.addEventListener('statechange', () => this.resume());
      if (this.wantMusic) this.playMusic(this.wantMusic);
    }
    this.unlocked = true;
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    this.primeMedia();
  }

  /** After the first tap: resume a suspended or interrupted context when the page is visible again. */
  resume(): void {
    if (!this.unlocked || !this.ctx || document.hidden) return;
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /**
   * Plays a silent HTML audio element inside the gesture. The game plays everything through Web Audio, so
   * this one element is all iOS needs to treat the page as media (sound with the ringer switch on silent).
   */
  private primeMedia(): void {
    if (!this.silent) {
      this.silent = new Audio(SILENCE_WAV);
      this.silent.preload = 'auto';
      this.silent.setAttribute('playsinline', 'true');
    }
    const el = this.silent;
    if (!el.paused) return;
    const play = el.play();
    if (play && typeof play.then === 'function') void play.then(() => el.pause(), () => {});
  }

  private download(url: string): Promise<ArrayBuffer | null> {
    let p = this.raw.get(url);
    if (!p) {
      const get = () => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))));
      // One retry after a short wait (a transient 503 from the host), then fail quietly; a failure isn't kept,
      // so the next play tries again instead of staying silent for the session.
      p = get()
        .catch(() => new Promise<void>((r) => setTimeout(r, 400)).then(get))
        .catch(() => { if (this.raw.get(url) === p) this.raw.delete(url); return null; });
      this.raw.set(url, p);
    }
    return p;
  }

  private buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url);
    if (!p) {
      if (!this.ctx) return this.download(url).then(() => null);
      // decodeAudioData takes the bytes over, so decode a copy and keep the download.
      const q = this.download(url).then((data) => (data && this.ctx ? this.ctx.decodeAudioData(data.slice(0)) : null)).catch(() => null);
      p = q.then((b) => { if (!b && this.buffers.get(url) === q) this.buffers.delete(url); return b; });
      this.buffers.set(url, p);
    }
    return p;
  }

  /**
   * Fetches (and, once sound is unlocked, decodes) everything a match plays:
   * every sound effect, the stage's music, the announcer, and the lines of the
   * fighters in it. Resolves when it's all in memory, or after a while.
   */
  async preloadMatch(stageId: string, fighterIds: string[], timeoutMs = 15000): Promise<void> {
    const who = new Set(['announcer', ...fighterIds]);
    const urls = [
      ...SOUNDS.filter((s) => s.file && (s.group !== 'music' || s.id === `music-${stageId}` || s.id === 'music-results')).map((s) => s.file!),
      ...VOICE.lines.filter((l) => l.audio && who.has(l.who)).map((l) => l.audio!),
    ];
    const all = Promise.all([...new Set(urls)].map((u) => (this.ctx ? this.buffer(u) : this.download(u))));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async start(url: string, bus: GainNode, volume: number, rate = 1, loop = false): Promise<AudioBufferSourceNode | null> {
    if (!this.ctx) return null;
    const buf = await this.buffer(url);
    if (!buf || !this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(bus);
    src.start();
    return src;
  }

  /** Plays a sound effect by id. Small pitch changes keep repeats from sounding canned. */
  sfx(id: string, opts: { vary?: boolean } = {}): void {
    const s = this.soundById.get(id);
    if (!s?.file || !this.buses) return;
    const rate = opts.vary ? 0.94 + Math.random() * 0.12 : 1;
    void this.start(s.file, this.buses.sfx, s.volume, rate);
  }

  /** Plays a catalog voice line by id, like 'announcer.go' or 'fighter.slice.win'. */
  line(id: string): void {
    const l = this.lineById.get(id);
    if (l?.audio) this.voice(l.audio, false);
  }

  /** Plays a voice file. Dialogue cuts off the line before it; callouts overlap. */
  voice(url: string | null | undefined, interrupt = true): void {
    if (!url || !this.buses) return;
    if (interrupt) this.stopVoice();
    void this.start(url, this.buses.voice, 1).then((src) => {
      if (interrupt && src) this.speech = src;
    });
  }

  stopVoice(): void {
    try {
      this.speech?.stop();
    } catch {
      // Already finished.
    }
    this.speech = null;
  }

  /** Crossfades to a music loop by sound id, or to silence with null. */
  playMusic(id: string | null): void {
    this.wantMusic = id;
    if (!this.ctx || !this.buses) return;
    if (this.music?.id === id) return;
    const old = this.music;
    this.music = null;
    if (old) {
      const t = this.ctx.currentTime;
      old.gain.gain.setTargetAtTime(0, t, 0.3);
      setTimeout(() => {
        try {
          old.src.stop();
        } catch {
          // Already stopped.
        }
      }, 1500);
    }
    const s = id ? this.soundById.get(id) : null;
    if (!s?.file) return;
    const ctx = this.ctx;
    void this.buffer(s.file).then((buf) => {
      if (!buf || this.wantMusic !== id || this.music) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(s.volume, ctx.currentTime, 0.4);
      src.connect(g).connect(this.buses!.music);
      src.start();
      this.music = { id: s.id, src, gain: g };
    });
  }
}

export const audio = new AudioSystem();

// The Tap to play prompt is the first gesture, but every click, tap or key press keeps trying: iOS only
// counts touchend and click as a gesture (not pointerdown), and can suspend the context again.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown'] as const) {
  window.addEventListener(type, () => audio.unlock(), { capture: true });
}
const tap = tapState();
if (tap) {
  if (tap.tapped) audio.unlock();
  else tap.onTap = () => audio.unlock();
}
// Back from another tab or app, or after an iOS interruption: sound picks up again by itself.
document.addEventListener('visibilitychange', () => audio.resume());
window.addEventListener('pageshow', () => audio.resume());
window.addEventListener('focus', () => audio.resume());
