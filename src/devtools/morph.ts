// Updates a live DOM tree to match a freshly built one, touching only what
// changed. Pages that redraw on every poll (the GPU tab) keep their scroll
// position, open <details>, focus, typed text and playing videos.
//
// Elements built with h() remember their listeners, so a kept element gets
// the new tree's handlers (no stale closures). Give list items a data-key
// (a job id, a server id) so they stay matched when the list reorders.

type Listeners = Record<string, EventListener>;
const on = (el: Element) => (el as unknown as { __on?: Listeners }).__on;

function key(n: Node): string | null {
  return n instanceof Element ? n.getAttribute('data-key') : null;
}

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a instanceof Element && b instanceof Element) return a.tagName === b.tagName && key(a) === key(b);
  return true;
}

/** Makes old look like next. Returns the node now in the tree (old, or next if it had to swap). */
export function morph(old: Node, next: Node): Node {
  if (!same(old, next)) {
    old.parentNode?.replaceChild(next, old);
    return next;
  }
  if (!(old instanceof Element) || !(next instanceof Element)) {
    if (old.textContent !== next.textContent) old.textContent = next.textContent;
    return old;
  }
  // Attributes. A <details> keeps whatever the user opened or closed.
  for (const a of [...old.attributes]) {
    if (!next.hasAttribute(a.name) && !(a.name === 'open' && old.tagName === 'DETAILS')) old.removeAttribute(a.name);
  }
  for (const a of [...next.attributes]) {
    if (a.name === 'open' && old.tagName === 'DETAILS') continue;
    if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  }
  // Form state lives in properties, not attributes; leave alone what is being typed in.
  if (old instanceof HTMLInputElement && next instanceof HTMLInputElement && document.activeElement !== old) {
    if (old.value !== next.value) old.value = next.value;
    if (old.checked !== next.checked) old.checked = next.checked;
    old.disabled = next.disabled;
  } else if (old instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
    morphChildren(old, next);
    if (document.activeElement !== old && old.value !== next.value) old.value = next.value;
    old.disabled = next.disabled;
    swapListeners(old, next);
    return old;
  } else if (old instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement && document.activeElement !== old) {
    if (old.value !== next.value) old.value = next.value;
  } else if (old instanceof HTMLButtonElement && next instanceof HTMLButtonElement) {
    old.disabled = next.disabled;
  }
  swapListeners(old, next);
  morphChildren(old, next);
  return old;
}

function swapListeners(old: Element, next: Element): void {
  const was = on(old) ?? {};
  const now = on(next) ?? {};
  for (const [type, fn] of Object.entries(was)) old.removeEventListener(type, fn);
  for (const [type, fn] of Object.entries(now)) old.addEventListener(type, fn);
  (old as unknown as { __on?: Listeners }).__on = now;
}

function morphChildren(old: Element, next: Element): void {
  const keyed = new Map<string, Node>();
  for (const c of old.childNodes) {
    const k = key(c);
    if (k) keyed.set(k, c);
  }
  const want = [...next.childNodes];
  let at = old.firstChild;
  for (const n of want) {
    const k = key(n);
    let match: Node | null = null;
    if (k) match = keyed.get(k) ?? null;
    else if (at && !key(at) && same(at, n)) match = at;
    if (match) {
      if (match !== at) old.insertBefore(match, at);
      const kept = morph(match, n);
      at = kept.nextSibling;
    } else {
      old.insertBefore(n, at);
    }
  }
  // Whatever is left after the last match is gone from the new tree.
  while (at) {
    const rest = at.nextSibling;
    old.removeChild(at);
    at = rest;
  }
}

/** Replaces root's children with nodes, morphing in place. */
export function morphChildrenTo(root: Element, nodes: Node[]): void {
  const holder = document.createElement(root.tagName);
  holder.append(...nodes);
  morphChildren(root, holder);
}
