// Who plays whom (docs/online.md, "Pairing"). Every queued player runs the same rule on the same lobby, so both
// sides of a pair pick each other without asking anyone: the queue sorted oldest first (time queued, ties by id),
// paired off in twos down the list. The older of the two hosts (slot 0, picks the stage and seed).
//
// Views of the lobby can differ for a second or two while presence spreads; the handshake in matchmaker.ts makes a
// pair real only when both sides have promised each other, so a short disagreement costs a retry, never a double
// pairing.

export interface QueueEntry {
  id: string;
  /** When this queue session started (ms on the player's clock). A new search is a new session. */
  queuedAt: number;
}

export interface Pairing {
  partner: QueueEntry;
  /** True when this player is the older of the two: slot 0, sends the setup. */
  host: boolean;
}

export function queueOrder(a: QueueEntry, b: QueueEntry): number {
  return a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The partner for `self` in `queue` (which includes self), or null to keep waiting. `skip` holds players this one
 * failed to reach lately: they are left out of this player's own pairs only (the other side times out the same way).
 */
export function pairFor(queue: readonly QueueEntry[], self: string, skip: ReadonlySet<string> = new Set()): Pairing | null {
  const order = [...queue].sort(queueOrder);
  const me = order.find((e) => e.id === self);
  if (!me) return null;
  const taken = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    if (taken.has(a.id)) continue;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (taken.has(b.id)) continue;
      // Only this player knows whom it skips; a pair with a skipped player is passed over by this side.
      if ((a.id === self && skip.has(b.id)) || (b.id === self && skip.has(a.id))) continue;
      taken.add(a.id);
      taken.add(b.id);
      if (a.id === self) return { partner: b, host: true };
      if (b.id === self) return { partner: a, host: false };
      break;
    }
    if (a.id === self) return null;
  }
  return null;
}

/** Every pair the rule makes from one view of the queue (for tests and the lobby's debug line). */
export function allPairs(queue: readonly QueueEntry[]): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const e of [...queue].sort(queueOrder)) {
    if (seen.has(e.id)) continue;
    const p = pairFor(queue, e.id);
    if (!p) continue;
    seen.add(e.id);
    seen.add(p.partner.id);
    out.push(p.host ? [e.id, p.partner.id] : [p.partner.id, e.id]);
  }
  return out;
}
