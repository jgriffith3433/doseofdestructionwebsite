/**
 * The landing page's numbers come from the game's own data, never from a hand: this reads content/*.json and writes
 * the fighter, stage, episode and season counts into index.html (facts, feature cards, share card), characters.html
 * and whatsnew.html. Run by `npm run build` (package.json) and the pages workflow (via the build); `npm test` runs
 * `--check`, which fails while a page is out of date.
 *
 * A generated spot in a page sits between markers: `<!--dod:KEY-->…<!--/dod:KEY-->`, rewritten on every run.
 *   KEY is a count (`fighters`, `stages`, `episodes`, `seasons`), `count:word` for the number in words ("thirty-three"),
 *   `count:Word` for it capitalised ("Thirty-three"), or a block (`og-description`, `meta-description`, which
 *   regenerate a whole <meta> tag, since a comment can't sit inside an attribute).
 * An unknown KEY is an error, so a typo can't leave a stale number behind.
 *
 * Seasons: a chapter's `season` in campaign.json (left out, it's 1; docs/story.md "Seasons on the map").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES = ['index.html', 'characters.html', 'whatsnew.html'];

const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, 'content', file), 'utf8'));

/** { fighters, stages, episodes, seasons } from content/*.json. */
export function siteCounts(root) {
  const campaign = readJson(root, 'campaign.json');
  return {
    fighters: readJson(root, 'fighters.json').length,
    stages: readJson(root, 'stages.json').length,
    episodes: campaign.length,
    seasons: new Set(campaign.map((c) => c.season ?? 1)).size,
  };
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 33 → "thirty-three" (0 to 99; anything bigger stays digits). */
export function numberWord(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The share card and search description: facts only, one line each. */
const BLOCKS = {
  'og-description': (c) => `<meta property="og:description" content="${esc(
    `A free platform fighter in your browser: ${c.fighters} fighters, ${c.stages} stages, a ${c.seasons}-season story campaign and online matches with ratings. Last stock wins.`,
  )}">`,
  'meta-description': (c) => `<meta name="description" content="${esc(
    `A free platform fighter you play in the browser or on your phone. ${c.fighters} fighters, ${c.stages} stages, ${c.episodes} campaign episodes across ${c.seasons} seasons, and online matches with a rated leaderboard.`,
  )}">`,
  'characters-description': (c) => `<meta name="description" content="${esc(`The Dose of Destruction roster. ${numberWord(c.fighters)[0].toUpperCase()}${numberWord(c.fighters).slice(1)} fighters.`)}">`,
};

function render(key, counts) {
  if (BLOCKS[key]) return BLOCKS[key](counts);
  const [name, form] = key.split(':');
  if (!(name in counts) || (form && form !== 'word' && form !== 'Word')) throw new Error(`site-facts: unknown marker "dod:${key}"`);
  const n = counts[name];
  if (!form) return String(n);
  const w = numberWord(n);
  return form === 'Word' ? w[0].toUpperCase() + w.slice(1) : w;
}

/** The page with every marker rewritten from `counts`. */
export function applyFacts(html, counts, file = 'page') {
  const re = /<!--dod:([A-Za-z:-]+)-->([\s\S]*?)<!--\/dod:\1-->/g;
  let seen = 0;
  const out = html.replace(re, (_m, key) => {
    seen++;
    return `<!--dod:${key}-->${render(key, counts)}<!--/dod:${key}-->`;
  });
  // An opening marker with no close is a typo that would leave a stale value.
  const opens = (html.match(/<!--dod:/g) || []).length;
  if (opens !== seen) throw new Error(`site-facts: ${file} has an unclosed or malformed dod marker`);
  return out;
}

/** Writes (or, with check, only compares) every page. Returns the files that changed or are stale. */
export function writeSiteFacts(root, { check = false } = {}) {
  const counts = siteCounts(root);
  const stale = [];
  for (const file of PAGES) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const before = fs.readFileSync(p, 'utf8');
    const after = applyFacts(before, counts, file);
    if (after !== before) {
      stale.push(file);
      if (!check) fs.writeFileSync(p, after);
    }
  }
  return { counts, stale };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const check = process.argv.includes('--check');
  const { counts, stale } = writeSiteFacts(root, { check });
  console.log(`site facts: ${counts.fighters} fighters, ${counts.stages} stages, ${counts.episodes} episodes, ${counts.seasons} seasons`);
  if (check && stale.length) {
    console.error(`FAIL ${stale.join(', ')} out of date with content/*.json (run: node tools/site-facts.mjs)`);
    process.exit(1);
  }
  console.log(stale.length ? `updated ${stale.join(', ')}` : 'pages already current');
}
