// The online parts of the page (docs/online.md): the lobby strip on the main menu ("N online" and who), Find match,
// the "Searching for opponent… 0:42 · Cancel" chip that stays up over whatever the player does meanwhile, the
// "Match found vs <name> — starting in 5…" banner, and the Profile panel.

import { CHARACTERS } from '../sim/characters.ts';
import { audio } from '../audio.ts';
import { $, h, headUrl } from './dom.ts';
import { focusFirst, onPanelBack, syncPad } from './screens.ts';
import { onlineParts } from '../net/online.ts';
import { NAME_MAX, generatedName, onProfile, profile, setProfile } from '../net/profile.ts';
import type { Found } from '../net/matchmaker.ts';
import type { Player } from '../net/lobby.ts';
import { renderProfileStats } from './leaderboard.ts';
import { feature } from '../analytics.ts';

const COUNTDOWN = 5;
const LIST_MAX = 8;

export interface OnlineUiHooks {
  /** The countdown ran out: end whatever is on and load the online match. */
  start(found: Found): void;
  /** Whether an online match is on (the chip hides then). */
  inOnlineMatch(): boolean;
}

let hooks: OnlineUiHooks;
let notice = '';
let noticeUntil = 0;
let countdown: { found: Found; timer: ReturnType<typeof setInterval>; left: number } | null = null;

export function initOnlineUi(h0: OnlineUiHooks): void {
  hooks = h0;
  const parts = onlineParts();
  $('mm-cancel').addEventListener('click', () => {
    onlineParts()?.mm.cancel();
    hideFound();
    say('Search cancelled.');
  });
  $('mm-found-cancel').addEventListener('click', () => {
    onlineParts()?.mm.cancel();
    hideFound();
    say('Match cancelled.');
  });
  wireProfile();
  renderProfileButton();
  onProfile(renderProfileButton);
  if (!parts) {
    $('lobby-count').textContent = 'Offline';
    $('find-sub').textContent = 'Online play is unavailable in this browser. Single player works as usual.';
    ($('btn-find') as HTMLButtonElement).disabled = true;
    return;
  }
  const { lobby, mm } = parts;
  lobby.on('change', renderLobby);
  lobby.on('state', renderLobby);
  mm.on('state', () => {
    renderChip();
    renderLobby();
  });
  mm.on('notice', (text: string) => say(text));
  mm.on('found', (found: Found) => showFound(found));
  mm.on('cancelled', (e: { name: string }) => {
    hideFound();
    say(`${e.name} backed out. Back in the queue.`);
  });
  setInterval(renderChip, 500);
  renderLobby();
}

/** Find match from the menu: joins the queue (or says why it can't). */
export function findMatch(): void {
  const parts = onlineParts();
  if (!parts) return;
  if (parts.lobby.state === 'offline') {
    say("Can't reach the online lobby from this network. Single player works as usual.");
    return;
  }
  if (parts.mm.state === 'idle') {
    parts.mm.queue();
    audio.line('announcer.searching');
    say('Searching. Play anything while you wait.');
  }
}

