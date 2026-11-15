// The menu-walk scenario (dod.ts `menuWalk` calls this): every menu screen reachable from Tap to play, walked with the
// keyboard, then an emulated gamepad (input/devices.ts emulatePad, read by ui/screens.ts pollMenuPad), then touch.
//
// Per button: time from the press to the pressed state (game.css `[data-pressed]`, set by ui/dom.ts in the press's own
// task) and to the ui sound (`dod:sound-take`); per screen change: time from the activating press to the stinger's end
// (ui/stinger.ts, one 210 ms transition) and every painted frame in between checked for a blank or unstyled screen;
// per screen: whether the selected item has a visible focus ring, and whether Escape / pad B / the Back button returns.
// Taps are pointer events at the control's centre (hit-tested), keys are real keydown events on the window, pad presses
// are held buttons on the emulated pad: no clicks from script, no teleporting. Named setup: forceTouchUi (touch mode).

import { emulatePad } from '../input/devices.ts';
import { forceTouchUi } from '../touchSettings.ts';
import { currentScreen, switching, type ScreenId } from '../ui/screens.ts';
import type { Tracker } from './hawkes-playtest.js';

export type Mode = 'keyboard' | 'gamepad' | 'touch';

/** What the scenario needs from dod.ts's Run (its menu drivers are private there). */
export interface WalkHooks {
  /** Taps Tap to play if it is up and ends on the main menu. */
  toMainMenu(): Promise<void>;
  /** Main menu → Versus → a 1v1 with one stock → stage → the match is live (Run.startVersus). */
  startVersus(stocks: number): Promise<void>;
  /** Every Run menu click is a pointer tap (hit-tested) while on. */
  setTap(on: boolean): void;
  /** Sim speed for the fight to the results. */
  setSpeed(speed: number): void;
  /** Lets the bot fight until the match is over or the results show. */
  fightToEnd(timeoutMs: number): Promise<void>;
  phase(): string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));

const PRESS_MAX_MS = 50;
const SOUND_MAX_MS = 50;
const TRANSITION_MAX_MS = 300;
const MIN_PX = 44;
const BUTTONS = 'button, a[href], [role="button"]';

const visible = (el: HTMLElement): boolean => {
  if (!el.getClientRects().length) return false;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('[hidden]');
};

const label = (el: HTMLElement): string => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28) || el.getAttribute('aria-label') || el.id || String(el.className) || el.tagName.toLowerCase();

interface Stats {
  buttons: number;
  pressMax: number;
  soundMax: number;
  transitions: number;
  transitionMax: number;
  blank: number;
  ringMissing: number;
  backChecked: number;
  backMissing: number;
  smallest: number;
  screens: number;
}
const newStats = (): Stats => ({ buttons: 0, pressMax: 0, soundMax: 0, transitions: 0, transitionMax: 0, blank: 0, ringMissing: 0, backChecked: 0, backMissing: 0, smallest: 999, screens: 0 });

type Ctx = { mode: Mode; s: Stats };
type Dir = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'start';

