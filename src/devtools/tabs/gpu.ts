// GPU: the AWS server that runs ComfyUI, the regions it can live in, and the
// generation queue. Launch it once (it installs itself, about 30 to 45
// minutes, mostly downloading 90 GB of models); after that start it when you
// want to generate and let it stop itself when idle.

import { h, kids } from '../../game/ui/dom.ts';
import { api, store } from '../api.ts';
import { GpuFailure, gpu, money, refreshGpu, watchGpu, type Attempt, type Failure, type GpuJob, type GpuServer, type GpuState, type LaunchOptions, type RegionInfo, type RetryState } from '../gpu.ts';
import { attempt, checkbox, numberInput, select, toast } from '../ui.ts';
import type { Tab } from '../main.ts';

let root: HTMLElement;
let last: GpuState | null = null;
let busy = false;
let failure: Failure | null = null;
const open = new Set<string>();
const form = { region: 'auto', type: 'auto', idleMinutes: 30, keepTrying: true, minutes: 60 };
/** AWS's capacity hints (spot placement scores), when asked for. */
let capacity: Record<string, Record<string, number>> | null = null;
let checking = false;
/** What the page last drew from, so polls that change nothing don't redraw it. */
let drawn = '';
/** The server's health (flags, memory, disk; over SSH), checked once it's ready. */
interface Health { ok: boolean; active: string; flags: string[]; missing: string[]; bad: string[]; ram: string | null; swap: string | null; disk: string | null; gpu: { usedMb: number; totalMb: number } | null }
let health: Health | null = null;
let healthFor = '';
let healthError = '';
let fixing = false;

async function checkHealth(id: string): Promise<void> {
  healthFor = id;
  try {
    health = await api.get<Health>('/gpu/health');
    healthError = '';
  } catch (e) {
    health = null;
    healthError = (e as Error).message;
  }
  render();
}

function healthBox(s: GpuServer): HTMLElement | null {
  if (s.state !== 'running' || s.boot?.stage !== 'ready') return null;
  // Once per server (and on demand).
  if (healthFor !== s.id) void checkHealth(s.id!);
  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  if (!health) return h('p', { class: healthError ? 'hint warn' : 'hint' }, healthError ? `Health check: ${healthError}` : 'Checking the server’s settings…');
  return h('div', { class: `health ${health.ok ? 'ok' : 'warn'}` },
    h('div', { class: 'row' },
      h('strong', {}, health.ok ? '✓ Server settings are right' : '⚠ Server settings need fixing'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => checkHealth(s.id!) }, 'Check again'),
      !health.ok && h('button', { type: 'button', class: 'btn small primary', disabled: fixing, title: 'Sets the flags that work and restarts ComfyUI (about 10 seconds; queued jobs wait)', onclick: async () => {
        fixing = true;
        render();
        try {
          health = await api.post<Health>('/gpu/health/fix', {});
          toast('ComfyUI restarted with the right settings.');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
        fixing = false;
        render();
      } }, fixing ? 'Fixing…' : 'Fix it')),
    h('p', { class: 'hint mono' }, `ComfyUI ${health.active} · flags ${health.flags.filter((f) => !['--listen', '--port', '--disable-auto-launch'].includes(f)).join(' ') || '(none)'}`),
    health.missing.length ? h('p', { class: 'hint warn' }, `Missing ${health.missing.join(', ')}: without it ComfyUI locks most of the RAM while loading models, and the server stops answering.`) : null,
    health.bad.length ? h('p', { class: 'hint warn' }, `${health.bad.join(', ')} makes Wan video run out of GPU memory (fp8 weights load as 16-bit, or two models stay loaded).`) : null,
    h('p', { class: 'hint' }, [health.gpu && `GPU ${gb(health.gpu.usedMb)} of ${gb(health.gpu.totalMb)} in use`, health.ram && `RAM ${health.ram} MB`, health.swap && `swap ${health.swap} MB`, health.disk && `disk ${health.disk}`].filter(Boolean).join(' · ')),
    h('p', { class: 'hint' }, 'Why these settings: docs/comfyui.md.'),
  );
}

