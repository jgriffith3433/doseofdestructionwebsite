// The player's online profile (docs/online.md, "Profile"): a name and a picture, which is one of our fighters, kept in
// localStorage and shown to everyone in the lobby. Online, you fight as your picture's fighter.

import { CHARACTERS } from '../sim/characters.ts';

export interface Profile {
  name: string;
  /** A fighter id from content/fighters.json. */
  avatar: string;
}

const KEY = 'dod.profile';
export const NAME_MAX = 16;
export const NAME_MIN = 2;

// The show's crowd: "<word> <word> <1-99>", always short enough for the HUD.
const FIRST = ['Loud', 'Neon', 'Static', 'Lucky', 'Rowdy', 'Molten', 'Midnight', 'Wild', 'Live', 'Sudden', 'Golden', 'Rapid', 'Brutal', 'Prime', 'Blazing', 'Fizzy'];
const SECOND = ['Comet', 'Walk-on', 'Rookie', 'Wildcard', 'Encore', 'Spark', 'Rocket', 'Riot', 'Stunt', 'Upset', 'Headline', 'Ember', 'Furnace', 'Ratings', 'Replay', 'Signal'];

export function generatedName(random: () => number = Math.random): string {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length) % list.length];
  for (let i = 0; i < 20; i++) {
    const name = `${pick(FIRST)} ${pick(SECOND)} ${1 + (Math.floor(random() * 99) % 99)}`;
    if (name.length <= NAME_MAX) return name;
  }
  return `Walk-on ${1 + (Math.floor(random() * 99) % 99)}`;
}

/**
 * A name fit to show: letters, digits, spaces and - _ . ' only, no control or invisible characters, spaces
 * collapsed, at most NAME_MAX characters. Returns '' when too little is left (the caller keeps the old name).
 * Used on our own name and on every name another player sends.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} \-_.']/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...name].slice(0, NAME_MAX).join('').trim();
  return [...cut].length >= NAME_MIN ? cut : '';
}

/** A fighter id that exists, else '' (pictures from other players are checked). */
export function cleanAvatar(raw: unknown): string {
  return typeof raw === 'string' && CHARACTERS.some((c) => c.id === raw) ? raw : '';
}

function randomAvatar(): string {
  return CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id;
}

let current: Profile | null = null;
const listeners = new Set<(p: Profile) => void>();

export function profile(): Profile {
  if (current) return current;
  let saved: Partial<Profile> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    // Unreadable storage: a fresh profile.
  }
  current = { name: cleanName(saved.name) || generatedName(), avatar: cleanAvatar(saved.avatar) || randomAvatar() };
  store(current);
  return current;
}

function store(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage can be blocked; the profile then lasts for this visit.
  }
}

/** Saves a change (an unusable name keeps the old one) and tells the lobby. */
export function setProfile(change: Partial<Profile>): Profile {
  const old = profile();
  const next: Profile = {
    name: change.name === undefined ? old.name : cleanName(change.name) || old.name,
    avatar: change.avatar === undefined ? old.avatar : cleanAvatar(change.avatar) || old.avatar,
  };
  current = next;
  store(next);
  for (const fn of listeners) fn(next);
  return next;
}

export function onProfile(fn: (p: Profile) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The fighter index for a profile picture. */
export function avatarChar(avatar: string): number {
  return Math.max(0, CHARACTERS.findIndex((c) => c.id === avatar));
}
