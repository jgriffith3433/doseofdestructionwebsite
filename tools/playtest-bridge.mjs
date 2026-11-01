// Copies the playtest scenario list (src/game/playtest/scenarios.ts) into site/playtest-bridge.js, the landing
// page's side of the Hawkes playtest contract. Run it after changing the scenarios or the campaign's chapters:
//   node tools/playtest-bridge.mjs          (write)
//   node tools/playtest-bridge.mjs --check  (exit 1 if the copy is stale; npm test runs it via the test)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE = path.join(root, 'site', 'playtest-bridge.js');
const BEGIN = '  // BEGIN SCENARIOS';
const END = '  // END SCENARIOS';

export async function rendered() {
  const { SCENARIOS } = await import(path.join(root, 'src/game/playtest/scenarios.ts'));
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error('site/playtest-bridge.js: the SCENARIOS markers are missing');
  const head = src.slice(0, src.indexOf('\n', a) + 1);
  return { src, out: head + `  var SCENARIOS = ${JSON.stringify(SCENARIOS, null, 2).replace(/\n/g, '\n  ')};\n` + src.slice(b) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { src, out } = await rendered();
  if (process.argv.includes('--check')) {
    if (src !== out) { console.error('site/playtest-bridge.js is stale: run node tools/playtest-bridge.mjs'); process.exit(1); }
    console.log('site/playtest-bridge.js is current');
  } else {
    fs.writeFileSync(BRIDGE, out);
    console.log(src === out ? 'site/playtest-bridge.js already current' : 'site/playtest-bridge.js updated');
  }
}
