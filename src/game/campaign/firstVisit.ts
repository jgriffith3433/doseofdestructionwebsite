// The first visit (docs/story.md "The pilot"): a player with nothing saved is dropped into Season 1 Episode 1 (open-mic)
// the moment they tap Play, with the title logo over the cold open's first shot, and is taught by prompts on the stage.
// Anyone with a save (dod-campaign, dod-versus or the pilot flag dod-pilot) keeps the title and the main menu.

export const PILOT_KEY = 'dod-pilot';
export const PILOT_CHAPTER = 'open-mic';

/** A playtest scenario other than first-visit sets this so the menus it clicks through still come first. */
let suppressed = false;
export function suppressFirstVisit(on = true): void {
  suppressed = on;
}

/** The URL flags that start something else (a devtools playtest, a chapter, a quick match) and so never the pilot. */
function otherRoute(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.has('chapter') || q.has('play') || q.has('room')) return true;
  const pt = q.get('playtest');
  return pt !== null && pt !== 'first-visit';
}

function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    // Storage blocked: nothing can be saved, so the player gets the usual title and menu, not a pilot on every visit.
    return true;
  }
}

/** True when nothing is saved: Tap to play starts the pilot. */
export function isFirstVisit(): boolean {
  if (suppressed || otherRoute()) return false;
  return !stored('dod-campaign') && !stored('dod-versus') && !stored(PILOT_KEY);
}

/** The pilot has been seen (won, skipped through the Menu link, or left): later visits keep the usual flow. */
export function markPilotSeen(how: 'won' | 'menu' | 'left'): void {
  try {
    localStorage.setItem(PILOT_KEY, how);
  } catch {
    // Storage can be blocked; the pilot then only lasts this visit.
  }
}

export function pilotState(): string | null {
  try {
    return localStorage.getItem(PILOT_KEY);
  } catch {
    return null;
  }
}

/** Kaelen's pilot tuning on the open-mic fight: a gentle bot that starts at 60% (so a first KO is close) and two stocks. */
export const PILOT_KAELEN = { cpu: 2, pilot: true, startPercent: 600 } as const;
