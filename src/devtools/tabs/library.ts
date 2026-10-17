// Library: every fighter in Hawkes Gen's library (hawkesgen/docs/library.md), shared with Studio, the other products'
// tools and Claude. Each slot (concept, reference, side, pose/air, clip/jab) keeps every version: pick one, discard,
// give feedback and revise, or make more takes with the fighter recipes in hawkesgen/presets/doseofdestruction.json.
//
// The fighter folders (AllTheCharacters) stay what the game and the other tabs read: Import brings them into the
// library (hawkes.library.json says which file is which slot), and a pick is written back to the folder (Write back).
// The components are Hawkes Gen's web components (src/devtools/hawkesgen/, a copy of hawkesgen/clients/js); they call
// Gen through this dev server (/api/dev/gen), which adds the key.

import { h } from '../../game/ui/dom.ts';
import { api } from '../api.ts';
import { toast } from '../ui.ts';
import type { Tab } from '../main.ts';

const PREF = 'dod-library-writeback';

async function loadKit(): Promise<void> {
  // A plain path so TypeScript leaves the module alone; Vite serves it as is.
  const kit = '/src/devtools/hawkesgen/hawkesgen-ui.mjs';
  const ui = await import(/* @vite-ignore */ kit);
  ui.configure({ url: `${location.origin}/api/dev/gen`, key: '', project: 'doseofdestruction' });
}

export const libraryTab: Tab = {
  mount(el) {
    let writeBack = true;
    try { writeBack = localStorage.getItem(PREF) !== 'off'; } catch { /* default */ }
    const status = h('span', { class: 'muted' });
    const run = async (what: 'import' | 'export', body: Record<string, unknown>) => {
      status.textContent = `${what === 'import' ? 'Importing' : 'Writing back'}…`;
      try {
        const r = await api.post<{ counts: Record<string, number> }>(`/library/${what}`, body);
        status.textContent = Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do';
        return r.counts;
      } catch (e: any) {
        status.textContent = '';
        toast(e.message, 'error');
        return null;
      }
    };
    const importBtn = h('button', { type: 'button', title: 'Bring AllTheCharacters into the library: new fighters, takes, old versions (files already there are skipped)' }, 'Import from AllTheCharacters');
    importBtn.onclick = async () => {
      const dry = await run('import', { dry: true });
      if (!dry) return;
      const n = (dry['would-add'] ?? 0) + (dry['would-create'] ?? 0) + (dry['would-pick'] ?? 0);
      if (!n) return toast('The library already has everything in AllTheCharacters');
      if (confirm(`Import ${dry['would-create'] ?? 0} new fighters and ${dry['would-add'] ?? 0} files into Hawkes Gen's library?`)) await run('import', {});
    };
    const exportBtn = h('button', { type: 'button', title: "Write every fighter's current versions into AllTheCharacters (only files that changed)" }, 'Write back');
    exportBtn.onclick = async () => {
      const dry = await run('export', { dry: true });
      if (!dry) return;
      if (!dry['would-write']) return toast('AllTheCharacters already matches the library');
      if (confirm(`Write ${dry['would-write']} files into AllTheCharacters?`)) await run('export', {});
    };
    const auto = h('input', { type: 'checkbox' });
    auto.checked = writeBack;
    auto.onchange = () => {
      writeBack = auto.checked;
      try { localStorage.setItem(PREF, writeBack ? 'on' : 'off'); } catch { /* fine */ }
    };
    const lib = document.createElement('hg-library');
    lib.setAttribute('project', 'doseofdestruction');
    lib.setAttribute('kind', 'fighter');
    lib.setAttribute('thumb', 'side,concept,reference');
    lib.setAttribute('open-inline', '');
    // A pick changes what the game uses: write that fighter's files back.
    lib.addEventListener('hg-pick', async (ev: Event) => {
      if (!writeBack) return;
      const id = String((ev as CustomEvent).detail.entity).split('/')[1];
      const counts = await run('export', { only: id });
      if (counts?.written) toast(`Wrote ${counts.written} file${counts.written > 1 ? 's' : ''} into AllTheCharacters`);
    });
    el.append(
      h('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
        importBtn, exportBtn,
        h('label', { title: 'When you pick a version, write it into the fighter folder so the game and the other tabs use it' }, auto, ' Write picks back'),
        status),
    );
    // The library goes in once the kit knows where Gen is.
    loadKit().then(() => el.append(lib)).catch((e) => {
      el.append(h('p', { class: 'error' }, `Couldn't load the library: ${e.message}`));
    });
  },
};
