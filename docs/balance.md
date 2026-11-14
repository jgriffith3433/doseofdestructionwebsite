# Balance table

Every fighter against every fighter (33 fighters, both sides, 6 seeds each: 384 games per fighter),
level-9 bots on city-top, 2 stocks, 60 s limit. Deterministic: the same build prints the same table.
Code: `src/game/balance.ts`; gate: `src/game/test/balance.test.ts` (in `npm test`) fails when a fighter's win rate leaves
25-75% (wide while the table is new; tighten it as kits are tuned). Regenerate with `node tools/balance-table.ts`.

| # | Fighter | Win rate | Wins | Games |
|--:|---|--:|--:|--:|
| 1 | Pyro Singer (pyro-singer) | 74.7% | 287 | 384 |
| 2 | Future Man (future-man) | 69.5% | 267 | 384 |
| 3 | Susan (susan) | 66.9% | 257 | 384 |
| 4 | Shark Dude (shark-dude) | 62.2% | 239 | 384 |
| 5 | Kaelen (kaelen) | 59.9% | 230 | 384 |
| 6 | Wallit (wallit) | 57.6% | 221 | 384 |
| 7 | Got Ur Back (got-ur-back) | 57.3% | 220 | 384 |
| 8 | Lapis Man (lapis-man) | 54.7% | 210 | 384 |
| 9 | Break (break) | 53.6% | 206 | 384 |
| 10 | Blog Man (blog-man) | 53.1% | 204 | 384 |
| 11 | Small Weather (small-weather) | 52.9% | 203 | 384 |
| 12 | Stratabots (stratabots) | 52.1% | 200 | 384 |
| 13 | Slice (slice) | 51.6% | 198 | 384 |
| 14 | Shutup Bot (shutup-bot) | 51.0% | 196 | 384 |
| 15 | Try Belt (try-belt) | 50.8% | 195 | 384 |
| 16 | Orchestrator (orchestrator) | 50.0% | 192 | 384 |
| 17 | TT (tt) | 49.2% | 189 | 384 |
| 18 | DJ Won't Read (dj-wont-read) | 48.7% | 187 | 384 |
| 19 | Not an Old Man Yet (not-an-old-man-yet) | 47.9% | 184 | 384 |
| 20 | Yo Bot (yo-bot) | 47.4% | 182 | 384 |
| 21 | Cel (cel) | 47.1% | 181 | 384 |
| 22 | Ball Person (ball-person) | 46.9% | 180 | 384 |
| 23 | Crosser (crosser) | 46.4% | 178 | 384 |
| 24 | Crystalline Intelligences (crystalline-intelligences) | 44.3% | 170 | 384 |
| 25 | The Mechanic (the-mechanic) | 44.3% | 170 | 384 |
| 26 | SS Boulder (ss-boulder) | 43.8% | 168 | 384 |
| 27 | Exit Punk (exit-punk) | 40.4% | 155 | 384 |
| 28 | Evil Blue Bird (evil-blue-bird) | 39.6% | 152 | 384 |
| 29 | Slow Rider (slow-rider) | 38.8% | 149 | 384 |
| 30 | Uh Me (uh-me) | 38.3% | 147 | 384 |
| 31 | Chooser (chooser) | 37.5% | 144 | 384 |
| 32 | Yooba (yooba) | 37.5% | 144 | 384 |
| 33 | Spider Bot (spider-bot) | 34.1% | 131 | 384 |
