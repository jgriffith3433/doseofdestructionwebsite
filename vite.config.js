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

// Authoring-only fields in content/stages.json (the painter's prompt and note per layer, the stage's source folder and
// design notes): the game never reads them (sim/stage.ts and the renderer use ids, images, geometry), so the build drops
// them. The dev server and devtools still see the full file.
const stripStageAuthoring = () => ({
  name: 'dod-strip-stage-authoring',
  apply: 'build',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0].endsWith('/content/stages.json')) return null;
    const stages = JSON.parse(code);
    for (const st of Array.isArray(stages) ? stages : Object.values(stages)) {
      delete st.source;
      delete st.notes;
      for (const l of st.layers ?? []) {
        delete l.prompt;
        delete l.note;
      }
    }
    return { code: JSON.stringify(stages), map: null };
  },
});

// Print every JS chunk's size at the end of the build, biggest first, so a change that grows one shows in the log.
const chunkReport = () => ({
  name: 'dod-chunk-report',
  apply: 'build',
  generateBundle(_o, bundle) {
    const rows = Object.values(bundle)
      .filter((c) => c.type === 'chunk')
      .map((c) => ({ name: c.fileName, kb: Buffer.byteLength(c.code) / 1024 }))
      .sort((a, b) => b.kb - a.kb);
    const total = rows.reduce((n, r) => n + r.kb, 0);
    console.log('\n[chunks] JS chunks, biggest first (KB, raw):');
    for (const r of rows.slice(0, 12)) console.log(`[chunks] ${r.kb.toFixed(1).padStart(9)}  ${r.name}`);
    console.log(`[chunks] ${total.toFixed(1).padStart(9)}  total of ${rows.length} chunks; largest ${rows[0]?.kb.toFixed(1)} KB`);
  },
});

// Separate chunks: Babylon (cached across deploys), the content JSON the game reads, the game code, and the playtest
// harness, which stays a lazy chunk of its own (main.ts imports it only when a playtest asks).
const manualChunks = (id) => {
  const f = id.split('?')[0].replace(/\\/g, '/');
  if (f.includes('/node_modules/@babylonjs/')) {
    return /\/(materials|loaders|serializers)\//.test(f) ? 'babylon-extras' : f.includes('/core/Shaders') ? 'babylon-shaders' : 'babylon';
  }
  if (f.includes('/node_modules/')) return undefined;
  if (/\/content\/voice\.json$/.test(f)) return 'content-voice';
  if (/\/content\/stages\.json$/.test(f)) return 'content-stages';
  if (/\/content\/campaign\.json$/.test(f)) return 'content-campaign';
  if (f.includes('/src/game/playtest/')) return undefined; // dynamic import only (main.ts): its own lazy chunk
  if (f.includes('/src/game/')) return 'game';
  return undefined;
};

export default defineConfig({
  base: './',
  appType: 'mpa',
  // devtools.html and its API exist only on the dev server. buildStamp: which build this is, for Hawkes Analytics.
  plugins: [devApi({ root, artRoot, mapsRoot }), buildStamp(root), copyGameFx(), stripStageAuthoring(), chunkReport()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Only the game is bundled. The rest of the site is static HTML copied as-is.
    rollupOptions: {
      input: { game: path.resolve(root, 'Game/index.html') },
      output: { manualChunks },
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
