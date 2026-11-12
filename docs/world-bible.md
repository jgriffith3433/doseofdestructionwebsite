# Dose of Destruction: world bible

Dose of Destruction is a midnight TV fight show. The world is the Foundry city and every stage the network can put
on air. Players do not walk an open map: they drop into a live arena for each bout. "Never more than about 10
seconds without something to see, hear or do" means on a stage: dressing, a landmark, life that moves on its own,
ambient sound and several kinds of interaction in every bout. Story is told in the arena (live intro and outro
scenes with arrivals, camera, voice and crowd), never on a text screen. The campaign bible is `docs/story.md`; this
file is the place bible agents build to. **The Mechanic is candidate canon only** (origin short, not confirmed): do
not put him on the card or in episode lines until J confirms.

## Areas

Each area is a broadcast stage the Foundry floor (or a cutaway feed) can become. Size is fight-scale: blast zones
and platforms a bout fits on, not a city block. You get in by the campaign card, Versus, Training or an online pair
room; you get out by Game!, Quit, or the season map. Mood and sound below are what a bout should feel like; gaps
call out where the live build is still thin.

### The Foundry floor — Humans In The Loop
- **Mood:** home set, sold-out arena, the show that never goes dark.
- **Look / sound:** truss towers, spot and strobe beams, flight cases, floor wedges, a packed crowd ring, cables in
  front. Layered bed: arena murmur (`bed: arena`) under `music-foundry` ambience + theme `music-humans-in-the-loop`;
  lifts on last stock / 100%; final-KO sting. Crowd noise, cheer on every KO (`go-wild`).
- **Size:** wide main deck with side platforms; the camera opens wide for scene cards then tightens on speakers.
- **In / out:** Season 1 Encore, Season 2 Sponsored, Season 3 Walk-On, Season 5 Clip Show, Season 8 Best in Show,
  Season 10 First Cut. The city tunes here first every midnight.
- **Now:** strongest "show" stage (crowd + KO reaction). **Short:** no day/night shift of the house lights outside
  a bout; booth is heard, not seen as a place you can visit.

### City Top
- **Mood:** LA rooftops at night, fireworks when someone falls, the first roof of the series.
- **Look / sound:** skyline backdrop, water tower, fire escape, billboard catwalk, skylight canopy, antenna.
  Layered bed: night wind/city hum (`bed: city-night`) under `music-rooftop` ambience + theme `music-city-top`;
  lifts on last stock / 100%; final-KO sting. Fireworks on falls.
- **Size:** long main roof, side ledges, a high solid perch; blast left/right into the city.
- **In / out:** Open Mic, Title Defense, Cold Open, Pilot Remake, Series Finale, Teaser, Final Cut (and returns).
- **Now:** painted and playable. **Short / vertical-slice fix:** add a soft timed beat every ~8–10 s (billboard
  flicker, distant firework volley, or antenna spark) plus denser night wind and city hum so stalling never leaves a
  dead roof. Fireworks-on-KO alone is not enough breathing between hits.

### Yo House
- **Mood:** bright living-room absurdity; the sponsor's living set.
- **Look / sound:** hardwood, fish tank, sofa, yoga corner, exercise ball, doorway frame, fern. Layered bed: room
  tone (`bed: indoor`) under a quiet `music-drift` ambience + theme `music-yo-house`; lifts on last stock / 100%;
  final-KO sting. Vacuum whirr and bubbler events.
- **Size:** indoor box with tank and furniture platforms.
- **In / out:** House Heavy, Product Placement, Laugh Track, Best Supporting.
- **Now:** vacuum and bubbler events keep the floor alive. **Short:** fish are mostly art; they should dart on their
  own between events.

### Solar Array
- **Mood:** hard sun, industrial desert, panels that do not care who is standing on them.
- **Look / sound:** mesa, panel pylons, sun-tracking plates, foreground rocks. Layered bed: sun glare hum
  (`bed: solar`) under `music-drift` ambience + theme `music-solar-array`; lifts on last stock / 100%; final-KO sting.
  Panel motors on `sun-tracking`.
- **Size:** mesa floor under tilting panels.
- **In / out:** Bad Signal, Hostile Takeover, Dead Air, Red Carpet.
- **Now:** `sun-tracking` tilts platforms away on a timer. **Quiet routine (Red Carpet, `hazards: 0`):** panels stay
  still (carpet must not scuff) but motor ticks keep time every few seconds, sun glare shimmers on the plate faces, and
  desert hush stays dense — a silent carpet that still feels like a lit set, not a stripped stage.

