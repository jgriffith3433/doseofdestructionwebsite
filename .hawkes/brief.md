# Work for Dose of Destruction

You are building something new in Dose of Destruction (Dose of Destruction: a Vite/TypeScript web fighting game (dist/Game) with its site (characters, stages, audio), published to GitHub Pages (doseofdestruction.com).).


## Player goal

Dose of Destruction no longer loses a harsh player on clarity: it reads 7/10 or better against Super Smash Bros. Ultimate.

Reference (a best-in-class game, and the moment to match): Super Smash Bros. Ultimate, the moment at frame a_2ae5a5d608566a12, t=25.5s.
Critic axis (what the critics will judge this on): core-loop
On a phone (390x844, touch): the fix shows at 390x844 on touch with no sideways scrolling and every tap target about 44 px.

The work is done when a player sees this on beta, not when the code compiles.

## What J asked for

Player goal: Dose of Destruction no longer loses a harsh player on clarity: it reads 7/10 or better against Super Smash Bros. Ultimate.
Reference: Super Smash Bros. Ultimate, the moment at frame a_2ae5a5d608566a12, t=25.5s.
Critic axis: core-loop
Phone: the fix shows at 390x844 on touch with no sideways scrolling and every tap target about 44 px.

Bring clarity up to 7/10: Shrink the ROUND START banner and fade it in under 1 s. Add a brighter outline or rim light to the fighters so they stand out from the background.

Original request:
[critic:clarity] Critic's review of Dose of Destruction (ledge-options): clarity scored 6/10, target 7/10.
Evidence (frame a_2ae5a5d608566a12, t=25.5s): The damage % HUD with stock pips and P1/CPU tags read instantly. The fighters are tiny against the busy skyline, and the Round Start banner covers them.
Reference game: Super Smash Bros. Ultimate
Fix the critic named: Shrink the ROUND START banner and fade it in under 1 s. Add a brighter outline or rim light to the fighters so they stand out from the background.

Work out what that means in this project (read the story doc and AGENTS.md), make it well, and keep it consistent with
the product's tone and style. If it's too big for one change, do a solid first part and say what's left in the summary.

## GPU budget: none

Nothing here was approved for GPU generation (images, video, music, 3D on the fleet). Do everything that needs no GPU
(design, data, specs, Claude-only steps, voice and sound effects are fine: cents each), price the GPU part with
`hawkesgen_estimate`, and end with that estimate in your summary so J can approve it. Never start a GPU server.

### Can GPU work run now? Studio has already decided

GPU work can run now: no AWS fleet is set up, and Gen sends GPU jobs to its other providers (RunPod, Modal); the Studio org's Gen credit balance is unknown. (read 19:30 UTC)

- `hawkesgen_fleet` reports only Hawkes Gen's AWS servers. "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not in
  hawkesgen/.env" with servers [] means AWS isn't set up, nothing more: Gen sends GPU jobs to RunPod and Modal. It is NOT
  "the GPU fleet is down". Don't pause, wait or stop for it, and don't re-decide GPU availability from it; queue the job.
- A "paused" or "wait until the fleet works" note left by an earlier pass (a .hawkes/summary.md, a memory) is not a
  decision by J. Only an owner answer recorded in this brief is. If a job really is refused (402, no provider), say that
  error in the summary and stop; Studio parks the task on it.

## Acceptance criteria (how this is judged)

The change is ready once your checks pass and its pull request is open; after it is merged into beta, beta's playtest
judges these, and the work is done only when every one of them passes there:
1. The next critic review of Dose of Destruction scores clarity at 7/10 or higher (it was 6/10)
2. Within one playtest of ledge-options the fix shows: Shrink the ROUND START banner and fade it in under 1 s. Add a brighter outline or rim light to the fighters so they stand out from the background.
3. [phone] On a 390x844 touch playtest the change shows with no horizontal scrolling and every control reachable by tap

Criteria starting with "[phone]" are judged on a 390x844 touch playtest (beta plays them apart from the rest), so the
scenario must play them through touch input (taps and drags, no mouse or keyboard), and the layout must work at that size.

