// On-stage teaching prompts (the pilot fight and How to play): one button glyph at a time near the player's fighter, for
// the device in use (keyboard, gamepad or touch), shown the moment the move is useful and faded once it is used.
// The Teacher only reads the sim (the player's action, the events, the other fighter); it never changes it.

import { inputDevice, type InputDevice } from '../input/devices.ts';
import { touchOverlay } from '../input/touch.ts';
import { FX } from '../sim/fixed.ts';
import { ACT, type Fighter } from '../sim/state.ts';
import { MOVE } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import type { Match } from '../match.ts';
import type { SimEvent } from '../sim/step.ts';

export type TeachStep = 'move' | 'attack' | 'jump' | 'smash' | 'shield' | 'recover';

/** What each prompt says and which glyphs show for each device. A glyph is a keycap, a pad button or a touch button. */
interface PromptDef {
  word: string;
  glyphs: Record<InputDevice, string[]>;
  /** The real touch button (class on `.touch-btn`) to pulse while the prompt is up. */
  touch?: string;
}

export const PROMPTS: Record<TeachStep, PromptDef> = {
  move: { word: 'Move', glyphs: { keyboard: ['A', 'D'], gamepad: ['L-stick'], touch: ['stick'] } },
  attack: { word: 'Attack', glyphs: { keyboard: ['J'], gamepad: ['A'], touch: ['Attack'] }, touch: 'attack' },
  jump: { word: 'Jump', glyphs: { keyboard: ['Space'], gamepad: ['X'], touch: ['Jump'] }, touch: 'jump' },
  smash: { word: 'Smash', glyphs: { keyboard: ['I', '+', '← →'], gamepad: ['R-stick'], touch: ['Smash'] }, touch: 'smash' },
  shield: { word: 'Shield', glyphs: { keyboard: ['L'], gamepad: ['LB'], touch: ['Shield'] }, touch: 'shield' },
  recover: { word: 'Up special', glyphs: { keyboard: ['W', '+', 'K'], gamepad: ['↑', '+', 'B'], touch: ['stick ↑', '+', 'Special'] }, touch: 'special' },
};

/**
 * Control words for hint text (campaign hints, select-screen rules, menu blurbs). Write `{smash}` in the text, never a
 * key letter; it reads as the control of the device in hand. `null` means the control has no equivalent there, and the
 * sentence that holds it is dropped.
 */
export const HINT_TOKENS: Record<string, Record<InputDevice, string | null>> = {
  smash: { keyboard: 'I + a direction', gamepad: 'the right stick', touch: 'the Smash button' },
  hitbox: { keyboard: 'H', gamepad: null, touch: null },
};

/** Fills a hint's `{token}`s for a device and drops any sentence whose token has no control there. */
export function hintText(text: string, dev: InputDevice = inputDevice()): string {
  if (!text.includes('{')) return text;
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  return parts
    .map((s) => {
      let gone = false;
      const out = s.replace(/\{(\w+)\}/g, (all, k: string) => {
        const v = HINT_TOKENS[k]?.[dev];
        if (v === undefined) return all;
        if (v === null) gone = true;
        return v ?? '';
      });
      return gone ? '' : out;
    })
    .join('')
    .trim();
}

const ORDER: TeachStep[] = ['recover', 'shield', 'jump', 'smash', 'attack', 'move'];
/** Reactive prompts take over a proactive one: they are only useful for a moment. */
const REACTIVE: ReadonlySet<TeachStep> = new Set(['shield', 'recover']);
const SMASHES: ReadonlySet<number> = new Set([MOVE.FSMASH, MOVE.USMASH, MOVE.DSMASH]);
const FADE_MS = 420;

export interface TeachOptions {
  /** How to play: the opponent is a dummy that never attacks, so Shield (and Jump) come on a timer instead of on a cue. */
  scripted: boolean;
}

export class Teacher {
  private readonly used = new Set<TeachStep>();
  private current: TeachStep | null = null;
  private el: HTMLElement | null = null;
  private fading = false;
  private usedAt: Partial<Record<TeachStep, number>> = {};
  private frames = 0;
  private offstageFrames = 0;
  private hits = 0;
  private flagged: string | null = null;
  /** Events a playtest can watch: a prompt shown, a prompt used. */
  onChange: ((step: TeachStep, state: 'shown' | 'used' | 'gone') => void) | null = null;

  private readonly opts: TeachOptions;