/** The server's log (over SSH), when asked for. */
let serverLogText: string | null = null;
let readingLog = false;

/** First-launch setup, in order, matched against what the server reports. */
const SETUP = [
  { label: 'System packages', match: /system packages/ },
  { label: 'ComfyUI', match: /^ComfyUI v/ },
  { label: 'PyTorch', match: /PyTorch/ },
  { label: 'ComfyUI requirements', match: /requirements/ },
  { label: 'Custom nodes', match: /custom nodes/ },
  { label: 'Models (about 90 GB)', match: /^model / },
  { label: 'Starting ComfyUI', match: /waiting for ComfyUI/ },
];

function setupList(s: GpuServer): HTMLElement | null {
  const boot = s.boot;
  if (!boot || boot.stage === 'ready' || s.state !== 'running') return null;
  const at = SETUP.findIndex((x) => x.match.test(boot.detail ?? ''));
  const mins = s.launched ? Math.round((Date.now() - new Date(s.launched).getTime()) / 60000) : 0;
  return h('div', { class: 'card', style: 'background:var(--panel-2)' },
    h('h3', {}, 'Setting up', h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${mins} min since launch`)),
    h('ol', { class: 'setup-steps' }, ...SETUP.map((x, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' },
      x.label, i === at && boot.stage === 'downloading' ? h('span', { class: 'muted' }, ` · ${boot.detail}`) : null))),
    h('p', { class: 'hint' }, 'First launch only: usually 10 to 25 minutes, mostly the model downloads. Nothing to do but wait; queued jobs start by themselves when it is ready. Later starts take a couple of minutes.'),
  );
}
let tick = 0;
const quotaAsk: Record<string, number> = {};

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const kindBadge: Record<string, string> = { ok: 'ok', capacity: 'warn', quota: 'warn', auth: 'bad', other: 'bad' };

/** Runs a server action, keeping a launch or start failure on screen. */
async function run(fn: () => Promise<unknown>, done?: string): Promise<void> {
  busy = true;
  render();
  try {
    await fn();
    failure = null;
    if (done) toast(done);
  } catch (e) {
    if (e instanceof GpuFailure) failure = e.failure;
    else toast((e as Error).message, 'error');
  }
  busy = false;
  await refreshGpu().catch(() => undefined);
}

// ------------------------------------------------------------ server

function launchForm(s: GpuServer, regions: RegionInfo[]): HTMLElement {
  const types = s.types ?? {};
  const group = form.type === 'auto' ? Object.keys(types) : null;
  if (!group && !types[form.type]) form.type = 'auto';
  const pickable = group ?? [form.type];
  // The cheapest in the group, for the estimate; "any" launches try the best first.
  const t = types[pickable[0]] ?? types[Object.keys(types)[0]];
  const price = group ? `${money(Math.min(...group.map((k) => types[k].price)))}–${money(Math.max(...group.map((k) => types[k].price)))}` : money(t.price);
  const usable = (r: RegionInfo) => pickable.some((k) => (r.quota ?? 0) >= types[k].vcpus && (r.zones[k]?.length ?? 0) > 0);
  if (form.region !== 'auto' && !regions.some((r) => r.region === form.region && usable(r))) form.region = 'auto';
  const anyUsable = regions.some(usable);
  const regionSel = select<string>(
    [['auto', `Any region with quota (${regions.filter(usable).map((r) => r.region).join(', ') || 'none yet'})`], ...regions.map((r): [string, string] => [r.region, `${r.region}: quota ${r.quota ?? '?'}${usable(r) ? '' : ' (not enough)'}`])],
    form.region,
    (v) => { form.region = v; render(); },
  );
  for (const o of regionSel.options) if (o.value !== 'auto') o.disabled = !regions.find((r) => r.region === o.value && usable(r));
  const launch = () => {
    const opts: LaunchOptions = { region: form.region, type: form.type, idleMinutes: form.idleMinutes, keepTrying: form.keepTrying ? { minutes: form.minutes } : undefined };
    const retryNote = form.keepTrying ? `\n\nIf AWS has none free, it tries again every 3 minutes for up to ${form.minutes} minutes. Charges start whenever it succeeds.` : '';
    if (!confirm(`Launch a ${group ? '48 GB GPU' : form.type} server (${form.region === 'auto' ? 'any region with quota' : form.region})?\n\nAbout ${price}/hour while running, plus about ${money(s.diskPerMonth)}/month for its disk until you terminate it. It stops itself after ${form.idleMinutes} idle minutes.${retryNote}`)) return;
    void run(() => gpu.launch(opts), form.keepTrying ? 'Launching; it keeps trying if AWS is full.' : 'Launching. Setup takes 30 to 45 minutes; progress shows here.');
  };
  return h(
    'div',
    {},
    h('dl', { class: 'form' },
      h('div', { class: 'field' }, h('label', {}, 'Machine'), select<string>([
        ['auto', 'Any size (all are L40S, 48 GB)'],
        ...Object.entries(types).map(([k, v]): [string, string] => [k, `${k} · ${v.gpu} · ${v.memory} GB RAM · ${money(v.price)}/h`]),
      ], form.type, (v) => { form.type = v; render(); })),
      h('div', { class: 'field' }, h('label', {}, 'Region'), regionSel),
      h('div', { class: 'field' }, h('label', {}, 'Stop after idle (minutes)'), numberInput(form.idleMinutes, (v) => (form.idleMinutes = v ?? 30), { min: 10, max: 240, step: 5 }))),
    h('div', { class: 'row' }, checkbox('If AWS is full, keep trying for', form.keepTrying, (v) => { form.keepTrying = v; render(); }),
      numberInput(form.minutes, (v) => (form.minutes = v ?? 60), { min: 5, max: 720, step: 5, style: 'width:70px' }), h('span', { class: 'muted' }, 'minutes (every 3)')),
    !anyUsable && h('p', { class: 'hint warn' }, `No region has quota for ${t?.vcpus ?? 4} GPU vCPUs yet. Request some in the Regions card.`),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', disabled: busy || !anyUsable || !!last?.retry?.active, onclick: launch }, busy ? 'Launching…' : 'Launch GPU server')),
  );
}

const countdown = (s: number) => `Next try in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.`;

function retryBox(r: RetryState): HTMLElement {
  const lastTry = r.log[r.log.length - 1];
  const wait = r.next ? Math.max(0, Math.round((r.next - Date.now()) / 1000)) : 0;
  return h(
    'div',
    { class: 'card', style: 'background:var(--panel-2)' },
    h('h3', {}, `Trying to ${r.action === 'launch' ? `launch ${r.opts.type ?? ''}` : 'start the server'}`, h('span', { class: 'spacer' }), h('span', { class: 'badge warn' }, `try ${r.tries}`)),
    h('p', { class: 'hint' }, r.next ? h('span', { 'data-next': r.next }, countdown(wait)) : 'Trying now…', r.next ? ` Gives up at ${clock(r.until)}.` : ''),
    lastTry && !lastTry.ok && h('p', { class: 'hint warn' }, lastTry.message),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => run(() => gpu.stopRetry(), 'Stopped trying.') }, 'Stop trying')),
  );
}

const ADVICE: Record<string, string> = {
  capacity: 'AWS has none of these machines free right now. That is AWS running short, not a problem with your account, and nothing is charged. It usually clears within minutes to hours: keep trying, pick another region with quota, or try another machine size.',
  quota: 'The account is not allowed that many GPU vCPUs there. Request more in the Regions card (free; AWS reviews it, usually within a day).',
  auth: 'The AWS keys in .env are not allowed to do this. Check the IAM permissions for that user (EC2 instances, security groups, key pairs; Service Quotas).',
  other: 'Something else went wrong; the details are below.',
};

function failureBox(f: Failure): HTMLElement {
  return h(
    'div',
    { class: 'card', style: 'background:var(--panel-2)' },
    h('h3', {}, 'Last try failed', h('span', { class: 'spacer' }), h('span', { class: `badge ${kindBadge[f.kind] ?? 'bad'}` }, f.kind)),
    h('p', { class: 'hint warn' }, f.message),
    h('p', { class: 'hint' }, ADVICE[f.kind] ?? ADVICE.other),
    f.attempts.length
      ? h('table', { class: 'table' }, h('tbody', {}, ...f.attempts.map((a: Attempt) =>
          h('tr', { title: a.message }, h('td', { class: 'mono' }, a.region), h('td', { class: 'mono' }, a.zone ?? 'setup'), h('td', {}, h('span', { class: `badge ${kindBadge[a.kind] ?? 'bad'}` }, a.code))))))
      : null,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: () => { failure = null; render(); } }, 'Dismiss')),
  );
}

function serverCard(s: GpuServer, state: GpuState): HTMLElement {
  const shownFailure = failure ?? state.retry?.error ?? (!state.retry?.active ? state.lastFailure : null);
  const retrying = state.retry?.active ? retryBox(state.retry) : null;
  if (s.error) {
    return h('section', { class: 'card' }, h('h3', {}, 'GPU server'), h('p', { class: 'hint warn' }, `Couldn't read the server from AWS: ${s.error}`), h('p', { class: 'hint' }, 'Check the AWS keys in .env and your connection, then Refresh.'));
  }
  if (!s.exists) {
    return h(
      'section',
      { class: 'card' },
      h('h3', {}, 'GPU server', h('span', { class: 'spacer' }), h('span', { class: 'badge' }, 'not launched')),
      h('p', {}, 'A GPU machine in your AWS account running ComfyUI with Wan 2.2 Animate, Wan 2.2 image-to-video and Qwen-Image-Edit 2511.'),
      h('ul', { class: 'hint', style: 'margin:0;padding-left:18px' },
        h('li', {}, 'Charged by the hour while it runs. It stops itself after the idle time below.'),
        h('li', {}, 'First launch sets itself up: about 30 to 45 minutes, mostly downloading 90 GB of models. Later starts take a couple of minutes.'),
        h('li', {}, `Its ${s.diskGb ?? 250} GB disk keeps the models while stopped: about ${money(s.diskPerMonth)} a month until you terminate it.`),
        h('li', {}, 'Only this computer’s IP can reach it, through a password-protected proxy.')),
      retrying ?? launchForm(s, state.regions),
      shownFailure && !retrying ? failureBox(shownFailure) : null,
    );
  }
  const running = s.state === 'running';
  const stage = s.boot?.stage;
  const isReady = running && stage === 'ready';
  const uptime = running && s.launched ? (Date.now() - new Date(s.launched).getTime()) / 3600000 : 0;
  const badge = isReady ? ['ok', 'ready'] : running ? ['warn', stage ?? 'booting'] : s.state === 'stopped' ? ['', 'stopped'] : ['warn', s.state ?? ''];
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'GPU server', h('span', { class: 'spacer' }), h('span', { class: `badge ${badge[0]}` }, badge[1])),
    h('dl', { class: 'form' },
      ...[
        ['Machine', `${s.type} · ${s.types?.[s.type]?.gpu ?? ''}`],
        ['Where', `${s.region ?? ''} · ${s.zone ?? ''} · ${s.id}`],
        ['State', `${s.state ?? ''}${s.reason && !running ? ` (${s.reason})` : ''}`],
        ['Address', s.url ?? 'none while stopped'],
        ['Setup', s.boot ? `${s.boot.stage}${s.boot.detail ? `: ${s.boot.detail}` : ''}` : running ? 'waiting for it to answer' : '—'],
        ['Cost', running ? `${money(s.pricePerHour)}/h · this run so far about ${money(uptime * s.pricePerHour)}` : `disk only, about ${money(s.diskPerMonth)}/month`],
        ['Idle stop', s.idleMinutes ? `after ${s.idleMinutes} minutes` : '—'],
        ['SSH', s.key ? `ssh -i ${s.key} ubuntu@${s.ip ?? '<ip>'}` : '—'],
      ].map(([k, v]) => h('div', { class: 'field' }, h('label', {}, k), h('span', { class: k === 'SSH' ? 'mono' : '' }, v))),
    ),
    stage === 'failed' && h('p', { class: 'hint warn' }, 'Setup failed. Server log (below) shows why; terminate and launch again once it is fixed.'),
    setupList(s),
    healthBox(s),
    stage === 'locked out' && h('p', { class: 'hint warn' }, 'The server rejected the saved password (.cache/gpu/server.json). If that file was replaced, terminate and launch again.'),
    retrying,
    shownFailure && !retrying ? failureBox(shownFailure) : null,
    h('div', { class: 'row' }, ...kids(
      s.state === 'stopped' && !retrying && h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: () => {
        if (!confirm(`Start the GPU server? About ${money(s.pricePerHour)}/hour until it stops itself or you stop it.${form.keepTrying ? `\n\nIf AWS has none free, it keeps trying for ${form.minutes} minutes.` : ''}`)) return;
        void run(() => gpu.start(form.keepTrying ? { minutes: form.minutes } : undefined), 'Starting. Ready in a couple of minutes.');
      } }, 'Start'),
      s.state === 'stopped' && !retrying && checkbox(`Keep trying ${form.minutes} min if AWS is full`, form.keepTrying, (v) => { form.keepTrying = v; }),
      running && h('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => run(() => gpu.act('stop'), 'Stopping.') }, 'Stop now'),
      running && h('button', { type: 'button', class: 'btn', disabled: busy, title: 'Use this if your IP changed', onclick: () => run(() => gpu.act('access'), 'This IP can reach the server.') }, 'Refresh access'),
      isReady && s.url && h('a', { class: 'btn', href: s.url, target: '_blank', rel: 'noopener', title: 'User dod; the password is the token in .cache/gpu/server.json' }, 'Open ComfyUI'),
      running && h('button', { type: 'button', class: 'btn', disabled: readingLog, title: 'The setup log, disk, memory and GPU, over SSH', onclick: async () => {
        readingLog = true;
        render();
        try {
          serverLogText = (await api.get<{ log: string }>('/gpu/log?lines=60')).log;
        } catch (e) {
          serverLogText = `Couldn't read the log: ${(e as Error).message}`;
        }
        readingLog = false;
        render();
      } }, readingLog ? 'Reading…' : 'Server log'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn danger', disabled: busy, onclick: () => {
        if (!confirm('Terminate the GPU server? This deletes it and its disk, models included. Launching again re-downloads everything.')) return;
        void run(() => gpu.act('terminate'), 'Terminating.');
      } }, 'Terminate'),
    )),
    serverLogText !== null && h('details', { open: true }, h('summary', { class: 'muted' }, 'Server log', ' ',
      h('button', { type: 'button', class: 'btn small', onclick: () => { serverLogText = null; render(); } }, 'Hide')),
      h('pre', { class: 'mono server-log' }, serverLogText)),
    isReady && s.url && h('p', { class: 'hint' }, 'ComfyUI in the browser asks for a login: user dod, password is the token in .cache/gpu/server.json. Job workflows (queue below) load into it by drag and drop.'),
  );
}

