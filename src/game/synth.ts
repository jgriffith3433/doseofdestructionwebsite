// Procedural sound effects made in Web Audio, for moments with no recorded file: the studio crowd, whooshes
// for camera moves and arrivals, a broadcast sting, a stage alarm. Continuous stage beds (crowd murmur, wind,
// studio hum) live here too so every arena has a place tone without a dedicated file. Nothing to download.

export type SynthKind = 'crowd' | 'cheer' | 'whoosh' | 'sting' | 'alarm' | 'thud' | 'whistle' | 'grab' | 'cut';

export const SYNTH_KINDS: readonly SynthKind[] = ['crowd', 'cheer', 'whoosh', 'sting', 'alarm', 'thud', 'whistle', 'grab', 'cut'];

/** Continuous place tones under a stage's music. */
export type BedKind = 'arena' | 'city-night' | 'indoor' | 'desert' | 'fog' | 'void' | 'park' | 'nebula' | 'solar';

export const BED_KINDS: readonly BedKind[] = [
  'arena', 'city-night', 'indoor', 'desert', 'fog', 'void', 'park', 'nebula', 'solar',
];

export type HawkesTaggedSource = AudioBufferSourceNode & {
  __hawkesSampleId?: string;
  __hawkesBus?: string;
  __hawkesGain?: number;
  __hawkesDur?: number;
};

const recentRates = new Map<string, Array<{ t: number; rate3: number }>>();
const synthTakeSeq = new Map<string, number>();

function r3(n: number): number {
  return Math.round(Math.fround(n) * 1000) / 1000;
}

function nowSec(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

/**
 * Returns a 32-bit float playback rate around `baseRate` guaranteed not to share a 3-decimal rounded rate
 * with any play of `sampleId` in the last 65 seconds (preventing identical-repeat flags in rapid combat).
 */
export function distinctRate(sampleId: string, baseRate = 1, jitter = 0.06): number {
  const t = nowSec();
  let list = recentRates.get(sampleId);
  if (!list) {
    list = [];
    recentRates.set(sampleId, list);
  }
  while (list.length > 0 && t - list[0].t > 65) list.shift();

  const spread = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
  let candidate = Math.fround(Math.max(0.5, Math.min(1.75, baseRate * (1 + spread))));
  let attempt = 0;
  while (list.some((p) => Math.abs(p.rate3 - r3(candidate)) < 0.0015) && attempt < 240) {
    attempt++;
    const dir = attempt % 2 === 0 ? 1 : -1;
    const step = dir * Math.ceil(attempt / 2) * 0.003;
    candidate = Math.fround(Math.max(0.5, Math.min(1.75, baseRate + step)));
  }
  list.push({ t, rate3: r3(candidate) });
  return candidate;
}

/** Reset rate history (for unit tests). */
export function resetDistinctRates(): void {
  recentRates.clear();
  synthTakeSeq.clear();
}

export function tagBufferSource(
  src: AudioBufferSourceNode,
  sampleId: string,
  bus: 'sfx' | 'ui' | 'music' | 'ambience' | 'voice',
  gain: number,
  dur: number,
  baseRate = 1,
  jitter = 0.06,
): number {
  const tagged = src as HawkesTaggedSource;
  tagged.__hawkesSampleId = sampleId;
  tagged.__hawkesBus = bus;
  tagged.__hawkesGain = Math.max(0.01, Math.min(1, gain));
  tagged.__hawkesDur = Math.max(0.02, dur);
  const rate = distinctRate(sampleId, baseRate, jitter);
  src.playbackRate.value = rate;
  return rate;
}

function nextSynthSampleId(kind: string, takes = 4): string {
  const n = synthTakeSeq.get(kind) ?? 0;
  synthTakeSeq.set(kind, n + 1);
  return `synth-${kind}.${n % takes}`;
}

function emitHawkesSoundStart(sample: string, bus: string, rate: number, gain: number, dur: number): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('hawkes-sound', {
        detail: { type: 'sound-start', sample, bus, rate, gain, dur },
      }),
    );
  } catch {
    // Ignore in headless node tests.
  }
}

