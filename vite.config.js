import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { devApi } from './tools/devApi.mjs';
import { buildStamp } from './tools/buildStamp.mjs';
import { sharedRoot } from './tools/roots.mjs';

const root = process.cwd();
// Where each fighter's source art and animation clips live. Override with DOD_ART_ROOT (else tools/roots.mjs: a
// sibling folder, /srv/hawkes/AllTheCharacters on the server, or C:\Projects\AllTheCharacters).
const artRoot = sharedRoot('AllTheCharacters', 'DOD_ART_ROOT', root);
// Stage concepts (a folder per stage with images and reference.txt). Override with DOD_MAPS_ROOT.
const mapsRoot = sharedRoot('AllTheMaps', 'DOD_MAPS_ROOT', root);

// Game/fx holds art the game fetches by path (the flipbook sheets, content/flipbooks.json), never imports: Vite only
// bundles what Game/index.html imports, so copy the folder into dist/Game/fx or those requests 404 in the build.
const copyGameFx = () => ({
  name: 'dod-copy-game-fx',
  apply: 'build',
  closeBundle() {
    const from = path.resolve(root, 'Game/fx');
    if (fs.existsSync(from)) fs.cpSync(from, path.resolve(root, 'dist/Game/fx'), { recursive: true });
  },
});

export default defineConfig({
  base: './',
  appType: 'mpa',
  // devtools.html and its API exist only on the dev server. buildStamp: which build this is, for Hawkes Analytics.
  plugins: [devApi({ root, artRoot, mapsRoot }), buildStamp(root), copyGameFx()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Only the game is bundled. The rest of the site is static HTML copied as-is.
    rollupOptions: {
      input: { game: path.resolve(root, 'Game/index.html') },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8089,
    strictPort: true,
    watch: {
      // Generated art and audio change often and are fetched, not imported.
      // content/ is watched by the devtools plugin instead, so saving from
      // devtools reloads game tabs without reloading devtools itself.
      ignored: ['**/content/**', '**/audio/**', '**/characters/**', '**/stages/**', '**/_anim_preview/**', '**/_backup/**', '**/dist/**'],
    },
  },
});