  constructor(opts: TeachOptions) {
    this.opts = opts;
  }

  /** The steps the player has done so far. */
  done(): TeachStep[] {
    return [...this.used];
  }

  /** The prompt on screen now (one at most), or null. */
  showing(): TeachStep | null {
    return this.current;
  }

  /** Per sim tick during play. */
  tick(m: Match, events: SimEvent[]): void {
    const me = m.state.fighters[m.player];
    if (!me || m.state.over) return;
    this.frames++;
    for (const e of events) if (e.type === 'hit' && e.attacker === m.player && !e.shield) this.hits++;
    if (this.hits > 0 && !this.rewarded) this.reward();
    this.markUsed(m, me, events);
    // Off the edge or below the stage for a moment (not a hop over the middle).
    const away = !me.grounded && (me.action === ACT.AIR || me.action === ACT.HELPLESS || me.action === ACT.HITSTUN);
    const x = me.x / FX;
    const y = me.y / FX;
    const solid = STAGES[m.state.stage].platforms.filter((p) => p.solid);
    const over = solid.some((p) => x >= p.x1 - 10 && x <= p.x2 + 10);
    const low = solid.length > 0 && y < Math.min(...solid.map((p) => p.y)) - 20;
    this.offstageFrames = away && (!over || low) ? this.offstageFrames + 1 : 0;
    const foe = m.state.fighters.find((f) => f.id !== me.id && f.stocks > 0 && f.action !== ACT.DEAD) ?? null;
    if (this.current && !this.fading) {
      if (this.used.has(this.current)) this.fade();
      else if (REACTIVE.has(this.current) && !this.cue(this.current, m, me, foe)) this.dismiss();
      else if (this.current === 'jump' && !this.cue('jump', m, me, foe) && this.frames - this.shownAt > 60) this.dismiss();
      else if (!REACTIVE.has(this.current)) {
        const urgent = ORDER.find((s) => REACTIVE.has(s) && !this.used.has(s) && this.cue(s, m, me, foe));
        if (urgent) this.show(urgent);
      }
    }
    if (!this.current && !this.fading) {
      const next = ORDER.find((s) => !this.used.has(s) && this.cue(s, m, me, foe));
      if (next) this.show(next);
    }
    this.sync();
  }

  private shownAt = 0;
  private rewarded = false;
  private rewardEl: HTMLElement | null = null;

