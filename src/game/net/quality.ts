// Input delay from the measured ping, and the connection bars (docs/online.md, "Delay and the bars"). Pure.

/** One sim frame in ms. */
export const FRAME_MS = 1000 / 60;
export const MIN_DELAY = 1;
export const MAX_DELAY = 4;

/**
 * The input delay in frames for a round trip: about ping / 2 (the one-way trip) in frames, clamped 1 to 4. A round
 * trip that was never measured (< 0) gets the old fixed 2.
 */
export function delayForRtt(rttMs: number): number {
  if (!(rttMs >= 0)) return 2;
  return Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(rttMs / 2 / FRAME_MS)));
}

/** What both players run with: the host measured its ping, the guest sent theirs; the worse one decides. */
export function agreedDelay(hostRtt: number, guestRtt: number): number {
  const known = [hostRtt, guestRtt].filter((r) => r >= 0);
  return known.length ? delayForRtt(Math.max(...known)) : 2;
}

/** 1 to 4 bars for a round trip in ms (4 = under 50 ms); 0 while there is no reading yet. A stall in the last seconds costs a bar. */
export function barsFor(rttMs: number, stalling = false): number {
  if (!(rttMs >= 0)) return 0;
  const n = rttMs < 50 ? 4 : rttMs < 100 ? 3 : rttMs < 170 ? 2 : 1;
  return stalling ? Math.max(1, n - 1) : n;
}
