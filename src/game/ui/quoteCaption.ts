// The winner's quote under the headline on the results screen: typed on as the voice take starts (winQuote.ts).
import type { WinQuote } from '../winQuote.ts';
import { h } from './dom.ts';

/** ms before the first letter (the take starts 900 ms after the screen opens) and per letter. */
const START_MS = 900;
const LETTER_MS = 34;

export function quoteCaption(q: WinQuote): HTMLElement {
  const typed = h('span', { class: 'wq-typed' });
  // The rest of the line is laid out but hidden, so the box never changes size as the letters arrive.
  const rest = h('span', { class: 'wq-rest', 'aria-hidden': 'true' }, `“${q.text}”`);
  const el = h('blockquote', { class: `win-quote ${q.kind}`, 'data-quote': q.id, 'data-kind': q.kind, 'data-state': 'waiting', 'aria-label': q.text }, typed, rest);
  const full = `“${q.text}”`;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let n = 0;
  const done = () => {
    el.dataset.state = 'done';
    typed.textContent = full;
    rest.textContent = '';
    window.dispatchEvent(new CustomEvent('dod:win-quote-typed', { detail: { id: q.id, text: q.text, kind: q.kind } }));
  };
  const step = () => {
    if (!el.isConnected) return;
    n++;
    typed.textContent = full.slice(0, n);
    rest.textContent = full.slice(n);
    el.dataset.state = 'typing';
    if (n >= full.length) done();
    else window.setTimeout(step, LETTER_MS);
  };
  if (reduced) done();
  else window.setTimeout(step, START_MS);
  return el;
}
