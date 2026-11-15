// The landing page's side of the Hawkes playtest contract (site/playtest-bridge.js): its scenario list matches the
// game's, and a scenario started on the landing page opens Game/ in a frame and runs in the game's own contract.
// Run with `npm test`.
import fs from 'node:fs';
import vm from 'node:vm';
import { BRIDGE, rendered } from './playtest-bridge.mjs';

let failed = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const { src, out } = await rendered();
check(src === out, 'site/playtest-bridge.js has the current scenario list (else: node tools/playtest-bridge.mjs)');

/** A landing page with just enough DOM for the bridge, at `href`. */
function page(href) {
  const appended = [];
  const document = {
    baseURI: href,
    body: { appendChild: (el) => appended.push(el) },
    documentElement: { style: {} },
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, focus() {}, contentWindow: null }),
    addEventListener() {},
  };
  const window = {};
  const ctx = vm.createContext({ window, document, location: new URL(href), URL, URLSearchParams, setTimeout, Promise, JSON, Date, Number, isFinite, Boolean, String });
  vm.runInContext(fs.readFileSync(BRIDGE, 'utf8'), ctx);
  return { api: window.hawkesPlaytest, appended };
}

/** The game's own contract inside the frame: ready after `readyAfter` polls of state(). */
function fakeGame(readyAfter = 3) {
  const calls = [];
  let polls = 0;
  let status = 'idle';
  return {
    calls,
    hawkesPlaytest: {
      state() { polls++; return { ready: polls > readyAfter, status, scene: 'Main Menu' }; },
      start(id, o) { calls.push(['start', id, o]); status = 'running'; return new Promise((r) => setTimeout(() => { status = 'done'; r(); }, 20)); },
      report() { return { scenario: 'smoke', outcome: 'done', seconds: 1, metrics: { kos: 2 } }; },
      stop() { calls.push(['stop']); },
      input(a, d) { calls.push(['input', a, d]); },
    },
  };
}

{
  const { api, appended } = page('https://doseofdestruction.com/');
  check(api && api.version === 1 && api.product === 'doseofdestruction', 'the landing page has window.hawkesPlaytest (v1, doseofdestruction)');
  const ids = api.scenarios().map((s) => s.id);
  check(ids.includes('smoke') && ids.includes('campaign'), `it lists the game's scenarios (${ids.join(', ')})`);
  const campaign = api.scenarios().find((s) => s.id === 'campaign');
  check(campaign.starts.includes('walk-on'), 'campaign takes the finale, walk-on, as a start point');
  const idle = api.state();
  check(idle.ready === true && idle.status === 'idle', 'idle and ready until a scenario starts');
  check(appended.length === 0 && api.report() === null, 'nothing opened for players until then');
}

{
  const { api, appended } = page('https://sites.hawkesgen.ai/o/x/dose-of-destruction/?room=abc&peer=1');
  const game = fakeGame();
  const started = api.start('smoke', { seed: 4, speed: 2, at: 'walk-on' });
  await new Promise((r) => setTimeout(r, 0));
  // Brand overlay then the game iframe (both full-screen).
  const frame = appended.find((el) => el.id === 'hawkes-playtest-frame');
  check(!!frame && appended.some((el) => el.id === 'hawkes-playtest-brand'), 'start() opens one frame');
  check(frame?.src === 'https://sites.hawkesgen.ai/o/x/dose-of-destruction/Game/?room=abc&peer=1', `the frame is the game next to this page, with room and peer passed on (${frame?.src})`);
  check(api.state().status === 'running', 'running while the game loads');
  frame.contentWindow = game;
  await started;
  check(game.calls[0]?.[0] === 'start' && game.calls[0][1] === 'smoke', "the game's own start() runs the scenario once it's ready");
  check(JSON.stringify(game.calls[0]?.[2]) === JSON.stringify({ seed: 4, speed: 2, at: 'walk-on' }), 'with the same options');
  check(api.state().status === 'done', "state() is the game's");
  check(api.report()?.metrics?.kos === 2, "report() is the game's");
  api.input('jump', true);
  api.stop();
  check(game.calls.some((c) => c[0] === 'input') && game.calls.some((c) => c[0] === 'stop'), 'input() and stop() go to the game');
}

{
  const { api, appended } = page('https://doseofdestruction.com/?playtest=campaign&seed=7&at=walk-on');
  await new Promise((r) => setTimeout(r, 0));
  const frame = appended.find((el) => el.id === 'hawkes-playtest-frame');
  check(!!frame && frame.src === 'https://doseofdestruction.com/Game/', '?playtest=<id> on the landing page starts it (own params not passed to the game)');
  const game = fakeGame(0);
  frame.contentWindow = game;
  await new Promise((r) => setTimeout(r, 600));
  check(JSON.stringify(game.calls[0]) === JSON.stringify(['start', 'campaign', { seed: 7, speed: 1, at: 'walk-on' }]), 'with seed, speed and at from the address');
  api.stop();
}

console.log(failed ? `\n${failed} failed` : '\nplaytest bridge: all ok');
process.exit(failed ? 1 : 0);
