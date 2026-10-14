// Dev tools: a workbench for authoring Dose of Destruction. Each tab edits one
// kind of content and runs the project scripts that build it. Only works on
// the dev server, which provides /api/dev (tools/devApi.mjs).

import { $, h } from '../game/ui/dom.ts';
import { log, mountConsole, onBusy, store } from './api.ts';
import { fightersTab } from './tabs/fighters.ts';
import { animationsTab } from './tabs/animations.ts';
import { clipsTab } from './tabs/clips.ts';
import { mapsTab } from './tabs/maps.ts';
import { soundsTab } from './tabs/sounds.ts';
import { voiceTab } from './tabs/voice.ts';
import { scriptsTab } from './tabs/scripts.ts';
import { gpuTab } from './tabs/gpu.ts';
import { aiTab } from './tabs/ai.ts';

export interface Tab {
  mount(el: HTMLElement): void;
  /** Called each time the tab is shown. */
  show?(): void;
}

const TABS: Record<string, Tab> = {
  fighters: fightersTab,
  animations: animationsTab,
  clips: clipsTab,
  maps: mapsTab,
  sounds: soundsTab,
  voice: voiceTab,
  gpu: gpuTab,
  ai: aiTab,
  scripts: scriptsTab,
};
const mounted = new Set<string>();

function showTab(name: string): void {
  if (!TABS[name]) name = 'fighters';
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const id of Object.keys(TABS)) $(`tab-${id}`).hidden = id !== name;
  const el = $(`tab-${name}`);
  if (!mounted.has(name)) {
    mounted.add(name);
    TABS[name].mount(el);
  }
  TABS[name].show?.();
  history.replaceState(null, '', `#${name}`);
  try {
    localStorage.setItem('dod-devtools-tab', name);
  } catch {
    // Not important.
  }
}

function renderStatus(): void {
  const s = store.state;
  if (!s) return;
  const clips = s.fighters.reduce((n, f) => n + Object.keys(f.manifest?.clips ?? {}).length, 0);
  const animated = s.fighters.filter((f) => f.manifest).length;
  $('status').replaceChildren(
    h('span', { class: `pill ${s.artRootExists ? 'ok' : 'bad'}`, title: s.artRoot }, s.artRootExists ? `Art: ${s.artRoot}` : `Art folder missing: ${s.artRoot}`),
    h('span', { class: 'pill' }, `${animated}/${s.fighters.length} fighters animated · ${clips} clips`),
    h(
      'span',
      { class: `pill ${s.elevenLabs ? 'ok' : 'warn'}`, title: s.elevenLabs ? 'Sound and voice generation is available.' : 'Add ELEVENLABS_API_KEY=... to .env and restart npm run dev to generate audio.' },
      s.elevenLabs ? 'ElevenLabs ready' : 'No ElevenLabs key',
    ),
  );
}

function wireConsole(): void {
  const out = $('console-out');
  mountConsole(out, $('busy'));
  $('console-clear').addEventListener('click', () => out.replaceChildren());
  const consoleEl = $('console');
  const toggle = $('console-toggle');
  toggle.addEventListener('click', () => {
    consoleEl.classList.toggle('collapsed');
    toggle.textContent = consoleEl.classList.contains('collapsed') ? 'Show' : 'Hide';
  });
  onBusy((task) => {
    if (task && consoleEl.classList.contains('collapsed')) toggle.click();
    // A finished script may have changed art, clips or content.
    if (!task) void store.refresh().catch(() => undefined);
  });
}

async function boot(): Promise<void> {
  wireConsole();
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
  store.on(renderStatus);
  try {
    await store.refresh();
  } catch (e) {
    $('offline').hidden = false;
    log(`Could not reach the dev tools API: ${(e as Error).message}`, 'error');
    return;
  }
  log('Dev tools ready.', 'ok');
  let first = location.hash.slice(1);
  if (!first) {
    try {
      first = localStorage.getItem('dod-devtools-tab') ?? 'fighters';
    } catch {
      first = 'fighters';
    }
  }
  showTab(first);
}

void boot();
