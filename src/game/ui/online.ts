// The online parts of the page (docs/online.md): the lobby strip on the main menu ("N online" and who), Find match,
// the "Searching for opponent… 0:42 · Cancel" chip that stays up over whatever the player does meanwhile, the
// "Match found vs <name> — starting in 5…" banner, and the Profile panel.

import { CHARACTERS } from '../sim/characters.ts';
import { isUnlocked } from '../campaign/story.ts';
import { audio } from '../audio.ts';
import { $, h, headUrl } from './dom.ts';
import { focusFirst, onPanelBack, syncPad } from './screens.ts';
import { onlineParts } from '../net/online.ts';
import { NAME_MAX, generatedName, onProfile, profile, setProfile } from '../net/profile.ts';
import type { Found } from '../net/matchmaker.ts';
import type { Player } from '../net/lobby.ts';
import { renderProfileStats } from './leaderboard.ts';
import { feature } from '../analytics.ts';
import { Invite, inviteUrl, makeInviteCode, type Friend, type InviteState } from '../net/invite.ts';

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
  wireInvite();
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
  // Screens make room under the chip while it is up (game.css), so it never covers their Back button or title.
  document.body.classList.toggle('mm-chip-on', !chip.hidden);
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
  // The match is made: the invite room has done its job.
  closeInvite();
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
          class: `profile-tile${c.id === picked ? ' on' : ''}${isUnlocked(c.id) ? '' : ' locked'}`,
          'aria-disabled': isUnlocked(c.id) ? undefined : 'true',
          role: 'option',
          'aria-selected': String(c.id === picked),
          'aria-label': c.name,
          title: isUnlocked(c.id) ? c.name : `${c.name} (locked)`,
          'data-avatar': c.id,
          onclick: () => {
            if (!isUnlocked(c.id)) return;
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


// ------------------------------------------------------------------ invite

let invite: Invite | null = null;
let inviteLink = '';

const inviteEvent = (phase: string, extra: Record<string, unknown> = {}) =>
  window.dispatchEvent(new CustomEvent('dod:invite', { detail: { phase, code: invite?.code ?? '', ...extra } }));

const INVITE_TEXT: Record<InviteState, string> = {
  joining: 'Joining your friend’s room…',
  waiting: 'Send the link. The fight starts when they open it.',
  paired: 'Your friend is in. Linking up…',
  full: 'That room is full: two players are already in it.',
  closed: 'That invite has ended. Your friend left the room.',
  offline: 'Can’t reach the online lobby from this network.',
  ended: 'Invite closed.',
};

/** Online > Invite a friend: makes a private room, shows its link and offers it to the share sheet (or copies it). */
export function inviteFriend(): void {
  const parts = onlineParts();
  if (!parts) return;
  if (parts.mm.state === 'found') {
    say('A match is starting. Invite after it.');
    return;
  }
  const code = makeInviteCode();
  inviteLink = inviteUrl(code);
  openInvitePanel(code, true);
  feature('invite', { value: 'create' });
  // The share sheet needs the tap that opened this: share before anything is awaited.
  void shareInvite();
}

/** Someone opened an invite link: straight into that room (main.ts, past the title). */
export function openInvite(code: string): void {
  const parts = onlineParts();
  if (!parts) return;
  inviteLink = inviteUrl(code);
  openInvitePanel(code, false);
  feature('invite', { value: 'open' });
}

function openInvitePanel(code: string, host: boolean): void {
  const parts = onlineParts();
  if (!parts) return;
  closeInvite();
  // A search in the queue yields to the invite (the same player can't be in both).
  if (parts.mm.state === 'searching' && !parts.mm.invited) parts.mm.cancel();
  const me = parts.lobby.me;
  const inv = new Invite(code, host, { id: me.id, name: me.name, avatar: me.avatar });
  invite = inv;
  inv.on('state', (s: InviteState) => {
    if (invite !== inv) return;
    renderInvite();
    inviteEvent('state', { state: s });
    if (s === 'full' || s === 'closed') feature('invite', { value: s });
    // A friend who left before the match was made: stop pairing with them.
    if ((s === 'waiting' || s === 'closed') && parts.mm.invited) parts.mm.cancel();
  });
  inv.on('friend', (f: Friend) => {
    if (invite !== inv) return;
    renderInvite();
    inviteEvent('friend', { friend: f.name });
    if (parts.mm.state === 'searching' && !parts.mm.invited) parts.mm.cancel();
    if (parts.mm.invite(f.id, host)) audio.sfx('ui-select');
  });
  $('invite').hidden = false;
  onPanelBack(closeInvitePanel);
  renderInvite();
  inviteEvent('open', { host });
  focusFirst();
  void inv.start();
}

function renderInvite(): void {
  const inv = invite;
  if (!inv) return;
  const panel = $('invite');
  panel.dataset.state = inv.state;
  panel.dataset.host = String(inv.host);
  $('invite-title').textContent = inv.host ? 'Invite a friend' : 'Invite';
  const line = inv.state === 'paired' && inv.friend ? `${inv.friend.name} is in. Linking up…` : INVITE_TEXT[inv.state];
  $('invite-status').textContent = line;
  const showLink = inv.host && (inv.state === 'waiting' || inv.state === 'paired' || inv.state === 'joining');
  $('invite-share-row').hidden = !showLink;
  $<HTMLInputElement>('invite-link').value = inviteLink;
  const problem = inv.state === 'full' || inv.state === 'closed' || inv.state === 'offline';
  $('invite-quick').hidden = !problem || inv.state === 'offline';
  $('invite-cancel').textContent = problem ? 'Close' : 'Cancel';
}

/** Hands the link to the system share sheet, or copies it when there isn't one. Says which in the panel. */
async function shareInvite(): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const url = inviteLink;
  const note = $('invite-note');
  const done = (r: 'shared' | 'copied' | 'cancelled' | 'failed', text: string) => {
    note.textContent = text;
    inviteEvent(r === 'shared' ? 'shared' : r === 'copied' ? 'copied' : 'share-' + r, { url });
    if (r === 'shared' || r === 'copied') {
      audio.sfx('ui-select');
      feature('invite', { value: r === 'shared' ? 'share' : 'copy' });
    }
    return r;
  };
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Dose of Destruction', text: 'Fight me in Dose of Destruction.', url });
      return done('shared', 'Shared. Waiting for your friend.');
    } catch (e) {
      // Closing the sheet is a choice, not a failure; anything else falls back to copying.
      if ((e as Error)?.name === 'AbortError') return done('cancelled', 'Not shared. Tap Share or Copy link.');
    }
  }
  return copyInvite(done);
}