// ------------------------------------------------------------ regions

function regionsCard(state: GpuState): HTMLElement {
  const type = state.server.exists ? state.server.type : form.type;
  const need = state.server.types?.[type]?.vcpus ?? 4;
  return h(
    'section',
    { class: 'card wide-card' },
    h('h3', {}, 'Regions', h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => attempt(() => gpu.refreshRegions(), 'Quotas re-read.').then(() => refreshGpu()) }, 'Refresh')),
    h('p', { class: 'hint' }, `GPU quota is how many GPU vCPUs the account may run in a region (a ${type} needs ${need}). It doesn't reserve machines: AWS can still be out of them.`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', disabled: checking, title: 'Read-only: AWS spot placement scores, its own estimate of spare capacity', onclick: async () => {
        checking = true;
        render();
        const out = await attempt(() => api.get<{ scores: Record<string, Record<string, number>> }>('/gpu/capacity'));
        if (out) capacity = out.scores;
        checking = false;
        render();
      } }, checking ? 'Asking AWS…' : 'Check availability'),
      h('span', { class: 'hint' }, 'AWS’s 1–10 guess at spare machines. Low everywhere partly reflects your Spot quota (0), so treat it as a hint.')),
    capacity && h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Machine'), ...state.regions.map((r) => h('th', {}, r.region)))),
      h('tbody', {}, ...Object.entries(capacity).map(([t, by]) => h('tr', {}, h('td', { class: 'mono' }, t),
        ...state.regions.map((r) => h('td', {}, by[r.region] ? h('span', { class: `badge ${by[r.region] >= 7 ? 'ok' : by[r.region] >= 4 ? 'warn' : ''}` }, String(by[r.region])) : '—')))))),
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Region'), h('th', {}, 'Quota'), h('th', {}, 'Requests'), h('th', {}, `${type} zones`), h('th', {}, ''))),
      h('tbody', {}, ...state.regions.map((r) => {
        const pending = r.requests.find((q) => ['PENDING', 'CASE_OPENED'].includes(q.status));
        quotaAsk[r.region] ??= Math.max(8, need);
        return h(
          'tr',
          {},
          h('td', { class: 'mono', style: 'white-space:nowrap' }, r.region, state.server.region === r.region ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, 'server') : null),
          h('td', {}, h('span', { class: `badge ${(r.quota ?? 0) >= need ? 'ok' : 'warn'}` }, String(r.quota ?? '?'))),
          h('td', { class: 'text' }, r.requests.length
            ? r.requests.map((q) => `${q.value}: ${q.status.toLowerCase().replace('_', ' ')}${q.caseId ? ` (case ${q.caseId})` : ''}`).join('; ')
            : r.error ?? 'none'),
          h('td', {}, String(r.zones[type]?.length ?? 0)),
          h('td', {}, pending ? h('span', { class: 'muted' }, 'waiting on AWS') : h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            numberInput(quotaAsk[r.region], (v) => (quotaAsk[r.region] = v ?? 8), { min: 4, max: 64, step: 4, style: 'width:56px' }),
            h('button', { type: 'button', class: 'btn small', onclick: async () => {
              if (!confirm(`Ask AWS for ${quotaAsk[r.region]} GPU vCPUs in ${r.region}? Free; AWS reviews it, usually within a day, and may email you.`)) return;
              await run(() => gpu.quota(r.region, quotaAsk[r.region]), `Requested ${quotaAsk[r.region]} vCPUs in ${r.region}.`);
            } }, 'Request'))),
        );
      }))),
  );
}