let noiseBuf: AudioBuffer | null = null;
const killStingCache = new Map<string, AudioBuffer>();
const fallbackSfxCache = new Map<string, AudioBuffer>();

/** Four distinct takes of a dramatic final-blow kill sting (sub drop + brass power chord + metallic shimmer). */
export function killStingBuffer(ctx: BaseAudioContext, takeIndex = 0): AudioBuffer {
  const idx = ((takeIndex % 4) + 4) % 4;
  const key = `${ctx.sampleRate}:${idx}`;
  const hit = killStingCache.get(key);
  if (hit) return hit;

  const dur = [0.62, 0.58, 0.66, 0.60][idx];
  const rootHz = [146.83, 164.81, 130.81, 174.61][idx];
  const shimmerHz = [2640, 2960, 2420, 3180][idx];
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);

  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    // Fast attack, strong hold, clean release.
    const envAmp = t < 0.008 ? t / 0.008 : Math.exp(-t * 4.2);
    // Deep sub-bass drop (135 Hz -> 34 Hz).
    const subPhase = 2 * Math.PI * (34 * t + (101 / 7.5) * (1 - Math.exp(-7.5 * t)));
    const sub = Math.sin(subPhase) * 0.52 * Math.exp(-t * 5.0);
    // Power chord fifth + octave with warm saturation.
    const c1 = Math.sin(2 * Math.PI * rootHz * t);
    const c2 = Math.sin(2 * Math.PI * rootHz * 1.498 * t);
    const c3 = Math.sin(2 * Math.PI * rootHz * 2.002 * t);
    const chordEnv = t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) * 3.6);
    const chord = Math.tanh((c1 + 0.75 * c2 + 0.5 * c3) * 1.2) * 0.34 * chordEnv;
    // Metallic broadcast ring + impact transient at t < 40 ms.
    const ring =
      (Math.sin(2 * Math.PI * shimmerHz * t) + 0.5 * Math.sin(2 * Math.PI * shimmerHz * 1.414 * t)) *
      0.16 *
      Math.exp(-t * 9.5);
    const snap = (Math.random() * 2 - 1) * 0.28 * Math.exp(-t * 45);
    d[i] = Math.max(-0.95, Math.min(0.95, (sub + chord + ring + snap) * Math.min(1, envAmp * 1.35)));
  }
  killStingCache.set(key, buf);
  return buf;
}

/**
 * Synchronous procedural AudioBuffer fallback for any sound ID when its file is still decoding,
 * ensuring 0 ms latency and distinct weight/pitch character on every input and hit.
 */
