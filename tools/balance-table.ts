// Writes docs/balance.md: the committed win-rate table later changes compare against.
// Run: node tools/balance-table.ts
import { writeFileSync } from 'node:fs';
import { BALANCE_BAND, BALANCE_LEVEL, BALANCE_SECONDS, BALANCE_SEEDS, BALANCE_STAGE, BALANCE_STOCKS, roundRobin, tableText } from '../src/game/balance.ts';

const rows = roundRobin();
const md = `# Balance table

Every fighter against every fighter (${rows.length} fighters, both sides, ${BALANCE_SEEDS.length} seeds each: ${rows[0].games} games per fighter),
level-${BALANCE_LEVEL} bots on ${BALANCE_STAGE}, ${BALANCE_STOCKS} stocks, ${BALANCE_SECONDS} s limit. Deterministic: the same build prints the same table.
Code: \`src/game/balance.ts\`; gate: \`src/game/test/balance.test.ts\` (in \`npm test\`) fails when a fighter's win rate leaves
${BALANCE_BAND.min * 100}-${BALANCE_BAND.max * 100}% (wide while the table is new; tighten it as kits are tuned). Regenerate with \`node tools/balance-table.ts\`.

${tableText(rows)}
`;
writeFileSync(new URL('../docs/balance.md', import.meta.url), md);
console.log(md);
