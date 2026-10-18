// Online play loads after boot, as its own chunk (net/entry.ts), behind a dynamic import: single player and the
// playtest hook are up before any online code runs, and a failure here (a missing package, no WebRTC, a relay, the
// online menus) is logged and never stops the game. Nothing here imports online code statically.

export type Online = typeof import('./entry.ts');

let online: Online | null = null;
let booted: Promise<Online | null> | null = null;
let settle: (m: Online | null) => void = () => {};
const ready = new Promise<Online | null>((r) => (settle = r));

/** The online module once it has loaded and started, else null (single player only). */
export const onlineApi = (): Online | null => online;

/** Resolves with the online module once it has loaded and started, or null if it failed to load. */
export const onlineReady = (): Promise<Online | null> => ready;

/** Loads online play on the next task and runs `start` with it (main.ts, once the game has booted). Once only. */
export function bootOnline(start: (m: Online) => void): Promise<Online | null> {
  booted ??= new Promise((r) => setTimeout(r, 0))
    .then(() => import('./entry.ts'))
    .then(
      (m) => {
        online = m;
        try {
          start(m);
        } catch (e) {
          console.error('[dod-online] online play failed to start (single player is unaffected):', e);
        }
        return m;
      },
      (e) => {
        console.error('[dod-online] online play failed to load (single player is unaffected):', e);
        return null;
      },
    )
    .then((m) => {
      settle(m);
      return m;
    });
  return booted;
}
