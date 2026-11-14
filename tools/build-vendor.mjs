// Pass 1 of `npm run build` (see tools/babylonVendor.mjs): Babylon's used names in one minified ES file.
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild'; // Vite's own dependency
import { build } from 'vite';
import { scanBabylonImports, vendorEntryPlugin, VENDOR_DIR, VENDOR_ENTRY, VENDOR_FILE, VENDOR_META } from './babylonVendor.mjs';

const root = process.cwd();
// A leftover file from an earlier build must never be read by pass 2 if this pass stops early.
fs.rmSync(path.join(root, VENDOR_DIR), { recursive: true, force: true });
const scan = scanBabylonImports(root);
if (!scan) {
  console.log('[vendor] a Babylon import this pass does not handle: pass 2 bundles Babylon itself');
  process.exit(0);
}
await build({
  configFile: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  root,
  logLevel: 'warn',
  plugins: [
    vendorEntryPlugin(scan),
    {
      // Vite leaves a library's ES output unminified, and pass 2 no longer touches this file: minify it here, as Vite does
      // a chunk. (writeBundle: a renderChunk would be pretty-printed again by Vite's own transpile step after it.)
      name: 'dod-vendor-minify',
      async writeBundle(options) {
        const file = path.join(options.dir, 'babylon.js');
        const r = await transform(fs.readFileSync(file, 'utf8'), { minify: true, format: 'esm', loader: 'js', legalComments: 'none' });
        fs.writeFileSync(file, r.code);
      },
    },
  ],
  build: {
    outDir: VENDOR_DIR,
    emptyOutDir: true,
    reportCompressedSize: false,
    sourcemap: false,
    minify: false,
    modulePreload: false,
    lib: { entry: VENDOR_ENTRY, formats: ['es'], fileName: () => 'babylon.js' },
    rollupOptions: { maxParallelFileOps: 1, output: { inlineDynamicImports: true } },
  },
});
fs.writeFileSync(path.join(root, VENDOR_META), JSON.stringify(scan));
console.log(`[vendor] ${Object.keys(scan).length} Babylon specifiers -> ${VENDOR_FILE} (${(fs.statSync(path.join(root, VENDOR_FILE)).size / 1024).toFixed(0)} KB)`);
