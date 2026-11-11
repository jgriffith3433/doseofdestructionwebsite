// Sound effects, voice lines and music. The catalogs are authored in
// content/sounds.json and content/voice.json (the Sounds and Voice tabs in
// devtools.html); an entry with no file yet is simply silent.

import { playSynth, startBed, type BedKind, type SynthKind } from './synth.ts';
import soundsJson from '../../content/sounds.json' with { type: 'json' };
import voiceJson from '../../content/voice.json' with { type: 'json' };
import {
  fightersNeedIntense,
  stageBedGaps,
  stageBedRecipe,
  type MusicState,
  type StageBedRecipe,
} from './stageBed.ts';
import { busLevel, onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';

export { fightersNeedIntense, INTENSE_PERCENT, stageBedGaps, stageBedRecipe, type MusicState, type StageBedRecipe } from './stageBed.ts';

type LoopVoice = {
  id: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter?: BiquadFilterNode;
};

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
  private music: LoopVoice | null = null;
  private wantMusic: string | null = null;
  private speech: AudioBufferSourceNode | null = null;
  private silent: HTMLAudioElement | null = null;
  /** True once a gesture has started sound; after that it is taken back whenever the page is in front. */
  private unlocked = false;
  /** Stage bed layers (ambience file + procedural bed + intensity stem). Cleared when menu/results music takes over. */
  private bedStageId: string | null = null;
  private bedWant: StageBedRecipe | null = null;
  private ambience: LoopVoice | null = null;
  private intense: LoopVoice | null = null;
  private bedStop: (() => void) | null = null;
  private musicState: MusicState | null = null;
  private ducked = false;
  private stung = false;
  /** Per-fighter bark: busy until the take ends so two lines from one fighter never overlap. */
  private fighterBusyUntil = new Map<string, number>();
  private fighterSrc = new Map<string, AudioBufferSourceNode>();
  /** Last effort start time per fighter (1.5 s cooldown). */
  private effortAt = new Map<string, number>();
  /** Round-robin index per fighter per kind (effort / hurt). */
  private fighterPick = new Map<string, number>();

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

  /** Calm or intense during a stage bed; null on menus / results / silence. */
  get musicBedState(): MusicState | null {
    return this.musicState;
  }

  /** What the playtest (and HUD probes) can see about the live stage bed. */
  bedStats(): {
    stageId: string | null;
    state: MusicState | null;
    music: string | null;
    ambience: string | null;
    intense: string | null;
    bed: BedKind | null;
    ambienceOn: boolean;
    intenseOn: boolean;
    stung: boolean;
    musicOn: boolean;
  } {
    return {
      stageId: this.bedStageId,
      state: this.musicState,
      music: this.music?.id ?? this.bedWant?.music ?? null,
      ambience: this.bedWant?.ambience ?? null,
      intense: this.bedWant?.intense ?? null,
      bed: this.bedWant?.bed ?? null,
      ambienceOn: !!(this.ambience || this.bedStop),
      intenseOn: this.musicState === 'intense',
      stung: this.stung,
      musicOn: !!this.music,
    };
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
    const music = busLevel('music') * (this.ducked ? 0.35 : 1);
    this.buses.music.gain.setTargetAtTime(music, t, 0.02);
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
      if (this.bedStageId) this.playStageBed(this.bedStageId);
      else if (this.wantMusic) this.playMusic(this.wantMusic);
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
      // Two retries with a growing wait (a transient 503 from the host), then fail quietly; a failure isn't kept,
      // so the next play tries again instead of staying silent for the session.
      p = get()
        .catch(() => new Promise<void>((r) => setTimeout(r, 400)).then(get))
        .catch(() => new Promise<void>((r) => setTimeout(r, 1500)).then(get))
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
    const bed = stageBedRecipe(stageId);
    const musicIds = new Set<string>([bed.music, 'music-results', `music-${stageId}`]);
    if (bed.ambience) musicIds.add(bed.ambience);
    if (bed.intense) musicIds.add(bed.intense);
    const urls = [
      ...SOUNDS.filter((s) => s.file && (s.group !== 'music' || musicIds.has(s.id))).map((s) => s.file!),
      ...VOICE.lines.filter((l) => l.audio && who.has(l.who)).map((l) => l.audio!),
    ];
    const all = Promise.all([...new Set(urls)].map((u) => (this.ctx ? this.buffer(u) : this.download(u))));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Fetches and decodes just these catalog lines (e.g. the VS announcer), so they can play on time. Resolves after a while at most. */
  async preloadLines(ids: string[], timeoutMs = 4000): Promise<void> {
    const urls = [...new Set(ids.map((id) => this.lineById.get(id)?.audio).filter((u): u is string => !!u))];
    const all = Promise.all(urls.map((u) => (this.ctx ? this.buffer(u) : this.download(u))));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** How long a catalog line plays, in ms (a guess if it isn't decoded). Call after preloadLines. */
  async lineMs(id: string): Promise<number> {
    const url = this.lineById.get(id)?.audio;
    const b = url && this.ctx ? await this.buffer(url) : null;
    return b ? b.duration * 1000 : 900;
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

  /** Plays a procedural effect (synth.ts): the crowd, a whoosh, a sting, an alarm, a thud. */
  synth(kind: SynthKind, level = 1): void {
    if (!this.ctx || !this.buses) return;
    playSynth(this.ctx, this.buses.sfx, kind, level);
  }

  /** Fetches and decodes voice files by URL (a story scene's lines). Resolves after a while at most. */
  async preloadUrls(urls: (string | null | undefined)[], timeoutMs = 6000): Promise<void> {
    const list = [...new Set(urls.filter((u): u is string => !!u))];
    const all = Promise.all(list.map((u) => (this.ctx ? this.buffer(u) : this.download(u))));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** How long a voice file plays, in ms, or null if it can't be decoded (no sound yet, or no file). */
  async voiceMs(url: string | null | undefined): Promise<number | null> {
    if (!url || !this.ctx) return null;
    const b = await this.buffer(url);
    return b ? b.duration * 1000 : null;
  }

  /** Lowers the music under dialogue (story scenes), and brings it back. */
  duck(on: boolean): void {
    this.ducked = on;
    this.applyVolumes();
  }

  /** Plays a catalog voice line by id, like 'announcer.go' or 'fighter.slice.win'. */
  line(id: string): void {
    const l = this.lineById.get(id);
    if (l?.audio) this.voice(l.audio, false);
  }

  /**
   * A fighter bark in a match: effort (smash/special), hurt (medium/heavy), KO cry, or taunt.
   * At most one line per fighter at a time; efforts also wait 1.5 s between starts.
   * Fires `dod:fighter-voice` when a take starts. Returns false when skipped (busy / cooldown / no take).
   */
  fighterVoice(who: string, kind: 'effort' | 'hurt' | 'ko' | 'taunt'): boolean {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if ((this.fighterBusyUntil.get(who) ?? 0) > now) return false;
    if (kind === 'effort' && now - (this.effortAt.get(who) ?? 0) < 1500) return false;

    let id: string;
    if (kind === 'effort' || kind === 'hurt') {
      const n = kind === 'effort' ? 3 : 2;
      const key = `${who}.${kind}`;
      const i = (this.fighterPick.get(key) ?? 0) % n;
      this.fighterPick.set(key, i + 1);
      id = `fighter.${who}.${kind}.${i}`;
    } else {
      id = `fighter.${who}.${kind}`;
    }
    const l = this.lineById.get(id);
    // Season 1 has the full kit; everyone else still has a KO (and win) take.
    if (!l?.audio) {
      if (kind === 'ko') {
        const ko = this.lineById.get(`fighter.${who}.ko`);
        if (ko?.audio) {
          this.voice(ko.audio, false);
          this.emitFighterVoice(who, kind, ko.id, ko.text, ko.audio, now);
          return true;
        }
      }
      return false;
    }

    if (!this.buses) return false;
    // Hold the slot immediately so a second bark in the same frame can't stack.
    this.fighterBusyUntil.set(who, now + 800);
    if (kind === 'effort') this.effortAt.set(who, now);
    const prev = this.fighterSrc.get(who);
    if (prev) {
      try {
        prev.stop();
      } catch {
        // Already finished.
      }
      this.fighterSrc.delete(who);
    }
    const audioUrl = l.audio;
    const text = l.text;
    // Fire the playtest event only once the buffer actually starts (a 404 must not look like a played line).
    void this.start(audioUrl, this.buses.voice, 1).then(async (src) => {
      if (!src) {
        this.fighterBusyUntil.set(who, now);
        if (kind === 'effort') this.effortAt.set(who, 0);
        return;
      }
      this.fighterSrc.set(who, src);
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.emitFighterVoice(who, kind, id, text, audioUrl, started);
      const buf = await this.buffer(audioUrl);
      const ms = buf ? buf.duration * 1000 : 800;
      this.fighterBusyUntil.set(who, started + ms);
      src.onended = () => {
        if (this.fighterSrc.get(who) === src) this.fighterSrc.delete(who);
      };
    });
    return true;
  }

  private emitFighterVoice(who: string, kind: string, id: string, text: string, audio: string, at: number): void {
    try {
      window.dispatchEvent(new CustomEvent('dod:fighter-voice', { detail: { who, kind, id, text, audio, at } }));
    } catch {
      // Node tests have no window.
    }
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

  /** Crossfades to a music loop by sound id, or to silence with null. Clears any stage bed. */
  playMusic(id: string | null): void {
    this.clearBedLayers(false);
    this.wantMusic = id;
    this.musicState = null;
    this.stung = false;
    this.bedStageId = null;
    this.bedWant = null;
    if (!this.ctx || !this.buses) return;
    if (this.music?.id === id && !this.music.filter) return;
    this.fadeOutLoop(this.music);
    this.music = null;
    if (!id) return;
    this.startMusicLoop(id, false);
  }

  /**
   * Starts a stage's layered bed: procedural place tone + reused ambience file under the stage theme.
   * Intensity is calm until setMusicIntensity(true). Crossfades; never cuts.
   */
  playStageBed(stageId: string): void {
    const recipe = stageBedRecipe(stageId);
    this.bedStageId = stageId;
    this.bedWant = recipe;
    this.wantMusic = recipe.music;
    this.stung = false;
    if (!this.ctx || !this.buses) return;

    // Same stage bed already up: keep layers, reset to calm without cutting.
    if (this.music?.id === recipe.music && this.musicState) {
      this.setMusicIntensity(false);
      return;
    }

    this.clearBedLayers(true);
    this.startMusicLoop(recipe.music, true);
    if (recipe.ambience) this.startAmbienceLoop(recipe.ambience, recipe.ambienceVolume);
    this.startProceduralBed(recipe.bed);
    this.musicState = 'calm';
    this.applyIntensityMix(false, true);
  }

  /**
   * Crossfades the bed to intense (last stock or ≥100%) or back to calm.
   * Returns true when the state actually changed.
   */
  setMusicIntensity(intense: boolean): boolean {
    const next: MusicState = intense ? 'intense' : 'calm';
    if (!this.bedWant) return false;
    if (this.musicState === next) return false;
    this.musicState = next;
    if (!this.ctx || !this.buses) return true;
    if (intense && this.bedWant.intense && !this.intense) {
      this.startIntenseLoop(this.bedWant.intense, this.bedWant.intenseVolume);
    }
    this.applyIntensityMix(intense, false);
    return true;
  }

  /**
   * Whether the live fighters call for the intense bed: anyone still in on their last stock, or anyone over 100%.
   */
  shouldBeIntense(fighters: ReadonlyArray<{ stocks: number; percent: number }>): boolean {
    return fightersNeedIntense(fighters);
  }

  /** Final-KO broadcast sting over the bed; the music crossfades down a little then holds (never cuts). */
  finalKoSting(): void {
    this.stung = true;
    this.synth('sting', 1);
    this.synth('cheer', 0.85);
    if (!this.ctx || !this.music) return;
    const t = this.ctx.currentTime;
    const g = this.music.gain.gain;
    const now = Math.max(0.0001, g.value);
    g.cancelScheduledValues(t);
    g.setValueAtTime(now, t);
    g.linearRampToValueAtTime(now * 1.15, t + 0.08);
    g.setTargetAtTime(now * 0.72, t + 0.12, 0.35);
  }

  private clearBedLayers(keepMusicSlot: boolean): void {
    this.fadeOutLoop(this.ambience);
    this.ambience = null;
    this.fadeOutLoop(this.intense);
    this.intense = null;
    if (this.bedStop) {
      this.bedStop();
      this.bedStop = null;
    }
    if (!keepMusicSlot) {
      // playMusic path clears music itself.
    }
  }

  private fadeOutLoop(loop: LoopVoice | null): void {
    if (!loop || !this.ctx) return;
    const t = this.ctx.currentTime;
    loop.gain.gain.cancelScheduledValues(t);
    loop.gain.gain.setTargetAtTime(0, t, 0.3);
    const src = loop.src;
    setTimeout(() => {
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
    }, 1500);
  }

  private startMusicLoop(id: string, withFilter: boolean): void {
    const s = this.soundById.get(id);
    if (!s?.file || !this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const token = id;
    const stage = this.bedStageId;
    void this.buffer(s.file).then((buf) => {
      if (!buf || this.wantMusic !== token || !this.buses) return;
      if (withFilter && this.bedStageId !== stage) return;
      // Same bed track already filtered in: keep it.
      if (withFilter && this.music?.id === id && this.music.filter) return;
      this.fadeOutLoop(this.music);
      this.music = null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 1;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(s.volume, ctx.currentTime, 0.4);
      let filter: BiquadFilterNode | undefined;
      if (withFilter) {
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 4200;
        filter.Q.value = 0.7;
        src.connect(filter).connect(g).connect(this.buses.music);
      } else {
        src.connect(g).connect(this.buses.music);
      }
      src.start();
      this.music = { id: s.id, src, gain: g, filter };
      if (this.musicState === 'intense') this.applyIntensityMix(true, true);
    });
  }

  private startAmbienceLoop(id: string, volume: number): void {
    const s = this.soundById.get(id);
    if (!s?.file || !this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const stage = this.bedStageId;
    void this.buffer(s.file).then((buf) => {
      if (!buf || this.bedStageId !== stage || !this.buses) return;
      this.fadeOutLoop(this.ambience);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(volume, ctx.currentTime, 0.7);
      src.connect(filter).connect(g).connect(this.buses.music);
      src.start();
      this.ambience = { id: s.id, src, gain: g, filter };
    });
  }

  private startIntenseLoop(id: string, volume: number): void {
    const s = this.soundById.get(id);
    if (!s?.file || !this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const stage = this.bedStageId;
    void this.buffer(s.file).then((buf) => {
      if (!buf || this.bedStageId !== stage || this.musicState !== 'intense' || !this.buses) return;
      this.fadeOutLoop(this.intense);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = 1.03;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 5200;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(volume, ctx.currentTime, 0.55);
      src.connect(filter).connect(g).connect(this.buses.music);
      src.start();
      this.intense = { id: s.id, src, gain: g, filter };
    });
  }

  private startProceduralBed(kind: BedKind): void {
    if (!this.ctx || !this.buses) return;
    if (this.bedStop) this.bedStop();
    this.bedStop = startBed(this.ctx, this.buses.music, kind, 0.55);
  }

  private applyIntensityMix(intense: boolean, instant: boolean): void {
    if (!this.ctx || !this.music) return;
    const t = this.ctx.currentTime;
    const tau = instant ? 0.05 : 0.55;
    const rate = intense ? 1.06 : 1;
    try {
      this.music.src.playbackRate.cancelScheduledValues(t);
      this.music.src.playbackRate.setTargetAtTime(rate, t, tau);
    } catch {
      // Source already ended.
    }
    if (this.music.filter) {
      this.music.filter.frequency.cancelScheduledValues(t);
      this.music.filter.frequency.setTargetAtTime(intense ? 7200 : 4200, t, tau);
    }
    if (this.ambience?.filter) {
      this.ambience.filter.frequency.cancelScheduledValues(t);
      this.ambience.filter.frequency.setTargetAtTime(intense ? 1600 : 900, t, tau);
    }
    if (this.ambience && this.bedWant) {
      const base = this.bedWant.ambienceVolume;
      this.ambience.gain.gain.cancelScheduledValues(t);
      this.ambience.gain.gain.setTargetAtTime(intense ? base * 1.35 : base, t, tau);
    }
    if (!intense && this.intense) {
      this.fadeOutLoop(this.intense);
      this.intense = null;
    }
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
