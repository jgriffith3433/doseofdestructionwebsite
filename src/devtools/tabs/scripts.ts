// Scripts: one button per project script, with its output in the console.

import { h } from '../../game/ui/dom.ts';
import { onBusy, runTask, store } from '../api.ts';
import { select } from '../ui.ts';
import type { Tab } from '../main.ts';

interface Script {
  task: string;
  title: string;
  what: string;
  command: string;
  needsFighter?: boolean;
}

const SCRIPTS: Script[] = [
  { task: 'test', title: 'Run sim tests', what: 'Checks the sim is deterministic and rollback-safe on every stage, and that bots finish matches with every fighter. Takes about a minute.', command: 'npm test' },
  { task: 'typecheck', title: 'Typecheck', what: 'Type errors across the game and dev tools.', command: 'tsc -p .' },
  { task: 'build', title: 'Production build', what: 'Builds the game into dist/, the same as the GitHub Pages deploy does.', command: 'vite build' },
  { task: 'anims', title: 'Build every animation', what: 'Rebuilds every clip for every fighter from the videos in the art folder. Use the Animations tab to build one clip.', command: 'python _build_anims.py' },
  { task: 'anims', title: 'Build one fighter’s animations', what: 'Rebuilds all of one fighter’s clips.', command: 'python _build_anims.py <fighter>', needsFighter: true },
  { task: 'lineup', title: 'Rebuild home lineup and images', what: 'The 33-fighter image on the home page, plus every thumbnail and large image the game uses. A few minutes.', command: 'python _build_lineup.py' },
  { task: 'fighter-images', title: 'Rebuild one fighter’s images', what: 'Just one fighter’s thumbnail and large image, after changing their cutout.', command: 'python _build_lineup.py --only <fighter>', needsFighter: true },
  { task: 'cutout', title: 'Recut every cutout with AI', what: 'Cuts every fighter out of their source art with a segmentation model (content/art-sources.json picks the image and model). About 45 seconds a fighter on the first run; cached after. Then run Rebuild home lineup and images.', command: '.venv\\Scripts\\python tools/cutout.py' },
  { task: 'anim-folders', title: 'Set up anims folders', what: 'Makes every fighter\u2019s anims folder in the art root with a reference image, a green-screen first frame and a CLIPS.txt checklist. Never touches videos.', command: 'python tools/make_anim_folders.py' },
  { task: 'recut', title: 'Recut dark cutouts (old)', what: 'Your _recut.py: recuts the fighters with dark outfits from their source art.', command: 'python _recut.py' },
];

const last = new Map<string, { code: number; at: Date }>();
let root: HTMLElement;

function render(): void {
  const busy = store.state?.running;
  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h('header', {}, h('h2', {}, 'Scripts'), h('span', { class: 'muted' }, 'Output shows in the console below. One script runs at a time.')),
      h(
        'div',
        { class: 'script-grid' },
        ...SCRIPTS.map((s) => {
          const key = `${s.task}:${s.title}`;
          let fighter = store.selected;
          const result = last.get(key);
          const picker = s.needsFighter ? select(store.fighters.map((f): [string, string] => [f.id, f.name]), fighter, (v) => (fighter = v)) : null;
          return h(
            'div',
            { class: 'script' },
            h('h3', {}, s.title),
            h('p', {}, s.what),
            h('code', {}, s.command),
            picker,
            h(
              'div',
              { class: 'row' },
              h('button', {
                type: 'button',
                class: 'btn primary',
                disabled: !!busy,
                onclick: async () => {
                  const code = await runTask(s.task, s.needsFighter ? { fighter } : {}, s.needsFighter ? `${s.title} (${fighter})` : s.title);
                  last.set(key, { code, at: new Date() });
                  render();
                },
              }, 'Run'),
              result && h('span', { class: `last ${result.code === 0 ? 'ok' : 'bad'}` }, `${result.code === 0 ? 'Passed' : `Failed (exit ${result.code})`} at ${result.at.toLocaleTimeString()}`),
            ),
          );
        }),
      ),
      h(
        'section',
        { class: 'card', style: 'margin-top:16px' },
        h('h3', {}, 'Links'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: '/Game/', target: '_blank' }, 'Game'),
          h('a', { class: 'btn', href: '/', target: '_blank' }, 'Home page'),
          h('a', { class: 'btn', href: '/characters.html', target: '_blank' }, 'Characters page'),
          h('a', { class: 'btn', href: '/docs/animation.md', target: '_blank' }, 'Animation guide')),
        h('p', { class: 'hint' }, 'Art folder: ', h('code', {}, store.state?.artRoot ?? '')),
      ),
    ),
  );
}

export const scriptsTab: Tab = {
  mount(el) {
    root = el;
    el.style.display = 'block';
    onBusy(() => {
      if (!root.hidden) render();
    });
    store.on(() => {
      if (!root.hidden) render();
    });
  },
  show() {
    render();
  },
};
