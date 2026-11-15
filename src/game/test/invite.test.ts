// Invite a friend (net/invite.ts): the link carries a code that parses back, and a bad code is no code. Run with `npm test`.
import { inviteCodeFrom, inviteUrl, makeInviteCode } from '../net/invite.ts';

declare const process: { exit(code: number): never };
let failed = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

const code = makeInviteCode();
check(/^[A-HJKMNP-Z2-9]{6}$/.test(code), `a code is 6 easy letters and numbers (${code})`);
check(new Set(Array.from({ length: 40 }, makeInviteCode)).size > 35, 'codes differ');
const url = inviteUrl(code, 'https://doseofdestruction.com/Game/?room=x1&peer=1&junk=2#top');
const u = new URL(url);
check(u.pathname === '/Game/' && u.searchParams.get('invite') === code, 'the link is the game page with ?invite=CODE');
check(u.searchParams.get('room') === 'x1' && !u.searchParams.has('peer') && !u.searchParams.has('junk') && !u.hash, 'only the test room travels with it');
check(inviteCodeFrom(u.search) === code, 'the code reads back from the link');
check(inviteCodeFrom('?invite=abc123') === 'ABC123', 'a typed code is upper-cased');
check(inviteCodeFrom('?invite=a') === '' && inviteCodeFrom('?invite=../../x') === '' && inviteCodeFrom('') === '', 'a short, odd or missing code is none');
process.exit(failed ? 1 : 0);
