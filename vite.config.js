import path from 'node:path';
import { defineConfig } from 'vite';
import { devApi } from './tools/devApi.mjs';

const root = process.cwd();
// Where each fighter's source art and animation clips live. Override with DOD_ART_ROOT.
const artRoot = process.env.DOD_ART_ROOT || 'C:\\Projects\\AllTheCharacters';
// Stage concepts (a folder per stage with images and reference.txt). Override with DOD_MAPS_ROOT.
const mapsRoot = process.env.DOD_MAPS_ROOT || 'C:\\Projects\\AllTheMaps';

export default defineConfig({
  base: './',
  appType: 'mpa',
  // devtools.html and its API exist only on the dev server.
  plugins: [devApi({ root, artRoot, mapsRoot })],
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