async function copyInvite(done?: (r: 'copied' | 'failed', text: string) => 'copied' | 'failed' | 'shared' | 'cancelled'): Promise<'copied' | 'failed' | 'shared' | 'cancelled'> {
  const url = inviteLink;
  const fin = done ?? ((r: 'copied' | 'failed', text: string) => {
    $('invite-note').textContent = text;
    inviteEvent(r === 'copied' ? 'copied' : 'share-failed', { url });
    if (r === 'copied') {
      audio.sfx('ui-select');
      feature('invite', { value: 'copy' });
    }
    return r;
  });
  try {
    await navigator.clipboard.writeText(url);
    return fin('copied', 'Link copied. Paste it to your friend.');
  } catch {
    // No clipboard permission: select the link so a long press or Ctrl+C copies it.
    const input = $<HTMLInputElement>('invite-link');
    input.focus();
    input.select();
    try {
      if (document.execCommand('copy')) return fin('copied', 'Link copied. Paste it to your friend.');
    } catch {
      // Falls through to the plain line.
    }
    return fin('failed', 'Press and hold the link to copy it.');
  }
}

function closeInvite(): void {
  const inv = invite;
  invite = null;
  inv?.close();
}

export function closeInvitePanel(): void {
  if ($('invite').hidden) return;
  const parts = onlineParts();
  if (parts?.mm.invited) parts.mm.cancel();
  closeInvite();
  hideInvitePanel();
  inviteEvent('closed');
}

function hideInvitePanel(): void {
  $('invite').hidden = true;
  onPanelBack(null);
  ($('btn-invite') as HTMLButtonElement).focus();
  syncPad();
}

function wireInvite(): void {
  $('invite-share').addEventListener('click', () => void shareInvite());
  $('invite-copy').addEventListener('click', () => void copyInvite());
  $('invite-cancel').addEventListener('click', closeInvitePanel);
  $('invite-quick').addEventListener('click', () => {
    closeInvitePanel();
    findMatch();
  });
  $<HTMLInputElement>('invite-link').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
}

/** What a playtest reads: the invite as it stands. */
export function inviteInfo(): { code: string; link: string; state: InviteState | ''; friend: string } {
  return { code: invite?.code ?? '', link: inviteLink, state: invite?.state ?? '', friend: invite?.friend?.name ?? '' };
}