  /** The first hit the player lands pays off on its own, big and centred (the first success a stranger sees; two words). */
  private reward(): void {
    this.rewarded = true;
    const el = document.createElement('div');
    el.id = 'teach-reward';
    el.className = 'teach-reward';
    el.setAttribute('role', 'status');
    el.textContent = 'First hit!';
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 1400);
    this.rewardEl = el;
  }

  /** Whether the moment for this prompt is now. */
  private cue(step: TeachStep, m: Match, me: Fighter, foe: Fighter | null): boolean {
    const s = m.state;
    const since = (st: TeachStep) => (this.usedAt[st] === undefined ? Infinity : this.frames - (this.usedAt[st] as number));
    switch (step) {
      case 'move':
        return this.frames >= 20;
      case 'attack':
        return this.used.has('move') ? since('move') >= 10 : this.frames >= 360;
      case 'jump': {
        if (!this.used.has('attack') && this.frames < 480) return false;
        if (this.opts.scripted) return since('attack') >= 150;
        if (!foe) return false;
        const p = foe.platform >= 0 ? STAGES[s.stage].platforms[foe.platform] : null;
        const up = p ? !p.solid || p.y > 100 : false;
        return up || (foe.y - me.y) / FX > 90;
      }
      case 'smash':
        return this.hits >= 3 && me.grounded > 0 && this.used.has('attack');
      case 'shield': {
        if (!me.grounded) return false;
        if (this.opts.scripted) return this.used.has('smash') && since('smash') >= 180;
        if (!foe || foe.action !== ACT.ATTACK || !SMASHES.has(foe.move)) return false;
        return Math.abs(foe.x - me.x) / FX < 360 && Math.abs(foe.y - me.y) / FX < 140 && foe.frame < 40;
      }
      case 'recover':
        return this.offstageFrames >= 12 && me.action !== ACT.DEAD;
    }
  }

  private markUsed(m: Match, me: Fighter, events: SimEvent[]): void {
    const mark = (step: TeachStep) => {
      if (this.used.has(step)) return;
      this.used.add(step);
      this.usedAt[step] = this.frames;
      this.onChange?.(step, 'used');
    };
    const jumped = events.some((e) => e.type === 'jump' && e.id === me.id);
    if (me.action === ACT.WALK) mark('move');
    if (me.action === ACT.ATTACK) {
      if (SMASHES.has(me.move)) mark('smash');
      else if (me.move === MOVE.UPB) mark('recover');
      else if (me.move <= MOVE.DTILT) mark('attack');
    }
    if (jumped) {
      if (this.current === 'recover') mark('recover');
      else mark('jump');
    }
    if (me.action === ACT.SHIELD) mark('shield');
    if (this.current === 'recover' && (me.action === ACT.LEDGE || me.action === ACT.HELPLESS)) mark('recover');
    void m;
  }

  private show(step: TeachStep): void {
    if (this.el) this.el.remove();
    this.current = step;
    this.shownAt = this.frames;
    this.fading = false;
    this.flagged = null;
    const el = document.createElement('div');
    el.id = 'teach-prompt';
    el.className = 'teach-prompt';
    el.dataset.step = step;
    el.setAttribute('role', 'status');
    this.el = el;
    this.paint();
    document.body.appendChild(el);
    this.onChange?.(step, 'shown');
  }

  /** Builds the glyphs for the device in use (it can change mid-fight: a pad picked up, a key pressed). */
  private paint(): void {
    const step = this.current;
    if (!step || !this.el) return;
    const dev = inputDevice();
    const def = PROMPTS[step];
    this.el.dataset.device = dev;
    const row = document.createElement('div');
    row.className = 'teach-glyphs';
    for (const g of def.glyphs[dev]) {
      if (g === '+') {
        const plus = document.createElement('b');
        plus.className = 'teach-plus';
        plus.textContent = '+';
        row.append(plus);
        continue;
      }
      const k = document.createElement('kbd');
      k.className = `teach-glyph ${dev}${g === 'stick' || g.startsWith('stick') ? ' stick' : ''}`;
      k.textContent = g === 'stick' ? '' : g;
      if (g === 'stick') k.setAttribute('aria-label', 'Left stick');
      row.append(k);
    }
    const word = document.createElement('span');
    word.className = 'teach-word';
    word.textContent = def.word;
    this.el.replaceChildren(row, word);
    this.el.dataset.glyphs = def.glyphs[dev].join(' ');
    this.pulse(dev === 'touch' ? def.touch ?? null : null);
  }

  private pulse(cls: string | null): void {
    if (this.flagged === cls) return;
    touchOverlay()?.querySelectorAll('.touch-btn.teach-pulse').forEach((b) => b.classList.remove('teach-pulse'));
    if (cls) touchOverlay()?.querySelector(`.touch-btn.${cls}`)?.classList.add('teach-pulse');
    this.flagged = cls;
  }

  private sync(): void {
    if (this.el && this.current && !this.fading && this.el.dataset.device !== inputDevice()) this.paint();
  }

  /** The prompt's context passed without the move: it goes, and can come back at the next chance. */
  private dismiss(): void {
    const step = this.current;
    this.fade(false);
    if (step) this.onChange?.(step, 'gone');
  }

  private fade(usedIt = true): void {
    if (!this.el) return;
    this.fading = true;
    const el = this.el;
    el.classList.add(usedIt ? 'used' : 'gone');
    this.pulse(null);
    window.setTimeout(() => {
      el.remove();
      if (this.el === el) {
        this.el = null;
        this.current = null;
        this.fading = false;
      }
    }, FADE_MS);
  }

  /** Puts the prompt near the player's head (CSS px from the renderer), kept on screen. */
  place(at: { x: number; y: number; scale: number } | null): void {
    const el = this.el;
    if (!el) return;
    if (!at) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = 'visible';
    const w = el.offsetWidth || 120;
    const h = el.offsetHeight || 60;
    const x = Math.max(8 + w / 2, Math.min(innerWidth - 8 - w / 2, at.x));
    const y = Math.max(8 + h, Math.min(innerHeight - 8, at.y - 14));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  /** The match is over or left: the prompt goes at once. */
  end(): void {
    this.rewardEl?.remove();
    this.rewardEl = null;
    this.el?.remove();
    this.el = null;
    this.current = null;
    this.fading = false;
    this.pulse(null);
  }
}
