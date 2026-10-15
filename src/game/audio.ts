// Sound effects, voice lines and music. The catalogs are authored in
// content/sounds.json and content/voice.json (the Sounds and Voice tabs in
// devtools.html); an entry with no file yet is simply silent.

import soundsJson from '../../content/sounds.json' with { type: 'json' };
import voiceJson from '../../content/voice.json' with { type: 'json' };

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

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  voice: number;
}

const DEFAULT_VOLUMES: Volumes = { master: 0.8, music: 0.6, sfx: 0.9, voice: 1 };
const STORE = 'dod-audio';

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
  volumes: Volumes = this.load();
  muted = false;

  private load(): Volumes {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (saved && typeof saved === 'object') return { ...DEFAULT_VOLUMES, ...saved };
    } catch {
      // Unreadable storage: defaults.
    }
    return { ...DEFAULT_VOLUMES };
  }

  setVolumes(v: Partial<Volumes>): void {
    this.volumes = { ...this.volumes, ...v };
    try {
      localStorage.setItem(STORE, JSON.stringify(this.volumes));
    } catch {
      // Storage can be blocked; levels then last only for this visit.
    }
    this.applyVolumes();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyVolumes();
    return this.muted;
  }

  private applyVolumes(): void {
    if (!this.buses || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.buses.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.02);
    this.buses.music.gain.setTargetAtTime(this.volumes.music, t, 0.02);
    this.buses.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.02);
    this.buses.voice.gain.setTargetAtTime(this.volumes.voice, t, 0.02);
  }

  /** Browsers only allow sound after a click or key press; call this from one. */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      const bus = () => {
        const g = this.ctx!.createGain();
        g.connect(master);
        return g;
      };
      this.buses = { master, music: bus(), sfx: bus(), voice: bus() };
      this.applyVolumes();
      if (this.wantMusic) this.playMusic(this.wantMusic);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private download(url: string): Promise<ArrayBuffer | null> {
    let p = this.raw.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .catch(() => null);
      this.raw.set(url, p);
    }
    return p;
  }

  private buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url);
    if (!p) {
      if (!this.ctx) return this.download(url).then(() => null);
      // decodeAudioData takes the bytes over, so decode a copy and keep the download.
      p = this.download(url).then((data) => (data && this.ctx ? this.ctx.decodeAudioData(data.slice(0)) : null)).catch(() => null);
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

// The first click or key press anywhere turns sound on.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => audio.unlock(), { capture: true });
}