### Dust Devil Mesa (`desert`)
- **Mood:** salt flats, wind-carved stone, something hunting overhead.
- **Look / sound:** rock arch, buttes, lakebed, sage, dust wall, circling hawk. Layered bed: dry wind (`bed: desert`)
  under `music-drift` ambience + theme `music-desert`; lifts on last stock / 100%; final-KO sting. Gusts and hawk dives.
- **Size:** arch climb over flats with side boulders.
- **In / out:** Low Pressure, Rerun, Prime Time, Table Read.
- **Now:** `dust-gust` and `hawk-dive` on timers. **Short:** wind should keep moving dust between storms.

### Watercolor Nebula
- **Mood:** soft, floaty, a paint sky that never dries.
- **Look / sound:** spiral puddles, underwash, cloud banks, drift swirls, dripping wisps. Layered bed: soft nebula
  tone (`bed: nebula`) under `music-drift` ambience + theme `music-watercolor-nebula`; lifts on last stock / 100%;
  final-KO sting. Pigment rain and drift.
- **Size:** stacked floating islands with long falls.
- **In / out:** Turn the Page, Simulcast, Global Feed.
- **Now:** `pigment-rain` and `nebula-drift`. **Short:** islands should breathe (slow bob) even when no event is up.

### Cursed Town
- **Mood:** fog streets you do not walk; rooftops only; something below.
- **Look / sound:** gabled houses, street beam, tentacles, surge fog. Layered bed: fog hush (`bed: fog`) under
  `music-pit` ambience + theme `music-cursed-town`; lifts on last stock / 100%; final-KO sting. Fog surge and Presence.
- **Size:** opposing roofs over a lethal street.
- **In / out:** Sudden Death, Champion's Tax, Cliffhanger.
- **Now:** `fog-surge` and `presence`. **Short:** tentacles should twitch between surges so the street never reads dead.

### Space Chess
- **Mood:** cold void, formal board, a king that falls when someone does.
- **Look / sound:** chessboard, floating squares, drifting pawn, white and black kings. Layered bed: void hum
  (`bed: void`) under `music-pit` ambience + theme `music-space-chess`; lifts on last stock / 100%; final-KO sting.
  Kings topple on KO.
- **Size:** flat board with side floats.
- **In / out:** Dead Weight, Cut to Size, Standards and Practices, Lifetime Achievement.
- **Now:** `king-falls` on KO. **Short:** pawn drift should be constant; board needs more idle motion when nobody falls.

### Rainbow Full Pipe
- **Mood:** sunny skate park, ramps and decks, a skater who drops in whether you are ready.
- **Look / sound:** full pipe, grind rail, decks, park trees, Drop In! sign. Layered bed: park chatter tone
  (`bed: park`) under `music-rooftop` ambience + theme `music-rainbow-full-pipe`; lifts on last stock / 100%;
  final-KO sting. Drop In! skater (or quiet affiliate riders).
- **Size:** pipe and decks with vertical play.
- **In / out:** Drop In, Local Affiliate, Crossover Event, Trailer.
- **Now:** `drop-in` skater on a timer (can be silenced with `hazards: 0`). **Quiet routine (Local Affiliate,
  `hazards: 0`):** no Drop In! hitbox, but two silhouette park riders carve the pipe about every 8 s (scenery only),
  denser park chatter and board-scrape beds so the underfunded affiliate still feels busy.

### The booth (not a selectable stage)
- **Mood:** live television from above the card.
- **Look / sound:** announcer calls and Blog Man's too-long headlines as captions and voice; procedural crowd under
  them. ON AIR bug and Tonight ticker on the menu.
- **In / out:** every Versus and campaign fight (not Training, not online).
- **Now:** kinds of call and Blog Man intros exist. **Short:** lines are often caption-only (no take); the booth is
  not a place you can walk into.

### Tonight's Episode (the main menu's nightly card, not a stage)
- **Mood:** the schedule at midnight: a one-night special every viewer gets at once.
- **Look / sound:** a gold-edged card above the campaign with the cast's heads, the rule in one line, Blog Man's own
  recorded episode intro (a button on the card, and again on air in the fight) and a countdown to the next one.
- **In / out:** from the main menu into a normal campaign-style fight on any of the nine stages, back to the results
  with the score, the day streak and the night's board.
- **Now:** picked from the UTC date (`campaign/daily.ts`), scored, streak in localStorage, board on Hawkes Net.
  **Short:** the intro reuses an existing episode line (no new take); no dedicated scene.

### Tour (the main menu's six-fight run, not a stage)
- **Mood:** the network's ladder night: six bouts booked for one fighter, the last against their rival.
- **Look / sound:** the Tour select is a wall of fighter tiles (cleared ones marked with a gold star line); between
  fights the arena's own lower third and the next foe's recorded line over a wide shot; the ending is the fighter's
  win line over the final KO with a gold "<Fighter> clears the Tour" card. The finale is always on the Foundry floor.