function say(text: string): void {
  notice = text;
  noticeUntil = performance.now() + 5000;
  renderChip();
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function renderChip(): void {
  const parts = onlineParts();
  const chip = $('mm-chip');
  const searching = parts?.mm.state === 'searching';
  const showNotice = notice && performance.now() < noticeUntil;
  const tapPrompt = document.getElementById('tap-to-play');
  chip.hidden = (!searching && !showNotice) || hooks.inOnlineMatch() || !!countdown || !!(tapPrompt && !tapPrompt.hidden);
  if (chip.hidden) return;
  let text = '';
  if (searching && parts) {
    text = `Searching for opponent… ${ago(Date.now() - parts.mm.queuedAt)}`;
    if (parts.mm.natTrouble) text += ' · this network may block player links';
    if (showNotice) text = `${notice} ${ago(Date.now() - parts.mm.queuedAt)}`;
  } else text = notice;
  $('mm-chip-text').textContent = text;
  $('mm-cancel').hidden = !searching;
  chip.classList.toggle('searching', !!searching);
}

function renderLobby(): void {
  const parts = onlineParts();
  if (!parts) return;
  const { lobby, mm } = parts;
  const count = lobby.count();
  const strip = $('lobby-strip');
  strip.dataset.state = lobby.state;
  $('lobby-count').textContent =
    lobby.state === 'connecting' ? 'Connecting…' : lobby.state === 'offline' ? 'Offline: the lobby is unreachable from this network' : `${count} online`;
  const others = lobby.players().filter((p) => !p.self).slice(0, LIST_MAX);
  $('lobby-list').replaceChildren(...others.map(playerChip));
  const find = $('btn-find') as HTMLButtonElement;
  const sub = $('find-sub');
  const fighter = CHARACTERS.find((c) => c.id === profile().avatar)?.name ?? '';
  if (lobby.state === 'offline') sub.textContent = "Online play needs the public lobby, which this network blocks. Single player works as usual.";
  else if (mm.state === 'searching') sub.textContent = 'Searching… (Cancel on the chip up top)';
  else if (mm.state === 'found') sub.textContent = 'Match found!';
  else sub.textContent = `Fight another player as ${fighter}. Play on while you wait.`;
  find.classList.toggle('searching', mm.state !== 'idle');
}

function playerChip(p: Player): HTMLElement {
  const status = p.status === 'queued' ? 'searching' : p.status === 'in-match' ? 'in a match' : '';
  return h(
    'li',
    { class: `lobby-player ${p.status}`, 'data-player': p.id, title: status ? `${p.name} · ${status}` : p.name },
    p.avatar ? h('img', { src: headUrl(p.avatar), alt: '' }) : null,
    h('span', { class: 'lobby-name' }, p.name),
    status ? h('em', {}, status) : null,
  );
}

// ------------------------------------------------------------- match found

function showFound(found: Found): void {
  hideFound();
  const el = $('mm-found');
  const opp = found.opponent;
  $<HTMLImageElement>('mm-found-img').src = headUrl(opp.avatar || CHARACTERS[found.setup.chars[1 - found.slot]].id);
  $('mm-found-name').textContent = `vs ${opp.name}`;
  el.hidden = false;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  audio.sfx('vs-slam');
  audio.line('announcer.match-found');
  const c = { found, left: COUNTDOWN, timer: setInterval(() => step(), 1000) };
  countdown = c;
  const paint = () => ($('mm-found-count').textContent = `Starting in ${c.left}…`);
  const step = () => {
    if (countdown !== c) return;
    c.left--;
    if (c.left > 0) {
      paint();
      audio.sfx('ui-move');
      return;
    }
    clearInterval(c.timer);
    countdown = null;
    $('mm-found-count').textContent = 'Here we go!';
    setTimeout(() => (el.hidden = true), 1200);
    hooks.start(found);
  };
  paint();
  renderChip();
}

function hideFound(): void {
  if (countdown) clearInterval(countdown.timer);
  countdown = null;
  $('mm-found').hidden = true;
  renderChip();
}

export function countdownOn(): boolean {
  return !!countdown;
}

// ----------------------------------------------------------------- profile

let picked = '';

function renderProfileButton(): void {
  const p = profile();
  $<HTMLImageElement>('profile-img').src = headUrl(p.avatar);
  $('profile-sub').textContent = p.name;
  renderLobby();
}

export function openProfile(): void {
  const p = profile();
  picked = p.avatar;
  const input = $<HTMLInputElement>('profile-name');
  input.value = p.name;
  input.maxLength = NAME_MAX;
  renderGrid();
  renderProfileStats();
  $('profile').hidden = false;
  onPanelBack(closeProfile);
  focusFirst();
}

function renderGrid(): void {
  $('profile-grid').replaceChildren(
    ...CHARACTERS.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: `profile-tile${c.id === picked ? ' on' : ''}`,
          role: 'option',
          'aria-selected': String(c.id === picked),
          'aria-label': c.name,
          title: c.name,
          'data-avatar': c.id,
          onclick: () => {
            picked = c.id;
            for (const b of document.querySelectorAll<HTMLElement>('#profile-grid .profile-tile')) {
              const on = b.dataset.avatar === picked;
              b.classList.toggle('on', on);
              b.setAttribute('aria-selected', String(on));
            }
          },
        },
        h('img', { src: headUrl(c.id), alt: '', loading: 'lazy' }),
      ),
    ),
  );
}

export function closeProfile(): void {
  if ($('profile').hidden) return;
  $('profile').hidden = true;
  onPanelBack(null);
  ($('btn-profile') as HTMLButtonElement).focus();
  syncPad();
}

function wireProfile(): void {
  const input = $<HTMLInputElement>('profile-name');
  $('profile-random').addEventListener('click', () => {
    input.value = generatedName();
  });
  const save = () => {
    const before = profile().name;
    const was = profile();
    const next = setProfile({ name: input.value, avatar: picked });
    // The picture is a fighter (who players like to be); the name stays on the device and the relays, never here.
    feature('profile_save', { value: next.avatar, picture_changed: next.avatar !== was.avatar, renamed: next.name !== was.name });
    if (input.value.trim() && next.name === before && input.value.trim() !== before) say('That name can’t be used (2–16 letters, numbers, spaces, - _ . \'). Kept the old one.');
    closeProfile();
  };
  $('profile-save').addEventListener('click', save);
  $('profile-cancel').addEventListener('click', closeProfile);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
}
