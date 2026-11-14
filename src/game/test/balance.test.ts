// Balance gate (npm test): the round robin in balance.ts prints a win-rate table for every fighter and fails when
// one falls outside the band. docs/balance.md keeps the committed table to compare later changes against.

import { BALANCE_BAND, roundRobin, tableText } from '../balance.ts';
import { CHARACTERS } from '../sim/characters.ts';

declare const process: { exit(code: number): never };

const t0 = Date.now();
const rows = roundRobin();
console.log(tableText(rows));
console.log(`balance: ${rows.length} fighters, ${rows[0].games} games each, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

check('the table has every fighter', rows.length === CHARACTERS.length && rows.length === 33, `${rows.length}`);
for (const r of rows) {
  check(`${r.id} win rate inside ${BALANCE_BAND.min * 100}-${BALANCE_BAND.max * 100}%`, r.rate >= BALANCE_BAND.min && r.rate <= BALANCE_BAND.max, `${(r.rate * 100).toFixed(1)}%`);
}
if (failed) process.exit(1);