- **In / out:** from the main menu into six campaign-style fights on the nine stages, a Continue or Quit panel after a
  loss, back to the Tour select with the mark.
- **Now:** `content/tours.json` (32 routes), `campaign/tour.ts`, `ui/tour.ts`. **Short:** the foes' lines are existing
  takes (no new recorded reaction per fight); no per-Tour music.

### The rival feed (Season 4 only, cutaway)
- **Mood:** a second set of lights across town, same hour.
- **Look / sound:** same stages under a colder grade (cooler grade / second city-light bank in the backdrop or scene
  wash); Orchestrator's booth voice in intros/outros; Hostile Takeover outro ends on a visible static cut (screen tear
  + static sting) when the rival feed dies — not a text crawl.
- **In / out:** Simulcast through Hostile Takeover.
- **Now:** told in lines and fights. **Build:** paint or grade the rival identity (second light bank / colder wash) and
  the static cut so the second network is a place on air, not only a booth voice.

## Landmarks

One landmark per area a fighter can read from the far blast and steer by:

| Area | Landmark |
|---|---|
| Humans In The Loop | The light truss and packed crowd ring under the spots |
| City Top | The water tower on the main roof |
| Yo House | The big fish tank |
| Solar Array | The sun-tracking panel bank |
| Dust Devil Mesa | The wind-carved rock arch |
| Watercolor Nebula | The main paint island at the spiral's center |
| Cursed Town | The street beam over the fog (and the reach below it) |
| Space Chess | The oversized kings at the board's ends |
| Rainbow Full Pipe | The rainbow full pipe and the Drop In! sign |
| The booth | The ON AIR bug (menu) / lower-third "Tonight" card (scenes) |
| Rival feed | A second bank of city lights in the Season 4 lines (not a painted prop yet) |

## Who lives here

### On the card (fighters)
Exit Punk is the champion after Season 1: dry, short-spoken, here for the exit and stuck with the show. The
Orchestrator runs Season 1, fights as the Encore giant, returns as Walk-On, villain-booths Season 4, then splits into
host and walk-on for the finale (one man, two roles). Blog Man covers Season 1 from the front row, hosts from Season 2
on, and sometimes fights (Turn the Page, Clip Show). Walk-ons join the Versus card when their episode clears (`unlock`
in `content/campaign.json`); Season 8–10 reuse nominees and promoters with no new unlocks.

**Wardrobe (colour looks).** Every fighter has four looks in `content/fighters.json` `looks`, drawn by a palette shader on
the same sprite sheets (`src/game/looks.ts`, `render/lookPlugin.ts`). In the show's terms this is Wardrobe: the same
contestant in the network's alternate rig. Look 1 is the fighter as aired; look 2 is open; looks 3 and 4 are earned by
wins with that fighter in any mode (3 and 10, `dod-wins`) and read "3 wins to unlock" on the select card. Outfit looks
turn the fighter's main colour band (skin, eyes and outlines stay); the dark, grey fighters tint their mid-tones
instead. Two of the same fighter in one match never share a look (the second is moved on automatically). Colour is
cosmetic: it is not in the sim, so it never changes a fight; online it rides in the match setup. The VS card and the
results name each fighter's look in a chip.

**Signature specials.** A fighter's Special does four different things by stick direction (neutral, side, up, down),
and a fighter on the card can have its own (`specials` in `content/fighters.json`, `docs/specials.md`). Exit Punk
is the first, and his kit is the one skateboard he walked on with: **Board throw** (neutral, he lobs the deck down
the floor like a bowling lane), **Skate dash** (side, he rides it straight through whoever is in the way),
**Ollie** (up, the pop that gets him back to the ledge) and **Kickflip trap** (down, he flips a board onto the
floor and walks away from it; whoever steps on it eats it). Dry as ever: no one on the show says what the moves
are called.