Where the game implements the playtest contract (`window.hawkesPlaytest`: see this project's AGENTS.md, and the spec
at `hawkesstudio/docs/playtest.md` next to this repository), add or extend a scenario that plays to what the criteria
describe (through real input, no teleporting; named setup shortcuts are fine) and logs events or checks that show each
one, so the review can judge them from the footage and the timeline. Write that scenario's name (one line, e.g.
`checkout`) in `.hawkes/scenario.txt`: beta's playtest plays it (and this change's, when J asks for one). To play specific content
(a new stage, level or enemy), add a second line with the scenario's options as JSON, e.g. `{"stage":"neon-pit"}`. Without a contract, make
sure each criterion can be seen when the page is played.





## This kind of work (feature)

- Build it to the full quality bar the first time: no placeholder art, grey boxes, stub content or "TODO" UI. Make
  art, sound and voice with Hawkes Gen (within the budget this brief gives), and wire them in.
- It has to feel good, not only work: in a game, the camera and controls rule below holds for anything a player moves or sees.
- Done means a player can use it end to end and a playtest shows it: add or extend a playtest scenario that plays it
  through real input.

## Skills to load (feature)

Load these skills (the Skill tool) before you plan or build; they are this studio's craft for feature work:
- `studio:story-through-play`: every named character has a want, an arc, the gameplay moment that shows it, three personality words, a Gen voice id and an idle, walk and talk animation set; story told by events and voice, not text
- `studio:level-design`: build gaps, ledges and corridors from the measured numbers in docs/metrics.json (jump height and distance, run speed, corridor widths)
- `studio:game-feel`: coyote time and jump buffer of at least 80 ms, hit-stop of at least 40 ms, a short screen shake
- `studio:ui-kit`: menus use the Hawkes UI kit (hawkes-ui.js createUiKit, Unity HawkesUI): pressed, hover and focus states, a ui-bus click on every press, 150-200 ms screen slides (0 ms with reduced motion), safe-area containers, 44 px targets, one ui-press per press (docs/ui-kit-skill.md if the skill is not loadable)

## Other agents on Dose of Destruction

Up to 2 agents work on Dose of Destruction at once, each on its own branch from beta. Another agent may merge into beta
while you work, so keep your change narrow: touch only the files your task needs, and don't reformat, rename or move
shared files. Running now:

- c_7c008a99aeb0 (working): story through play 3/10 (target 7): Write a short world bible. Let the opening fight itself carry the story, with Future. Asked: "Player goal: Dose of Destruction no longer loses a harsh player on story through play: it reads 7/10 or better against Mortal Kombat. Reference: Mortal Kombat, the moment at frame a_978e57076d27d61c, t=19.7s. Critic axis: story Phone: the f..."
  Files touched so far: none yet

Stay out of the files they touch where you can; where you can't, keep your edit there small and say so in your
summary.

## Game quality rules (every game, every change)

These hold for every change to a game, whatever the task says. Breaking one fails the change: Studio scans what you
touched before your pull request opens and sends you back with what it found, and a playtest that shows a broken rule
fails, so the change doesn't merge and the game doesn't go live. The full guide, with probes and fixes for Unity and
the web, is the game-quality skill (load it before building anything a player sees).