function accountCard(a: GpuState['account']): HTMLElement {
  if (!a) return h('section', { class: 'card' }, h('h3', {}, 'AWS account'), h('p', { class: 'hint' }, 'Checking…'));
  if (a.error) return h('section', { class: 'card' }, h('h3', {}, 'AWS account'), h('p', { class: 'hint warn' }, a.error), h('p', { class: 'hint' }, 'The keys come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.'));
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'AWS account'),
    h('dl', { class: 'form' },
      h('div', { class: 'field' }, h('label', {}, 'Account'), h('span', {}, a.account ?? '')),
      h('div', { class: 'field' }, h('label', {}, 'Keys'), h('span', { class: 'mono' }, a.arn?.split(':').pop() ?? '')),
      h('div', { class: 'field' }, h('label', {}, 'Home region'), h('span', {}, a.region ?? ''))),
    h('p', { class: 'hint' }, 'Credentials and the home region come from .env.'),
  );
}

// -------------------------------------------------------------- queue

function jobDetail(j: GpuJob): HTMLElement {
  const r = j.resolved;
  return h(
    'div',
    { class: 'job-detail' },
    r && h('div', { class: 'field' }, h('label', {}, 'Prompt'), h('p', { class: 'text' }, r.prompt)),
    r && h('details', {}, h('summary', { class: 'muted' }, 'Negative prompt'), h('p', { class: 'text muted' }, r.negative)),
    r && h('div', { class: 'field' }, h('label', {}, 'Settings'), h('code', { class: 'mono' }, Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(' · '), ` · ${r.size}px · ${r.fps} fps${j.frames ? ` · ${j.frames} frames` : ''}`)),
    j.seeds?.length ? h('div', { class: 'field' }, h('label', {}, 'Seeds'), h('code', {}, j.seeds.join(', '))) : null,
    j.outputs?.length ? h('div', { class: 'field' }, h('label', {}, 'Saved'), h('code', {}, j.outputs.join(', '))) : null,
    j.graphs?.length
      ? h('div', { class: 'field' }, h('label', {}, 'ComfyUI workflows'), h('div', { class: 'row' }, ...j.graphs.map((g, i) => h('a', { class: 'btn small', href: gpu.graphUrl(g), download: `dod-${g}`, title: 'Drag the downloaded file into ComfyUI to open it there' }, `Workflow ${i + 1}`))))
      : null,
    h('details', { open: j.status === 'failed' }, h('summary', { class: 'muted' }, `Log (${j.log.length})`), h('pre', { class: 'mono', style: 'white-space:pre-wrap;max-height:200px;overflow:auto' }, j.log.join('\n'))),
  );
}

