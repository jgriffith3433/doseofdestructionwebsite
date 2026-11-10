// Procedural sound effects made in Web Audio, for moments with no recorded file: the studio crowd, whooshes
// for camera moves and arrivals, a broadcast sting, a stage alarm. Continuous stage beds (crowd murmur, wind,
// studio hum) live here too so every arena has a place tone without a dedicated file. Nothing to download.

export type SynthKind = 'crowd' | 'cheer' | 'whoosh' | 'sting' | 'alarm' | 'thud';

export const SYNTH_KINDS: readonly SynthKind[] = ['crowd', 'cheer', 'whoosh', 'sting', 'alarm', 'thud'];

/** Continuous place tones under a stage's music. */
export type BedKind = 'arena' | 'city-night' | 'indoor' | 'desert' | 'fog' | 'void' | 'park' | 'nebula' | 'solar';

export const BED_KINDS: readonly BedKind[] = [
  'arena', 'city-night', 'indoor', 'desert', 'fog', 'void', 'park', 'nebula', 'solar',
];

let noiseBuf: AudioBuffer | null = null;

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

function noiseSource(ctx: BaseAudioContext, t: number, dur: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  src.start(t, Math.random() * 1.5);
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
      const src = noiseSource(ctx, t, dur);
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
      const src = noiseSource(ctx, t, dur);
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
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4200, t);
      lp.frequency.exponentialRampToValueAtTime(500, t + dur);
      lp.connect(g);
      for (const f of [220, 277.2, 329.6, 440]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = (Math.random() - 0.5) * 14;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
      break;
    }
    case 'alarm': {
      // Two-tone warning before a stage event.
      g.gain.value = 0.12 * level;
      const o = ctx.createOscillator();
      o.type = 'square';
      for (let i = 0; i < 4; i++) o.frequency.setValueAtTime(i % 2 ? 660 : 880, t + i * 0.18);
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
      noiseSource(ctx, t, 0.1).connect(lp).connect(k);
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