The other twelve Season 1 fighters each have their own kit, drawn from their blurb and the show, and no two share
the same four kinds (neutral / side / up / down): Kaelen (Hi, bye · Gone · Bye · Slip: a flurry, a dash, a straight
jump, a sidestep counter; gone before the trade lands), Break (Rule one · Hammer fists · House jump · Hold the line:
the command grab, rule one of the house), DJ Won't Read (Sound wave · Scratch · Drop the bass · Rewind: a thrown
sound, quick hits, a counter that plays the hit back), Shutup Bot (Mute · Tank charge · Thrusters · Hush: a
counter, a charge, a command grab; says nothing), Small Weather (Gust · Hailstorm · Front rider · Storm cell: a gust
projectile and a weather trap), Blog Man (Long headline · Scoop · Stop the presses · No comment: a headline that is
far too long and slow, a counter), Evil Blue Bird (Peck · Dive · Flap · Egg: pecks, a dive, a glide, an egg trap),
Got Ur Back (Bear hug · Lean in · Big hop · Got ur back: a hug grab, a shoulder, a protective counter), Slice (Ribbon
cut · Shred · Slice up · Parry: the fastest flurry and a thin fast cutter), SS Boulder (Hurl rock · Crush · Rock climb
· Landslide: a slow thrown rock, a grab, a trap), Stratabots (Plate down · Plate stack · Stack up · Plates up: a plate
trap, a stack of hits, a counter) and the Orchestrator (Baton · Crescendo · Cadenza · Downbeat: a baton counter,
a crescendo orb, a glide, a downbeat trap). Character select lists them by name with a looping clip.

The other twenty fighters have their own kits too, so all 33 play differently and no two share the same four kinds.
Each is the blurb turned into four moves (neutral · side · up · down): Ball Person (Free kick · Slide tackle ·
Bicycle kick · Nutmeg: an arcing ball, a slide, a grab), Cel (Onion skin · Smear · Multiplane · In-betweens: a
see-through orb, a smear dash, a glide, five drawn frames in a flurry), Chooser (Opt out · Pick a card · Rebound ·
Pick up: a counter that declines the hit, a card, a glide), Crosser (Cross counter · Red pen · Reshoot · Final cut: a
slow, heavy counter, three red strokes, a command grab), Crystalline Intelligences (Seed crystal · Refraction ·
Lattice · Facet storm: a crystal laid on the floor, a bent beam, a flurry), Future Man (Fast forward · Montage ·
Jump cut · Next season: a dash, a montage of hits, a trap that arms late and does not say what it is), Lapis Man
(Lapis shard · Planted staff · Vault · Staff parry: the zoner, with a shard, a staff planted in the floor and a
parry), Not an Old Man Yet (Collar · Lawn chair · Back in the day · Not yet: a collar grab, a lawn chair left in
the middle, a counter that says not yet), Pyro Singer (Sparkler · High note · Pyro lift · Pyro cue: the opener's
sparkler flurry, a note thrown across the stage, a flame trap), Shark Dude (Run in · Chomp · Breach · Not a belt: a
dash, a bite that is a grab, a counter for the belt that is not a belt), Slow Rider (Throttle · Tailpipe · Long haul
· Oil slick: a long slow dash, a flame, the longest glide, a slick), Spider Bot (Web · Snare · Rappel · Eight legs:
a web trap, a low grab, an angled climb, a flurry), Susan (Tendril · Drift · Float · Fog patch: a grab from the fog,
a slow orb that drifts for a long time, a fog trap), TT (Withdraw · Shell roll · Spin up · Spike strip: the shell
counter, a heavy roll, a trap), Try Belt (Rewrite · Retakes · Cut away · Tape: a counter that rewrites the hit,
retakes, a tape trap), Uh Me (Hum · Embrace · Drift up · Calm: a hummed orb, a quiet grab, a calm counter), Wallit
(Tip jar · Bat lunge · Pop fly · Buyout: a jar on the floor, a bat lunge, a command grab called the buyout), Yo Bot
(Four-leg grapple · Pop-up · Hover legs · Hits back: a four-legged grab, a pop-up thrown at you, the laptop that hits
back) and Yooba (Gulp · Tongue lash · Squelch · Goo puddle: a long-reach gulp grab, a tongue lash, a puddle). The
Mechanic (Wrench throw · Ratchet · Lift · Clamp) keeps to his wrench and nothing from the show: his origin short is
all he has, and he is still not on the card. Bots use them by kind: a thrown special at range, a trap by the ledge
or on the way in, a dash to close the distance, a counter when the opponent swings, a grab or flurry up close, an
angled recovery aimed at the ledge; the higher the CPU level, the more often.

Routines through a broadcast night: walk-ons wait off-camera until their card; the champion stays on between defenses;
the host reads the sheet; the announcer only speaks once the match is live. Reaction to the player: opponents fight;
hosts and the booth talk about ratings and the card, never "levels" or "the game".

Roster voices in one line each (fighter blurbs are the play feel; story voice stays in `docs/story.md`): Kaelen (Hi.
Bye.), Break (does not plan to fall off), DJ Won't Read (talks), Shutup Bot (only "Fine." when he loses), Small
Weather (brings the weather), Evil Blue Bird / Got Ur Back (Season 1 tag team), Slice (sudden death), SS Boulder /
Stratabots (heavies), Shark Dude (the belt that is not a belt), Pyro Singer (opener and closer), Susan (fog), Wallit
(bought bat), Cel (three extra jumps), Try Belt (rewritten tapes), Crosser (budget cuts), Crystalline Intelligences
(network partner), Uh Me / Yo Bot / Spider Bot / Lapis Man / TT (Sweeps), Ball Person / Chooser / Not an Old Man Yet /
Yooba / Slow Rider (Syndication), Future Man (guest who will not spoil the next season). **The Mechanic:** Foundry
parts and a fixed board in the origin short only — candidate, unused on the show.

