/**
 * The boot line (Game/index.html's inline script owns `window.__dodBoot`, so it works before this module loads).
 * main.ts reports real load steps through here; the page shows them under Press start. A press before the engine is ready
 * is answered on the spot by the inline script (sound, pressed look, "Starting…") and carried out by `bootReady`.
 */

export interface BootState {
  step(name: string, label?: string): void;
  fail(message: string): void;
  ready(start: () => void): void;
  software: boolean;
  /** True once a Press start press has been taken (and when): main's own handler skips that press's click. */
  handledAt: number;
}

const boot = (): BootState | undefined => (window as unknown as { __dodBoot?: BootState }).__dodBoot;

export const bootStep = (name: string, label?: string): void => boot()?.step(name, label);
export const bootFail = (message: string): void => boot()?.fail(message);
export const bootReady = (start: () => void): void => (boot() ? boot()!.ready(start) : undefined);
/** A software WebGL renderer (SwiftShader, llvmpipe): no GPU, so the game starts on Low with Glow off. */
export const softwareRenderer = (): boolean => !!boot()?.software;
/** A press that the inline script already carried out within the last 1.5 s (its click must not start twice). */
export const pressHandled = (): boolean => {
  const b = boot();
  return !!b && b.handledAt > 0 && performance.now() - b.handledAt < 1500;
};
