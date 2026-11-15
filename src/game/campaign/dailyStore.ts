// Tonight's Episode on this device: the best score per day and the day streak (localStorage `dod.daily`).
import { EMPTY_DAILY, dateKey, isDateKey, type DailyState } from './daily.ts';
import { IS_LIVE } from '../net/hawkes.ts';

export const DAILY_KEY = 'dod.daily';
const KEY = DAILY_KEY;

/** The episode's date: today in UTC; off the live site `?daily=YYYY-MM-DD` names another (so two playtest tabs agree). */
export function dailyDate(): string {
  const asked = new URLSearchParams(location.search).get('daily');
  return !IS_LIVE && isDateKey(asked) ? asked : dateKey(Date.now());
}

export function loadDaily(): DailyState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DailyState>;
    const best: Record<string, number> = {};
    for (const [d, s] of Object.entries(raw.best ?? {})) if (isDateKey(d) && Number.isFinite(s)) best[d] = Math.max(0, Math.round(s));
    const num = (n: unknown) => (Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0);
    return { best, streak: num(raw.streak), longest: num(raw.longest), last: isDateKey(raw.last) ? raw.last : '' };
  } catch {
    return { ...EMPTY_DAILY, best: {} };
  }
}

export function saveDaily(state: DailyState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked; the streak then lasts only for this visit.
  }
}
