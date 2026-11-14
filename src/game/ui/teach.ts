// On-stage teaching prompts (the pilot fight and How to play): one button glyph at a time near the player's fighter, for
// the device in use (keyboard, gamepad or touch), shown the moment the move is useful and faded once it is used.
// The Teacher only reads the sim (the player's action, the events, the other fighter); it never changes it.

import { PAD_NAMES, inputDevice, padFamily, type InputDevice, type PadFamily } from '../input/devices.ts';
import { touchOverlay } from '../input/touch.ts';
import { FX } from '../sim/fixed.ts';
import { ACT, type Fighter } from '../sim/state.ts';
import { MOVE } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import type { Match } from '../match.ts';
import type { SimEvent } from '../sim/step.ts';

export type TeachStep = 'move' | 'attack' | 'jump' | 'smash' | 'shield' | 'recover' | DefenceStep | RecoveryStep;

/** Lesson 2 (How to play: grabs and dodges), in the order it is taught. */
export type DefenceStep = 'grab' | 'throw' | 'rollL' | 'rollR' | 'dodge';
export const DEFENCE_STEPS: readonly DefenceStep[] = ['grab', 'throw', 'rollL', 'rollR', 'dodge'];

/**
 * Lesson 3 (How to play 3: specials and the way back), in the order it is taught. The last three come after the dummy knocks
 * the player off the edge: double jump, up special, then the ledge (grabbing it is what clears the lesson).
 */
export type RecoveryStep = 'spN' | 'spS' | 'spD' | 'fastfall' | 'dJump' | 'upB' | 'ledge';
export const RECOVERY_STEPS: readonly RecoveryStep[] = ['spN', 'spS', 'spD', 'fastfall', 'dJump', 'upB', 'ledge'];
/** Prompts that only make sense off the stage: they wait for the knock-off. */
const OFFSTAGE_STEPS: ReadonlySet<TeachStep> = new Set<TeachStep>(['dJump', 'upB', 'ledge']);

/** What each prompt says and which glyphs show for each device. A glyph is a keycap, a pad button or a touch button. */
interface PromptDef {
  word: string;
  glyphs: Record<InputDevice, string[]>;
  /** The real touch button(s) (class on `.touch-btn`) to pulse while the prompt is up. */
  touch?: string | string[];
}

/**
 * The pad glyphs of a family for a prompt (Xbox letters, PlayStation symbols, Switch letters). `name` is the logged word
 * (Cross, Circle, Square, Triangle, L1, R1 / A, B, X, Y, L, R / ...); `symbol` is what the glyph shows.
 */
export function padGlyphs(step: TeachStep, f: PadFamily): { symbol: string; name: string }[] {
  const n = PAD_NAMES[f];
  const g = (k: 'attack' | 'special' | 'jump' | 'shield') => ({ symbol: n.symbol[k], name: k === 'jump' ? n.jump.split(' / ')[0] : n[k] });
  const dir = (s: string) => ({ symbol: s, name: s });
  switch (step) {
    case 'move': return [dir('L-stick')];
    case 'attack': return [g('attack')];
    case 'jump': return [g('jump')];
    case 'smash': return [dir('R-stick')];
    case 'shield': return [g('shield')];
    case 'recover': return [dir('↑'), dir('+'), g('special')];
    case 'spN': return [g('special')];
    case 'spS': return [dir('L-stick →'), dir('+'), g('special')];
    case 'spD': return [dir('L-stick ↓'), dir('+'), g('special')];
    case 'fastfall': return [g('jump'), dir('+'), dir('L-stick ↓')];
    case 'dJump': return [g('jump')];
    case 'upB': return [dir('↑'), dir('+'), g('special')];
    case 'ledge': return [dir('L-stick ←')];
    // Lesson 2 prompts have no pad family glyphs of their own: paint() falls back to the prompt's gamepad list.
    default: return [];
  }
}

