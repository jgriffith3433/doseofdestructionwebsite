// Colour looks on screen: the chip on the VS card and results, and the swatch row on character select.

import { CHARACTERS } from '../sim/characters.ts';
import { h } from './dom.ts';
import { lookCount, lookOf, lookOpen, recolorUrl, swatchColor, winsToUnlock, winsWith } from '../looks.ts';

/** "● Neon": the colour a fighter plays in (data-look is the look index, for the playtest). */
export function lookChip(char: number, look: number): HTMLElement {
  return h(
    'small',
    { class: 'look-chip', 'data-look': String(look), 'data-look-name': lookOf(char, look).name },
    h('i', { style: `background:${swatchColor(char, look)}` }),
    lookOf(char, look).name,
  );
}

/** Paints an <img> or sprite element's picture through a look (the original URL until the recolour is ready). */
export function paintImage(img: HTMLImageElement, url: string, char: number, look: number): void {
  img.src = url;
  const l = lookOf(char, look);
  if (l.from === undefined) return;
  void recolorUrl(url, l).then((u) => {
    if (img.isConnected || img.src !== u) img.src = u;
  }).catch(() => undefined);
}

export interface SwatchOptions {
  char: number;
  /** The look in use. */
  picked: number;
  /** Which slot a swatch belongs to (the playtest reads it). */
  slot: number;
  /** A tap or arrow on an open swatch. */
  pick(look: number): void;
  /** Colours a CPU slot may use are all open (unlocks are the player's own). */
  allOpen?: boolean;
}

/** One row of colour swatches for a fighter: open ones pick on a tap, locked ones read "N wins to unlock". */
export function swatchRow(o: SwatchOptions): HTMLElement {
  const id = CHARACTERS[o.char].id;
  const wins = winsWith(id);
  return h(
    'div',
    { class: 'swatches', role: 'radiogroup', 'aria-label': `${CHARACTERS[o.char].name} colours`, 'data-slot': String(o.slot) },
    ...Array.from({ length: lookCount(o.char) }, (_, i) => {
      const look = lookOf(o.char, i);
      const open = o.allOpen || lookOpen(o.char, i);
      const on = i === o.picked;
      return h(
        'button',
        {
          type: 'button',
          class: `swatch${on ? ' on' : ''}${open ? '' : ' locked'}`,
          role: 'radio',
          'aria-checked': String(on),
          'aria-disabled': open ? undefined : 'true',
          'aria-label': open ? look.name : `${look.name}, ${winsToUnlock(look)}`,
          'data-look': String(i),
          'data-slot': String(o.slot),
          title: open ? look.name : `${winsToUnlock(look)} (${wins} so far)`,
          onclick: () => {
            if (open) o.pick(i);
          },
          // Left and right step through the colours and pick as they go (the row is a radio group); the menu's own arrows stay out.
          onkeydown: (ev: Event) => {
            const e = ev as KeyboardEvent;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            e.stopPropagation();
            const n = lookCount(o.char);
            const d = e.key === 'ArrowLeft' ? -1 : 1;
            for (let k = 1; k <= n; k++) {
              const j = (i + d * k + n * k) % n;
              if (o.allOpen || lookOpen(o.char, j)) {
                o.pick(j);
                return;
              }
            }
          },
        },
        h('i', { class: 'dot', style: `background:${swatchColor(o.char, i)}` }),
        h('span', { class: 'name' }, open ? look.name : winsToUnlock(look)),
      );
    }),
  );
}
