declare const process: { exit(code: number): never };
// Story cards: every campaign episode has a before and after card line in content/campaign.json, and storyCard reads them.
import { CHAPTERS, storyCard } from '../campaign/story.ts';

let bad = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) {
    bad++;
    console.log(`FAIL ${what}`);
  }
};
for (const c of CHAPTERS) {
  check(!!c.card?.before && !!c.card?.after, `${c.id} has card.before and card.after`);
  for (const w of ['before', 'after'] as const) {
    const card = storyCard(c, w);
    check(card.title === c.title && card.line === c.card?.[w], `${c.id} ${w} card reads its title and line from campaign.json`);
    check(card.line.length <= 120, `${c.id} ${w} line is short`);
  }
}
check(storyCard(CHAPTERS[0], 'before').kicker === 'Season 1 · Episode 01', 'kicker of the first episode');
const first2 = CHAPTERS.find((c) => c.season === 2)!;
check(storyCard(first2, 'before').kicker === 'Season 2 · Episode 01', 'episodes number from 01 within each season');
if (bad) process.exit(1);
console.log('all story card checks passed');
