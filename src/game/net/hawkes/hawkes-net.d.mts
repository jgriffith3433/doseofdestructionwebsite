// Types for hawkes-net.mjs (Hawkes Net: multiplayer for web games, docs/net.md). Served beside the SDK at
// https://net.hawkesgen.com/sdk/hawkes-net@1.d.ts; keep it in step with hawkes-net.mjs.

export declare const VERSION: string;
export declare const protocols: readonly number[];

/** What Hawkes Net's ticket door answers (your server forwards it to the page as it is). */
export interface Ticket { ticket: string; peer?: string; relayUrl?: string; signalUrl?: string; transports?: string[]; expiresAt?: number; [k: string]: unknown }

export interface RoomConfig {
  /** 'star' (everyone together, the default) or 'pair' (two players at most: a match). */
  topology?: 'star' | 'pair';
  /** Up to the project's limit (64 for customers' projects). */
  maxPlayers?: number;
  /** Peer to peer up to this many, then the relay (up to 8). */
  p2pMax?: number;
  profile?: 'light' | 'medium' | 'heavy';
  /** How often the relay sends each player a bundle (10 to 60). */
  sendHz?: number;
}

export interface JoinOptions {
  /** A Hawkes Net project whose sites may ask without a key (yours is your account's, usr_...: list its sites on net.hawkesgen.com). */
  project?: string;
  /** A ticket from your server, or a function that asks your server for one (called again on reconnects and moves). */
  ticket?: string | (() => Promise<Ticket> | Ticket);
  /** 'relay' (default); 'auto' (peer to peer while small) or 'p2p' only where the project allows peer to peer. */
  transport?: 'auto' | 'p2p' | 'relay';
  name?: string;
  /** Your id for this player: the same person reconnecting keeps their place. */
  sub?: string;
  role?: 'player' | 'spectator' | 'bot' | 'test';
  /** The room's shape if this join opens it. */
  config?: RoomConfig;
  /** The Hawkes Net service (default https://net.hawkesgen.com). */
  endpoint?: string;
  /** A Gen API key: servers, bots and tests only, never a page. */
  key?: string;
  /** Leave when the tab is closed (default true). */
  leaveOnHide?: boolean;
  /** false: no console lines. */
  log?: boolean;
  /** Node only: { RTCPeerConnection } for peer to peer. */
  rtc?: unknown;
  WebSocket?: unknown;
  /** An engine with its own multiplayer logic: every room message in the core's shapes. */
  onRaw?: (m: any) => void;
}

export interface Peer {
  id: string;
  name: string | null;
  color: string | null;
  /** Join order: the lowest is the host. */
  ord: number;
  role: string;
  route: 'self' | 'host' | 'relay' | 'direct' | string;
  rttMs: number | null;
  seenAt: number;
  pose: PoseState | null;
}

/** An avatar: p the position, y the heading (degrees), plus your extra values. */
export interface PoseState { p: [number, number, number]; y: number; [extra: string]: unknown }

export interface MessageMeta { at: number; reliable: boolean; kind: string }

export interface SendOptions {
  /** true (default): once, in order, across reconnects and moves. false: may drop; the newest of its key wins. */
  reliable?: boolean;
  /** One peer only. */
  to?: string;
  /** Me too, in order. */
  self?: boolean;
  /** Unreliable: the newest message with this key replaces an older one still queued (default: its kind). */
  key?: string;
}

export type Off = () => void;
export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface RoomEvents {
  status: { status: RoomStatus; peers: number; transport: 'p2p' | 'relay' };
  ready: { peers: Peer[]; host: string | null; resumed: boolean };
  'peer:join': Peer;
  'peer:leave': { peer: Peer; reason: string };
  host: { host: string | null; previous: string | null; reason: string };
  transport: { from: 'p2p'; to: 'relay'; why: string };
  problem: { code: 'ticket' | 'capped' | 'reload' | 'full' | 'refused' | 'relay-lost' | string; detail: string };
}

export interface Track {
  push(at: number, values: number[], from?: string): void;
  sample(at?: number): number[] | null;
  [k: string]: unknown;
}

export interface Sync {
  /** A shared document (a score, a door): joiners get its newest copy. */
  state(name: string, def: { get(): unknown; set(v: unknown): void }): { remove(): void; resend(): void };
  /** Something that must happen once for everyone, decided by the host. Returns invoke(data). */
  action<T = unknown>(name: string, run: (data: T, o: { authoritative: boolean; from: string | null }) => void): (data: T) => void;
  /** Smooth playback of someone else's snapshots, behind the room's clock. */
  track(o?: Record<string, unknown>): Track;
  /** A thing you simulate: [x, y, z, rx, ry, rz, vx, vy, vz, spin x, y, z] (a prefix is fine). */
  push(id: string, values: number[], o?: { important?: boolean }): void;
  onThing(fn: (id: string, at: number, values: number[], from: string, important: boolean, mask: number) => void): Off;
  thing(id: string): number[] | null;
  onOps(fn: (ops: unknown[], o: { by?: string; fx?: unknown; from?: string }) => void): Off;
  onOwner(fn: (id: string, owner: string | null, locked: boolean) => void): Off;
  claim(id: string, o?: { lock?: boolean }): void;
  hold(id: string, on?: boolean): void;
  release(id: string): void;
  mine(id: string): boolean;
  holder(id: string): string | null;
  owner(id: string): string | null;
  clear(): void;
  onClear(fn: () => void): Off;
  onHost(fn: (isHost: boolean) => void): Off;
  now(): number;
}

