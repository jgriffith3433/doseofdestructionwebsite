# Balance table

Every fighter against every fighter (33 fighters, both sides, 6 seeds each: 384 games per fighter),
level-9 bots on city-top, 2 stocks, 60 s limit. Deterministic: the same build prints the same table.
Code: `src/game/balance.ts`; gate: `src/game/test/balance.test.ts` (in `npm test`) fails when a fighter's win rate leaves
25-75% (wide while the table is new; tighten it as kits are tuned). Regenerate with `node tools/balance-table.ts`.

| # | Fighter | Win rate | Wins | Games |
|--:|---|--:|--:|--:|
| 1 | Lapis Man (lapis-man) | 63.8% | 245 | 384 |
| 2 | Crystalline Intelligences (crystalline-intelligences) | 60.7% | 233 | 384 |
| 3 | SS Boulder (ss-boulder) | 60.2% | 231 | 384 |
| 4 | Future Man (future-man) | 58.3% | 224 | 384 |
| 5 | Blog Man (blog-man) | 56.8% | 218 | 384 |
| 6 | Slice (slice) | 56.8% | 218 | 384 |
| 7 | The Mechanic (the-mechanic) | 56.0% | 215 | 384 |
| 8 | Wallit (wallit) | 55.7% | 214 | 384 |
| 9 | Stratabots (stratabots) | 55.2% | 212 | 384 |
| 10 | Orchestrator (orchestrator) | 54.9% | 211 | 384 |
| 11 | Shark Dude (shark-dude) | 53.1% | 204 | 384 |
| 12 | Small Weather (small-weather) | 53.1% | 204 | 384 |
| 13 | Shutup Bot (shutup-bot) | 52.9% | 203 | 384 |
| 14 | Slow Rider (slow-rider) | 51.6% | 198 | 384 |
| 15 | Not an Old Man Yet (not-an-old-man-yet) | 51.3% | 197 | 384 |
| 16 | Crosser (crosser) | 51.0% | 196 | 384 |
| 17 | TT (tt) | 50.0% | 192 | 384 |
| 18 | Pyro Singer (pyro-singer) | 49.7% | 191 | 384 |
| 19 | Uh Me (uh-me) | 49.0% | 188 | 384 |
| 20 | Chooser (chooser) | 48.7% | 187 | 384 |
| 21 | Cel (cel) | 48.4% | 186 | 384 |
| 22 | DJ Won't Read (dj-wont-read) | 47.9% | 184 | 384 |
| 23 | Try Belt (try-belt) | 47.7% | 183 | 384 |
| 24 | Kaelen (kaelen) | 47.1% | 181 | 384 |
| 25 | Yooba (yooba) | 45.8% | 176 | 384 |
| 26 | Yo Bot (yo-bot) | 45.6% | 175 | 384 |
| 27 | Susan (susan) | 45.3% | 174 | 384 |
| 28 | Got Ur Back (got-ur-back) | 45.1% | 173 | 384 |
| 29 | Break (break) | 40.9% | 157 | 384 |
| 30 | Evil Blue Bird (evil-blue-bird) | 40.1% | 154 | 384 |
| 31 | Spider Bot (spider-bot) | 38.8% | 149 | 384 |
| 32 | Exit Punk (exit-punk) | 35.9% | 138 | 384 |
| 33 | Ball Person (ball-person) | 32.6% | 125 | 384 |

## Auto CPU level (quick play)

Versus's CPU slots default to **Auto** (`ai/autoLevel.ts`; the slot's Auto button, off as soon as + or − is used, so a manual level
always wins). The saved level lives beside the profile in `localStorage` `dod.profile.cpu` (`{ level }`, 1 to 9, starts at 3). A match
made from the select (and its Rematch) plays at that level, the VS card reads "CPU · Level N · Auto", and a finished match moves it:
+1 after a clear win (at most one stock lost: 2+ left of 3; fewer stocks need a flawless win), -1 after a clear loss (no stock taken, or
under 60% dealt), else it stays. A change shows as one line on Results ("Auto: CPU level 3 → 4", `.level-note`). Campaign, Tours, Training,
Daily and online never use it. Scenario `auto-level`; `test/autoLevel.test.ts`.