function jobRows(j: GpuJob): HTMLElement[] {
  const name = j.type === 'paint' ? `stage ${j.stage}` : store.fighters.find((f) => f.id === j.fighter)?.name ?? j.fighter;
  const what = j.type === 'paint' ? `paint ${j.piece}${(j.takes ?? 1) > 1 ? ` · ${j.takes} takes` : ''}`
    : j.type === 'side' ? 'side views' : `${j.clip} · ${j.type === 'animate' ? 'from motion' : 'from prompt'}${(j.takes ?? 1) > 1 ? ` · ${j.takes} takes` : ''}`;
  const cls = j.status === 'done' ? 'ok' : j.status === 'failed' || j.status === 'interrupted' ? 'bad' : j.status === 'running' ? 'warn' : '';
  const took = j.started ? (j.finished ? `${Math.round((j.finished - j.started) / 1000)}s` : `${ago(j.started)} so far`) : '';
  const finished = !['queued', 'running'].includes(j.status);
  const isOpen = open.has(j.id);
  const row = h(
    'tr',
    {},
    h('td', {}, j.type === 'paint' ? h('span', { class: 'badge' }, 'map') : h('img', { src: `/characters/thumb/${j.fighter}.webp`, alt: '', style: 'width:26px;height:26px;object-fit:contain' })),
    h('td', {}, name),
    h('td', { class: 'mono' }, what),
    h('td', {}, h('span', { class: `badge ${cls}` }, j.status)),
    h('td', { class: 'text' }, j.detail),
    h('td', { class: 'muted' }, took),
    h('td', { class: 'muted' }, j.cost ? money(j.cost) : ''),
    h('td', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' }, ...kids(
      h('button', { type: 'button', class: 'btn small', onclick: () => { if (isOpen) open.delete(j.id); else open.add(j.id); render(); } }, isOpen ? 'Hide' : 'Details'),
      !finished && h('button', { type: 'button', class: 'btn small', onclick: () => attempt(() => gpu.cancel(j.id)).then(() => refreshGpu()) }, 'Cancel'),
      finished && h('button', { type: 'button', class: 'btn small', title: 'Queue it again with a new seed', onclick: () => attempt(() => gpu.rerun(j.id), 'Queued again.').then(() => refreshGpu()) }, 'Rerun'),
      finished && !!j.seeds?.length && h('button', { type: 'button', class: 'btn small', title: 'Queue it again with the same seed (after changing settings, say)', onclick: () => attempt(() => gpu.rerun(j.id, true), 'Queued again with the same seed.').then(() => refreshGpu()) }, 'Same seed'),
    ))),
  );
  return isOpen ? [row, h('tr', {}, h('td', { colspan: 8 }, jobDetail(j)))] : [row];
}