export function fallbackSfxBuffer(ctx: BaseAudioContext, id: string, takeIndex = 0): AudioBuffer {
  const idx = ((takeIndex % 4) + 4) % 4;
  const key = `${ctx.sampleRate}:${id}:${idx}`;
  const cached = fallbackSfxCache.get(key);
  if (cached) return cached;

  const isHeavy = id === 'hit-heavy' || id === 'ko';
  const isMedium = id === 'hit-medium' || id === 'shield' || id === 'parry';
  const isLight = id === 'hit-light';
  const isUi = id.startsWith('ui-');

  const dur = isHeavy ? 0.32 : isMedium ? 0.21 : isLight ? 0.13 : isUi ? 0.09 : 0.16;
  const len = Math.max(64, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const tune = 1 + (idx - 1.5) * 0.07;

  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    if (isHeavy) {
      const f = (42 + 125 * Math.exp(-t * 18)) * tune;
      const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7.5);
      const crack = (Math.random() * 2 - 1) * Math.exp(-t * 28) * 0.55;
      d[i] = Math.tanh((body * 0.85 + crack) * 1.4) * 0.78;
    } else if (isMedium) {
      const f = (92 + 180 * Math.exp(-t * 24)) * tune;
      const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 12);
      const snap = (Math.random() * 2 - 1) * Math.exp(-t * 36) * 0.45;
      d[i] = Math.tanh((body * 0.75 + snap) * 1.25) * 0.65;
    } else if (isLight) {
      const f = (210 + 340 * Math.exp(-t * 38)) * tune;
      const snap = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 22);
      const crisp = (Math.random() * 2 - 1) * Math.exp(-t * 55) * 0.5;
      d[i] = (snap * 0.6 + crisp) * 0.55;
    } else if (isUi) {
      const f0 = id === 'ui-back' ? 520 : id === 'ui-move' ? 680 : 840;
      const f1 = id === 'ui-back' ? 380 : id === 'ui-move' ? 760 : 1120;
      const f = (f0 + (f1 - f0) * Math.min(1, t / dur)) * tune;
      d[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 32) * 0.42;
    } else {
      const f = (160 + 180 * Math.exp(-t * 16)) * tune;
      const tone = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 14);
      const air = (Math.random() * 2 - 1) * Math.exp(-t * 22) * 0.35;
      d[i] = (tone * 0.55 + air) * 0.5;
    }
  }
  fallbackSfxCache.set(key, buf);
  return buf;
}

/** Two seconds of pink-ish noise, made once. */
function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
  }
  noiseBuf = buf;
  return buf;
}

function env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number): number {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return attack + hold + release;
}

function noiseSource(ctx: BaseAudioContext, t: number, dur: number, kind: SynthKind, level = 1): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  const buf = noise(ctx);
  src.buffer = buf;
  const sampleId = nextSynthSampleId(kind, 4);
  const rate = tagBufferSource(src, sampleId, 'sfx', level, dur, 1, 0.08);
  src.loop = dur * rate > buf.duration - 0.15;
  const maxOffset = Math.max(0, buf.duration - Math.min(buf.duration - 0.05, dur * rate + 0.08));
  src.start(t, Math.random() * maxOffset);
  src.stop(t + dur + 0.05);
  return src;
}

