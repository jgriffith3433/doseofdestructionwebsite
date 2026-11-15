// vendor/babylon (the checked-in Babylon bundle, tools/babylonVendor.mjs) must match the game's Babylon imports and the
// installed Babylon version. Stale? Run `npm run vendor` and commit vendor/.
import { vendorFresh, VENDOR_FILE } from './babylonVendor.mjs';
import fs from 'node:fs';

const root = process.cwd();
if (!vendorFresh(root)) {
  console.error(`vendor test: ${VENDOR_FILE} is missing or stale (a Babylon import or the Babylon version changed): run "npm run vendor" and commit vendor/`);
  process.exit(1);
}
const kb = fs.statSync(`${root}/${VENDOR_FILE}`).size / 1024;
if (kb < 200) { console.error(`vendor test: ${VENDOR_FILE} is only ${kb.toFixed(0)} KB`); process.exit(1); }
console.log(`vendor test ok: ${VENDOR_FILE} ${kb.toFixed(0)} KB matches the imports`);