export interface Room {
  readonly room: string;
  readonly project: string;
  readonly id: string | null;
  readonly ord: number;
  readonly host: string | null;
  readonly isHost: boolean;
  readonly status: RoomStatus;
  readonly transport: 'p2p' | 'relay';
  readonly peers: Map<string, Peer>;
  /** The room's shared clock (ms). It never jumps. */
  now(): number;
  send(kind: string, data?: unknown, opt?: SendOptions): void;
  /** Messages of one kind ('*' for all). */
  on<T = any>(kind: string, fn: (data: T, from: Peer | null, meta: MessageMeta) => void): Off;
  when<E extends keyof RoomEvents>(event: E, fn: (e: RoomEvents[E]) => void): Off;
  /** Your avatar: call it every frame; the newest goes each send. */
  pose(p: [number, number, number] | number[], yaw?: number, extra?: Record<string, unknown> | null): void;
  onPose(fn: (peer: string, state: PoseState, at: number) => void): Off;
  /** The game's own bytes, now: sent at once, forwarded at once, never queued or resent (between peers on an unordered,
   *  no-retransmit channel). May be lost or reordered: carry your own frame numbers. At most 1200 bytes. False when
   *  there's no way out right now. */
  express(bytes: Uint8Array | ArrayBufferView | ArrayBuffer, opt?: { to?: string }): boolean;
  onExpress(fn: (bytes: Uint8Array, from: string) => void): Off;
  readonly sync: Sync;
  readonly raw: { send(m: any): void };
  stats(): { transport: string; protocol: number; seconds: number; upBytes: number; downBytes: number; upMsgs: number; downMsgs: number; expressUp: number; expressDown: number; rttMs: number | null; clockOffsetMs: number; migrations: number; linkRetries: number; reconnects: number };
  /** Asks to move the room to the relay (a game that knows it will grow). */
  migrate(why?: string): void;
  leave(reason?: string): Promise<void>;
}

/** Joins a room. Resolves when it is ready; rejects when the join is refused. */
export declare function join(room: string, o?: JoinOptions): Promise<Room>;

export type LobbyStatus = 'off' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'full';

export interface LobbyOptions extends JoinOptions {
  /** Your game's own host names (mygame.com, www.mygame.com): there the rooms are live; anywhere else, test rooms (t-...). */
  liveHosts?: string[];
  /** Before every area: "p1/" for a protocol version, so pages that can't talk never meet. */
  prefix?: string;
  /** The most shards tried before the status is "full" (20). */
  maxShards?: number;
  /** The page's address for room names (default location.href). */
  url?: string;
}

export interface LobbyEvents extends Omit<RoomEvents, 'status' | 'ready'> {
  status: { status: LobbyStatus; area: string; room: string };
  joined: Room;
  left: Room;
}

/** Shared rooms by area, kept joined: the standard way a game puts its players together. */
export interface Lobby {
  readonly area: string;
  /** 1 = the first room of the area; 2 = "<area>.2"... */
  readonly shard: number;
  readonly roomName: string;
  readonly status: LobbyStatus;
  readonly lastProblem: string;
  /** The room now (null between rooms). */
  readonly room: Room | null;
  readonly ready: boolean;
  readonly peers: Map<string, Peer>;
  readonly host: string | null;
  readonly id: string | null;
  readonly isLive: boolean;
  /** The playtest's own room id (?room= on the page), "" otherwise. */
  readonly testRoom: string;
  now(): number;
  nameFor(area: string, shard?: number): string;
  /** Joins an area's shared room (the first with room, or this shard). */
  join(area: string, shard?: number): void;
  /** Leaves and stays out until the next join. */
  leave(): void;
  /** The current room's (dropped while not in one). */
  send(kind: string, data?: unknown, opt?: SendOptions): void;
  pose(p: [number, number, number] | number[], yaw?: number, extra?: Record<string, unknown> | null): void;
  express(bytes: Uint8Array | ArrayBufferView | ArrayBuffer, opt?: { to?: string }): boolean;
  onExpress(fn: (bytes: Uint8Array, from: string) => void): Off;
  /** Stays subscribed across rooms. */
  on<T = any>(kind: string, fn: (data: T, from: Peer | null, meta: MessageMeta) => void): Off;
  onPose(fn: (peer: string, state: PoseState, at: number) => void): Off;
  when<E extends keyof LobbyEvents>(event: E, fn: (e: LobbyEvents[E]) => void): Off;
}

export declare function lobby(o?: LobbyOptions): Lobby;

declare const _default: { join: typeof join; lobby: typeof lobby; VERSION: string; protocols: readonly number[]; Track: unknown; Links: unknown };
export default _default;