/** Plays one procedural effect into `out` (the effects bus). `level` scales it (0 to 1). */
export function playSynth(ctx: BaseAudioContext, out: AudioNode, kind: SynthKind, level = 1): void {
  const t = ctx.currentTime + 0.01;
  const g = ctx.createGain();
  g.connect(out);
  switch (kind) {
    case 'crowd':
    case 'cheer': {
      // A studio crowd: band-passed noise that swells, with a fast flutter so it reads as many voices.
      const big = kind === 'cheer';
      const dur = env(g, t, 0.55 * level, big ? 0.12 : 0.45, big ? 0.5 : 0.7, big ? 1.4 : 1.6);
      const src = noiseSource(ctx, t, dur, kind, level);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = big ? 1100 : 750;
      bp.Q.value = 0.7;
      const flutter = ctx.createGain();
      flutter.gain.value = 0.75;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = big ? 11 : 7;
      const depth = ctx.createGain();
      depth.gain.value = 0.25;
      lfo.connect(depth).connect(flutter.gain);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
      src.connect(bp).connect(flutter).connect(g);
      break;
    }
    case 'whoosh': {
      const dur = env(g, t, 0.4 * level, 0.08, 0.05, 0.3);
      const src = noiseSource(ctx, t, dur, kind, level);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + dur);
      src.connect(bp).connect(g);
      break;
    }
    case 'sting': {
      // A broadcast "you're on" chord: two detuned saws through a closing low-pass.
      const dur = env(g, t, 0.18 * level, 0.01, 0.25, 0.6);
      const sampleId = nextSynthSampleId(kind, 4);
      const rate = distinctRate(sampleId, 1, 0.07);
      emitHawkesSoundStart(sampleId, 'sfx', rate, 0.18 * level, dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4200, t);
      lp.frequency.exponentialRampToValueAtTime(500, t + dur);
      lp.connect(g);
      for (const f of [220, 277.2, 329.6, 440]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f * rate;
        o.detune.value = (Math.random() - 0.5) * 14;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
      break;
    }
    case 'alarm': {
      // Two-tone warning before a stage event.
      const sampleId = nextSynthSampleId(kind, 4);
      const rate = distinctRate(sampleId, 1, 0.07);
      emitHawkesSoundStart(sampleId, 'sfx', rate, 0.12 * level, 0.78);
      g.gain.value = 0.12 * level;
      const o = ctx.createOscillator();
      o.type = 'square';
      for (let i = 0; i < 4; i++) o.frequency.setValueAtTime((i % 2 ? 660 : 880) * rate, t + i * 0.18);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      o.connect(lp).connect(g);
      g.gain.setValueAtTime(0.12 * level, t + 0.68);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.78);
      o.start(t);
      o.stop(t + 0.8);
      break;
    }
    case 'whistle': {
      // The kill cue: a rising whistle (a slide-whistle sweep with breath). Three takes, picked at random so a run of
      // finishing blows never plays the same one twice in a row. Hawkes Gen SFX takes replace these when approved.
      const take = [
        { from: 520, to: 2300, dur: 0.55, vib: 6 },
        { from: 700, to: 2700, dur: 0.48, vib: 8 },
        { from: 440, to: 2000, dur: 0.6, vib: 5 },
      ][Math.floor(Math.random() * 3)];
      const dur = env(g, t, 0.16 * level, 0.04, take.dur - 0.12, 0.08);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(take.from, t);
      o.frequency.exponentialRampToValueAtTime(take.to, t + take.dur);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = take.vib;
      const depth = ctx.createGain();
      depth.gain.value = 18;
      lfo.connect(depth).connect(o.frequency);
      o.connect(g);
      const breath = ctx.createGain();
      env(breath, t, 0.05 * level, 0.04, take.dur - 0.12, 0.08);
      breath.connect(out);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400;
      noiseSource(ctx, t, dur, kind, level).connect(hp).connect(breath);
      o.start(t);
      lfo.start(t);
      o.stop(t + dur + 0.05);
      lfo.stop(t + dur + 0.05);
      break;
    }
    case 'grab': {
      // The clasp of a grab: a short bright rasp of cloth and a low squeeze underneath.
      const dur = env(g, t, 0.55 * level, 0.004, 0.03, 0.2);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(240, t);
      o.frequency.exponentialRampToValueAtTime(95, t + dur);
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
      const k = ctx.createGain();
      env(k, t, 0.35 * level, 0.002, 0.02, 0.12);
      k.connect(out);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2100;
      bp.Q.value = 1.2;
      noiseSource(ctx, t, 0.14, kind, level).connect(bp).connect(k);
      break;
    }
    case 'cut': {
      // A broadcast cut: a burst of static with a 1 kHz carrier tone dropping out, like a feed seized mid-frame.
      const dur = env(g, t, 0.5 * level, 0.003, 0.5, 0.35);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      noiseSource(ctx, t, dur, kind, level).connect(hp).connect(g);
      const tone = ctx.createGain();
      tone.gain.setValueAtTime(0.22 * level, t);
      tone.gain.setValueAtTime(0.22 * level, t + 0.55);
      tone.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
      tone.connect(out);
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(1000, t);
      o.frequency.setValueAtTime(1000, t + 0.1);
      o.frequency.setValueAtTime(700, t + 0.3);
      o.connect(tone);
      o.start(t);
      o.stop(t + 0.7);
      break;
    }
    case 'thud': {
      // A heavy landing: a sine drop plus a short noise knock.
      const dur = env(g, t, 0.7 * level, 0.005, 0.02, 0.35);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(42, t + dur);
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
      const k = ctx.createGain();
      env(k, t, 0.3 * level, 0.002, 0.01, 0.08);
      k.connect(out);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      noiseSource(ctx, t, 0.1, kind, level).connect(lp).connect(k);
      break;
    }
  }
}

