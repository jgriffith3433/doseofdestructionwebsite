// The landing page's counts match content/*.json and no page carries a hand-typed count or a stale claim.
// Run with `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFacts, numberWord, siteCounts, writeSiteFacts } from './site-facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

check(numberWord(33) === 'thirty-three' && numberWord(9) === 'nine' && numberWord(10) === 'ten' && numberWord(40) === 'forty', 'numberWord');
check(applyFacts('<!--dod:stages-->5<!--/dod:stages-->', { stages: 9 }) === '<!--dod:stages-->9<!--/dod:stages-->', 'a marker is rewritten');
let threw = false;
try { applyFacts('<!--dod:nope-->1<!--/dod:nope-->', { stages: 9 }); } catch { threw = true; }
check(threw, 'an unknown marker is an error');

const counts = siteCounts(root);
check(counts.fighters === 33 && counts.stages === 9 && counts.episodes === 39 && counts.seasons === 10, `counts today: ${JSON.stringify(counts)}`);
const { stale } = writeSiteFacts(root, { check: true });
check(stale.length === 0, `pages current with content/*.json${stale.length ? ` (stale: ${stale.join(', ')}; run node tools/site-facts.mjs)` : ''}`);

// Outside the markers, no page types a count of its own, and the old claims are gone.
const strip = (h) => h.replace(/<!--dod:([A-Za-z:-]+)-->[\s\S]*?<!--\/dod:\1-->/g, '');
for (const file of ['index.html', 'characters.html', 'whatsnew.html']) {
  const text = strip(fs.readFileSync(path.join(root, file), 'utf8')).replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  const typed = text.match(/\b(33|thirty-three|39|10-season|ten-season)\b/gi) || [];
  check(typed.length === 0, `${file}: no hand-typed counts${typed.length ? ` (${typed.join(', ')})` : ''}`);
  check(!/\bComing\b|one stage|Eight chapters|5 stages|Room codes/i.test(text), `${file}: no stale claims`);
}
process.exit(failed ? 1 : 0);
