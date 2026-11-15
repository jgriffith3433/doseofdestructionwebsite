# Balance table

Every fighter against every fighter (33 fighters, both sides, 6 seeds each: 384 games per fighter),
level-9 bots on city-top, 2 stocks, 60 s limit. Deterministic: the same build prints the same table.
Code: `src/game/balance.ts`; gate: `src/game/test/balance.test.ts` (in `npm test`) fails when a fighter's win rate leaves
25-75% (wide while the table is new; tighten it as kits are tuned). Regenerate with `node tools/balance-table.ts`.

| # | Fighter | Win rate | Wins | Games |
|--:|---|--:|--:|--:|
| 1 | Pyro Singer (pyro-singer) | 72.4% | 278 | 384 |
| 2 | Kaelen (kaelen) | 66.1% | 254 | 384 |
| 3 | Slice (slice) | 65.9% | 253 | 384 |
| 4 | Future Man (future-man) | 64.3% | 247 | 384 |
| 5 | Susan (susan) | 63.3% | 243 | 384 |
| 6 | Shark Dude (shark-dude) | 63.0% | 242 | 384 |
| 7 | Try Belt (try-belt) | 62.5% | 240 | 384 |
| 8 | Ball Person (ball-person) | 59.9% | 230 | 384 |
| 9 | Wallit (wallit) | 59.6% | 229 | 384 |
| 10 | DJ Won't Read (dj-wont-read) | 59.4% | 228 | 384 |
| 11 | Lapis Man (lapis-man) | 55.2% | 212 | 384 |
| 12 | Small Weather (small-weather) | 54.7% | 210 | 384 |
| 13 | Got Ur Back (got-ur-back) | 51.6% | 198 | 384 |
| 14 | Blog Man (blog-man) | 48.7% | 187 | 384 |
| 15 | Not an Old Man Yet (not-an-old-man-yet) | 48.7% | 187 | 384 |
| 16 | Break (break) | 48.4% | 186 | 384 |
| 17 | Orchestrator (orchestrator) | 48.4% | 186 | 384 |
| 18 | Yo Bot (yo-bot) | 48.4% | 186 | 384 |
| 19 | Uh Me (uh-me) | 47.9% | 184 | 384 |
| 20 | Crosser (crosser) | 45.3% | 174 | 384 |
| 21 | Shutup Bot (shutup-bot) | 45.3% | 174 | 384 |
| 22 | Cel (cel) | 44.8% | 172 | 384 |
| 23 | Slow Rider (slow-rider) | 44.0% | 169 | 384 |
| 24 | Stratabots (stratabots) | 40.6% | 156 | 384 |
| 25 | Yooba (yooba) | 40.4% | 155 | 384 |
| 26 | The Mechanic (the-mechanic) | 38.8% | 149 | 384 |
| 27 | TT (tt) | 38.8% | 149 | 384 |
| 28 | Spider Bot (spider-bot) | 38.5% | 148 | 384 |
| 29 | Crystalline Intelligences (crystalline-intelligences) | 38.0% | 146 | 384 |
| 30 | Exit Punk (exit-punk) | 38.0% | 146 | 384 |
| 31 | SS Boulder (ss-boulder) | 38.0% | 146 | 384 |
| 32 | Evil Blue Bird (evil-blue-bird) | 37.0% | 142 | 384 |
| 33 | Chooser (chooser) | 33.9% | 130 | 384 |