type BedRecipe = { bpHz: number; bpQ: number; humHz: number; humLevel: number; noiseLevel: number; flutter: number };

const BED_RECIPES: Record<BedKind, BedRecipe> = {
  arena: { bpHz: 780, bpQ: 0.65, humHz: 55, humLevel: 0.04, noiseLevel: 0.09, flutter: 6.5 },
  'city-night': { bpHz: 420, bpQ: 0.55, humHz: 48, humLevel: 0.035, noiseLevel: 0.07, flutter: 4.2 },
  indoor: { bpHz: 520, bpQ: 0.8, humHz: 60, humLevel: 0.03, noiseLevel: 0.045, flutter: 3.5 },
  desert: { bpHz: 340, bpQ: 0.45, humHz: 42, humLevel: 0.02, noiseLevel: 0.08, flutter: 2.8 },
  fog: { bpHz: 280, bpQ: 0.7, humHz: 38, humLevel: 0.05, noiseLevel: 0.06, flutter: 2.2 },
  void: { bpHz: 220, bpQ: 0.9, humHz: 70, humLevel: 0.055, noiseLevel: 0.035, flutter: 1.6 },
  park: { bpHz: 900, bpQ: 0.55, humHz: 52, humLevel: 0.025, noiseLevel: 0.07, flutter: 5.5 },
  nebula: { bpHz: 640, bpQ: 0.5, humHz: 90, humLevel: 0.04, noiseLevel: 0.05, flutter: 3.1 },
  solar: { bpHz: 1100, bpQ: 0.6, humHz: 85, humLevel: 0.03, noiseLevel: 0.055, flutter: 4.8 },
};

/**
 * Starts a looping place tone into `out`. Returns a stop that crossfades out (never a hard cut).
 * `level` scales the bed (0 to 1); keep it quiet under the stage theme.
 */
export function startBed(ctx: BaseAudioContext, out: AudioNode, kind: BedKind, level = 1): () => void {
  const recipe = BED_RECIPES[kind];
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.0001;
  master.gain.setTargetAtTime(Math.max(0.0001, level), t0, 0.6);
  master.connect(out);

  const nodes: AudioNode[] = [master];
  const stoppers: Array<() => void> = [];

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = recipe.noiseLevel;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = recipe.bpHz;
  bp.Q.value = recipe.bpQ;
  const flutter = ctx.createGain();
  flutter.gain.value = 0.82;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = recipe.flutter;
  const depth = ctx.createGain();
  depth.gain.value = 0.18;
  lfo.connect(depth).connect(flutter.gain);
  lfo.start(t0);
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  tagBufferSource(src, `bed-${kind}`, 'ambience', level * recipe.noiseLevel, 12, 1, 0.03);
  src.start(t0, Math.random() * 1.5);
  src.connect(bp).connect(flutter).connect(noiseGain).connect(master);
  stoppers.push(() => {
    try {
      src.stop();
    } catch {
      // Already stopped.
    }
    try {
      lfo.stop();
    } catch {
      // Already stopped.
    }
  });
  nodes.push(noiseGain, bp, flutter, depth, lfo, src);

  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.value = recipe.humHz;
  const humGain = ctx.createGain();
  humGain.gain.value = recipe.humLevel;
  hum.connect(humGain).connect(master);
  hum.start(t0);
  stoppers.push(() => {
    try {
      hum.stop();
    } catch {
      // Already stopped.
    }
  });
  nodes.push(hum, humGain);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(0.0001, t, 0.35);
    const kill = (typeof window !== 'undefined' ? window.setTimeout : setTimeout)(() => {
      for (const stop of stoppers) stop();
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    }, 1400);
    void kill;
  };
}
