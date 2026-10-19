# The story

Dose Of Destruction's campaign is a TV show. Every night at midnight the furnace floor of the Foundry becomes
a stage and the whole city tunes in. Each chapter is an episode: a scene, a fight with its own rules, and a
scene after. The fights, lines and rules live in `content/campaign.json` (`src/game/campaign/story.ts` reads
it; the Voice tab in devtools edits the lines). This doc says what the show is, so new episodes stay in it.

## The rules of the show

- **It's television.** Ratings, the card, the broadcast, going off the air, running long. Nobody talks about
  "levels" or "the game". The jokes are about the show and about fighting, never about jobs or offices.
- **Lines are short.** One or two sentences, said by someone. A scene is 2 to 8 lines.
- **Who speaks:**
  - `narrator`: sets the place, in the present tense. Never jokes.
  - `orchestrator`: Season 1's host. He runs the show, calls the card and talks about ratings. He is a
    fighter, never scenery: when he's on a stage, he fights on it.
  - `exit-punk`: the hero. Dry, short-spoken, never impressed. Answers a speech with four words.
  - Opponents get a line or two in their own voice (their fighter blurb is the starting point).
- **A rule twist per episode**, said in the chapter's `hint` (what the fight asks of the player) and played
  by the chapter's `fight` (stage, stocks, `rules`, `objective`, `startPercent`, `scale`, teams, CPU level).

## Season 1: Open Mic to Encore (as built)

Exit Punk walks on with no sponsor, no record and one skateboard. He's not here for the show; he's here for
the exit. The Orchestrator tells him the only way out is through everyone else on the card.

| # | Episode (id) | Opponents (CPU level) | Stage | Rule twist |
|---|---|---|---|---|
| 1 | Open Mic (`open-mic`) | Kaelen (2) | City Top | None: learn damage and launches. 2 stocks each. |
| 2 | House Heavy (`house-heavy`) | Break (3), at 135% size | Yo House | A giant heavy: build damage before the launch. |
| 3 | Bad Signal (`bad-signal`) | DJ Won't Read (3) and Shutup Bot (3), 1 stock each | Solar Array | Two on one, on panels that tilt away. |
| 4 | Low Pressure (`low-pressure`) | Small Weather (4) | Dust Devil Mesa (`desert`) | Gravity at 55%: jumps hang, launches carry. |
| 5 | Turn the Page (`turn-the-page`) | Evil Blue Bird (4) and Got Ur Back (4); Blog Man (5) fights with you | Watercolor Nebula | Two on two. Teammates can't hit each other. |
| 6 | Sudden Death (`sudden-death`) | Slice (6) | Cursed Town | One stock each, both start at 150%. |
| 7 | Dead Weight (`dead-weight`) | SS Boulder (6) and Stratabots (6), 3 stocks each | Space Chess | Survive 60 seconds (`objective: survive`), damage at 120%. |
| 8 | Encore (`encore`) | The Orchestrator (8), at 150% size | Humans In The Loop | The man who runs the show steps onto it. |

The beats:

1. **Open Mic.** The narrator opens the Foundry. The Orchestrator introduces "a walk-on". Exit Punk: "I'm not
   here for the show. I'm here for the exit." Kaelen: "Hi. Bye." After: "The crowd likes the kid. Keep him on
   the card."
2. **House Heavy.** Break's rule one is that he doesn't fall off. He falls off. Ratings go up eleven points.
3. **Bad Signal.** The network remixes a hit: DJ Won't Read talks, Shutup Bot doesn't. He only talks when he
   loses ("Fine.").
4. **Low Pressure.** The Orchestrator asked for drama, so Small Weather brought the weather. "It's a
   broadcast. Everything is allowed."
5. **Turn the Page.** Blog Man has covered the run, front page, three nights straight. He fights beside Exit
   Punk; his headline is way too long.
