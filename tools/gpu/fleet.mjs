// How many GPU servers to use, and whether the queue may start them by
// itself. Saved on this machine in .cache/gpu/fleet.json (the GPU tab's
// Scaling card edits it).
//
//   servers  how many servers there may be, and how many jobs run at once
//            (one per ready server). Launching a new one is always a click;
//            this caps it.
//   auto     when jobs are waiting and fewer servers are running than jobs,
//            start stopped servers (ones already set up) up to `servers`.
//            Off unless turned on: starting a server costs money.
//   idleMinutes  how long a server sits idle before it stops itself (the scale
//            down). Long enough not to give the machine back between bursts
//            of work: a stopped server can only start again in its own zone,
//            and AWS is often out of L40S machines there.
// Servers already running pick up a new idleMinutes as soon as they're ready.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

const FILE = path.join(ROOT, '.cache', 'gpu', 'fleet.json');
export const FLEET_DEFAULTS = { servers: 4, auto: false, idleMinutes: 60 };
export const FLEET_MAX = 16;

export function loadFleet() {
  try {
    return clean({ ...FLEET_DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) });
  } catch {
    return { ...FLEET_DEFAULTS };
  }
}

export function saveFleet(patch) {
  const next = clean({ ...loadFleet(), ...patch });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

function clean(f) {
  return {
    servers: Math.max(1, Math.min(FLEET_MAX, Math.round(Number(f.servers) || FLEET_DEFAULTS.servers))),
    auto: f.auto === true,
    idleMinutes: Math.max(10, Math.min(240, Math.round(Number(f.idleMinutes) || FLEET_DEFAULTS.idleMinutes))),
  };
}
