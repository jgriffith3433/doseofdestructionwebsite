/**
 * The studio's standard sound settings, shared by every Hawkes game: localStorage "hawkes.sound" holds
 * { on, music, sfx }, the volumes 0-1. Music is the menu, stage and results loops. Effects is everything
 * else: hits, menu clicks, the announcer and the fighters' voices. audio.ts applies them to its buses.
 */

export type SoundSettings = { on: boolean; music: number; sfx: number };

export const SOUND_KEY = 'hawkes.sound';
/** Where the levels lived before the studio standard (master, music, sfx, voice); read once to carry them over. */
const OLD_KEY = 'dod-audio';
const DEFAULTS: SoundSettings = { on: true, music: 0.6, sfx: 0.9 };

const level = (value: unknown, fallback: number) => {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

export const readSoundSettings = (): SoundSettings => {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>;
      return { on: parsed.on !== false, music: level(parsed.music, DEFAULTS.music), sfx: level(parsed.sfx, DEFAULTS.sfx) };
    }
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null') as { master?: number; music?: number; sfx?: number } | null;
    if (old && typeof old === 'object') {
      const master = level(old.master, 1);
      return { on: true, music: level(old.music, DEFAULTS.music) * master, sfx: level(old.sfx, DEFAULTS.sfx) * master };
    }
  } catch {
    // Unreadable storage: defaults.
  }
  return { ...DEFAULTS };
};

let current = readSoundSettings();
const listeners = new Set<(settings: SoundSettings) => void>();

export const soundSettings = (): SoundSettings => ({ ...current });

/** What a bus plays at: its volume, or 0 with Sound off. */
export const busLevel = (bus: 'music' | 'sfx') => (current.on ? current[bus] : 0);

export const setSoundSettings = (next: Partial<SoundSettings>) => {
  current = {
    on: next.on ?? current.on,
    music: level(next.music, current.music),
    sfx: level(next.sfx, current.sfx),
  };
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(current));
  } catch {
    // Private mode can block storage; the choice still holds for this visit.
  }
  for (const listener of listeners) listener(soundSettings());
};

export const onSoundSettings = (listener: (settings: SoundSettings) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
