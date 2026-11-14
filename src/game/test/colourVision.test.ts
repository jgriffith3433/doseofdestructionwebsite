import { PALETTES, PLAYER_COLORS, SHAPES, TEAM_COLORS, colourVision, setColourVision, shapeOf } from '../colourVision.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error('FAIL', m); } };

ok(new Set(SHAPES).size === 4, 'four distinct shapes');
ok([0, 1, 2, 3].every((i) => shapeOf(i) === SHAPES[i]), 'one shape per slot');
ok(colourVision() === 'standard' && PLAYER_COLORS[0] === '#ff5a1f', 'standard by default');
setColourVision('safe');
ok(colourVision() === 'safe' && PLAYER_COLORS.join() === PALETTES.safe.players.join(), 'safe swaps the live array');
ok(TEAM_COLORS[0] === '#d55e00', 'teams follow');
ok(new Set(PLAYER_COLORS).size === 4, 'four distinct colours');
setColourVision('standard');
ok(PLAYER_COLORS.join() === PALETTES.standard.players.join(), 'back to standard');
if (fails) process.exit(1);
console.log('colourVision ok');