/** Everything the page shows, minus what changes every poll without meaning anything. */
function signature(s: GpuState): string {
  const r = s.retry;
  return JSON.stringify([s.server, s.regions, s.account, s.motions, s.lastFailure, s.jobs.map((j) => [j.id, j.status, j.detail, j.cost]), r && [r.active, r.tries, r.next, r.ended]]);
}

function render(): void {
  const s = last;
  if (s) drawn = signature(s);
  if (!s) {
    root.replaceChildren(h('div', { class: 'main' }, h('p', { class: 'muted' }, 'Loading the GPU service…')));
    return;
  }
  const jobs = [...s.jobs].reverse();
  const spent = s.jobs.reduce((n, j) => n + (j.cost ?? 0), 0);
  root.replaceChildren(
    h(
      'div',
      { class: 'main' },
      h('header', {}, h('h2', {}, 'GPU'), h('span', { class: 'muted' }, 'ComfyUI on your AWS account, for side views and animation clips. Prompts and settings: AI Settings tab.')),
      h('div', { class: 'cards' }, serverCard(s.server, s), regionsCard(s), accountCard(s.account),
        h('section', { class: 'card' },
          h('h3', {}, 'Motion library'),
          h('p', { class: 'hint' }, 'Driving videos for Wan Animate: one per clip, shared by every fighter so their timing matches. Make a clip once (from a prompt, or your own video), then "Add to motion library" in the clip editor.'),
          s.motions.length
            ? h('div', { class: 'row' }, ...s.motions.map((m) => h('a', { class: 'badge ok', href: `/api/dev/gpu/motion?clip=${m.clip}&v=${m.mtime}`, target: '_blank' }, m.clip)))
            : h('p', { class: 'hint warn' }, 'Empty so far.'),
          h('p', { class: 'hint mono' }, s.motionsDir))),
      h('h3', { style: 'margin:20px 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)' },
        `Queue · ${s.jobs.filter((j) => j.status === 'queued').length} waiting · ${money(spent)} of GPU time so far`),
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('span', { class: 'hint' }, 'Queue jobs from the Clips and Animations tabs (clips) and the Fighters tab (side views). Jobs wait until the server is ready.'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn small', onclick: () => attempt(() => gpu.clear()).then(() => refreshGpu()) }, 'Clear finished')),
      jobs.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Fighter'), h('th', {}, 'Job'), h('th', {}, 'Status'), h('th', {}, 'Detail'), h('th', {}, 'Time'), h('th', {}, 'Cost'), h('th', {}, ''))),
            h('tbody', {}, ...jobs.flatMap(jobRows))))
        : h('section', { class: 'card' }, h('p', { class: 'hint' }, 'No jobs yet.')),
    ),
  );
}

export const gpuTab: Tab = {
  mount(el) {
    root = el;
    el.style.display = 'block';
    watchGpu((s) => {
      // Finished jobs and launches are announced everywhere by activity.ts.
      last = s;
      // Don't redraw under someone typing in the form, or when nothing changed.
      const typing = root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement!.tagName);
      if (!root.hidden && !typing && signature(s) !== drawn) render();
    });
  },
  show() {
    render();
    // The retry countdown ticks on its own; the page only redraws when something changes.
    clearInterval(tick);
    tick = window.setInterval(() => {
      for (const el of root.querySelectorAll<HTMLElement>('[data-next]')) el.textContent = countdown(Math.max(0, Math.round((Number(el.dataset.next) - Date.now()) / 1000)));
    }, 1000);
    void refreshGpu().catch(() => undefined);
  },
};
