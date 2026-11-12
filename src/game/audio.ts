// Sound effects, voice lines and music. The catalogs are authored in
// content/sounds.json and content/voice.json (the Sounds and Voice tabs in
// devtools.html); an entry with no file yet is simply silent.

import { playSynth, startBed, type BedKind, type SynthKind } from './synth.ts';
import type { SpecialKind } from './sim/fighterDefs.ts';
import soundsJson from '../../content/sounds.json' with { type: 'json' };
import voiceJson from '../../content/voice.json' with { type: 'json' };
import { winQuoteLines, type FighterQuotes } from './winQuote.ts';
import {
  fightersNeedIntense,
  stageBedGaps,
  stageBedRecipe,
  type MusicState,
  type StageBedRecipe,
} from './stageBed.ts';
import { departing, makeImpulse, roomOf, wetFor, type StageRoom } from './roomAudio.ts';
import { graphics, onGraphics } from './graphics.ts';
import { busLevel, onSoundSettings, setSoundSettings, soundSettings } from './soundSettings.ts';

export { fightersNeedIntense, INTENSE_PERCENT, stageBedGaps, stageBedRecipe, type MusicState, type StageBedRecipe } from './stageBed.ts';

/** Where a fighter's sound comes from: a stereo pan (-0.8 to 0.8, from the fighter's screen x) and, for a KO, how far past the view they leave (0..1). */
export interface Spatial {
  pan: number;
  away?: number;
}

/** The loudness the whole mix is levelled to, and the ceiling the last stage never passes. */
export const TARGET_LUFS = -14;
/** The sample ceiling after the limiter: 0.85 = -1.4 dBFS, so the true peak stays under -1 dBTP. */
const CEILING = 0.85;
/** Sounds that are menu feedback: never panned, never sent to the room. */
const UI_SOUNDS: ReadonlySet<string> = new Set(['ui-move', 'ui-select', 'ui-back', 'wipe', 'vs-slam']);

type LoopVoice = {
  id: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter?: BiquadFilterNode;
};

export interface SoundTake {
  /** Stable id for playtest logs, e.g. hit-light.2. */
  id: string;
  file: string;
}

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
  /** Alternate takes in the same family (no-repeat pick + pitch spread). */
  takes?: SoundTake[];
}

/** Stage floor material for landing SFX. */
export type StageSurface = 'metal' | 'wood' | 'stone' | 'soft';

/** Per-stage landing surface (world-bible place tone → footfall family). */
export const STAGE_SURFACE: Readonly<Record<string, StageSurface>> = {
  'city-top': 'metal',
  'humans-in-the-loop': 'metal',
  'solar-array': 'metal',
  desert: 'stone',
  'space-chess': 'stone',
  'cursed-town': 'wood',
  'rainbow-full-pipe': 'wood',
  'yo-house': 'wood',
  'watercolor-nebula': 'soft',
};

const LAND_BY_SURFACE: Readonly<Record<StageSurface, string>> = {
  metal: 'land',
  wood: 'land-wood',
  stone: 'land-stone',
  soft: 'land-soft',
};

/** ~8 dB under voice: 10^(-8/20). */
const VOICE_DUCK = 10 ** (-8 / 20);
const DUCK_RESTORE_S = 0.4;

