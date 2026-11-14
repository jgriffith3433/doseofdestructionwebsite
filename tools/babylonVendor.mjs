/**
 * Babylon as its own build pass (npm run build -> tools/build.mjs).
 *
 * Studio's build cell is small, and one Vite pass holds every module's syntax tree at once: Babylon's 495 modules (4.7 MB of
 * source) plus the game's 169 peaked at ~600 MB. So pass 1 (tools/build-vendor.mjs) bundles just the Babylon names the game
 * imports into one file and ends; pass 2 (vite.config.js) reads that one file in place of the Babylon graph.
 *
 *   scanBabylonImports(root)  every `@babylonjs/...` import in src/ and Game/, by specifier: { names: [...], effect: bool }
 *                             (null when an import has a form this does not handle: the build then bundles Babylon in one pass)
 *   vendorEntryPlugin(scan)   pass 1's virtual entry: `export { A as m3$A } from 'spec'` per name
 *   vendorUsePlugin(root)     pass 2: each Babylon specifier resolves to a virtual module re-exporting from the vendor file
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VENDOR_DIR = 'node_modules/.dod-vendor';
export const VENDOR_FILE = `${VENDOR_DIR}/babylon.js`;
export const VENDOR_META = `${VENDOR_DIR}/babylon.json`;
// Vite resolves a lib entry against the root, so the virtual entry is a file name that does not exist.
export const VENDOR_ENTRY = 'dod-vendor-entry.js';
const isEntry = (s) => path.basename(s.split('?')[0]) === VENDOR_ENTRY;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|js|mjs)$/.test(e.name)) yield p;
  }
}

export function scanBabylonImports(root) {
  const specs = {};
  const entry = (s) => (specs[s] ??= { names: new Set(), effect: false });
  const files = [];
  for (const d of ['src/game', 'Game']) if (fs.existsSync(path.join(root, d))) files.push(...walk(path.join(root, d)));
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('@babylonjs/')) continue;
    // Every mention of a Babylon specifier must be one of the two handled forms, else give up (null).
    const mentions = (src.match(/['"]@babylonjs\/[^'"]+['"]/g) ?? []).length;
    let handled = 0;
    for (const m of src.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](@babylonjs\/[^'"]+)['"];?/gm)) {
      handled++;
      if (m[1]) continue; // import type: erased
      for (const part of m[2].split(',')) {
        const t = part.trim();
        if (!t || /^type\s/.test(t)) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
        entry(m[3]).names.add(name);
      }
    }
    for (const m of src.matchAll(/^import\s+['"](@babylonjs\/[^'"]+)['"];?/gm)) {
      handled++;
      entry(m[1]).effect = true;
    }
    if (handled !== mentions) return null;
  }
  const out = {};
  for (const s of Object.keys(specs).sort()) out[s] = { names: [...specs[s].names].sort(), effect: specs[s].effect };
  return out;
}

const alias = (i, name) => `m${i}$${name}`;

export function vendorEntryPlugin(scan) {
  return {
    name: 'dod-vendor-entry',
    resolveId: (s) => (isEntry(s) ? `\0${VENDOR_ENTRY}` : null),
    load(s) {
      if (s !== `\0${VENDOR_ENTRY}`) return null;
      const lines = [];
      Object.entries(scan).forEach(([spec, { names, effect }], i) => {
        if (names.length) lines.push(`export { ${names.map((n) => `${n} as ${alias(i, n)}`).join(', ')} } from '${spec}';`);
        if (effect) lines.push(`import '${spec}';`);
      });
      return lines.join('\n');
    },
  };
}

/** Pass 2. Returns null when there is no matching vendor file from pass 1 (a plain `vite build` bundles Babylon itself). */
export function vendorUsePlugin(root) {
  const metaPath = path.join(root, VENDOR_META);
  const file = path.join(root, VENDOR_FILE).replace(/\\/g, '/');
  if (!fs.existsSync(metaPath) || !fs.existsSync(file)) return null;
  const scan = scanBabylonImports(root);
  if (!scan || JSON.stringify(scan) !== fs.readFileSync(metaPath, 'utf8')) return null; // stale: imports changed since pass 1
  const index = Object.keys(scan);
  const prefix = '\0dod-babylon:';
  // Pass 1's file is already bundled and minified: Rollup does not parse it again (that alone cost ~200 MB). It is
  // copied to dist/assets as it is, and the game chunks import it from there.
  const source = fs.readFileSync(file);
  const name = `babylon-${createHash('sha256').update(source).digest('base64url').slice(0, 8)}.js`;
  return {
    name: 'dod-vendor-use',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      this.emitFile({ type: 'asset', fileName: `assets/${name}`, source });
    },
    resolveId(spec) {
      if (spec === file) return { id: `./${name}`, external: true };
      return scan[spec] ? prefix + spec : null;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const spec = id.slice(prefix.length);
      const names = scan[spec].names;
      const i = index.indexOf(spec);
      const f = JSON.stringify(file);
      return names.length ? `export { ${names.map((n) => `${alias(i, n)} as ${n}`).join(', ')} } from ${f};` : `import ${f};`;
    },
    // The same hint Vite writes for a chunk it bundled itself: start the download with the page.
    transformIndexHtml: () => [{ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `../assets/${name}` }, injectTo: 'head' }],
  };
}
