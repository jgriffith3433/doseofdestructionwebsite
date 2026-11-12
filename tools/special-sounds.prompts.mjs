const A = {
  projectile: {
    release: ['a rising charge whoosh then a sharp launch crack, a energy projectile fired forward, tight, dry', 'a short wind-up hum and a hard throw release, whipping whoosh flying away, arcade fighting game', 'a bright snapping launch, quick airy whoosh fading into the distance, projectile thrown'],
    impact: ['a projectile smacking a target, a bright crack with a small energy burst, short, dry', 'a sharp splat-crack of a thrown shot hitting, with a zappy sparkle tail, fighting game', 'a hard thwack and fizzling spark burst, projectile impact'],
  },
  dash: {
    release: ['a fast low whoosh of a body rushing forward, a scrape of shoes skidding, short burst', 'a rushing wind swoosh with a quick boost thump, a lunging dash start', 'a sharp sliding scuff and a streaking whoosh, fast charge forward'],
    impact: ['a heavy shoulder-check collision, a thick body thud with a short crunch, dash hit', 'a ramming body slam impact, deep thump and a quick dust crunch', 'a skidding tackle hit, solid slap-thud with a scuff'],
  },
  counter: {
    release: ['a tense metallic ring as a guard stance snaps up, a bright shimmer, ready to parry', 'a quick high chime-like shimmer and a stance whoosh, a counter-stance starting', 'a crisp glassy ping with a faint air rise, a parry window opening'],
    impact: ['a successful parry: a bright metal clang with a ringing reversal sting and a whip-back whoosh', 'a sharp glassy clang, a reflected hit, ringing sparkle tail, counter success', 'a heavy block-clang then a snapping reversal crack, bright ring'],
  },
  grab: {
    release: ['a fast lunging reach, cloth rustle and a hard grasping snatch, short', 'a quick whoosh with a gripping fabric clutch, a command grab starting', 'a low growl-like swoop and a clutching snatch of hands'],
    impact: ['a crushing grip then a heavy throw slam, a body hitting the floor with a deep thud', 'a squeeze, a twist and a big floor slam thump, wrestling throw', 'a bone-rattling slam with a rumbling low boom and a grunting crunch'],
  },
  trap: {
    release: ['placing a device on the floor: a clunk, a click, and a soft arming beep', 'a small object set down with a tick, a mechanical latch and a rising arming tone', 'a quick thud of something dropped, a snap-click arming, tiny blip'],
    impact: ['a trap springing: a sharp snap-clack and a burst pop, a surprise trigger', 'a hidden trap triggers with a loud mechanical clap and a springing boing burst', 'a floor trap detonating with a punchy pop-bang and rattling debris'],
  },
  flurry: {
    release: ['a rapid-fire start of quick light swishes, five fast air cuts in a row', 'a quick flicking series of whooshes, a flurry of fast strikes beginning', 'rapid staccato whip-swishes, a fast multi-hit combo start'],
    impact: ['a rapid string of quick smacks, many light hits stacked with a final heavier crack', 'machine-gun fast thwacks ending in a loud finishing blow', 'a fast flurry of slaps and snaps with a hard final smash'],
  },
  recovery: {
    release: ['an upward rushing whoosh, a leap with rising wind and a short airy lift', 'a rising swoop, a spring-loaded jump and air streaming upward', 'a lifting rocket-like whoosh climbing up fast, an aerial recovery'],
    impact: ['a rising strike hitting from below, a sharp uppercut crack with an airy tail', 'a launching upward hit, a bright pop and a fading whoosh', 'an anti-air smack with a springy lift and a quick snap'],
  },
};
const ACC = {
  'exit-punk': 'a skateboard grinding on a metal rail with a short wheel rattle and a trucks scrape, punk, quick',
  'kaelen': 'a quick teleport blip, a soft vanishing pop with a tiny breathy whisper-like swish',
  'break': 'a heavy hand slap on a table and a house door slam, a firm authoritative thump',
  'dj-wont-read': 'a vinyl record scratch, a wicka-wicka turntable scrub with a bass thump',
  'shutup-bot': 'a burst of radio static and a digital mute click, harsh white noise cut off sharply',
  'small-weather': 'a small thunder crack with a gust of wind and a drizzle of hail pinging',
  'blog-man': 'a frantic burst of keyboard typing and a notification ping, then a send whoosh',
  'evil-blue-bird': 'a sharp bird screech with fast wing flaps and a beak peck tap',
  'got-ur-back': 'a warm bear-hug thump of a big fabric squeeze and a reassuring low hum',
  'slice': 'a razor ribbon slicing air, a bright zing of a thin blade with a shimmery swish',
  'ss-boulder': 'a heavy rock grinding and a stone crumble thud, rumbling gravel',
  'stratabots': 'stacked metal plates clanking together, a rattling clang of layered steel',
  'orchestrator': 'an orchestral baton tap on a stand and a brassy conductor sting with a hall swell',
};
/** Prompts for the special sound set (Gen audio.sfx variants, in order): 7 archetypes x release/impact x 3 takes, then 13 Season 1 accents. See docs/specials.md "Sound". */
export const arche = [], accs = [];
for (const [k, v] of Object.entries(A)) for (const r of ['release','impact']) v[r].forEach((t,i)=>arche.push({id:`special-${k}-${r}`, i, text:t+'. One-shot.'}));
for (const [k,t] of Object.entries(ACC)) accs.push({id:`special-accent-${k}`, text:t+'. Short one-shot, under one second.'});