export type CrowdKind = 'ooh' | 'roar' | 'rising';
const CROWD_SOUND: Readonly<Record<CrowdKind, string>> = {
  ooh: 'crowd-ooh',
  roar: 'crowd-roar',
  rising: 'crowd-rising',
};

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
  /** Win quotes per fighter (winQuote.ts, tools/win-quotes.mjs). */
  winQuotes?: Record<string, FighterQuotes>;
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
  private buses: Record<'master' | 'music' | 'sfx' | 'voice' | 'ui', GainNode> | null = null;
  /** The master chain after the buses: makeup gain, compressor, limiter, ceiling; the room's reverb beside it. */
  private chain: {
    makeup: GainNode;
    convolver: ConvolverNode;
    sfxSend: GainNode;
    voiceSend: GainNode;
    returnLp: BiquadFilterNode;
    dryLp: BiquadFilterNode;
    analyser: AnalyserNode;
    block: Float32Array;
  } | null = null;
  private room: StageRoom | null = null;
  private peakTap: AnalyserNode | null = null;
  private peakBlock = new Float32Array(2048);
  private roomImpulses = new Map<string, AudioBuffer>();
  private makeupDb = 6;
  private levelBlocks: number[] = [];
  private peak = 0;
  private lufs = -70;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** Downloaded but not yet decoded (decoding needs the AudioContext, which waits for a click). */
  private raw = new Map<string, Promise<ArrayBuffer | null>>();
  private soundById = new Map(SOUNDS.map((s) => [s.id, s]));
  private lineById = new Map([...VOICE.lines, ...winQuoteLines(VOICE)].map((l) => [l.id, l]));
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
  /** Nested duck depth: scene holds one; the voice-line hold is a second layer. */
  private duckDepth = 0;
  /** True while a timed voice-line duck hold is open (announcer / fighter / Blog Man). */
  private voiceDuckHeld = false;
  private duckVoiceUntil = 0;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  private stung = false;
  /** Last take index per sound id (never the same take twice in a row). */
  private lastTake = new Map<string, number>();
  /** Last crowd reaction kind (ooh / roar / rising). */
  private lastCrowd: CrowdKind | null = null;
  /** Active stage id for surface landings (set by playStageBed). */
  private landStageId: string | null = null;
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

  private applyVolumes(opts: { duckRampS?: number } = {}): void {
    if (!this.buses || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Effects covers the announcer and the fighters' voices too (the studio standard has two levels).
    this.buses.master.gain.setTargetAtTime(soundSettings().on ? 1 : 0, t, 0.02);
    const music = busLevel('music') * (this.duckDepth > 0 ? VOICE_DUCK : 1);
    const ramp = opts.duckRampS;
    if (ramp != null && ramp > 0) {
      const g = this.buses.music.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.linearRampToValueAtTime(Math.max(0.0001, music), t + ramp);
    } else {
      this.buses.music.gain.setTargetAtTime(music, t, 0.02);
    }
    this.buses.sfx.gain.setTargetAtTime(busLevel('sfx'), t, 0.02);
    this.buses.ui.gain.setTargetAtTime(busLevel('sfx'), t, 0.02);
    this.buses.voice.gain.setTargetAtTime(busLevel('sfx'), t, 0.02);
  }

  /**
   * The stage's room: builds (and caches) its impulse from the numbers in content/stages.json, sets the wet send
   * (10-25%, halved on Low), the return low-pass and, underwater, the dry low-pass. Logs `dod:mix-room`.
   */
  setRoom(stageId: string | null): void {
    const room = roomOf(stageId);
    this.room = room;
    this.applyRoom();
    try {
      window.dispatchEvent(new CustomEvent('dod:mix-room', { detail: this.mixStats(stageId) }));
    } catch {
      // Node tests.
    }
  }

  private applyRoom(): void {
    const c = this.chain;
    const ctx = this.ctx;
    if (!c || !ctx || !this.room) return;
    const low = graphics().quality === 'low';
    const room = this.room;
    const key = `${room.name}:${low ? 'low' : 'high'}:${ctx.sampleRate}`;
    let ir = this.roomImpulses.get(key);
    if (!ir) {
      const ch = makeImpulse(room, ctx.sampleRate, low);
      ir = ctx.createBuffer(2, ch[0].length, ctx.sampleRate);
      ir.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
      ir.copyToChannel(ch[1] as Float32Array<ArrayBuffer>, 1);
      this.roomImpulses.set(key, ir);
    }
    if (c.convolver.buffer !== ir) c.convolver.buffer = ir;
    const t = ctx.currentTime;
    const wet = wetFor(room, low);
    c.sfxSend.gain.setTargetAtTime(wet, t, 0.05);
    c.voiceSend.gain.setTargetAtTime(wet, t, 0.05);
    c.returnLp.frequency.setTargetAtTime(room.lowpassHz, t, 0.05);
    c.dryLp.frequency.setTargetAtTime(room.dryLowpassHz ?? 20000, t, 0.05);
  }

  /** What the mix is doing now, for the playtest: the room, the wet share, the measured loudness and the sample peak. */
  mixStats(stageId: string | null = this.bedStageId): {
    stage: string | null; room: string; seconds: number; wet: number; low: boolean;
    lufs: number; makeupDb: number; peakDbfs: number; chain: boolean;
  } {
    const room = this.room ?? roomOf(stageId);
    const low = graphics().quality === 'low';
    return {
      stage: stageId,
      room: room.name,
      seconds: low ? Math.min(room.seconds, 1) : room.seconds,
      wet: Math.round(wetFor(room, low) * 1000) / 1000,
      low,
      lufs: Math.round(this.lufs * 10) / 10,
      makeupDb: Math.round(this.makeupDb * 10) / 10,
      peakDbfs: this.peak > 0 ? Math.round(20 * Math.log10(this.peak) * 10) / 10 : -120,
      chain: !!this.chain,
    };
  }

  /** Every 100 ms: the K-weighted level of the last block steers the makeup gain slowly towards -14 LUFS. */
  private level(): void {
    const c = this.chain;
    if (!c || !this.ctx || this.ctx.state !== 'running') return;
    c.analyser.getFloatTimeDomainData(c.block as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < c.block.length; i++) sum += c.block[i] * c.block[i];
    const ms = sum / c.block.length;
    if (this.peakTap) {
      this.peakTap.getFloatTimeDomainData(this.peakBlock as Float32Array<ArrayBuffer>);
      for (let i = 0; i < this.peakBlock.length; i++) this.peak = Math.max(this.peak, Math.abs(this.peakBlock[i]));
    }
    const block = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -120;
    this.levelBlocks.push(block);
    if (this.levelBlocks.length > 40) this.levelBlocks.shift();
    // Short-term loudness: the energy mean of the last 4 s of blocks above the -70 LUFS absolute gate.
    const live = this.levelBlocks.filter((b) => b > -70);
    if (live.length < 5) return;
    this.lufs = 10 * Math.log10(live.reduce((a, b) => a + 10 ** (b / 10), 0) / live.length);
    // Only a real signal steers the gain (a quiet gap must not pump it up); a slow step, never more than 0.4 dB at a time.
    if (this.lufs < -45) return;
    const step = Math.max(-0.4, Math.min(0.4, (TARGET_LUFS - this.lufs) * 0.06));
    this.makeupDb = Math.max(-6, Math.min(18, this.makeupDb + step));
    c.makeup.gain.setTargetAtTime(10 ** (this.makeupDb / 20), this.ctx.currentTime, 0.1);
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
      const ctx = this.ctx;
      const master = ctx.createGain();
      // Master chain: a levelling gain, a gentle compressor, a fast limiter and a ceiling clip (4x oversampled).
      const makeup = ctx.createGain();
      makeup.gain.value = 10 ** (this.makeupDb / 20);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 14;
      comp.ratio.value = 3;
      comp.attack.value = 0.008;
      comp.release.value = 0.22;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.06;
      const ceiling = ctx.createWaveShaper();
      const curve = new Float32Array(4097);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / 2048) - 1;
        curve[i] = Math.abs(x) <= CEILING * 0.8 ? x : Math.sign(x) * (CEILING * 0.8 + (CEILING * 0.2) * Math.tanh((Math.abs(x) - CEILING * 0.8) / (CEILING * 0.2)));
      }
      ceiling.curve = curve;
      ceiling.oversample = '4x';
      master.connect(makeup).connect(comp).connect(limiter).connect(ceiling).connect(ctx.destination);
      // Dry effects and voices pass a low-pass that only underwater closes; the room returns beside it.
      const dryLp = ctx.createBiquadFilter();
      dryLp.type = 'lowpass';
      dryLp.frequency.value = 20000;
      dryLp.connect(master);
      const bus = (to: AudioNode = master) => {
        const g = ctx.createGain();
        g.connect(to);
        return g;
      };
      const convolver = ctx.createConvolver();
      const returnLp = ctx.createBiquadFilter();
      returnLp.type = 'lowpass';
      returnLp.frequency.value = 14000;
      convolver.connect(returnLp).connect(master);
      const sfxSend = ctx.createGain();
      const voiceSend = ctx.createGain();
      sfxSend.gain.value = 0;
      voiceSend.gain.value = 0;
      sfxSend.connect(convolver);
      voiceSend.connect(convolver);
      this.buses = { master, music: bus(), sfx: bus(dryLp), voice: bus(dryLp), ui: bus() };
      this.buses.sfx.connect(sfxSend);
      this.buses.voice.connect(voiceSend);
      // The loudness meter listens to the finished mix, K-weighted (BS.1770: a high shelf and a 38 Hz high-pass).
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1500;
      shelf.gain.value = 4;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 38;
      hp.Q.value = 0.5;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      ceiling.connect(shelf).connect(hp).connect(analyser);
      const tap = ctx.createAnalyser();
      tap.fftSize = 2048;
      ceiling.connect(tap);
      this.chain = { makeup, convolver, sfxSend, voiceSend, returnLp, dryLp, analyser, block: new Float32Array(analyser.fftSize) };
      this.peakTap = tap;
      this.levelTimer = setInterval(() => this.level(), 100);
      onGraphics(() => this.applyRoom());
      this.applyVolumes();
      if (this.bedStageId) this.setRoom(this.bedStageId);
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
    const urls: string[] = [];
    for (const s of SOUNDS) {
      if (!s.file) continue;
      if (s.group === 'music' && !musicIds.has(s.id)) continue;
      urls.push(s.file);
      if (s.takes) for (const t of s.takes) urls.push(t.file);
    }
    for (const l of this.lineById.values()) {
      if (l.audio && who.has(l.who)) urls.push(l.audio);
    }
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

  private async start(url: string, bus: GainNode, volume: number, rate = 1, loop = false, at?: Spatial): Promise<AudioBufferSourceNode | null> {
    if (!this.ctx) return null;
    const buf = await this.buffer(url);
    if (!buf || !this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    if (at) {
      // Placed in the stereo field by the fighter's screen x; a fighter leaving through the blast zone loses highs and level.
      let node: AudioNode = g;
      if (at.away != null) {
        const d = departing(at.away);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 12000;
        const fade = this.ctx.createGain();
        const t = this.ctx.currentTime;
        lp.frequency.setValueAtTime(12000, t);
        lp.frequency.exponentialRampToValueAtTime(Math.max(100, d.cutoffHz), t + d.seconds);
        fade.gain.setValueAtTime(1, t);
        fade.gain.linearRampToValueAtTime(d.gain, t + d.seconds);
        g.connect(lp).connect(fade);
        node = fade;
      }
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-0.8, Math.min(0.8, at.pan));
      node.connect(pan).connect(bus);
      src.connect(g);
    } else {
      src.connect(g).connect(bus);
    }
    src.start();
    return src;
  }

  /**
   * Picks a take for `id`: random among its `takes` (or the single `file`), never the same index twice
   * in a row, with a 5–10% pitch spread when `vary` is set (default true for combat/movement).
   */
  private pickTake(id: string): { entry: SoundEntry; take: SoundTake; rate: number } | null {
    const s = this.soundById.get(id);
    if (!s?.file || !this.buses) return null;
    const pool: SoundTake[] = s.takes?.length
      ? s.takes
      : [{ id: `${s.id}.0`, file: s.file }];
    const last = this.lastTake.get(id);
    let idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && last != null && idx === last) idx = (idx + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
    this.lastTake.set(id, idx);
    // 5–10% pitch spread (±), so back-to-back hits never share buffer+rate.
    const spread = 0.05 + Math.random() * 0.05;
    const rate = 1 + (Math.random() < 0.5 ? -spread : spread);
    return { entry: s, take: pool[idx], rate };
  }

  private emitSoundTake(soundId: string, take: SoundTake, rate: number, at?: Spatial): void {
    try {
      window.dispatchEvent(new CustomEvent('dod:sound-take', {
        detail: { id: soundId, takeId: take.id, file: take.file, rate, pan: at?.pan ?? null, t: typeof performance !== 'undefined' ? performance.now() : 0 },
      }));
    } catch {
      // Node tests have no window.
    }
  }

  /** Plays a sound effect by id. Picks among takes without immediate repeats; pitch varies 5–10%. */
  sfx(id: string, opts: { vary?: boolean; at?: Spatial } = {}): void {
    const pick = this.pickTake(id);
    if (!pick || !this.buses) return;
    const rate = opts.vary === false ? 1 : pick.rate;
    this.emitSoundTake(id, pick.take, rate, opts.at);
    // Menu feedback goes round the room and the pan.
    const ui = UI_SOUNDS.has(id);
    void this.start(pick.take.file, ui ? this.buses.ui : this.buses.sfx, pick.entry.volume, rate, false, ui ? undefined : opts.at);
  }

  /**
   * A victory fanfare (victory.ts, content/sounds.json `fanfare-<group>`, 5 s) on the music bus, so the win quote ducks it like music.
   * Fires `dod:fanfare` when it starts and `dod:fanfare-end` when it ends or is stopped. Returns stop() (a short fade).
   */
  fanfare(id: string): () => void {
    const s = this.soundById.get(id);
    let stopped = false;
    let src: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    const end = (why: string) => {
      try { window.dispatchEvent(new CustomEvent('dod:fanfare-end', { detail: { id, why } })); } catch { /* Node tests */ }
    };
    if (!s?.file || !this.buses || !this.ctx) {
      try { window.dispatchEvent(new CustomEvent('dod:fanfare', { detail: { id, file: s?.file ?? null, played: false } })); } catch { /* Node tests */ }
      return () => undefined;
    }
    const ctx = this.ctx;
    const bus = this.buses.music;
    try { window.dispatchEvent(new CustomEvent('dod:fanfare', { detail: { id, file: s.file, played: true, t: performance.now() } })); } catch { /* Node tests */ }
    void this.buffer(s.file).then((buf) => {
      if (!buf || stopped) return;
      src = ctx.createBufferSource();
      src.buffer = buf;
      // A rematch inside a minute never replays the same buffer at the same rate.
      src.playbackRate.value = 1 + (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.03);
      gain = ctx.createGain();
      gain.gain.value = s.volume;
      src.connect(gain).connect(bus);
      src.onended = () => { if (!stopped) end('done'); };
      src.start();
    });
    return () => {
      if (stopped) return;
      stopped = true;
      if (gain && src) {
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        const g = src;
        window.setTimeout(() => { try { g.stop(); } catch { /* already stopped */ } }, 400);
      }
      end('skipped');
    };
  }

  /** Whether a sound has a file to play yet (a pool with no take made returns false). */
  hasSound(id: string): boolean {
    const s = this.soundById.get(id);
    return !!s && (!!s.takes?.length || !!s.file);
  }

  /**
   * A special's sound: its archetype's release (at the move's first frame) or impact (on the hit), then the
   * fighter's signature accent on top when it has one (`special-accent-<fighter id>`, Season 1 kits). Every layer
   * goes through pickTake (no take twice in a row, 5-10% pitch) and emits `dod:sound-take` with its pool name.
   * Returns whether the archetype layer played, so a caller can leave the generic swing out.
   */
  special(phase: 'release' | 'impact', kind: SpecialKind, fighterId: string, at?: Spatial): boolean {
    const id = `special-${kind}-${phase}`;
    const played = this.hasSound(id);
    if (played) this.sfx(id, { vary: true, at });
    const accent = `special-accent-${fighterId}`;
    if (this.hasSound(accent)) this.sfx(accent, { vary: true, at });
    return played;
  }

  /** Landing SFX for the current stage's surface (metal / wood / stone / soft). */
  landSfx(stageId?: string | null, at?: Spatial): void {
    const stage = stageId ?? this.landStageId ?? this.bedStageId;
    const surface = (stage && STAGE_SURFACE[stage]) || 'metal';
    this.sfx(LAND_BY_SURFACE[surface], { vary: true, at });
  }

  /**
   * Crowd reaction from a match event: ooh (heavy hit), roar (KO), rising (comeback).
   * Never plays the same reaction kind twice in a row; takes also no-repeat inside the family.
   */
  crowd(kind: CrowdKind): void {
    let use = kind;
    if (this.lastCrowd === use) {
      const alts: CrowdKind[] = (['ooh', 'roar', 'rising'] as CrowdKind[]).filter((k) => k !== use);
      use = alts[Math.floor(Math.random() * alts.length)];
    }
    this.lastCrowd = use;
    const id = CROWD_SOUND[use];
    const pick = this.pickTake(id);
    if (!pick || !this.buses) return;
    this.emitSoundTake(id, pick.take, pick.rate);
    try {
      window.dispatchEvent(new CustomEvent('dod:crowd', {
        detail: { kind: use, takeId: pick.take.id, file: pick.take.file },
      }));
    } catch {
      // Node tests.
    }
    void this.start(pick.take.file, this.buses.sfx, pick.entry.volume, pick.rate);
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

  /**
   * Lowers the music ~8 dB under any voice (announcer, Blog Man, scene, fighter), then restores over 0.4 s.
   * Nestable: a scene hold and a line hold can stack; music only returns when the last hold ends.
   * Respects mute and Music volume. Emits `dod:music-duck` for the playtest.
   */
  duck(on: boolean): void {
    if (on) {
      const first = this.duckDepth === 0;
      this.duckDepth++;
      if (first) {
        this.applyVolumes({ duckRampS: 0.05 });
        this.emitDuck(true);
      }
    } else {
      if (this.duckDepth === 0) return;
      this.duckDepth--;
      if (this.duckDepth === 0) {
        // Restore over 0.4 s after the last voice/scene hold ends.
        this.applyVolumes({ duckRampS: DUCK_RESTORE_S });
        this.emitDuck(false);
      }
    }
  }

  private emitDuck(on: boolean): void {
    try {
      window.dispatchEvent(new CustomEvent('dod:music-duck', {
        detail: { on, db: on ? -8 : 0, restoreMs: on ? 0 : DUCK_RESTORE_S * 1000 },
      }));
    } catch {
      // Node tests.
    }
  }

  /** Duck for the length of a voice take (extends if another line overlaps). */
  private duckForVoice(ms: number): void {
    const hold = Math.max(200, ms);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.duckVoiceUntil = Math.max(this.duckVoiceUntil, now + hold);
    if (!this.voiceDuckHeld) {
      this.voiceDuckHeld = true;
      this.duck(true);
    }
    if (this.duckTimer) clearTimeout(this.duckTimer);
    const wait = Math.max(16, this.duckVoiceUntil - now);
    this.duckTimer = setTimeout(() => {
      this.duckTimer = null;
      const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (t + 16 < this.duckVoiceUntil) {
        this.duckForVoice(this.duckVoiceUntil - t);
        return;
      }
      this.voiceDuckHeld = false;
      this.duckVoiceUntil = 0;
      this.duck(false);
    }, wait);
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
  fighterVoice(who: string, kind: 'effort' | 'hurt' | 'ko' | 'taunt', at?: Spatial): boolean {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if ((this.fighterBusyUntil.get(who) ?? 0) > now) return false;
    if (kind === 'effort' && now - (this.effortAt.get(who) ?? 0) < 1500) return false;

    let id: string;
    if (kind === 'effort' || kind === 'hurt') {
      // Season 1 has 3 efforts, everyone else 2: count the takes this fighter really has.
      let n = 0;
      while (this.lineById.get(`fighter.${who}.${kind}.${n}`)?.audio) n++;
      n = Math.max(1, n);
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
          this.voice(ko.audio, false, at);
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
    void this.start(audioUrl, this.buses.voice, 1, 1, false, at).then(async (src) => {
      if (!src) {
        this.fighterBusyUntil.set(who, now);
        if (kind === 'effort') this.effortAt.set(who, 0);
        return;
      }
      this.fighterSrc.set(who, src);
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.emitFighterVoice(who, kind, id, text, audioUrl, started);
      const buf = await this.buffer(audioUrl);
      this.duckForVoice(buf ? buf.duration * 1000 : 800);
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

  /** Plays a voice file. Dialogue cuts off the line before it; callouts overlap. Ducks music ~8 dB. */
  voice(url: string | null | undefined, interrupt = true, at?: Spatial): void {
    if (url) window.dispatchEvent(new CustomEvent('dod:voice', { detail: { url, played: !!this.buses } }));
    if (!url || !this.buses) return;
    if (interrupt) this.stopVoice();
    void this.start(url, this.buses.voice, 1, 1, false, at).then(async (src) => {
      if (!src) return;
      if (interrupt) this.speech = src;
      const buf = await this.buffer(url);
      this.duckForVoice(buf ? buf.duration * 1000 : 900);
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
    this.landStageId = null;
    this.bedWant = null;
    // Menus and results sound like the default room, not the last stage's.
    if (this.room) {
      this.room = roomOf(null);
      this.applyRoom();
    }
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
    this.landStageId = stageId;
    this.bedWant = recipe;
    this.wantMusic = recipe.music;
    this.stung = false;
    if (!this.ctx || !this.buses) return;
    this.setRoom(stageId);

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
    try {
      window.dispatchEvent(new CustomEvent('dod:music-state', {
        detail: { state: next, stageId: this.bedStageId, intense: this.bedWant.intense },
      }));
    } catch {
      // Node tests.
    }
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
