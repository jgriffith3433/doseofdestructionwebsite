// The leaderboard's store on Hawkes Net (docs/online.md, "The leaderboard"; Hawkes Gen docs/net.md "Records"): the signed
// result events board.ts makes, kept by Hawkes Net's records for this project and read back by every page. Hawkes Net
// only keeps them (one per match and publisher, the newest); the signatures and the rules are checked here, as before.
// This is the same small pool the relays' was (subscribe, publish, ready, openUrls), so board.ts is unchanged: a
// subscription is a fetch of the tag's events since a time, then one every 30 s (and right after we publish).
// Off doseofdestruction.com the records are test ones (Hawkes Net keeps them apart), so beta never touches the real table.
import type { Filter, NostrEvent } from './sign.ts';
import { netError } from './util.ts';
import { IS_LIVE, NET_ENDPOINT, NET_PROJECT } from './hawkes.ts';

const POLL_MS = 30000;
const RETRY_MS = 15000;

interface Sub {
  tag: string;
  since: number;
  limit: number;
  onEvent: (e: NostrEvent) => void;
  onEose?: () => void;
  eosed: boolean;
}

export class RecordsPool {
  /** Hawkes Net is taken as reachable until a request fails (the relays' pool was open from the lobby on; a page that
   *  never read the board still sends its own result). */
  private up = true;
  private readonly subs: Sub[] = [];
  private readonly seen = new Set<string>();
  /** Events to publish that haven't gone yet (tried again with the next poll). */
  private readonly waiting: NostrEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readyWaiters: ((ok: boolean) => void)[] = [];

  /** Where the records are: Hawkes Net (one address), while it answers. */
  openUrls(): string[] {
    return this.up ? [NET_ENDPOINT] : [];
  }

  /** Resolves true once Hawkes Net has answered, false after `ms` without. */
  ready(ms: number): Promise<boolean> {
    if (this.up) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.readyWaiters.push(done);
    });
  }

  subscribe(filters: Filter[], onEvent: (e: NostrEvent) => void, onEose?: () => void): { close(): void } {
    const f = filters[0] ?? {};
    const tag = Array.isArray(f['#t']) ? String((f['#t'] as unknown[])[0] ?? '') : '';
    const sub: Sub = { tag, since: Number(f.since) || 0, limit: Number(f.limit) || 3000, onEvent, onEose, eosed: false };
    this.subs.push(sub);
    void this.fetchSub(sub);
    if (!this.timer) this.timer = setInterval(() => this.poll(), POLL_MS);
    return { close: () => this.subs.splice(this.subs.indexOf(sub), 1) };
  }

  /** Sends an event (true: it is on its way; a failure keeps it and tries again). */
  publish(event: NostrEvent): boolean {
    void this.put(event);
    return true;
  }

  private async put(event: NostrEvent): Promise<void> {
    try {
      const r = await fetch(`${NET_ENDPOINT}/v1/net/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: NET_PROJECT, test: !IS_LIVE, event }),
        credentials: 'omit',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // Refused for good (a malformed or oversized record): reported, not retried.
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          netError(`leaderboard: Hawkes Net refused a result (${r.status}: ${(j as { error?: string }).error ?? 'no reason'})`);
          return;
        }
        throw new Error(`Hawkes Net answered ${r.status}`);
      }
      this.markUp(true);
      // Ours shows on the next read: read now rather than in 30 s.
      setTimeout(() => this.poll(), 500);
    } catch (e) {
      this.markUp(false);
      if (!this.waiting.some((x) => x.id === event.id)) this.waiting.push(event);
      console.warn(`[dod-online] leaderboard: a result could not reach Hawkes Net yet (${(e as Error)?.message ?? e}); trying again`);
      setTimeout(() => this.retry(), RETRY_MS);
    }
  }

  private retry(): void {
    for (const e of this.waiting.splice(0)) void this.put(e);
  }

  private poll(): void {
    for (const sub of this.subs) void this.fetchSub(sub);
    if (this.waiting.length) this.retry();
  }

  private async fetchSub(sub: Sub): Promise<void> {
    if (!sub.tag) return;
    const q = new URLSearchParams({ project: NET_PROJECT, tag: sub.tag, limit: String(sub.limit) });
    if (sub.since) q.set('since', String(sub.since));
    if (!IS_LIVE) q.set('test', '1');
    try {
      const r = await fetch(`${NET_ENDPOINT}/v1/net/records?${q}`, { credentials: 'omit' });
      if (!r.ok) throw new Error(`Hawkes Net answered ${r.status}`);
      const j = (await r.json()) as { events?: NostrEvent[] };
      this.markUp(true);
      let newest = sub.since;
      for (const e of j.events ?? []) {
        if (!e || typeof e.id !== 'string') continue;
        newest = Math.max(newest, Number(e.created_at) || 0);
        if (this.seen.has(e.id)) continue;
        this.seen.add(e.id);
        sub.onEvent(e);
      }
      // Next time from a minute before the newest (a record stamped a little late still comes).
      sub.since = Math.max(0, newest - 60);
      if (!sub.eosed) {
        sub.eosed = true;
        sub.onEose?.();
      }
    } catch (e) {
      this.markUp(false);
      console.warn(`[dod-online] leaderboard: Hawkes Net's records did not answer (${(e as Error)?.message ?? e}); the saved table stays`);
    }
  }

  private markUp(up: boolean): void {
    this.up = up;
    if (up) for (const w of this.readyWaiters.splice(0)) w(true);
  }
}

let shared: RecordsPool | null = null;
/** The page's one pool (the leaderboard and anything else that keeps records). */
export function sharedRecords(): RecordsPool {
  return (shared ??= new RecordsPool());
}
