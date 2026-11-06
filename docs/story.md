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
- Season 3, *The Orchestrator Returns*: "He signed the sheet. He took the baton. The show goes on."
- Season 4, *The Rival Broadcast*: "Two networks. One card. The show is still his."
- Season 5, *Sweeps Week*: "Four nights. Four sweeps. Nobody changed the channel."
- Season 6, *Syndication*: "Four markets. Four feeds. The card travels."
- Season 7, *The Reboot*: "Four pilots. Four reboots. The champion was never recast."
- Season 8, *Awards Season*: "Four nominees. Four envelopes. The speech was four words."
- Season 9, *The Cliffhanger*: "Four teasers. One cliffhanger. Two names on the sheet."

- Season 10, *The Finale*: "Two Orchestrators. Two fights. One finale. The card is yours, and the show is over."

A new season just adds `"season": N` chapters (it shows locked until the season before is cleared). Season 10 is the last: its end line closes the series.

The names and end lines live in `src/game/campaign/story.ts` (`SEASON_TEXT`) next to the chapter reader.

## Unlocks: who joins the card

The show's roster grows as the champion clears it. A chapter's optional `unlock` in `content/campaign.json` names
the fighter id that joins the card when that episode is cleared, always the walk-on it was fought against (Open
Mic: Kaelen, House Heavy: Break, Bad Signal: DJ Won't Read, Low Pressure: Small Weather, Turn the Page: Blog Man,
Sudden Death: Slice, Dead Weight: SS Boulder, Encore: the Orchestrator, Title Defense: Shark Dude, Drop In: Pyro
Singer, The Champion's Tax: Susan, Sponsored: Wallit, Simulcast: Cel, Rerun: Try Belt, Cut to Size: Crosser, Hostile
Takeover: Crystalline Intelligences, Cold Open: Uh Me, Product Placement: Yo Bot, Dead Air: Spider Bot, Clip Show: Lapis
Man). Walk-On, with no `unlock`, gives nothing.

- A fighter named by some chapter is **locked** on a fresh save: a dark "Locked" tile in Versus select (the preview
  says which episode opens them), a grey picture in Profile. Everyone no chapter names (Exit Punk first) is open.
