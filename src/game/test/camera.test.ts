// Headless check of the match camera (render/cameraRig.ts) against real bot matches, stepped at 60 frames a second
// the way the renderer does it, kill cues included (punch-in and slow motion):
// 1. no frame moves or zooms past the jump threshold (cameraJumps stays 0),
// 2. every living fighter inside the blast zone is on screen, feet and all, in every frame (framingMisses stays 0).

import { FX } from '../sim/fixed.ts';
import { CHARACTERS } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { ACT, newGame, type FighterSetup } from '../sim/state.ts';
import { step } from '../sim/step.ts';
import { Bot } from '../ai/bot.ts';
import { KILL_CUE, killPunch, killTimeScale } from '../hitFeel.ts';
import { cameraFighters, followCamera, frameGoal, punchGoal, type CamBounds, type CamState } from '../render/cameraRig.ts';

declare const process: { exit(code: number): never; env?: Record<string, string | undefined> };

const S = 1 / (100 * FX);
const W = 1 / 100;
const FOV = 0.55;
const tan = Math.tan(FOV / 2);

/** Screen position (0..1 across and down) of a world point for a camera aimed at (tx, ty, 0) from the rig's offset position. */
function project(px: number, py: number, cam: CamState, side: number, tilt: number, aspect: number): { x: number; y: number } | null {
  const eye = [cam.x + side * cam.d * 0.12, cam.y + cam.d * (0.06 + tilt), -cam.d];
  let fz = [cam.x - eye[0], cam.y - eye[1], 0 - eye[2]];
  const fl = Math.hypot(fz[0], fz[1], fz[2]);
  fz = fz.map((v) => v / fl);
  // Babylon is left-handed: right = up x forward.
  const up = [0, 1, 0];
  let r = [up[1] * fz[2] - up[2] * fz[1], up[2] * fz[0] - up[0] * fz[2], up[0] * fz[1] - up[1] * fz[0]];
  const rl = Math.hypot(r[0], r[1], r[2]);
  r = r.map((v) => v / rl);
  const u = [fz[1] * r[2] - fz[2] * r[1], fz[2] * r[0] - fz[0] * r[2], fz[0] * r[1] - fz[1] * r[0]];
  const v = [px - eye[0], py - eye[1], 0 - eye[2]];
  const z = v[0] * fz[0] + v[1] * fz[1] + v[2] * fz[2];
  if (z <= 0.1) return null;
  const sx = (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / (z * tan * aspect);
  const sy = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (z * tan);
  return { x: (sx + 1) / 2, y: (1 - sy) / 2 };
}

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const setups: FighterSetup[][] = [[{ char: 0 }, { char: 2 }], [{ char: 9 }, { char: 13 }], [{ char: 5 }, { char: 22, scale: 150 }]];
const aspects = [16 / 9, 844 / 390, 390 / 844];

for (const [aspect, fps] of aspects.flatMap((a) => [[a, 60], [a, 20]] as const)) {
  const renderDt = 1 / fps;
  let jumps = 0;
  let misses = 0;
  let cues = 0;
  let frames = 0;
  const first: string[] = [];
  for (let si = 0; si < STAGES.length; si++) {
    const setup = setups[si % setups.length];
    const state = newGame(setup, { stocks: 2, seed: 31 + si, stage: si });
    const bots = setup.map((_, i) => new Bot(i, 9, 500 + i));
    const stage = STAGES[si];
    const world: CamBounds = { left: stage.blast.left * W, right: stage.blast.right * W, bottom: stage.blast.bottom * W, top: stage.blast.top * W };
    let cam: CamState | null = null;
    let kill: { at: number; x: number; y: number } | null = null;
    let now = 0;
    let simAcc = 0;
    let simFrames = 0;
    while (!state.over && simFrames < 60 * 150) {
      now += renderDt;
      // The renderer's loop: the sim runs at the kill cue's time scale, the camera at real time.
      const scale = kill ? killTimeScale(now - kill.at) : 1;
      if (kill && now - kill.at > KILL_CUE.slowSeconds + KILL_CUE.easeBack + 0.1) kill = null;
      simAcc += scale * 60 * renderDt;
      while (simAcc >= 1 && !state.over) {
        simAcc -= 1;
        simFrames++;
        for (const e of step(state, bots.map((b) => b.think(state)))) {
          if (e.type === 'launch' && e.ko) {
            kill = { at: now, x: state.fighters[e.victim].x * S, y: state.fighters[e.victim].y * S + 0.5 };
            cues++;
          }
        }
      }
      const { live, soon } = cameraFighters(state, stage.respawn);
      let goal = frameGoal([...live, ...soon], world, aspect, tan);
      let smooth = 0.18;
      let smoothZoom = 0.25;
      if (kill) {
        const t = now - kill.at;
        const p = killPunch(t);
        goal = punchGoal(goal, kill, p, KILL_CUE.punchIn);
        smooth = 0.12 + 0.16 * (1 - p);
        smoothZoom = 0.1 + 0.3 * (1 - p);
      }
      if (!cam) {
        cam = { ...goal, vx: 0, vy: 0, vd: 0 };
        continue;
      }
      const side = [0, 1, -1][state.angle] ?? 0;
      const tilt = state.angle === 2 ? 0.1 : 0;
      if (followCamera(cam, goal, { smooth, smoothZoom, dt: renderDt, tan, side, tilt, keep: { fighters: live, tan, aspect } })) {
        jumps++;
        if (process.env?.DBG && aspect < 1 && jumps < 6) console.log('JUMP', stage.name, simFrames, JSON.stringify(cam), 'goal', JSON.stringify(goal), 'live', JSON.stringify(live), 'kill', !!kill);
        if (first.length < 3) first.push(`${stage.name} jump at frame ${simFrames}`);
      }
      frames++;
      for (const f of state.fighters) {
        if (f.action === ACT.DEAD) continue;
        const bx = f.x / FX;
        const by = f.y / FX;
        if (bx <= stage.blast.left || bx >= stage.blast.right || by >= stage.blast.top || by <= stage.blast.bottom) continue;
        const p = project(f.x * S, f.y * S, cam, side, tilt, aspect);
        if (!p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
          misses++;
          if (process.env?.DBG && misses < 4) console.log(stage.name, simFrames, 'cam', JSON.stringify(cam), 'f', f.x*S, f.y*S, 'ang', state.angle, 'kill', !!kill);
          if (first.length < 6) first.push(`${stage.name} fighter ${f.id} off screen at frame ${simFrames} (${p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : 'behind'})`);
        }
      }
    }
  }
  const label = `${aspect > 1.9 ? 'phone landscape' : aspect > 1 ? 'desktop 16:9' : 'phone portrait'} at ${fps} fps`;
  check(`${label}: cameraJumps 0 over ${frames} frames, ${cues} kill cues`, jumps === 0, `${jumps} jumps ${first.join('; ')}`);
  check(`${label}: every fighter on screen until the blast zone`, misses === 0, `${misses} misses ${first.join('; ')}`);
}

if (failed) process.exit(1);