export const PROMPTS: Record<TeachStep, PromptDef> = {
  move: { word: 'Move', glyphs: { keyboard: ['A', 'D'], gamepad: ['L-stick'], touch: ['stick'] } },
  attack: { word: 'Attack', glyphs: { keyboard: ['J'], gamepad: ['A'], touch: ['Attack'] }, touch: 'attack' },
  jump: { word: 'Jump', glyphs: { keyboard: ['Space'], gamepad: ['X'], touch: ['Jump'] }, touch: 'jump' },
  smash: { word: 'Smash', glyphs: { keyboard: ['I', '+', '← →'], gamepad: ['R-stick'], touch: ['Smash'] }, touch: 'smash' },
  shield: { word: 'Shield', glyphs: { keyboard: ['L'], gamepad: ['LB'], touch: ['Shield'] }, touch: 'shield' },
  recover: { word: 'Up special', glyphs: { keyboard: ['W', '+', 'K'], gamepad: ['↑', '+', 'B'], touch: ['stick ↑', '+', 'Special'] }, touch: 'special' },
  // Lesson 2. Grab = Shield + Attack together; throw = the stick (or Attack) while holding; roll = Shield + stick sideways;
  // spot dodge = Shield + stick down.
  grab: { word: 'Grab', glyphs: { keyboard: ['L', '+', 'J'], gamepad: ['LB', '+', 'A'], touch: ['Shield', '+', 'Attack'] }, touch: ['shield', 'attack'] },
  throw: { word: 'Throw', glyphs: { keyboard: ['A', 'D'], gamepad: ['L-stick'], touch: ['stick'] } },
  rollL: { word: 'Roll left', glyphs: { keyboard: ['L', '+', 'A'], gamepad: ['LB', '+', '← L-stick'], touch: ['Shield', '+', 'stick ←'] }, touch: 'shield' },
  rollR: { word: 'Roll right', glyphs: { keyboard: ['L', '+', 'D'], gamepad: ['LB', '+', 'L-stick →'], touch: ['Shield', '+', 'stick →'] }, touch: 'shield' },
  dodge: { word: 'Spot dodge', glyphs: { keyboard: ['L', '+', 'S'], gamepad: ['LB', '+', 'L-stick ↓'], touch: ['Shield', '+', 'stick ↓'] }, touch: 'shield' },
  // Lesson 3. Special = K / B; with the stick sideways, down or up it is the side, down or up special. Fast fall = stick down
  // while falling. The ledge is on the left of the player once they are knocked off the right edge.
  spN: { word: 'Special', glyphs: { keyboard: ['K'], gamepad: ['B'], touch: ['Special'] }, touch: 'special' },
  spS: { word: 'Side special', glyphs: { keyboard: ['D', '+', 'K'], gamepad: ['L-stick →', '+', 'B'], touch: ['stick →', '+', 'Special'] }, touch: 'special' },
  spD: { word: 'Down special', glyphs: { keyboard: ['S', '+', 'K'], gamepad: ['L-stick ↓', '+', 'B'], touch: ['stick ↓', '+', 'Special'] }, touch: 'special' },
  fastfall: { word: 'Jump, then fall fast', glyphs: { keyboard: ['Space', '+', 'S'], gamepad: ['X', '+', 'L-stick ↓'], touch: ['Jump', '+', 'stick ↓'] }, touch: 'jump' },
  dJump: { word: 'Double jump', glyphs: { keyboard: ['Space'], gamepad: ['X'], touch: ['Jump'] }, touch: 'jump' },
  upB: { word: 'Up special', glyphs: { keyboard: ['W', '+', 'K'], gamepad: ['↑', '+', 'B'], touch: ['stick ↑', '+', 'Special'] }, touch: 'special' },
  ledge: { word: 'Grab the ledge', glyphs: { keyboard: ['A'], gamepad: ['L-stick ←'], touch: ['stick ←'] } },
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
  /** 'defence' is lesson 2: grab, throw, roll left, roll right, spot-dodge, each ticked when the sim sees it. */
  lesson?: 'defence' | 'recovery';
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
    if (this.opts.lesson === 'defence') {
      this.tickDefence(m, me, events);
      return;
    }
    if (this.opts.lesson === 'recovery') {
      this.tickRecovery(m, me, events);
      return;
    }
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

  /** Lesson 2: the first step not yet ticked is the prompt; each step is ticked by the move itself (events and actions the sim reports). */
  private tickDefence(m: Match, me: Fighter, events: SimEvent[]): void {
    this.frames++;
    const mark = (step: DefenceStep) => {
      this.used.add(step);
      this.usedAt[step] = this.frames;
      this.onChange?.(step, 'used');
    };
    const first = () => DEFENCE_STEPS.find((s) => !this.used.has(s)) ?? null;
    const cur = first();
    if (cur) {
      const mine = (e: SimEvent) => 'attacker' in e && e.attacker === m.player;
      if (cur === 'grab' && events.some((e) => e.type === 'grab' && mine(e))) mark('grab');
      else if (cur === 'throw') {
        if (events.some((e) => e.type === 'throw' && mine(e))) mark('throw');
        // The hold ran out before the throw: back to the grab.
        else if (events.some((e) => e.type === 'grab-break' && mine(e))) this.used.delete('grab');
      } else if (cur === 'rollL' && me.action === ACT.ROLL && me.dir < 0) mark('rollL');
      else if (cur === 'rollR' && me.action === ACT.ROLL && me.dir > 0) mark('rollR');
      else if (cur === 'dodge' && me.action === ACT.SPOTDODGE) mark('dodge');
    }
    const next = first();
    if (this.current && !this.fading) {
      if (this.used.has(this.current)) this.fade();
      else if (next && next !== this.current) this.show(next);
    }
    if (!this.current && !this.fading && next && this.frames >= 25) this.show(next);
    if (!next && !this.rewarded) this.reward('Lesson clear!');
    this.sync();
  }

  /** Lesson 3: the player is off the stage after the knock-off (the recovery prompts are for now), from the sim's own reading. */
  private offstage = false;

  /**
   * Lesson 3: specials, fast fall, then the way back. Each step is ticked by the sim seeing it (the special's move, the fall
   * speed flag, the jump event, the up special, the ledge event). The last three wait for the knock-off; doing a later one
   * ticks the ones before it, and landing without the ledge starts the way back again.
   */
  private tickRecovery(m: Match, me: Fighter, events: SimEvent[]): void {
    this.frames++;
    const mark = (step: RecoveryStep) => {
      if (this.used.has(step)) return;
      this.used.add(step);
      this.usedAt[step] = this.frames;
      this.onChange?.(step, 'used');
    };
    const first = () => RECOVERY_STEPS.find((s) => !this.used.has(s)) ?? null;
    const x = me.x / FX;
    const y = me.y / FX;
    const solid = STAGES[m.state.stage].platforms.filter((p) => p.solid);
    const over = solid.some((p) => x >= p.x1 - 10 && x <= p.x2 + 10);
    const low = solid.length > 0 && y < Math.min(...solid.map((p) => p.y)) - 20;
    const away = !me.grounded && (me.action === ACT.AIR || me.action === ACT.HELPLESS || me.action === ACT.HITSTUN || me.action === ACT.AIRDODGE);
    this.offstageFrames = away && (!over || low) ? this.offstageFrames + 1 : 0;
    if (this.offstageFrames >= 8) this.offstage = true;
    else if (this.offstage && (me.grounded > 0 || me.action === ACT.DEAD || me.action === ACT.RESPAWN) && !this.used.has('ledge')) {
      // Back on the ground (or lost the stock) without the ledge: the way back is taught again.
      this.offstage = false;
      this.used.delete('dJump');
      this.used.delete('upB');
    }
    const cur = first();
    if (cur === 'spN' && me.action === ACT.ATTACK && me.move === MOVE.NSPECIAL) mark('spN');
    else if (cur === 'spS' && me.action === ACT.ATTACK && me.move === MOVE.SSPECIAL) mark('spS');
    else if (cur === 'spD' && me.action === ACT.ATTACK && me.move === MOVE.DSPECIAL) mark('spD');
    else if (cur === 'fastfall' && !me.grounded && me.fastFall === 1) mark('fastfall');
    else if (cur && OFFSTAGE_STEPS.has(cur) && this.offstage) {
      if (events.some((e) => e.type === 'ledge' && e.id === me.id)) {
        mark('dJump');
        mark('upB');
        mark('ledge');
      } else if (me.action === ACT.ATTACK && me.move === MOVE.UPB) {
        mark('dJump');
        mark('upB');
      } else if (cur === 'dJump' && events.some((e) => e.type === 'jump' && e.id === me.id)) mark('dJump');
    }
    const next = first();
    const want = next && (!OFFSTAGE_STEPS.has(next) || this.offstage) ? next : null;
    if (this.current && !this.fading) {
      if (this.used.has(this.current)) this.fade();
      else if (want !== this.current) {
        if (want) this.show(want);
        else this.dismiss();
      }
    }
    if (!this.current && !this.fading && want && this.frames >= 25) this.show(want);
    if (!next && !this.rewarded) this.reward('Lesson clear!');
    this.sync();
  }

  private shownAt = 0;
  private rewarded = false;
  private rewardEl: HTMLElement | null = null;

  /** The first hit the player lands pays off on its own, big and centred (the first success a stranger sees; two words). */
  private reward(text = 'First hit!'): void {
    this.rewarded = true;
    const el = document.createElement('div');
    el.id = 'teach-reward';
    el.className = 'teach-reward';
    el.setAttribute('role', 'status');
    el.textContent = text;
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
      default:
        return false;
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
    const fam = padFamily();
    const padList = dev === 'gamepad' ? padGlyphs(step, fam) : [];
    const pad = padList.length ? padList : null;
    const list = pad ? pad.map((p) => p.symbol) : def.glyphs[dev];
    this.el.dataset.family = dev === 'gamepad' ? fam : '';
    for (const [i, g] of list.entries()) {
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
      if (pad && pad[i]!.name !== g) k.setAttribute('aria-label', pad[i]!.name);
      if (g === 'stick') k.setAttribute('aria-label', 'Left stick');
      row.append(k);
    }
    const word = document.createElement('span');
    word.className = 'teach-word';
    word.textContent = def.word;
    this.el.replaceChildren(row, word);
    if (this.opts.lesson) {
      // One pip per step: ticked ones filled, this one lit.
      const pips = document.createElement('span');
      pips.className = 'teach-pips';
      for (const s of this.opts.lesson === 'defence' ? DEFENCE_STEPS : RECOVERY_STEPS) {
        const pip = document.createElement('i');
        pip.className = this.used.has(s) ? 'done' : s === step ? 'now' : '';
        pips.append(pip);
      }
      this.el.append(pips);
    }
    this.el.dataset.glyphs = (pad ? pad.map((p) => p.name) : def.glyphs[dev]).join(' ');
    this.pulse(dev === 'touch' ? [def.touch ?? []].flat() : []);
  }

  private pulse(classes: string[]): void {
    const key = classes.join(' ') || null;
    if (this.flagged === key) return;
    touchOverlay()?.querySelectorAll('.touch-btn.teach-pulse').forEach((b) => b.classList.remove('teach-pulse'));
    for (const cls of classes) touchOverlay()?.querySelector(`.touch-btn.${cls}`)?.classList.add('teach-pulse');
    this.flagged = key;
  }

  private sync(): void {
    if (this.el && this.current && !this.fading && (this.el.dataset.device !== inputDevice() || (this.el.dataset.device === 'gamepad' && this.el.dataset.family !== padFamily()))) this.paint();
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
    this.pulse([]);
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
    this.pulse([]);
  }
}