6. **Sudden Death.** The show is running long. One clean hit decides it. "I didn't flinch. I ducked."
7. **Dead Weight.** The kid is getting too popular, so the Orchestrator sends two heavies to take him off the
   air. He only has to still be standing when the clock runs out. "Fine. I'll do it myself."
8. **Encore.** On the Foundry floor dressed as the show's home set, the Orchestrator fights. "There isn't an
   exit. There's only the next show." Exit Punk ends the show. The broadcast goes quiet for the first time in
   years. Blog Man: "You're off the air, maestro." Exit Punk: "I came for the exit. Turns out it was the main
   event."

Season end: *"Dose of Destruction will return. The card is yours now."*

Fighters Season 1 used (none of them is a Season 2 walk-on): exit-punk, kaelen, break, dj-wont-read,
shutup-bot, small-weather, blog-man, evil-blue-bird, got-ur-back, slice, ss-boulder, stratabots, orchestrator.

## Seasons on the map

A chapter's optional `season` in `content/campaign.json` says which season it airs in (left out, it's 1).
The Campaign map shows each season under its own heading, "Season 1", "Season 2", with the season's name
beside it, and numbers the episodes from 01 within each season. A season is locked until every chapter of
the season before it is cleared, and its first card says so ("Clear Season 1 to open it."). Inside a
season the chapters unlock in order, as they always have. Once a season is cleared its end line shows under it:

- Season 1, *Open Mic to Encore*: "Season 1 cleared. The card is yours now."
- Season 2, *The card is yours*: "Four walk-ons. Four defenses. The card is still his."

The names and end lines live in `src/game/campaign/story.ts` (`SEASON_TEXT`) next to the chapter reader.

## Season 2: The card is yours (outline, not built yet)

The show came back, the way the Orchestrator said it would. Exit Punk is the champion now, and the champion
doesn't get an exit: he gets defenses. Four walk-ons the show has never put on the card come for it, one per
episode. Exit Punk is the player in every fight, team 0, as in Season 1.

**The host.** Blog Man hosts Season 2. He covered the whole first run, he talks in headlines, and the
headlines are still too long. The narrator stays. The Orchestrator is off the air: he doesn't host and isn't
seen until the season's last line.

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist |
|---|---|---|---|---|
| 1 | Title Defense (`title-defense`) | Shark Dude (5) | City Top (`city-top`) | On the clock: 2 minutes (`timeLimit: 7200`), 2 stocks each. When time runs out, the most stocks left keeps the card. |
| 2 | Drop In (`drop-in`) | Pyro Singer (6), 5 stocks | Rainbow Full Pipe (`rainbow-full-pipe`) | **Ratings**: score 3 KOs before the 2-minute clock runs out. Her stocks don't matter; the KO count does. The Drop In! skater keeps coming. |
| 3 | The Champion's Tax (`champions-tax`) | Susan (6) | Cursed Town (`cursed-town`) | Exit Punk starts every life at 60% (`startPercent: 600` on his slot); Susan starts at 0. 3 stocks each. |
| 4 | Sponsored (`sponsored`) | Wallit (7), at 130% size | Humans In The Loop (`humans-in-the-loop`) | A bought fighter: Wallit is giant and damage is at 120% (`damage: 120`). 3 stocks each. |

