// Small pieces several tabs share.

import { h, listen } from '../game/ui/dom.ts';
import { store, thumb } from './api.ts';

export function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const el = h('div', { class: `toast ${kind}` }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

/** Runs an async action, reporting failure as a toast instead of an unhandled error. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (success) toast(success);
    return out;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

/**
 * The searchable fighter list down the left of a tab. badge() adds a short
 * status on the right of each row.
 */
export function fighterList(badge: (id: string) => HTMLElement | null): { el: HTMLElement; render: () => void } {
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Filter fighters' });
  const list = h('div', { class: 'side-list' });
  const el = h('aside', { class: 'side' }, h('div', { class: 'side-head' }, search), list);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(
      ...store.fighters
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.includes(q) || f.role.toLowerCase().includes(q))
        .map((f) => {
          const st = store.fighterState(f.id);
          return h(
            'button',
            {
              type: 'button',
              class: `fighter-item${f.id === store.selected ? ' active' : ''}`,
              onclick: () => store.select(f.id),
            },
            h('img', { src: thumb(f.id, st?.art.img), alt: '', loading: 'lazy' }),
            h('div', {}, h('strong', {}, f.name), h('span', {}, f.role)),
            badge(f.id) ?? '',
          );
        }),
    );
  };
  search.addEventListener('input', render);
  return { el, render };
}

export function field(label: string, input: HTMLElement, opts: { wide?: boolean; sub?: string } = {}): HTMLElement {
  return h('div', { class: `field${opts.wide ? ' wide' : ''}` }, h('label', {}, label), input, opts.sub ? h('span', { class: 'sub' }, opts.sub) : null);
}

export function numberInput(value: number | null | undefined, onChange: (v: number | null) => void, attrs: Record<string, string | number> = {}): HTMLInputElement {
  const input = h('input', { type: 'number', value: value ?? '', ...attrs });
  listen(input, 'input', (e) => {
    const v = (e.currentTarget as HTMLInputElement).value;
    onChange(v === '' ? null : Number(v));
  });
  return input;
}

export function textInput(value: string, onChange: (v: string) => void, attrs: Record<string, string | number> = {}): HTMLInputElement {
  const input = h('input', { type: 'text', value, ...attrs });
  listen(input, 'input', (e) => onChange((e.currentTarget as HTMLInputElement).value));
  return input;
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = value;
  listen(input, 'change', (e) => onChange((e.currentTarget as HTMLInputElement).checked));
  return h('label', { class: 'check' }, input, label);
}

export function select<T extends string>(options: (T | [T, string])[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', {});
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    el.add(new Option(label, v, v === value, v === value));
  }
  listen(el, 'change', (e) => onChange((e.currentTarget as HTMLSelectElement).value as T));
  return el;
}

/** Plays an audio file once; a second call stops the first. */
let playing: HTMLAudioElement | null = null;
export function preview(url: string | null | undefined, volume = 1): void {
  playing?.pause();
  if (!url) return;
  playing = new Audio(`${url}?v=${Date.now()}`);
  playing.volume = Math.max(0, Math.min(1, volume));
  void playing.play().catch((e) => toast(`Could not play: ${e.message}`, 'error'));
}