**Match barks (Season 1).** Each of the thirteen Season 1 fighters has its own cast voice for in-bout sound, not a
shared scream: 3 short attack efforts (smash / special), 2 hurts (medium and heavy hits), 1 KO cry written for the
character (Break: "Rule one!", Blog Man: a cut-off headline, Shutup Bot: a static burst), and 1 taunt of four words
or fewer from the blurb or story (T / gamepad D-pad up; no touch button). Lines live in `content/voice.json`
(`fighter.<id>.effort.*` / `.hurt.*` / `.ko` / `.taunt`) and play through `audio.fighterVoice` with no two lines from
one fighter overlapping and a 1.5 s effort cooldown. The other twenty fighters keep the shared KO take until their
kits ship. Cold opens that mark `taunt` also play the bark with the arrival bounce.

### Creatures and set life
- City Top: distant fireworks crews; no named mascot on the roof yet.
- Dust Devil Mesa: the hunting hawk (circles, then dives).
- Cursed Town: the Presence under the street (tentacles).
- Rainbow Full Pipe: the Drop In! skater.
- Yo House: robo-vacuum, tank fish, bubbler.
- Humans In The Loop: the studio crowd (goes wild on KO).
- Space Chess: drifting pawn; kings that topple.
- Solar Array: the panels themselves (they track the sun, not the fighters).
- Watercolor Nebula: pigment weather.

They run on their own clocks or on KO. They do not chat; they shove the fight. When a chapter turns hazards off, the
area still needs a quieter routine (crowd bed, wind, fish, pawn drift) so it does not die.

### Booth and city
Narrator (present tense, no jokes), announcer (fight calls), Blog Man (headlines too long), and the city watching
every screen. Season 4 adds the Orchestrator's rival-booth voice. Online players are visitors on the same card with
their own picture and name; the lore does not name them.

## What happens

Per area: several kinds of interaction, events that fire on their own, ambient sound, and what changes over a night
or a season. Fight verbs (move, jump, attack, special, shield, grab, dodge) count as one family; stage life and booth
calls are the others.

### Humans In The Loop
- **Interactions:** brawl on the deck; use cases and wedges as cover height; ride the crowd's KO spike; scene arrivals
  with thud and shake before Ready.