**The Ratings rule** is new (built). A Ratings fight is won by scoring N KOs before the clock runs out, and
lost when the clock wins (or when the champion runs out of stocks). The fight ends on the Nth KO, whatever
stocks are left. In data it is `"objective": "ko"` with `"kos": 3` and a `timeLimit` in `rules`. The HUD
shows "KOs 0/3" with the clock where Dead Weight shows "Survive", and counts up. Only the player's own KOs
count (a fall nobody caused isn't scored). The results say which way it went:

- 3 KOs: "3 KOs before the clock. That's the highlight reel."
- on time: "Time ran out at 1 of 3 KOs. No highlights tonight."
- out of stocks: "Out of stocks at 1 of 3 KOs. They cut to commercial."

Pacing: three KOs from 0% in two minutes is hard. The playtest bot (level 9) mostly scores 1 or 2 against a
CPU 1 to 3 on Rainbow Full Pipe. Drop In needs help to be fair: a longer clock, a lower CPU level, or
Pyro Singer starting every life hurt (`startPercent`).

### 1. Title Defense: Shark Dude on City Top

*Tagline: The champion's first night back on the roof where it started.*
*Hint: Two minutes on the clock. Keep more stocks than he does. He comes straight at you: shield, then punish.*

- Narrator: the Foundry lights come back on. The city tunes in again.
- Blog Man introduces himself as host, with a headline that's far too long.
- Blog Man: the first walk-on of the season. No record. One fin.
- Shark Dude: he's here for the belt. Exit Punk: "There's no belt. There's a card."
- After: Shark Dude goes for the bite once too often. Exit Punk: "Next."

### 2. Drop In: Pyro Singer on Rainbow Full Pipe

*Tagline: She wants the ratings. So does the network.*
*Hint: Ratings: 3 KOs before the clock runs out. Her aerials burn hard. Watch for the skater dropping in.*

- Narrator: Rainbow Full Pipe. Ramps, decks, and a skater who drops in whether you're ready or not.
- Blog Man: the network wants highlights, not survivors. Tonight is scored in KOs.
- Pyro Singer: she sings the opener, and the closer, and he's the chorus.
- Exit Punk, looking at the ramps: he's been here before. On a board.
- After: three KOs, clock still running. Blog Man reads the ratings like a headline. Exit Punk: "Shorter."

### 3. The Champion's Tax: Susan on Cursed Town

*Tagline: The champion pays to fight. The challenger doesn't.*
*Hint: You start every life at 60%. Susan drifts and reaches far. Stay on the rooftops, out of the fog.*

- Narrator: Cursed Town. The fog in the street eats you alive, and something below is reaching up.
- Blog Man: new rule from the network. The champion starts every round already hurt.
- Susan: she drifts in from the fog and doesn't say where she came from.
- Exit Punk: "Is that allowed?" Blog Man: "It's a broadcast." (Small Weather's line, from Low Pressure.)
- After: Susan goes back into the fog. Exit Punk: "Tell the network the tax is paid."

### 4. Sponsored: Wallit on Humans In The Loop

*Tagline: Someone bought a fighter. And then bought a bigger one.*
*Hint: The final defense: a giant Wallit, and every hit lands harder. Stay out of the bat's reach and punish the swing.*

- Narrator: the arena show, the same lights that went quiet at the end of last season.
- Blog Man: tonight's walk-on comes with a sponsor. Exit Punk came with one skateboard.
- Wallit: the card has a price, and he's paying it. Exit Punk: "It's not for sale."
- After: the bat on the floor, the cash in the air. Blog Man: the highest ratings since the Encore.
- Exit Punk: he came for the exit; he keeps finding a main event.

**Season end.** Narrator: *"Four walk-ons. Four defenses. The card is still his."* Then the sign-up sheet
for next season, one name on it, read by Blog Man: *"Walk-on. No sponsor. No record. One baton."*

That's the Orchestrator, coming back as a fighter (never as scenery), in the new finale stage that's a
later item. The finale isn't part of Season 2's four episodes.

### Building Season 2

What it takes, in order:

1. The Ratings objective (episode 2's mechanic), with a sim test. Built: `objective: "ko"`, above.
2. The four chapters in `content/campaign.json` after `encore`, from the tables above, each with
   `"season": 2`. The map already shows seasons (below).
3. The lines written out in full (the beats above are the outline) and voiced through Hawkes Gen
   (`dod-voice-music`): Blog Man as host, narrator, Exit Punk and the four walk-ons. Voice lines cost cents,
   no GPU.
4. The `campaign` playtest scenario reaching the new chapters (or a setup option that starts at a chapter).

No new stages or art are needed: every Season 2 stage and fighter already exists.