- Clearing the episode unlocks them for good (`localStorage` `dod-unlocks`, next to `dod-campaign`; starting the
  campaign over doesn't take it back). The map says so: "*Kaelen* joins the card. Unlocked for Versus and online."
- The campaign itself is never gated: Exit Punk is the player and every walk-on fights as written. Training is open.
- Online you fight as your profile picture, so the picture follows the same rule (`fighterOpen` in
  `campaign/story.ts`, used by select, Profile and the online setup). A save that cleared chapters before unlocks
  existed gets their fighters from `dod-campaign`. The leaderboard rates what was played; it can't see another
  player's unlocks, so it trusts each client to pick only fighters it may.

## Season 2: The card is yours (as built)

The show came back, the way the Orchestrator said it would. Exit Punk is the champion now, and the champion
doesn't get an exit: he gets defenses. Four walk-ons the show has never put on the card come for it, one per
episode. Exit Punk is the player in every fight, team 0, as in Season 1.

**The host.** Blog Man hosts Season 2. He covered the whole first run, he talks in headlines, and the
headlines are still too long. The narrator stays. The Orchestrator is off the air: he doesn't host and isn't
seen until the season's last line.

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist |
|---|---|---|---|---|
| 1 | Title Defense (`title-defense`) | Shark Dude (5) | City Top (`city-top`) | On the clock: 2 minutes (`timeLimit: 7200`), 2 stocks each. When time runs out, the most stocks left keeps the card. |
| 2 | Drop In (`drop-in`) | Pyro Singer (6), 5 stocks, every life at 100% | Rainbow Full Pipe (`rainbow-full-pipe`) | **Ratings**: score 3 KOs before the 2-minute clock runs out. Her stocks don't matter; the KO count does. The Drop In! skater keeps coming. |
| 3 | The Champion's Tax (`champions-tax`) | Susan (5) | Cursed Town (`cursed-town`) | Exit Punk starts every life at 60% (`startPercent: 600` on his slot); Susan starts at 0. 3 stocks each. |
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
Pyro Singer starting every life hurt (`startPercent`). Built with the last: she starts every life at 100%
(`startPercent: 1000`), CPU 6, 2-minute clock; the level-9 bot then wins about 5 fights in 8 in the sim. The
Champion's Tax runs Susan at CPU 5 (not 6): at 60% a life, CPU 6 was harder than Encore.

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
*Hint: Ratings: 3 KOs before the clock runs out. She starts every life hurt, but her aerials burn hard. Watch for the skater dropping in.*

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

**Season end** (the last lines of Sponsored's outro; the map's end line under Season 2 is the narrator's). Narrator: *"Four walk-ons. Four defenses. The card is still his."* Then the sign-up sheet
for next season, one name on it, read by Blog Man: *"Walk-on. No sponsor. No record. One baton."*

That's the Orchestrator, coming back as a fighter (never as scenery). His return isn't part of Season 2's
four episodes: it airs as Season 3, below.

### Building Season 2

What it took, in order (all built; the lines as said are in `content/campaign.json`):

1. The Ratings objective (episode 2's mechanic), with a sim test. Built: `objective: "ko"`, above.
2. The four chapters in `content/campaign.json` after `encore`, from the tables above, each with
   `"season": 2`. The map already shows seasons (below).
3. The lines written out in full (the beats above are the outline) and voiced through Hawkes Gen
   (`dod-voice-music`): Blog Man as host, narrator, Exit Punk and the four walk-ons. Voice lines cost cents,
   no GPU.
4. The `campaign` playtest scenario reaching the new chapters (or a setup option that starts at a chapter).

No new stages or art are needed: every Season 2 stage and fighter already exists.

## Season 3: The Orchestrator Returns (as built)

The sign-up sheet at the end of Sponsored had one name on it. Season 3 is that walk-on: the Orchestrator,
off the air since the Encore, signs up like everybody else and fights for the card. It's one episode, on its
own heading on the map ("Season 3", *The Orchestrator Returns*), so Season 2 keeps its four. Blog Man still hosts; the
narrator stays. The Orchestrator is a fighter, never scenery.

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist |
|---|---|---|---|---|
| 1 | Walk-On (`walk-on`) | The Orchestrator (9), 4 stocks, normal size | Humans In The Loop (`humans-in-the-loop`) | **Top billing**: the Encore turned around. Exit Punk is the giant this time (`scale: 130` on his slot), with 3 stocks; the walk-on gets a stock more (4). |

Pacing: being the giant helps (reach and weight) more than it hurts (a bigger target), so on its own the
level-9 bot beat a CPU 9 Orchestrator about 2 fights in 3. The walk-on's extra stock brings it back to the
Encore's level: about 3 in 8 over 32 sim fights (the Encore is 3 in 8, Sponsored 2 in 8).

### 1. Walk-On: the Orchestrator on Humans In The Loop

*Tagline: One name on the sign-up sheet. No sponsor. No record. One baton.*
*Hint: Top billing: you're the giant tonight. Longer reach and harder to launch, but easier to hit. He has four stocks to your three and punishes every whiff.*

- Narrator: midnight at the Foundry; the arena lights come up on a walk-on with no entrance music.
- Blog Man: breaking news. Tonight's walk-on used to run this show.
- The Orchestrator: no sponsor, no record, one baton. He signed the sheet like everybody else.
- Exit Punk: "You said there wasn't an exit." The Orchestrator: there's only the next show, and tonight he's
  on the card.
- Blog Man reads the network's rules: the walk-on gets an extra stock, the champion gets top billing. Exit
  Punk: "Fine. Bring the baton."
- After: the baton spins across the floor. The Orchestrator: best ratings ever, and he wasn't even hosting.
  Blog Man's headline is too long. Exit Punk: "Keep the baton. I'll keep the card."
- The Orchestrator: "Same time tomorrow?" Exit Punk: "Same time tomorrow." The man who came for the exit
  chooses the show.

**Season end** (the last line of Walk-On's outro, and the map's end line under Season 3). Narrator: *"He signed the
sheet. He took the baton. The show goes on."*

Later items (not built; both cost money, so they wait for a yes):

- **Voice.** Walk-On's lines are text only: no `audio` or `take` yet, so they show as "no take" in the Voice
  tab and play silent. Record them through Hawkes Gen like Season 2's (cents, no GPU).
- **A dedicated Season 3 stage.** Walk-On uses Humans In The Loop, the arena where the Orchestrator ran the
  Encore. A stage of its own for his return is a later item (new art).

## Season 4: The Rival Broadcast (as built)

The Orchestrator lost the card twice, so he stops trying to win it and starts a second show: a rival
broadcast that airs the same hour on the same city's screens. He is the season's villain. He fights on the
card only in the finale (never as scenery); in the first three episodes he is the voice from the rival
network's booth, heard in the lines, who sends a walk-on each night and closes the outro with a threat. Blog Man
still hosts and the narrator stays; Exit Punk is the player, team 0, as always. **The Mechanic is not used**
(he is still a candidate, not confirmed canon). Every fighter and stage already exists; all four walk-ons
are fighters no earlier season used.

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist |
|---|---|---|---|---|
| 1 | Simulcast (`simulcast`) | Cel (5) | Watercolor Nebula | Heavy gravity (`gravity: 130`): the rival network turns it up, cutting Cel's air game short. 3 stocks each. |
| 2 | Rerun (`rerun`) | Try Belt (5), 5 stocks, every life at 100% | Dust Devil Mesa (`desert`) | **Ratings**: 3 KOs before the 2-minute clock (`objective: ko`), as in Drop In, with the rerun gag. |
| 3 | Cut to Size (`cut-to-size`) | Crosser (5) | Space Chess | Exit Punk is smaller (`scale: 85`): lighter, shorter reach. 3 stocks each. |
| 4 | Hostile Takeover (`hostile-takeover`) | The Orchestrator (7) and Crystalline Intelligences (6), 2 stocks each | Solar Array | Two on one: Exit Punk has 3 stocks. The Orchestrator brings a partner "from the network". |

The beats:

1. **Simulcast.** A second set of lights comes on across town, same hour. Blog Man: the lighting is better. Cel:
   "Three extra jumps." After: "Okay. That was a lot of ground." The Orchestrator: "One night. I have a whole season."
2. **Rerun.** The rival network airs reruns of the champion, with the scores rewritten. Try Belt has watched every
   tape. Exit Punk: "The tape's wrong." The rerun is cancelled; the rival goes live.
3. **Cut to Size.** Budget cuts, the champion first. Exit Punk: "Is that allowed?" Blog Man: "It's a broadcast."
   (the show's running joke, from Low Pressure). Crosser lands once; Exit Punk lands more.
4. **Hostile Takeover.** Both broadcasts on one channel; the rival wants to buy the show. The Orchestrator fights
   with a partner. After: the rival feed goes to static; Exit Punk: "Keep the baton. Stay off my channel."

**Season end** (the last line of Hostile Takeover's outro, and the map's end line under Season 4). Narrator: *"Two
networks. One card. The show is still his."* The rival network's fold leaves Season 5 open.

Later items: the lines are text only (no `audio`/`take` yet, so they play silent and show as "no take" in the
Voice tab); recording them through Hawkes Gen costs cents. No new art is needed.

## Season 5: Sweeps Week (as built)

The rival broadcast is dead and every screen in the city is back on one channel. The network answers the way
television does: it calls Sweeps Week, four nights where the ratings decide everything and the champion
fights whatever the network can book. No villain this season. The Orchestrator is off the air (not seen,
not heard) and **The Mechanic is not used** (still a candidate, not confirmed canon). Blog Man hosts and the
narrator stays; Exit Punk is the player, team 0. Every fighter and stage exists; the four walk-ons are
fighters no earlier season used (Uh Me, Yo Bot, Spider Bot, Lapis Man); TT also fights, as Lapis Man's
partner, and is not unlocked (one fighter per chapter).

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | Cold Open (`cold-open`) | Uh Me (5) | City Top | Light gravity (`gravity: 70`): everything floats, and Uh Me is the best at it. 3 stocks each. | Uh Me |
| 2 | Product Placement (`product-placement`) | Yo Bot (6) | Yo House | The sponsor's night: damage at 130% (`damage: 130`) for both. **Quota** (`objective: quota`): deal 300% before the 100-second clock. 3 stocks each. | Yo Bot |
| 3 | Dead Air (`dead-air`) | Spider Bot (6), 3 stocks | Solar Array | Survive 60 seconds (`objective: survive`), the signal drops. Exit Punk has 2 stocks. | Spider Bot |
| 4 | Clip Show (`clip-show`) | Lapis Man (7) and TT (6), 2 stocks each | Humans In The Loop | Two on two: Blog Man (CPU 5) fights beside Exit Punk. 3 stocks on the champion's side. | Lapis Man |

The beats:

1. **Cold Open.** Sweeps Week starts with no warning, and with the gravity turned down "for reasons". Uh Me: "The
   ground is real." Exit Punk: "Next."
2. **Product Placement.** The sponsor is also the walk-on, and pays by the percent: the network has booked a quota of 300%, delivered before the clock runs out. Yo Bot's laptop hits back, 30% harder. After: "Low battery."
3. **Dead Air.** The signal drops for a minute and the champion has to stay on it. Spider Bot doesn't leave. "You
   didn't try to win." "Didn't need to."
4. **Clip Show.** The last night: every highlight, and one live fight with the host in it ("I did not read the fine
   print"). Lapis Man and TT. Exit Punk: "Good night."

**Season end** (the last line of Clip Show's outro, and the map's end line under Season 5). Narrator: *"Four nights.
Four sweeps. Nobody changed the channel."*

**The Quota rule** is new (built, Product Placement). A Quota fight is won by dealing N percent of damage before the
clock runs out, and lost when the clock wins (or when the champion runs out of stocks). It ends the moment the
number is met, whatever stocks are left. In data it is `"objective": "quota"` with `"quota": 300` (percent) and a
`timeLimit` in `rules`. The HUD shows "Quota 120/300%" with the clock where Dead Weight shows "Survive", and counts
up. Only the player's own hits on the other side count: shielded hits, hazards and falls don't, and damage keeps
counting when the foe is KO'd and starts over. It's the sponsor's rule, so the results talk about the sponsor:

- met: "300% delivered before the clock. The sponsor is thrilled."
- on time: "Time ran out at 180 of 300%. The sponsor wants a refund."
- out of stocks: "Out of stocks at 180 of 300%. The sponsor pulled the ad."

Pacing: tuned in the sim against the level-9 bot on Yo House with damage at 130%: 300% in 100 seconds against Yo Bot
(CPU 6) is won in about 9 fights of 16 (the other seven end on the clock or out of stocks).

Later items: the lines are text only (no `audio`/`take`, so they play silent and show as "no take" in the Voice tab);
recording them through Hawkes Gen costs cents. No new art is needed. Pacing of the other episodes (CPU levels,
stocks) is not sim-tuned.

## Season 6: Syndication (as built)

Sweeps Week was so good that every city wants the champion. The network answers the way television does: it
syndicates the show, one market per night, each with its own station and its own rules. No villain this season.
The Orchestrator is off the air (not seen, not heard) and **The Mechanic is not used** (still a candidate, not
confirmed canon). Blog Man hosts and the narrator stays; Exit Punk is the player, team 0. Every fighter and stage
exists; the walk-ons are fighters no earlier season used (Ball Person, Chooser, Not an Old Man Yet, Yooba), and
Slow Rider fights as Yooba's partner and is not unlocked (one fighter per chapter). Future Man is still unused.

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | Local Affiliate (`local-affiliate`) | Ball Person (5) | Rainbow Full Pipe | Quiet stage (`hazards: 0`): the local station can't afford the effects, so no skater drops in. 3 stocks each. | Ball Person |
| 2 | Standards and Practices (`standards-and-practices`) | Chooser (5) | Space Chess | A censor: damage at 70% (`damage: 70`) for both, so fights run long. 3 stocks each. | Chooser |
| 3 | Prime Time (`prime-time`) | Not an Old Man Yet (5) | Dust Devil Mesa (`desert`) | **Quota** (`objective: quota`): deal 200% before the 80-second clock (`timeLimit: 4800`). 3 stocks each. | Not an Old Man Yet |
| 4 | Global Feed (`global-feed`) | Yooba (6) and Slow Rider (6), 2 stocks each | Watercolor Nebula | Two on one: Exit Punk has 3 stocks. Gravity at 85% (`gravity: 85`). | Yooba |

The beats:

1. **Local Affiliate.** The first syndicated city has a small budget and a very good pipe. Ball Person: "I know every
   inch of this pipe." Exit Punk: "Show me." After: "Okay. You know it better." Exit Punk: "Next city."
2. **Standards and Practices.** The second city has a censor: hits shown at seventy percent, "family hour". Chooser
   chooses where to stand. After: "I did not choose that." Exit Punk: "Seventy percent was plenty."
3. **Prime Time.** The third market buys the show at its best hour and books a quota of 200%. Not an Old Man Yet
   owns the middle of the stage. After: "Not an old man yet. A little bruised."
4. **Global Feed.** Every city at once, one live fight, and the network sends two. Yooba and Slow Rider. Exit Punk:
   "Good night, everyone."

**Season end** (the last line of Global Feed's outro, and the map's end line under Season 6). Narrator: *"Four
markets. Four feeds. The card travels."*

Later items: the lines are text only (no `audio`/`take`, so they play silent and show as "no take" in the Voice
tab); recording them through Hawkes Gen costs cents. No new art is needed. Pacing (CPU levels, stocks, the 200%
quota in 80 seconds) is not sim-tuned.

## Season 7: The Reboot (as built)

Syndication made the show so big that the network does what television does with a hit: it reboots it. Four nights,
each a remake of an old kind of episode (a pilot, a sitcom, a crossover, a finale), with the same champion and a
"bold new look" that is the old look with a bigger budget. No villain. The Orchestrator is off the air (not seen,
not heard) and **The Mechanic is not used** (still a candidate, not confirmed canon). Blog Man hosts and the narrator
stays; Exit Punk is the player, team 0. Every fighter and stage exists; the walk-ons are fighters no earlier season
made a walk-on (Evil Blue Bird, Shutup Bot, Stratabots, Future Man), and TT fights as Stratabots' partner and is not
unlocked (one fighter per chapter). Only the Mechanic is left unused. One new rule: the Clean Streak (Series Finale).

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | Pilot Remake (`pilot-remake`) | Evil Blue Bird (6) | City Top | Both start every life at 100% (`startPercent: 1000`): one clean hit can end it. 2 stocks each. | Evil Blue Bird |
| 2 | Laugh Track (`laugh-track`) | Shutup Bot (6), 4 stocks, every life at 100% | Yo House | **Ratings** (`objective: ko`): 2 KOs before the 90-second clock (`timeLimit: 5400`). | Shutup Bot |
| 3 | Crossover Event (`crossover-event`) | Stratabots (7) and TT (6), 2 stocks each | Rainbow Full Pipe | Two on one: Exit Punk has 3 stocks. Gravity at 115% (`gravity: 115`). | Stratabots |
| 4 | Series Finale (`series-finale`) | Future Man (8) | City Top | **Clean Streak** (`objective: streak`): land 5 hits in a row without being hit before the 90-second clock (`timeLimit: 5400`). Damage at 120% (`damage: 120`). 3 stocks each. | Future Man |

The beats:

1. **Pilot Remake.** The reboot starts on the roof where it started, with a new logo. Evil Blue Bird: "I get to be the
   first one this time." Exit Punk: "You were already first." After: "That was not in the script."
2. **Laugh Track.** The network added a canned laugh to a comedy nobody asked for; Shutup Bot doesn't talk and doesn't
   flinch. After: "Fine." (his only line, as in Bad Signal). Blog Man: the laugh track is off, the ratings are up anyway.
3. **Crossover Event.** Two shows on one night. Stratabots: "Plates up." TT: "I am heavier than I look." Exit Punk:
   "Believe it." The spin-off gets a pilot; Blog Man isn't sure how this works.
4. **Series Finale.** Back on City Top for the last night, with a guest from the next season who isn't allowed to
   say how it goes, and an editor who wants a supercut: five clean hits in a row, no cuts. After: "That is not how it went in the next season." Exit Punk: "Good night, future."

**Season end** (the last line of Series Finale's outro, and the map's end line under Season 7). Narrator: *"Four pilots.
Four reboots. The champion was never recast."*

**The Clean Streak rule** is new (built, Series Finale). A streak fight is won by landing N hits in a row without being
hit back before the clock runs out, and lost when the clock wins (or when the champion runs out of stocks). It ends on
the hit that makes the number. In data it is `"objective": "streak"` with `"streak": 5` (hits) and a `timeLimit` in
`rules`. The HUD shows "Clean streak 2/5" with the clock, counting up with each hit landed and back to 0 the moment
the champion is hit (falls and hazards don't reset it; shielded hits count for neither side). Hits on teammates
don't exist in this show's fights, so there is no friendly-fire case. It's the editor's rule, so the results talk
about the supercut (the line shows the best streak, not the current one):

- met: "5 clean hits in a row before the clock. That one goes in the supercut."
- on time: "Time ran out at a best streak of 3 of 5. Nothing for the supercut."
- out of stocks: "Out of stocks at a best streak of 3 of 5. The editor cut around you."

Pacing: tuned in the sim against the level-9 bot on City Top, Future Man (CPU 8), damage 120%: 5 in 90 seconds is
won in about 7 fights of 12 (3 in 60 s is won every time, 5 in 60 s about 5 of 12).

Later items: the lines are text only (no `audio`/`take`, so they play silent and show as "no take" in the Voice tab);
recording them through Hawkes Gen costs cents. No new art is needed (GPU estimate: none). Pacing of the other episodes
(CPU levels, stocks, the 2-KO Laugh Track clock) is not sim-tuned.

## Season 8: Awards Season (as built)

The reboot was a hit, so the network does what television does next: it gives itself prizes. Four nights of the
awards show, each a stage of the ceremony (the red carpet, the supporting category, the lifetime award, the big
one), and the champion is nominated for everything. No villain. The Orchestrator is off the air (not seen, not heard)
and **The Mechanic is not used** (still a candidate, not confirmed canon). Blog Man hosts and the narrator stays; Exit
Punk is the player, team 0. Season 7 used every fighter but the Mechanic, so the nominees are **returning walk-ons**
from earlier seasons (Kaelen, Break and Small Weather, Slice, Susan) in their own voices, glad to be nominated. Nobody
is unlocked this season: they already joined the card (`unlock` is left out, as in Walk-On).

| # | Episode (id) | Nominee (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | Red Carpet (`red-carpet`) | Kaelen (6) | Solar Array | Quiet stage (`hazards: 0`): the carpet is not to be scuffed. 3 stocks each. | none |
| 2 | Best Supporting (`best-supporting`) | Break (6) and Small Weather (5), 2 stocks each | Yo House | Two on one: Exit Punk has 3 stocks. Gravity at 90% (`gravity: 90`). | none |
| 3 | Lifetime Achievement (`lifetime-achievement`) | Slice (6) | Space Chess | **Quota** (`objective: quota`): deal 250% before the 90-second clock (`timeLimit: 5400`). Damage at 110% (`damage: 110`). 3 stocks each. | none |
| 4 | Best in Show (`best-in-show`) | Susan (7) | Humans In The Loop | **Clean Streak** (`objective: streak`): land 4 hits in a row without being hit before the 90-second clock (`timeLimit: 5400`). Damage at 120%. 3 stocks each. | none |

The beats:

1. **Red Carpet.** Kaelen, first opponent of the first night, is back to walk the carpet. Kaelen: "I came to say I'm
   glad to be here." Exit Punk: "Then stay glad." After: "Still glad." Blog Man: nobody scuffed the carpet but the champion.
2. **Best Supporting.** Two nominees for the supporting award; Break and Small Weather share a category and a grudge
   about who is supporting whom. After: Break: "I was the lead." Small Weather: "You were the weather." Exit Punk: "Congratulations."
3. **Lifetime Achievement.** The network gives the champion a lifetime award, which takes a quota: 250% of
   applause, in 90 seconds. Slice has been cutting the ribbon all night. After: "Lifetime. Already?" Exit Punk: "Seems so."
4. **Best in Show.** The big envelope. Susan has been waiting for the champion since The Champion's Tax and wants a
   word. The editor wants a clean acceptance: four hits in a row, nobody touches the champion. After: Susan: "Keep
   the trophy. I'll keep the receipt." Exit Punk's speech: "Thanks. Good night. Goodbye. Nice."

**Season end** (the last line of Best in Show's outro, and the map's end line under Season 8). Narrator: *"Four
nominees. Four envelopes. The speech was four words."*

Later items: the lines are text only (no `audio`/`take`); recording them through Hawkes Gen costs cents. No new art
is needed (GPU estimate: none). Pacing (CPU levels, stocks, the 250% quota, the 4-hit streak) is not sim-tuned; the 4-hit streak
is one easier than Series Finale's 5.

## Season 9: The Cliffhanger (as built)

Awards season is over, and television does what it does before a finale: it teases it. Four nights of promotion (a
teaser, a trailer, a table read, a cliffhanger), each a piece of the Season 10 finale that the network won't show
whole. No villain, and the Orchestrator is still off the air: **he is never seen or heard in Season 9, only talked
about**, so the first time he is on the card again is the finale. **The Mechanic is not used** (still a candidate,
not confirmed canon). Blog Man hosts and the narrator stays; Exit Punk is the player, team 0. The promoters are
**returning walk-ons** (Shark Dude, Wallit and Cel, Try Belt, Pyro Singer), in their own voices. Nobody is unlocked
(`unlock` is left out, as in Season 8).

| # | Episode (id) | Walk-on (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | Teaser (`teaser`) | Shark Dude (6) | City Top | Heavy gravity (`gravity: 115`). 3 stocks each. | none |
| 2 | Trailer (`trailer`) | Wallit (7) and Cel (5), 2 stocks each | Rainbow Full Pipe | Two on one: Exit Punk has 3 stocks. | none |
| 3 | Table Read (`table-read`) | Try Belt (6) | Desert | **Ratings** (`objective: ko`): 2 KOs before the 90-second clock (`timeLimit: 5400`). 3 stocks each. | none |
| 4 | Cliffhanger (`cliffhanger`) | Pyro Singer (7) | Cursed Town | **Quota** (`objective: quota`): deal 280% before the 100-second clock (`timeLimit: 6000`). Damage at 110%. 3 stocks each. | none |

The beats, and how they set up Season 10:

1. **Teaser.** A 30-second teaser that shows nothing and ends on a sign-up sheet. Shark Dude: "I am here to watch the
   champion defend it." After: the sheet has a name on it; the network won't say whose.
2. **Trailer.** Wallit and Cel share a trailer and fight over the voiceover. After: the champion records it, four words.
3. **Table Read.** The finale script has a page missing from every copy. After: the page turns up, in the
   Orchestrator's handwriting: *the finale needs two of him.* Blog Man: the network is checking.
4. **Cliffhanger.** Pyro Singer sings a song that doesn't resolve. After: the finale card is out, two sign-up sheets
   with one name on both, in the same handwriting. Exit Punk: "Two sheets. Fine. Same time tomorrow."

**Season end** (the last line of Cliffhanger's outro, and the map's end line under Season 9). Narrator: *"Four
teasers. One cliffhanger. Two names on the sheet."*

Season 10 is built, see below.

Later items: the lines are text only (no `audio`/`take`); recording them through Hawkes Gen costs cents. No new art is
needed (GPU estimate: none). Pacing (CPU levels, stocks, the 280% quota, the 2-KO clock) is not sim-tuned.

## Season 10: The Finale (as built)

The last season of the show. Season 9 promised two Orchestrators, two sign-up sheets and one handwriting, and it keeps the
promise: the Orchestrator is on the card twice, as **the host** (the man who ran the Encore) and **the walk-on** (the man
who signed the sheet in Season 3). One man, two halves of the show: the one who runs it and the one who fights for it.
It is not a twin, a rival network or a rerun; it is the same man, and the show needs both. This is the only season where
he is seen after Season 3. Blog Man hosts and the narrator stays; Exit Punk is the player, team 0. Two episodes, played
back to back (no new engine code, no new fighter, nothing unlocked: `unlock` is left out). The Mechanic is not used.

| # | Episode (id) | Opponent (CPU level) | Stage | Rule twist | Unlocks |
|---|---|---|---|---|---|
| 1 | First Cut (`first-cut`) | The Orchestrator, the host (8), at 150% size, 3 stocks | Humans In The Loop | The Encore's giant, back on his home set. 3 stocks each. | none |
| 2 | Final Cut (`final-cut`) | The Orchestrator, the walk-on (9), 3 stocks | City Top | No break after fight one: Exit Punk starts at 60% (`startPercent: 600`). 3 stocks each. | none |

The beats:

1. **First Cut.** Both sheets are on the card, same handwriting. The host: "A finale needs two of me." After: the lights
   cut to the next shot, not to black. Blog Man: the finale is two parts, back to back. Exit Punk: "Back to back. Fine."
2. **Final Cut.** City Top, where the first night began. The walk-on has wanted one ending and tonight he fights it.
   After: the baton lands and the handwriting on the two sheets looks like two men. Exit Punk: "I came for the exit."
   The Orchestrator: "And?" Exit Punk: "It was a good show."

**Season end, and the end of the series** (the last line of Final Cut's outro, and the map's end line under Season 10).
Narrator: *"Two Orchestrators. Two fights. One finale. The card is yours, and the show is over."*

Later items: the lines are text only (no `audio`/`take`); recording them through Hawkes Gen costs cents. No new art is
needed (GPU estimate: none). Pacing (CPU 8 and 9, the 60% head start) is not sim-tuned.

## The booth: announcer and Blog Man commentary (as built)

The show has a voice in the booth. In Versus and in the campaign (not Training, not online) the **announcer** calls the
fight as it happens, and in the campaign **Blog Man** opens every episode from the booth, just after "Go!", with one line
in his own style: a headline that is far too long. Season 1's host is still the Orchestrator; Blog Man is the reporter in
the front row there (in Turn the Page he is in the fight itself). The Mechanic is not used.

- Announcer lines are `announcer.<kind>.<n>` in `content/voice.json`, 14 kinds: `first-blood`, `ko`, `comeback` (a
  fighter who was behind on stocks KOs to draw level or lead), `last-stock`, `showdown` (everyone left on a last stock),
  `self-destruct` (a fall nobody caused, or a hazard), `big-hit`, `combo` (3 hits in 2 s without a reply), `danger` (150%+),
  `shield-break`, `hazard`, `stage-event` (the stage's warning), `time-low` (10 s left) and `lull` (12 s with no hit).
  One call per KO (the most newsworthy); other calls keep 3 s apart. A line is never said twice in a row.
- Blog Man's intros are `blog-man.intro.<chapter id>`, one per episode (39), keeping each season's tone.
- Every call also shows as a caption (`.booth`) and fires `dod:commentary`. The lines are text only for now: no `audio` or
  `take`, so they are captioned and silent until recorded through Hawkes Gen (cents, no GPU).