export async function walkMenus(t: Tracker, hooks: WalkHooks, modes: Mode[], phone: boolean): Promise<void> {
  const all = newStats();

  // Sounds and stingers of the whole run.
  const sounds: { id: string; t: number }[] = [];
  const onSound = (e: Event) => {
    const d = (e as CustomEvent<{ id: string; t: number }>).detail;
    if (d.id.startsWith('ui-')) sounds.push({ id: d.id, t: d.t });
  };
  const stingers: { to: string; ms: number; loadMs: number; at: number }[] = [];
  const onStinger = (e: Event) => {
    const d = (e as CustomEvent<{ to: string; ms: number; loadMs: number }>).detail;
    stingers.push({ to: d.to, ms: d.ms, loadMs: d.loadMs, at: performance.now() });
  };
  window.addEventListener('dod:sound-take', onSound);
  window.addEventListener('dod:stinger', onStinger);
  const pad = { buttons: [] as boolean[], axes: [0, 0] as [number, number] };
  /** One frame's length here: a pad press is read once per frame, so its budget is 50 ms plus a frame. */
  let frameMs = 17;

  try {
    hooks.setTap(modes.length === 1 && modes[0] === 'touch');
    await hooks.toMainMenu();
    const f0 = await frame();
    let f = f0;
    for (let i = 0; i < 6; i++) f = await frame();
    frameMs = Math.max(17, Math.min(200, (f - f0) / 6));
    t.event('menu-frame', `${Math.round(frameMs)} ms per frame while walking`);
    for (const [mi, mode] of modes.entries()) {
      t.scene(`menu walk: ${mode}`);
      t.progress(0.05 + (0.9 * mi) / modes.length);
      forceTouchUi(mode === 'touch');
      hooks.setTap(mode === 'touch');
      const s = newStats();
      await walkMode({ mode, s });
      for (const k of Object.keys(all) as (keyof Stats)[]) {
        if (k === 'smallest') all[k] = Math.min(all[k], s[k]);
        else if (k === 'pressMax' || k === 'soundMax' || k === 'transitionMax') all[k] = Math.max(all[k], s[k]);
        else all[k] += s[k];
      }
      t.event('menu-mode', `${mode}: ${s.screens} screens, ${s.buttons} buttons pressed (slowest pressed state ${s.pressMax} ms, slowest sound ${s.soundMax} ms), ${s.transitions} screen changes (slowest ${s.transitionMax} ms, ${s.blank} blank frames), ${s.ringMissing} without a focus ring, ${s.backMissing} of ${s.backChecked} Back checks failed${s.smallest < 999 ? `, smallest button ${s.smallest} px tall` : ''}`);
    }
  } finally {
    window.removeEventListener('dod:sound-take', onSound);
    window.removeEventListener('dod:stinger', onStinger);
    emulatePad(null);
    forceTouchUi(false);
    hooks.setTap(false);
    hooks.setSpeed(1);
  }
  t.metric('menuScreens', all.screens);
  t.metric('menuButtonsPressed', all.buttons);
  t.metric('menuPressedMaxMs', all.pressMax);
  t.metric('menuSoundMaxMs', all.soundMax);
  t.metric('menuTransitions', all.transitions);
  t.metric('menuTransitionMaxMs', all.transitionMax);
  t.metric('menuBlankFrames', all.blank);
  t.metric('menuFocusMissing', all.ringMissing);
  t.metric('menuBackFailures', all.backMissing);
  if (all.smallest < 999) t.metric('menuSmallestButtonPx', all.smallest);
  if (!all.screens) t.problem('bug', 'the menu walk reached no screen');

  // ---------------------------------------------------------------- per mode

  async function walkMode(ctx: Ctx): Promise<void> {
    const { mode } = ctx;
    await expectScreen('main');
    await visit(ctx, 'main', '#main', null);

    // Versus → character select → stage pick
    await guard(ctx, 'versus select and stage pick', async () => {
      await go(ctx, '#main [data-go="versus"]', 'select');
      await visit(ctx, 'select', '#select', 'main');
      const tiles = () => [...document.querySelectorAll<HTMLElement>('#select-grid .tile:not(.locked):not(.random)')];
      await act(ctx, () => document.querySelector<HTMLElement>('#select-slots .slot-pick'), 'your slot');
      await act(ctx, () => tiles()[0], 'a fighter');
      await act(ctx, () => tiles()[1], 'a CPU fighter');
      await go(ctx, '#select-slots .fight', 'stages');
      await visit(ctx, 'stages', '#stages', 'select');
      await backTo(ctx, 'select');
      await backTo(ctx, 'main');
    });

    // Settings (sound, music, effects; the touch sliders on touch): a panel over the main menu
    await guard(ctx, 'settings', () => panel(ctx, '#main [data-go="settings"]', '#settings', '#settings-done', 'Settings'));

    // Controls, campaign map, tour list, extras, leaderboard
    for (const [sel, id] of [['controls', 'howto'], ['campaign', 'campaign'], ['tour', 'tour'], ['extras', 'extras'], ['leaderboard', 'leaderboard']] as const) {
      await guard(ctx, id, async () => {
        await go(ctx, `#main [data-go="${sel}"]`, id);
        await visit(ctx, id, `#${id}`, 'main');
        await backTo(ctx, 'main');
      });
    }

    // Pause (and its Settings), then the results of a fight played to its end
    await hooks.startVersus(1);
    await sleep(600);
    await openPause(ctx);
    await visit(ctx, 'Pause', '#pause', null);
    await panel(ctx, '#btn-pause-settings', '#settings', '#settings-done', 'Settings (Pause)');
    await until(() => !document.querySelector<HTMLElement>('#pause')!.hidden, 4000, 'the pause menu to come back');
    await resumeFrom(ctx);
    hooks.setSpeed(4);
    await hooks.fightToEnd(6 * 60 * 1000);
    await until(() => currentScreen() === 'results' && !switching(), 120000, 'the results');
    hooks.setSpeed(1);
    await sleep(1500);
    await visit(ctx, 'Results', '#results', 'main');
    await backTo(ctx, 'main');

    // Back out of the main menu to the title and Start again (touch has no Back on the main menu: it is the root of the thumb's walk)
    if (mode !== 'touch') {
      await backTo(ctx, 'title');
      await visit(ctx, 'Title', '#title', null);
      await act(ctx, () => document.querySelector<HTMLElement>('#btn-start'), 'Press start');
      await expectScreen('main');
    }
  }

  // ------------------------------------------------------------ steps

  async function expectScreen(id: ScreenId, ms = 20000): Promise<void> {
    await until(() => currentScreen() === id && !switching(), ms, `the ${id} screen`);
  }

  function until(test: () => unknown, ms: number, what: string): Promise<void> {
    return t.until(test, ms, what);
  }

  /** A stop that fails (a screen did not open, Back did not return) is a problem; the walk goes back to the main menu and on. */
  async function guard(ctx: Ctx, what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      t.problem(what === 'leaderboard' ? 'warning' : 'bug', `${ctx.mode}: ${what}: ${(e as Error).message}`);
      for (let i = 0; i < 4 && currentScreen() !== 'main'; i++) {
        if (switching()) await sleep(300);
        const el = document.querySelector<HTMLElement>(`.screen:not([hidden]) [data-back]`);
        if (el) el.click();
        else window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
        await sleep(600);
      }
    }
  }

  /** A key or pad press, the way the menus read it. Keys are real keydown events on the window; the pad is held on the emulated pad. */
  async function press(mode: Mode, what: Dir): Promise<number> {
    const at = performance.now();
    if (mode === 'keyboard') {
      const code = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', confirm: 'KeyJ', back: 'Escape', start: 'Enter' }[what];
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true }));
      await sleep(Math.max(130, frameMs * 1.5));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
      await sleep(80);
    } else {
      const btn = { up: 12, down: 13, left: 14, right: 15, confirm: 0, back: 1, start: 9 }[what];
      pad.buttons = [];
      pad.buttons[btn] = true;
      emulatePad(pad);
      await sleep(Math.max(240, frameMs * 2.5));
      pad.buttons = [];
      emulatePad(pad);
      await sleep(Math.max(140, frameMs));
    }
    return at;
  }

  /** The focused control moves to `el` the way the mode does it (arrows or D-pad; a focus() finishes a long grid). */
  async function reach(ctx: Ctx, el: HTMLElement): Promise<void> {
    if (ctx.mode === 'touch') {
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    for (let i = 0; i < 12 && document.activeElement !== el; i++) {
      const cur = document.activeElement as HTMLElement | null;
      if (!cur || cur === document.body) break;
      const a = cur.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
      const vertical = Math.abs(dy) >= Math.abs(dx) * 0.6;
      await press(ctx.mode, vertical ? (dy > 0 ? 'down' : 'up') : dx > 0 ? 'right' : 'left');
    }
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Presses a control and measures it: the press → the pressed state (game.css `[data-pressed]`, read in the same task) → the
   * ui sound. `activate` false (touch only) lifts the finger off it (pointercancel) so nothing fires: every button on a screen
   * can be pressed without leaving it. Returns when the activating event was sent.
   */
  async function pressControl(ctx: Ctx, el: HTMLElement, activate: boolean, what: string): Promise<number> {
    const { mode, s } = ctx;
    const name = label(el);
    const before = getComputedStyle(el).scale;
    let pressedAt = -1;
    let looks = false;
    const mo = new MutationObserver(() => {
      if (pressedAt < 0 && el.hasAttribute('data-pressed')) {
        pressedAt = performance.now();
        const cs = getComputedStyle(el);
        looks = cs.scale !== before || (cs.filter !== 'none' && cs.filter !== '');
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-pressed'] });
    const soundsBefore = sounds.length;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const t0 = performance.now();
    let activatedAt = t0;
    if (mode === 'touch') {
      const target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? el;
      if (!el.contains(target) && !target.contains(el)) t.problem('bug', `${what}: "${name}" is covered: a touch on it lands on ${target.id ? `#${target.id}` : target.tagName.toLowerCase()}`);
      const init = { pointerType: 'touch', pointerId: 77, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      await sleep(70);
      if (activate) {
        activatedAt = performance.now();
        target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 }));
      } else {
        target.dispatchEvent(new PointerEvent('pointercancel', { ...init, buttons: 0 }));
      }
    } else {
      await press(mode, 'confirm');
    }
    await sleep(60);
    mo.disconnect();
    s.buttons++;
    // A pad press is read once per frame, so a frame is added to its budget.
    const slack = mode === 'gamepad' ? frameMs : 0;
    const pressMs = pressedAt < 0 ? -1 : Math.max(0, Math.round(pressedAt - t0));
    const snd = sounds.slice(soundsBefore).find((x) => x.id === 'ui-select' && x.t >= t0 - 1);
    const soundMs = snd ? Math.max(0, Math.round(snd.t - t0)) : -1;
    if (pressMs < 0) t.problem('bug', `${mode} ${what}: "${name}" shows no pressed state when pressed`);
    else if (pressMs > PRESS_MAX_MS + slack) t.problem('bug', `${mode} ${what}: "${name}" took ${pressMs} ms to show its pressed state (want ${PRESS_MAX_MS})`);
    else if (!looks) t.problem('bug', `${mode} ${what}: "${name}" is marked pressed but looks the same (scale and filter unchanged)`);
    if (soundMs < 0) t.problem('bug', `${mode} ${what}: "${name}" played no ui sound`);
    else if (soundMs > SOUND_MAX_MS + slack) t.problem('bug', `${mode} ${what}: "${name}" played its ui sound ${soundMs} ms after the press (want ${SOUND_MAX_MS})`);
    s.pressMax = Math.max(s.pressMax, pressMs);
    s.soundMax = Math.max(s.soundMax, soundMs);
    await frame();
    return activatedAt;
  }

  /** Presses a control to go on (keys and pad move to it first). */
  async function act(ctx: Ctx, find: () => HTMLElement | null | undefined, what: string): Promise<void> {
    let el: HTMLElement | null | undefined = null;
    await until(() => {
      el = find();
      return !!el && visible(el) && !(el as HTMLButtonElement).disabled && !switching();
    }, 15000, what);
    await reach(ctx, el!);
    await pressControl(ctx, el!, true, what);
    await sleep(120);
  }

  /** Presses a control that changes screen and times the change from the activating event to the stinger's end; a blank frame in between is a bug. */
  async function go(ctx: Ctx, selector: string, to: ScreenId, timeoutMs = 20000): Promise<void> {
    await until(() => {
      const e = document.querySelector<HTMLElement>(selector);
      return !!e && visible(e) && !(e as HTMLButtonElement).disabled && !switching();
    }, timeoutMs, selector);
    const el = document.querySelector<HTMLElement>(selector)!;
    await reach(ctx, el);
    const from = currentScreen();
    await changeScreen(ctx, `${from} → ${to}`, to, () => pressControl(ctx, el, true, `${from} → ${to}`), timeoutMs);
  }

  async function changeScreen(ctx: Ctx, what: string, to: ScreenId, press_: () => Promise<number>, timeoutMs: number): Promise<void> {
    const stingersBefore = stingers.length;
    let blank = 0;
    let stop = false;
    let firstPaintAt = -1;
    const sampler = (async () => {
      while (!stop) {
        await frame();
        const shown = [...document.querySelectorAll<HTMLElement>('.screen:not([hidden])')];
        const screen = shown[0];
        if (!screen || shown.length > 1 || (screen.id !== 'match' && getComputedStyle(screen).backgroundImage === 'none')) blank++;
        if (firstPaintAt < 0 && currentScreen() === to) firstPaintAt = performance.now();
      }
    })();
    const activatedAt = await press_();
    try {
      await until(() => currentScreen() === to && !switching() && stingers.length > stingersBefore, timeoutMs, `the ${to} screen`);
    } finally {
      stop = true;
      await sampler;
    }
    const st = stingers[stingers.length - 1];
    const loading = st.loadMs > 150;
    // From the activating press to the end of the stinger's own event: not the polling that noticed it.
    const ms = Math.max(0, Math.round(st.at - activatedAt));
    ctx.s.transitions++;
    if (!loading) ctx.s.transitionMax = Math.max(ctx.s.transitionMax, ms);
    ctx.s.blank += blank;
    t.event('menu-transition', `${ctx.mode}: ${what}: ${ms} ms from the press to the end of the change (stinger ${st.ms} ms${loading ? `, loading held ${st.loadMs} ms` : ''}), first frame of ${to} ${firstPaintAt < 0 ? 'n/a' : `${Math.round(firstPaintAt - activatedAt)} ms`} after the press, ${blank} blank frames`);
    if (!loading && ms > TRANSITION_MAX_MS) t.problem('bug', `${ctx.mode}: ${what} took ${ms} ms from the press (want under ${TRANSITION_MAX_MS})`);
    if (blank) t.problem('bug', `${ctx.mode}: ${what} showed ${blank} blank or unstyled frame(s)`);
  }

  /** A panel over a screen (Settings): open it, check it, close it with the mode's Back and check what is under it is back. */
  async function panel(ctx: Ctx, open: string, root: string, doneSel: string, name: string): Promise<void> {
    await act(ctx, () => document.querySelector<HTMLElement>(open), name);
    await until(() => !!document.querySelector<HTMLElement>(root) && !document.querySelector<HTMLElement>(root)!.hidden, 5000, `${name} to open`);
    await sleep(250);
    await visit(ctx, name, root, null);
    ctx.s.backChecked++;
    const how = ctx.mode === 'keyboard' ? 'Escape' : ctx.mode === 'gamepad' ? 'B' : 'Done';
    if (ctx.mode === 'touch') await pressControl(ctx, document.querySelector<HTMLElement>(doneSel)!, true, `${name} Done`);
    else await press(ctx.mode, 'back');
    await sleep(300);
    if (!document.querySelector<HTMLElement>(root)!.hidden) {
      ctx.s.backMissing++;
      t.problem('bug', `${ctx.mode}: ${how} does not close ${name}`);
      (document.querySelector<HTMLElement>(doneSel))?.click();
    } else t.event('menu-back', `${ctx.mode}: ${name} closed by ${how}`);
  }

  /** Back from a screen by the mode (Escape, pad B, the Back button) and check where it lands. */
  async function backTo(ctx: Ctx, to: ScreenId): Promise<void> {
    const from = currentScreen();
    ctx.s.backChecked++;
    const how = ctx.mode === 'keyboard' ? 'Escape' : ctx.mode === 'gamepad' ? 'pad B' : 'the Back button';
    try {
      await changeScreen(ctx, `${from} → ${to} by ${how}`, to, async () => {
        if (ctx.mode !== 'touch') return press(ctx.mode, 'back');
        // On touch the Back button; the results have none: their last action (Main menu, Campaign map) is the way out.
        const btn = [...document.querySelectorAll<HTMLElement>(`#${from} [data-back], #${from} .back-btn`)].find(visible)
          ?? [...document.querySelectorAll<HTMLElement>('#results-actions button')].filter(visible).pop();
        if (!btn) throw new Error(`${from} has no Back button to touch`);
        return pressControl(ctx, btn, true, `${from} Back`);
      }, 8000);
    } catch (e) {
      ctx.s.backMissing++;
      throw new Error(`Back from ${from} (${how}) did not return to ${to}: ${(e as Error).message}`);
    }
  }

  async function openPause(ctx: Ctx): Promise<void> {
    if (ctx.mode === 'touch') {
      const btn = document.querySelector<HTMLElement>('.touch-pause');
      if (btn && visible(btn)) {
        const r = btn.getBoundingClientRect();
        const init = { pointerType: 'touch', pointerId: 78, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        btn.dispatchEvent(new PointerEvent('pointerdown', init));
        await sleep(80);
        btn.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }));
      }
    } else {
      await press(ctx.mode, ctx.mode === 'keyboard' ? 'back' : 'start');
    }
    if (hooks.phase() !== 'pause') {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
      await sleep(250);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
    }
    await until(() => hooks.phase() === 'pause', 5000, 'Pause to open');
    await sleep(250);
  }

  async function resumeFrom(ctx: Ctx): Promise<void> {
    ctx.s.backChecked++;
    if (ctx.mode === 'touch') await pressControl(ctx, document.querySelector<HTMLElement>('#btn-resume')!, true, 'Resume');
    else await press(ctx.mode, 'back');
    const ok = await until(() => hooks.phase() === 'play', 5000, 'Back to resume').then(() => true, () => false);
    if (!ok) {
      ctx.s.backMissing++;
      t.problem('bug', `${ctx.mode}: Back from Pause (${ctx.mode === 'keyboard' ? 'Escape' : ctx.mode === 'gamepad' ? 'pad B' : 'Resume'}) did not resume the match`);
      document.querySelector<HTMLElement>('#btn-resume')?.click();
      await until(() => hooks.phase() === 'play', 4000, 'Resume').catch(() => undefined);
    } else t.event('menu-back', `${ctx.mode}: Pause closed by ${ctx.mode === 'keyboard' ? 'Escape' : ctx.mode === 'gamepad' ? 'B' : 'Resume'}`);
  }

  /**
   * Checks one screen: every visible button for size (phone), a visible focus ring (keys and pad), a pressed state and sound
   * (touch: a finger that lifts off so nothing fires; keys and pad press the control they navigate with, in `go`/`act`), and
   * that the screen has a Back, reachable with one thumb on touch.
   */
  async function visit(ctx: Ctx, title: string, rootSel: string, backTarget: ScreenId | null): Promise<void> {
    const root = document.querySelector<HTMLElement>(rootSel);
    if (!root) {
      t.problem('bug', `${ctx.mode}: no ${rootSel} to check`);
      return;
    }
    ctx.s.screens++;
    await sleep(150);
    const controls = [...root.querySelectorAll<HTMLElement>(BUTTONS)].filter(visible);
    if (ctx.mode !== 'touch') {
      await press(ctx.mode, 'right'); // the first key or pad press marks "keys are driving", which is when the ring shows
      for (const el of controls) {
        el.focus({ preventScroll: true });
        const cs = getComputedStyle(el);
        if (document.activeElement === el && !(cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2)) {
          ctx.s.ringMissing++;
          t.problem('bug', `${ctx.mode}: "${label(el)}" on ${title} has no visible focus ring when selected`);
        }
      }
      controls[0]?.focus({ preventScroll: true });
    }
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (ctx.mode === 'touch' || phone) {
        ctx.s.smallest = Math.min(ctx.s.smallest, Math.round(r.height));
        if (r.height < MIN_PX - 0.5) t.problem('bug', `${ctx.mode}: "${label(el)}" on ${title} is ${Math.round(r.height)} px tall (want ${MIN_PX})`);
        if (r.left < -0.5 || r.right > innerWidth + 0.5) t.problem('bug', `${ctx.mode}: "${label(el)}" on ${title} runs off the screen sideways`);
      }
    }
    if (ctx.mode === 'touch') {
      for (const el of controls) {
        el.scrollIntoView({ block: 'nearest' });
        await pressControl(ctx, el, false, title);
      }
    }
    if (backTarget) {
      const btn = controls.find((el) => el.matches('.back-btn, [data-back]'));
      if (!btn && title !== 'Results') {
        ctx.s.backMissing++;
        t.problem('bug', `${ctx.mode}: ${title} has no Back button`);
      } else if (btn && ctx.mode === 'touch') {
        const r = btn.getBoundingClientRect();
        const corner = r.left < innerWidth * 0.5 || r.right > innerWidth * 0.5;
        if (!corner || r.height < MIN_PX - 0.5 || r.width < MIN_PX - 0.5) t.problem('bug', `touch: the Back button on ${title} is ${Math.round(r.width)}x${Math.round(r.height)} px (want ${MIN_PX}x${MIN_PX})`);
        else t.event('menu-back-reach', `${title}: Back ${Math.round(r.width)}x${Math.round(r.height)} px at ${Math.round(r.left)},${Math.round(r.top)} of ${innerWidth}x${innerHeight}`);
      }
    }
    t.event('menu-screen', `${ctx.mode} ${title}: ${controls.length} buttons ${ctx.mode === 'touch' ? 'pressed' : 'focused'}`);
  }
}