- **On their own:** crowd beds; `go-wild` on every KO (lights and cheer).
- **Ambient:** layered bed (arena murmur + foundry underbed + theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** Encore went quiet once; later seasons light the same floor for defenses, awards and the first finale
  cut. Ratings lines change who hosts.

### City Top
- **Interactions:** roof run-outs, fire-escape and catwalk platforms, edge guards into fireworks KO dressing.
- **On their own:** fireworks on falls; skyline parallax. **Gap:** add a soft timed beat (billboard flicker, distant
  firework volley, or antenna spark) so the roof matches other stages' 10-second rule when players stall.
- **Ambient:** layered bed (night wind/city hum + rooftop underbed + theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** first Open Mic roof returns for title defenses, reboot pilots, the teaser and the last cut of the series.

### Yo House
- **Interactions:** tank and furniture platforms; dodge or ride the vacuum path; bubbler burst as a vertical threaten.
- **On their own:** `robo-vacuum`, `bubbler-burst`; fish should idle-swim between them.
- **Ambient:** layered bed (room tone + quiet drift underbed + house theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** House Heavy's giant Break; sponsor night (Product Placement quota); laugh-track reboot; awards supporting category.

### Solar Array
- **Interactions:** stand on panels that will leave; punish landings when a plate tilts; Red Carpet plays the same
  geometry with hazards off (no scuffed carpet).
- **On their own:** `sun-tracking` on a timer (unless silenced).
- **Ambient:** layered bed (sun glare hum + drift underbed + solar theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** Bad Signal's two-on-one; rival takeover; Dead Air's survive minute; awards carpet with quiet panels.

### Dust Devil Mesa
- **Interactions:** arch control, edge guards into gusts, react to hawk dive warnings.
- **On their own:** `dust-gust`, `hawk-dive`.
- **Ambient:** layered bed (dry wind + drift underbed + desert theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** low gravity night; rerun Ratings; prime-time quota; table-read Ratings.

### Watercolor Nebula
- **Interactions:** island hops, recover through soft gravity nights, weather the pigment rain.
- **On their own:** `pigment-rain`, `nebula-drift`.
- **Ambient:** layered bed (nebula tone + drift underbed + nebula theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** 2v2 with Blog Man; heavy-gravity simulcast; global two-on-one feed.

### Cursed Town
- **Interactions:** stay on roofs; punish anyone who drops to the street; read fog and Presence warnings.
- **On their own:** `fog-surge`, `presence`.
- **Ambient:** layered bed (fog hush + pit underbed + town theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** sudden death at 150%; champion's tax; cliffhanger quota that sets the finale sheets.

### Space Chess
- **Interactions:** board center control, float squares as recoveries, KO for the checkmate sting.
- **On their own:** `king-falls` on KO; pawn should drift always.
- **Ambient:** layered bed (void hum + pit underbed + chess theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** survive heavies; cut-to-size shrink; censored damage; lifetime quota.

### Rainbow Full Pipe
- **Interactions:** pipe and deck control, punish off the lip, dodge the Drop In! skater (or play a quiet park when
  the local affiliate cannot afford effects).
- **On their own:** `drop-in` (optional).
- **Ambient:** layered bed (park chatter + rooftop underbed + pipe theme); lifts on last stock / 100%; final-KO sting.
- **Over time:** Ratings Drop In; quiet affiliate; crossover two-on-one; trailer two-on-one.

### Booth and broadcast shell
- **Interactions:** read the lower-third card; hear announcer kinds (first blood, KO, comeback, last stock, showdown,
  self-destruct, big hit, combo, danger, shield break, hazard, stage-event, time-low, lull); Blog Man intro after Go
  in campaign; pause / settings without leaving the show's voice.
- **On their own:** calls from sim events; menu ticker lines.
- **Ambient:** ducked music (~8 dB) under any voice line, restored over 0.4 s; combat/movement SFX use four takes each
  with no immediate repeat and 5–10% pitch spread; landings follow the stage surface (metal / wood / stone / soft);
  crowd ooh on heavy hits, roar on KOs, rising cheer on comebacks (never the same reaction twice in a row); layered
  stage beds already lift to intense on last stock / ≥100% with a final-KO sting. Procedural sting/alarm/thud when a
  file is missing.
- **Over time:** Orchestrator hosts S1; Blog Man from S2; rival booth in S4; commentary still needs recorded takes for
  many lines. Dedicated ambience loops (not reused music) remain a gap listed in `content/stage-beds.json`.

**Where the live world falls short today:** City Top's soft timed beat (vertical-slice #1); hazard-off nights need the
named quiet routines above (Local Affiliate riders, Red Carpet motor ticks); booth and many Season 3+ episode lines
still silent (captions only — record takes through Hawkes Gen, cents, no GPU); rival feed needs grade + static cut;
fish / pawn / tentacle idle motion is thinner than the timed events; no walkable Foundry hub between bouts (by design
for now — the map and menu are the hub). Vertical slice priority: finish **City Top** to the full bar (landmark already
there; soft timed beat + denser ambient + keep Open Mic's voiced scene) before new stages.

## Story beats

Every beat below is something the player lives in the arena: gameplay, a live scene (fighters drop in, camera on the
speaker, voice take, crowd/sting), a stage event, or a booth call. On-screen text is a last resort (story cards are
one line under the scene, not a text screen). Full episode tables stay in `docs/story.md`; this is the spine agents
must not flatten into paragraphs alone.

1. **Midnight open (Open Mic, City Top).** Furnace floor / city tunes in (narrator voice). Orchestrator introduces a
   walk-on. Exit Punk: four words about the exit. Kaelen: "Hi. Bye." Fight teaches damage and launches. After: crowd
   keeps him on the card (Orchestrator voice + card line).
2. **House rules (House Heavy → Encore).** Giant Break falls anyway; Bad Signal's silent bot only speaks on loss; low
   gravity weather; Blog Man tags in; sudden death; survive the heavies; then the Orchestrator steps onto Humans In
   The Loop as a giant. Broadcast goes quiet — Blog Man and Exit Punk close on voice, not a crawl.
3. **Season end 1.** Narrator end line under the map after Encore: the card is yours. Heard/seen as the map beat after
   the outro, not a paragraph.
4. **Champion defenses (Season 2).** Blog Man hosts with too-long headlines. Title Defense on the clock; Drop In
   Ratings (KOs before the clock, skater drops in); Champion's Tax starts the champ hurt; Sponsored giant Wallit.
   Outro sheet read aloud: one baton, no sponsor — Orchestrator returns next.
5. **Walk-On (Season 3, Humans In The Loop).** Top billing: Exit Punk is the giant; Orchestrator has the extra stock.
   Baton on the floor; "Same time tomorrow?" spoken. Narrator: the show goes on.
6. **Rival broadcast (Season 4).** Second lights in the lines; Cel under heavy gravity; Try Belt Ratings rerun; Crosser
   shrinks the champ; Hostile Takeover two-on-one until the rival feed dies to static in the outro voice. Narrator:
   the show is still his.
7. **Sweeps Week (Season 5).** Cold Open float; Product Placement quota chip and sponsor results line; Dead Air survive
   through signal drop; Clip Show with Blog Man in the fight. Narrator: nobody changed the channel.
8. **Syndication (Season 6).** Quiet pipe affiliate; censored damage; prime-time quota; global two-on-one. Narrator:
   the card travels.
9. **Reboot (Season 7).** Hurt pilots; laugh-track Ratings; crossover heavies; Series Finale clean-streak chip and
   supercut results line. Narrator: the champion was never recast.
10. **Awards (Season 8).** Quiet carpet; supporting two-on-one; lifetime quota; Best in Show streak; Exit Punk's four-word
    speech spoken in the outro. Narrator: the speech was four words.
11. **Cliffhanger (Season 9).** Teaser sheet; trailer voiceover fight; table-read page in the Orchestrator's hand
    (spoken); unresolved song into two sheets, same handwriting. Narrator: two names on the sheet.
12. **Finale (Season 10).** First Cut: host Orchestrator giant on the home set; lights cut to the next shot, not to
    black. Final Cut: walk-on Orchestrator on City Top, champ starts hurt; baton and the exit line spoken. Narrator
    series close: the card is yours, and the show is over.
13. **Booth through every bout.** Announcer calls from real sim events; Blog Man's campaign intro after Go; story cards
    as lower thirds during live arrivals — never a wall of text.

Beats still thin in the build (keep as targets, do not paper over with text): Season 3+ and booth voice takes (hear
them, do not replace with longer captions); City Top soft timed beat; rival-feed colder grade and Hostile Takeover
static cut; Local Affiliate / Red Carpet quiet routines. Do not invent new seasons here — extend `docs/story.md` first.
14. **The pilot (first visit, City Top).** Tap to play opens on the cold open's first shot under the logo; Kaelen hops up
    onto a side platform and poses (the Jump beat), takes a few hits, winds up one slow smash (the Shield beat); the
    crowd, the stage's flicker and the booth carry on as in any Open Mic. Prompts are glyphs over Exit Punk, never
    paragraphs. Win: the main menu says "Next episode".
15. **Tour (every fighter).** Six bouts, the CPU rising, the four twists in the fighter's own order; each foe is heard in
    the arena before their fight; the rival closes it on the Foundry floor. The fighter's own win line plays over the final
    KO under "<Fighter> clears the Tour", and the Tour select keeps the mark.

## Square-ups (added with the pre-fight exchanges)

- **Areas:** the match stage itself, in the seconds between the VS card and Ready. No new area.
- **Landmarks:** the camera push onto each speaker and the lower-third caption (name, one line).
- **Who lives here:** the 32 rival pairs in `content/intros.json`, plus the announcer and Blog Man for the generic six.
- **Characters:** no new character; each speaks with their existing Gen voice id (`content/voice.json` `voices`).
- **What happens:** line, answer, the listener's taunt; crowd ambience and the stage bed play under ducked music.
- **Story beats:** told by voice and camera, one caption line at a time; never a text screen.

## Stage light (fighters stand inside each set)

Every stage lights its fighters with its own colours (`light` in `content/stages.json`, drawn by `render/lightPlugin.ts`,
shadows in `render/fighterLight.ts`). The light is the set's own: City Top's rooftop sunset throws an orange key from the
left with a cold skyline rim on the far side; Space Chess is a cold blue key with a pale rim and a polished floor; Humans
in the Loop is amber stage light with a cyan rim over a glossy studio floor; Cursed Town is a dim grey-green overcast;
the Desert, Solar Array and Rainbow Full Pipe are hard daylight; Watercolor Nebula and Yo House are soft and washed.
Every fighter casts a soft contact shadow on the platform under them that shrinks and fades as they leave it and is gone
above 300 units; glossy floors (Humans in the Loop, Space Chess) add a faint 15% mirror image on High. Low keeps the
ambient tint and the shadow only. No stage is underwater yet; the cold stages are Space Chess and Cursed Town.

## Stage depth (every set opens up as the camera moves)

The broadcast camera pans and zooms with the fight, and every stage is built to show it: pictures sit at their own depths
behind the fighters (`z` in `content/stages.json`, authored as seen from the default camera, so the real perspective gives
the parallax), a **foreground element** stands at the play area's edge in front of them, and a **distance haze** tinted to
the stage veils the far layers. The code is `render/stageArt.ts` (layers, haze, the High-only extras), `render/foreground.ts`
(the fade) and `render/stageLive.ts`; scenario `stage-depth`; test `src/game/test/foreground.test.ts`.

- **Rule:** at least four layers at different depths behind the fighters on High (far sky, far set, mid set, near set),
  three depths on Low (layers marked `high` are the extras and are not built there), plus one foreground element.
- **Foreground element** (`foreground: true`, z below 0, at the main floor's end): turns to 30% opacity while a fighter is
  behind one of its solid pixels, read from the picture's own alpha along the camera's ray (so the parallax counts), and
  eases back when they walk out, and shivers on every KO (a `ko` shake react). It stays on Low. The fog layers of Cursed Town stay silhouette occluders (a fighter in
  the fog shows as a coloured outline), not foreground elements.
- **Haze** (`haze: { color, strength, z }`, High only, dropped on Low): 2 gradient sheets at depths between the layers, clear
  at the top and thickest low where the set meets the floor; the nearer one is lighter.
- **Decks:** every painted platform top lies within 2 units of its collision. `node tools/deck-align.mjs` measures it
  (and `--fix` slides the art; it moved a few units on every stage); the dome of City Top's skylight is curved and stays
  about 8 units proud of its flat platform.

| Stage | Depths behind the fighters (z) | Foreground element (at the edge) | Haze |
|---|---|---|---|
| City Top | backdrop 20, skyline 12, left building 5, escape building 3 | rooftop antenna and vent stack, left | night smog violet |
| Dust Devil Mesa | backdrop 22, buttes 8, hawk 6, dust wall 4 | sagebrush clump, right | dusty ochre |
| Cursed Town | backdrop 20, street 13, tentacles 9, gables and tentacles 4 | a tentacle column rising at the left street edge; fog stays in front | grey-green |
| Humans In The Loop | backdrop 20, crowd 8, spot beams 6, strobes 5, truss 4 | the floor wedges, right | stage-smoke magenta |
| Rainbow Full Pipe | backdrop 20, park 14, clouds 10, trees 6 | the round bush, right | sky blue |
| Solar Array | backdrop 20, canyon 14, plain 10, back panels 6 | foreground rock outcrop, right | sand |
| Space Chess | backdrop 20, nebula 14, galaxy 9, the two kings 3 | the lost pawn drifting, left | nebula blue |
| Watercolor Nebula | backdrop 20, underwash 8, clouds 6, swirl 4 | the front cloud wisp, right | pigment cream |
| Yo House | backdrop 18, kitchen 11, doorway 5, ball and dock light 3 | potted snake plant and monstera, right | morning blue-white |

**Stand-ins to replace:** the extra bands (City Top skyline, Cursed Town street, Rainbow park, Solar canyon and plain,
Space Chess nebula and galaxy, Yo House kitchen) and Cursed Town's tentacle are cut from each stage's own backdrop by
`tools/depth-bands.mjs`: identical pixels at rest, sliding at their own depth under a pan. The finished art is Hawkes Gen's
`image.layers` split of each backdrop plus `image.repaint` for the gaps each cut reveals (not yet made: Gen was out of
credits). **Short:** the foregrounds only shake on KOs (and sway where the art already did), and the cut bands add parallax, not new things to see: crowd heads, a bird, traffic lights crawling are the next layer of life. No stage has crowd heads, cables or kelp painted just for the foreground yet; they use art already on
the stage, moved to the edge.

## Room sound (every stage is its own room)

Each stage sounds like the place it is (`room` in `content/stages.json`; the impulse is made in code by `roomAudio.ts`,
played by `audio.ts`). Effects and voices go 10-25% into the room, never the music or the menus. Humans in the Loop is a
TV studio (short, bright, 0.6 s); City Top a rooftop (open, a 0.2 s slap); Yo House the fish tank, underwater (long,
dark, 1.8 s, with a low-pass over everything); Dust Devil Mesa a canyon (a late slap, 0.45 s); Cursed Town a foggy street
(damp, dark, 0.95 s); Rainbow Full Pipe a half-pipe (bright, metallic, 1.1 s); Solar Array an open field (dry, 0.3 s);
Space Chess a hollow void (cold, 1.4 s); Watercolor Nebula a dream (soft, 1.5 s). Fighters' hits, swings, jumps, landings
and barks sit where the fighter stands on screen (left to right, -0.8 to 0.8); a fighter blasted out of the zone loses
highs and level as they leave, the crowd's roar stays put. The whole match is levelled to -14 LUFS under a limiter.