1. **In-world text reads the right way round.** Unity's 3D text reads correctly only when it faces away from the camera. Pointing it straight at the camera, or giving it a negative scale, mirrors it.
   - A billboard sign copies the camera's rotation (transform.rotation = camera.transform.rotation); it never calls LookAt(camera) on text.
   - Never use a negative scale on text, or on anything that holds text.
   - Checked by: Text (TextMesh, TextMeshPro) whose scale, or a parent's, mirrors it. (Studio's scan, before your pull request) A script on text that calls LookAt on the camera without turning it round. (Studio's scan, before your pull request) A screenshot of every in-world sign: each one reads left to right. (the playtest)
2. **No z-fighting and no models clipping through each other.** Agents stack separate walls, floors and ceilings so two surfaces sit in exactly the same place, and a tiny camera near distance makes even slightly separated surfaces flicker.
   - Rooms snap to a grid: walls sit on top of the floor and meet at corners without overlapping; no two surfaces share a plane.
   - The camera's near distance is 0.05 or more (Unity nearClipPlane, Babylon minZ, three.js near); 0.1 to 0.3 for a third-person camera.
   - Props and characters never overlap other meshes; colliders match the visible shape.
   - Checked by: A camera near distance under 0.05. (Studio's scan, before your pull request) Two copies of the same mesh at the same position, rotation and scale. (Studio's scan, before your pull request) Two frames from a slightly moved camera: surfaces that swap or flicker. (the playtest) Models poking through each other, the player or the camera inside a wall or floor. A hard limit: one sighting fails. (the playtest)
3. **No inside-out models.** AI-made 3D models often come out with faces flipped, and mirroring with a negative scale or mixing up glTF and Unity axes flips them too, so you see the back of each face.
   - Every model goes through one cleanup step on import (and Hawkes Gen's 3D export) that points normals outward and bakes in any mirroring.
   - Mirror a model by making a mirrored copy of the mesh, never with a negative scale on its object.
   - Checked by: A glTF or GLB model whose faces mostly point inward. (Studio's scan, before your pull request) A mesh object (Unity scene or prefab, glTF node) with a mirroring negative scale. (Studio's scan, before your pull request) A model that looks inside out on screen. (the playtest)
4. **Buildings and props sit on the ground.** Agents drop models at guessed coordinates without checking the ground height or where the model's base really is, so buildings sink into the ground and props float.
   - Every building and prop is placed by finding the ground below it (a raycast or the terrain's height) and lining up the bottom of the model's bounds, not its center or pivot.
   - Placement runs again whenever the terrain changes.
   - Checked by: A ground-contact scan of every scene: anything sunk more than 5 cm into the ground, or floating more than 2 cm above it. (the playtest) Buildings or props that look sunk or floating on screen. (the playtest)
5. **Animation holds up over time.** Playtests that take snapshots miss what goes wrong between frames: a landing decided only when falling speed hits zero never happens on a slope, and walk and run animations played at a fixed speed slide on the ground.
   - Landing uses a ground check that allows for slopes (a short spherecast or the controller's isGrounded), and every animation state has a way back out.
   - Measure how fast each walk and run animation really moves and match playback speed (or a blend) to the character's actual speed.
   - The playtest scenario jumps onto slopes of 10 to 40 degrees and ramps walk to run and back, logging state, grounded, speed and foot movement every frame.
   - Checked by: The character stays in a jump or fall state while on the ground for more than 0.3 seconds. (the playtest) A planted foot slides along the ground. (the playtest)
6. **A game is a full, living world with soul, not a demo.** A game is an entire world: it needs character and soul, very little empty space, room to breathe and many kinds of interaction. Story is told through gameplay, real in-game events, cutscenes, sound and voice, not text.
   - Plan before building: each game has a world bible (docs/world-bible.md) covering its areas, landmarks, who lives there, what happens in each place, and the story beats as events, and it is checked before any code.
   - Build a vertical slice first: one area finished to the full bar (dressed, a landmark, life, ambient sound, several kinds of interaction, a story beat told as an event) before widening.
   - Full world: a player never walks more than about 10 seconds without something to see, hear or do. Every area has dressing, a landmark, life, ambient sound and several kinds of interaction.
   - Breathing: things move and change on their own, like characters' routines, weather, wind and reactions to the player.
   - Story as experience: every story beat happens through gameplay, in-game cutscenes with real events, sound effects and Hawkes Gen voice lines. On-screen text is a last resort, one line at most; a beat told only in text fails.
   - Checked by: A world bible that is added or changed has every section: Areas, Landmarks, Who lives here, Characters, What happens, Story beats. (Studio's scan, before your pull request) Every named character in the bible's Characters section has a want, an arc, the gameplay moment that shows it, three personality words, a Gen voice id and an idle, walk and talk animation set. (Studio's scan, before your pull request) The playtest walks each area and times the gaps between things to see, hear or do: none longer than 10 seconds. (the playtest) Story text counted against voiced and acted beats: no beat told only in text. (the playtest) How empty each area looks: bare floors, nothing alive, nothing to do. (the playtest) The fun reviewer's verdict on a played build: a living world, or a demo. (the fun review of a played build)
7. **The camera and controls feel right.** What makes a game feel cheap is mostly felt, not seen in a still: a camera that clips into walls, snaps or shakes, controls that answer late, a jump that fails just after the edge, stutters. The numbers here are industry starting values; each game tunes its own and reports them.
   - Input to a visible response in under 100 ms: movement and actions start on the frame the input arrives, never after an animation finishes.
   - Jumping games: coyote time of 80 to 150 ms (a jump still works just after running off an edge) and a jump buffer of 100 to 150 ms (a jump pressed just before landing happens on landing).
   - Combat games: hit-stop of 50 to 100 ms on heavy hits, with short, small screen shake.
   - The camera never clips: it pulls in ahead of walls (a sphere cast from the target to the camera, radius at least the near distance) and never shows the inside of geometry.
   - The camera never snaps or jitters: smooth, critically damped follow with a capped turn rate. An intended cut, respawn or teleport tells the playtest (hawkesPlaytest.cut()).
   - No frame over 250 ms during play: load and stream content off the main thread.
   - Report the tuned values as playtest metrics, e.g. run.metric('feel.coyoteMs', 120), run.metric('feel.jumpBufferMs', 120), run.metric('feel.hitStopMs', 70); the feel sensor measures input latency, camera clipping and hitches itself.
   - Checked by: The camera inside or behind a wall or floor (the feel sensor's camera-blocked). A hard limit: one sighting fails. (the playtest) The camera snaps, jumps or shakes between frames outside an intended cut. A hard limit: one sighting fails. (the playtest) The player or camera jitters back and forth, or collision shoves the player. (the playtest) Input to visible movement, measured by the feel sensor: under 100 ms. (the playtest) Frame hitches during play: no frame over 250 ms. Loading, title and menu screens and a scene's first seconds are load stutter, a note, not a fail. (the playtest) Stutters the recording shows (the review's video freezes): none over 250 ms. Advisory: the recorder can stall on its own, so it is a note unless the game's own frame timings agree (the hitch check). (the fun review of a played build) docs/metrics.json records jump height, jump distance, run speed and corridor widths as numbers, and the game-feel defaults: coyote time and jump buffer at least 80 ms, hit-stop at least 40 ms. (Studio's scan, before your pull request) Jumping games report their coyote time: at least 80 ms. (the playtest) Jumping games report their jump buffer: at least 80 ms. (the playtest) Combat games report their hit-stop: at least 40 ms on heavy hits. (the playtest) The explore bot (hugging walls, jumping edges) never falls through or out of the world. A hard limit: one spot fails. (the playtest) The explore bot never gets stuck on geometry it can't escape by sliding, jumping or backing out. (the playtest)
8. **A stranger is playing within 20 seconds and succeeds within a minute.** Vampire Survivors fires the first weapon before anything is read, and CrazyGames' bar is 20 seconds to gameplay: a stranger who opens a game cold leaves if the terms, sign-in or menus come first, or if the screen is a wall of words. Developer panels or debug controls on a public page read as an unfinished game.
   - Gameplay within 20 s of the page opening, first input accepted within 30 s, first success (a kill, a score, a solved step) within 60 s, on a desktop and on a 390x844 phone.
   - At most 2 taps from the first screen to play: no terms wall, sign-in wall or menu chain before the game; ask for sign-in only when it is needed (to save), after the player has played.
   - At most 40 words on screen in the first minute: teach by doing (the first weapon fires on its own, the first obstacle shows the jump), never by paragraphs.
   - No developer or debug UI visible on a public page (FPS counters, level pickers, cheat panels, dev menus, 'debug' buttons): ship them behind a flag that is off, never in the live build.
   - Report the moments from the game's own bot where you can: t.milestone('gameplay'), t.milestone('first-input-accepted'), t.milestone('first-success'), t.milestone('tutorial-step:<name>') (hawkes-playtest.js, docs/playtest.md#first-five). The built-in first-five scenario plays the live page cold for 5 minutes and measures the same things from what is on screen.
   - Checked by: Seconds from opening the public page cold to gameplay: at most 20. (the playtest) Seconds to the first input the game accepts: at most 30. (the playtest) Seconds to the first success: at most 60. (the playtest) Taps or clicks from the first screen to play: at most 2. (the playtest) Words on screen in the first minute: at most 40. (the playtest) Developer panels or debug controls visible on the public page. A hard limit: one sighting fails. (the playtest)
9. **No silent jump, no clipping mix, no identical sample twice.** Celeste and Hades answer every input with a sound within a frame and never repeat the same sample twice; PlayStation's mobile target is -18 LUFS (±2, we allow ±3) with true peak at most -1 dBTP. A silent action, a clipping mix or a looping identical take reads as unfinished.
   - Every player action (jump, attack, confirm, cancel, UI click) plays a one-shot within 150 ms of the input.
   - Mix to about -18 LUFS integrated (±3) with true peak at most -1 dBTP; limit masters, don't clip.
   - Footsteps and repeated oneshots use a small pool so the same buffer+rate never plays twice within 60 s.
   - When voice plays, duck the music bus by at least 6 dB and restore it after.
   - In play (not menus or loading) never leave more than 10 s of silence without ambient, footsteps or reactive SFX.
   - Web and Unity WebGL: the playtest audio probe (hawkes-audio.js) taps WebAudio; tag sources with __hawkesSampleId / __hawkesBus when the auto id is wrong.
   - Checked by: Integrated loudness near -18 LUFS (±3). (the playtest) True peak at most -1 dBTP. (the playtest) An input with no sound start within 150 ms. A hard limit: one silent action fails. (the playtest) The same sample at the same rate twice within 60 s. A hard limit: one repeat fails. (the playtest) Music ducks at least 6 dB under voice. (the playtest) Longest silence in play at most 10 s (menus and loading excluded). (the playtest)
10. **Every control is big enough, in reach, on screen, and answers a press.** Apple's HIG asks for 44 pt targets and Material for 48 dp; Poki rejects games whose phone UX confuses; Hades' menus answer every press within a frame. On a phone a 30 px button, a control under the notch or home bar, one off the edge of a landscape screen, or a button that does nothing you can see or hear reads as a broken game.
   - Every control is at least 44x44 px (CSS px) with at least 8 px between neighbours; make a small picture a big target with padding, never leave the hit area at the picture's size.
   - Keep controls clear of the notch and home bar (env(safe-area-inset-*) with viewport-fit=cover; Screen.safeArea in Unity) and inside the thumb zone: the main actions low on the screen, near the bottom corners.
   - Everything is on screen and usable at 390x844 portrait and at 844x390 landscape; nothing runs off an edge.
   - Every press shows a pressed state at once and the result within 100 ms, and plays a UI sound within 150 ms. No dead buttons, no silent buttons.
   - Web games: the playtest UI probe (hawkes-ui.js) reads the DOM; canvas and Unity UI report rects (t.ui(rects) or the Unity UiRects reporter) and presses (t.uiPress).
   - Checked by: Controls under 44 px (390x844 and 844x390). A control counted once per orientation. (the playtest) Controls under a simulated notch, Dynamic Island or home bar. (the playtest) Controls partly or wholly off the screen at either orientation. (the playtest) A press with no visual change within 100 ms. (the playtest) A press with no sound start within 150 ms (the audio probe's events). (the playtest) The fun reviewer comments on the menu screens it sees: size, reach, safe areas, feedback, and whether they look like this game's own. (the fun review of a played build)
11. **A mid-range phone over mobile data is playing within 20 s and stays smooth.** CrazyGames' mobile homepage bar is at most 20 MB and 20 s to gameplay; Poki's Cannon Clash case shows a fast first load wins. A phone playtest that only checks layout at 390x844 misses a mid-range CPU and Slow 4G, so a heavy first payload ships unnoticed.
   - Keep the payload before gameplay at most 20 MB transferred: defer non-critical assets, compress textures and audio, code-split, and start play before secondary downloads finish.
   - Reach gameplay within 20 s on a mid-range phone over Slow 4G (the phone twin: Gen applies CDP 4x CPU throttling, Slow 4G and DPR 2 at 390x844 touch).
   - Hold fps p5 at least 30 during play under that throttle; report the dip time when it drops.
   - Every phone playtest reports phone.mbBeforeGameplay, phone.secondsToGameplay and phone.fpsP5 (src/phoneperf.ts). A miss files a finding naming the five largest pre-gameplay assets, or the clip time of the fps dip.
   - Checked by: Megabytes transferred before gameplay on a throttled phone run: at most 20. (the playtest) Seconds to gameplay on a throttled phone run: at most 20. (the playtest) fps p5 during play on a throttled phone run: at least 30. (the playtest)

Before feature or content work: read `docs/world-bible.md` and build to it (add to it when your work adds an area, a
character or a story beat). No world bible yet and your task adds areas, characters or story: write it first (the
game-quality skill has the template), commit it, then build. Before you finish work a player will see, ask the
studio:fun-reviewer subagent to look at what you made against these rules, and fix what it calls a demo.

## Studio's tools, and Talk

You have Studio's own tools, the same ones Talk has (the `hawkesstudio` MCP server): the backlog, reports, playtests,
previews, the roadmap, the other projects, deploy plans. Read whatever helps. `studio_task` starts work in another
project (up to 3; work you start can't start more). Going live, rollbacks and Approve cards stay the owner's.
To tell the owner something while you work (a result, a question you can carry on without), use `studio_tell`: it goes
to Talk, which passes it on. A question you can't go on without still goes in `.hawkes/question.md` (see above).
GitHub: `studio_github_api` makes REST calls to any of this Studio's repos with Studio's own token (issues, pull
requests, Actions runs and logs, search, branches of your own). There is no GitHub token in your shell, so use it
instead of `gh` or `curl`. Merging and approving stay with Studio's gates.

## Files from Hawkes Gen

To put a file from Hawkes Gen into this repo (an image, a sound, a model), call `studio_gen_import` with its asset id
(`a_...`) and the path in the repo; give `width`/`height`/`format`/`quality` to resize or convert an image (Gen does it,
free). It writes the file for you: no download, key or converter needed. Then commit it.
It takes files from this Studio's own Gen library and from its owners' own hawkesgen.ai libraries.

## The Studio's other repositories (read-only)

Shallow clones of the other projects' repositories, to read (not to change: a change there is that project's own task).
They are cloned in the background after you start, a few at a time, so each appears as it lands: read one only once its folder has a `.ready` file
(`ls <folder>/.ready`); a folder with none is still being cloned, and a repo that never appears could not be copied (carry on without it):
- `jgriffith3433/hawkesstudio`: `../c_203ced51427a.repos/hawkesstudio` (ready when `../c_203ced51427a.repos/hawkesstudio/.ready` exists)
- `jgriffith3433/breakingthrough`: `../c_203ced51427a.repos/breakingthrough` (ready when `../c_203ced51427a.repos/breakingthrough/.ready` exists)
- `jgriffith3433/icanbeaiwebsite`: `../c_203ced51427a.repos/icanbeaiwebsite` (ready when `../c_203ced51427a.repos/icanbeaiwebsite/.ready` exists)
- `jgriffith3433/hawkesbiomedical`: `../c_203ced51427a.repos/hawkesbiomedical` (ready when `../c_203ced51427a.repos/hawkesbiomedical/.ready` exists)
- `jgriffith3433/imaginelivetvwebsite`: `../c_203ced51427a.repos/imaginelivetvwebsite` (ready when `../c_203ced51427a.repos/imaginelivetvwebsite/.ready` exists)
- `jgriffith3433/sickofitgame-unity`: `../c_203ced51427a.repos/sickofitgame-unity` (ready when `../c_203ced51427a.repos/sickofitgame-unity/.ready` exists)
- `jgriffith3433/hawkesnet`: `../c_203ced51427a.repos/hawkesnet` (ready when `../c_203ced51427a.repos/hawkesnet/.ready` exists)
- `jgriffith3433/hawkesnet-js`: `../c_203ced51427a.repos/hawkesnet-js` (ready when `../c_203ced51427a.repos/hawkesnet-js/.ready` exists)
- `jgriffith3433/hawkesnet-babylon`: `../c_203ced51427a.repos/hawkesnet-babylon` (ready when `../c_203ced51427a.repos/hawkesnet-babylon/.ready` exists)
- `jgriffith3433/hawkesnet-unity`: `../c_203ced51427a.repos/hawkesnet-unity` (ready when `../c_203ced51427a.repos/hawkesnet-unity/.ready` exists)
- `jgriffith3433/sickofitgamewebsite`: `../c_203ced51427a.repos/sickofitgamewebsite` (ready when `../c_203ced51427a.repos/sickofitgamewebsite/.ready` exists)
- `jgriffith3433/hawkesgen`: `../c_203ced51427a.repos/hawkesgen` (ready when `../c_203ced51427a.repos/hawkesgen/.ready` exists)
- `jgriffith3433/YoobaLand`: `../c_203ced51427a.repos/YoobaLand` (ready when `../c_203ced51427a.repos/YoobaLand/.ready` exists)
- `jgriffith3433/hawkesgenwebsite`: `../c_203ced51427a.repos/hawkesgenwebsite` (ready when `../c_203ced51427a.repos/hawkesgenwebsite/.ready` exists)
- `jgriffith3433/phoriginswebsite`: `../c_203ced51427a.repos/phoriginswebsite` (ready when `../c_203ced51427a.repos/phoriginswebsite/.ready` exists)
- `jgriffith3433/YoobaLandGame`: `../c_203ced51427a.repos/YoobaLandGame` (ready when `../c_203ced51427a.repos/YoobaLandGame/.ready` exists)
- `jgriffith3433/theplacedepartmentwebsite`: `../c_203ced51427a.repos/theplacedepartmentwebsite` (ready when `../c_203ced51427a.repos/theplacedepartmentwebsite/.ready` exists)
- `jgriffith3433/hawkes-analytics`: `../c_203ced51427a.repos/hawkes-analytics` (ready when `../c_203ced51427a.repos/hawkes-analytics/.ready` exists)

## What the studio already knows (shared memory)

Earlier agents, J and Talk learned these; follow decisions and preferences, respect canon, and use the lessons
(unconfirmed ones are an earlier agent's notes: check them). More: memory_search, if you have the tool.
- [decision] Replace all GPU-off stand-ins with Gen art: Place Department (Unity), Yooba Land, Hawkes Games: 2026-11-07: J approved all three stand-in replacement items, including GPU budgets (cap about $84 total across 16 tasks, per-task budgets set from hawkesgen_estimate incl. idle tail). Items: i_8935d13bf43e (place-department-unity: kit textures, skies, portraits, UI, Registrar/Plated Alpha, then other bosses/lodgers/~10 landmark kit pieces; keep the other ~150 kit pieces code-built for triangle/te… (m_142d9f54d4cf)
- [decision] No polling: use server push or on-demand fetches: In every product (Studio, Gen, sites, games): never add setInterval/setTimeout loops that fetch. Use a server push stream (SSE: Studio's /api/stream, Gen's /v1/events) or fetch on page open, user action or event. An idle page makes zero requests. Polling through the Cloudflare edge workers burned 100k requests on 2026-11-01. A poll that truly can't be avoided needs a written reason in the PR. (m_4f6d1382b804)
- [decision] Agents must do quality work: design spec first, un-cheatable criteria, vertical slices, forbidden shortcuts, playtest of the experience: After the Place Department campaign came out as the wave game with a text intro, J approved the whole quality plan: (1) a design-spec step (docs/*.md, player fantasy, structure, new vs reused, distinct layouts) before any big build; (2) acceptance criteria a reskin can't pass (observable: different map, no wave timer, explore/talk/pickup before combat); (3) vertical slices (one playable slice, re… (m_7a31fee7272a)
- [preference] Roadmap planning: go deep, aim AAA, don't ask first: For roadmap and milestone planning J wants depth and AAA ambition on story and polish, and no confirmation questions first. Plan and add; report afterwards. 2026-11-06: 19 milestones and 95 items added (5 per project) from backlog findings, memory and project descriptions. (m_7f0b957f00bf)
- [preference] No caching changes for now (Jaycee, Nov 1): Jaycee said on 2026-11-01: "I don't want you to mess with caching right now." Don't add or change Cache-Control, edge/Worker caching or CDN cache rules in any product until they lift this. Internal services must not go through Cloudflare. Gen task k_36c3244487d8 (edge cache for the dashboard) was parked as idea on 2026-11-07 for this reason. (m_92901cfcc7df)
- [preference] Resume GPU playtests after RunPod top-up: J confirmed credit added after balance was $-0.06: resume GPU playtests. Inbox subject runpod-playtest-credit. (m_c75e4ff4a9c1)
- [preference] PM Agents at once matches Agents (6): Keep PM maxConcurrent at 6 to match Agents so the PM does not hold roadmap starts when Agents are at their cap. Decided on q_5303ed2e266e: Raise PM to 6 (match Agents). (m_c7eed6bec5c4)
- [preference] Org Gen wall: pause until fleet works — do not requeue or mark stand-ins done: When Gen credits are 1 and/or hawkesgen/.env lacks AWS keys, apply J's Pause until Gen fleet works (q_25923ead3331). Covers painted island, B3 wet maps, power SFX, day soundscapes, Yooba homecoming + landmarks. Keep pending-gpu; resume when fleet + credits allow. Do not file repeat 3-run Inbox cards for the same wall. (m_f60905657340)
- [preference] Exhausted conflict passes: prefer leave if already on beta: When J says use your judgement on try-again vs close after conflict passes, leave the change if it already merged/built on beta; otherwise one more conflict resolve before close. (m_086b26a2df3f)

## How to work

1. Read `AGENTS.md` (and any docs it points to) before changing anything. Follow its rules.
2. Read the story doc, the world bible and the code it touches. Plan it, then build it.
3. Keep to this request. Don't refactor unrelated code, don't touch generated output or build folders, don't change secrets, CI, or deploy scripts.
4. Run the project's checks:
- `npm ci && npm run typecheck && npm test` (in the repo root)
   If .hawkes/beta-build.md is in your worktree, beta's build was red when Studio last looked: read it first, keep your change from adding to those errors, and say in the PR what you saw.
   Before the pull request, also run the project's build or compile check where you can, and say in the PR description which you ran and which you could not (and why).
   Build `site`: run `export DOD_BUILD_COMMIT=$(git rev-parse HEAD) && rm -rf .git videos && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules && cp -alf index.html characters.html privacypolicy.html whatsnew.html releases.json favicon.svg site characters audio stages dist/` if it can run here.
5. Commit your change with a clear message (`Add: ...`). Don't push; Studio does. Studio stops a pass after
   90 minutes: commit as you go (after each working piece or finished batch), so a stop loses nothing.
   A third-party error from a Gen job (ElevenLabs payment_issue, a 401 or 402) is not yours to retry: test ONE line
   first for voice work, and on that error stop at once, write `.hawkes/stuck.md` naming the service, and end.
6. Write `.hawkes/summary.md`: what was wrong, what you changed (files), how you checked it, and anything J should
   look at. If you couldn't fix it, explain why there instead, and don't commit.
   Two approaches, then stop: when two different approaches haven't worked (the checks still fail, or you can't find
   the cause), don't keep iterating. Write `.hawkes/stuck.md` (what you tried, what happened, where you think the cause
   is) and commit nothing that doesn't work: Studio gives the next attempt a bigger model, with your notes.
7. Write `.hawkes/try.md`: how J tries it on the beta site, in two to five short steps a player would follow (where to
   go, what to press, what he should see).
8. If you can't go on without a decision that the request, the criteria and the thread don't settle (a real direction
   choice, not a detail you can decide well yourself), write ONE clear question to `.hawkes/question.md` (the options
   you see and the one you'd pick), commit nothing, and stop. Studio gets you the answer and you continue in this same
   session.
9. Before you finish, write `.hawkes/learned.md`: what the next agent working on this project should know that
   isn't obvious from the code (at most 5 lines, only real knowledge: a trap you hit and how you got past it, how a part of
   the codebase really works, a check that matters). One per line, in this form:
   - lesson: <short title> — <what broke or misled you, and the fix>
   - convention: <short title> — <how this codebase does it>
   Write nothing there if you learned nothing new. Studio keeps these in the shared memory for the next agent.

## The product's story (for tone and intent)


