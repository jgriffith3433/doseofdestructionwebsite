/**
 * The studio's standard sound settings, shared by every Hawkes game: localStorage "hawkes.sound" holds
 * { on, music, sfx, voice, captions }, the volumes 0-1. Music is the menu, stage and results loops. Effects is hits and
 * menu clicks. Voice is the announcer, commentary, story and fighter lines (its own bus). Captions is read-along text. audio.ts applies them to its buses.
 */

export type SoundSettings = { on: boolean; music: number; sfx: number; voice: number; captions: boolean };

export const SOUND_KEY = 'hawkes.sound';
/** Where the levels lived before the studio standard (master, music, sfx, voice); read once to carry them over. */
const OLD_KEY = 'dod-audio';
const DEFAULTS: SoundSettings = { on: true, music: 0.6, sfx: 0.9, voice: 0.9, captions: true };

const level = (value: unknown, fallback: number) => {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

export const readSoundSettings = (): SoundSettings => {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>;
      const sfx = level(parsed.sfx, DEFAULTS.sfx);
      // Saved before Voice existed: voices stayed at the Effects level, so they start there.
      return { on: parsed.on !== false, music: level(parsed.music, DEFAULTS.music), sfx, voice: level(parsed.voice, sfx), captions: parsed.captions !== false };
    }
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null') as { master?: number; music?: number; sfx?: number } | null;
    if (old && typeof old === 'object') {
      const master = level(old.master, 1);
      const sfx = level(old.sfx, DEFAULTS.sfx) * master;
      return { on: true, music: level(old.music, DEFAULTS.music) * master, sfx, voice: sfx, captions: true };
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
export const busLevel = (bus: 'music' | 'sfx' | 'voice') => (current.on ? current[bus] : 0);

export const setSoundSettings = (next: Partial<SoundSettings>) => {
  current = {
    on: next.on ?? current.on,
    music: level(next.music, current.music),
    sfx: level(next.sfx, current.sfx),
    voice: level(next.voice, current.voice),
    captions: next.captions ?? current.captions,
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
