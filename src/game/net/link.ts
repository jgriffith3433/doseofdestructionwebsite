// One direct WebRTC link to another peer: a reliable, ordered data channel for events and an unreliable, unordered
// one (no retransmits) for the per-frame inputs. Both are negotiated up front (ids 1 and 2), so the answering side
// makes the same two and no second negotiation is needed. ICE is gathered before the offer or answer is sent (one
// signalling message each way); STUN is Google's and Cloudflare's. Adapted from Yooba Land's hawkes-net (src/link.js).
import { ICE_SERVERS } from './util.ts';

const GATHER_MS = 2500;
const CONNECT_MS = 15000;
const DISCONNECTED_MS = 5000;

export interface LinkHandlers {
  open(): void;
  message(text: string, reliable: boolean): void;
  close(reason: string, was: string): void;
}

export class PeerLink {
  readonly remoteId: string;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  readonly startedAt = Date.now();
  openedAt = 0;
  initiator = false;
  sid = '';
  readonly pc: RTCPeerConnection;
  private readonly reliable: RTCDataChannel;
  private readonly unreliable: RTCDataChannel;
  private readonly handlers: LinkHandlers;
  private connectTimer: ReturnType<typeof setTimeout>;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(remoteId: string, handlers: LinkHandlers, rtc?: typeof RTCPeerConnection) {
    this.remoteId = remoteId;
    this.handlers = handlers;
    const Peer = rtc ?? globalThis.RTCPeerConnection;
    // A fresh copy each time: some implementations rewrite the config they are given.
    this.pc = new Peer({ iceServers: ICE_SERVERS.map((s) => ({ urls: s.urls })) });
    this.reliable = this.pc.createDataChannel('r', { negotiated: true, id: 1, ordered: true });
    this.unreliable = this.pc.createDataChannel('u', { negotiated: true, id: 2, ordered: false, maxRetransmits: 0 });
    for (const [channel, reliable] of [[this.reliable, true], [this.unreliable, false]] as const) {
      channel.onmessage = (event) => {
        if (typeof event.data === 'string') this.handlers.message(event.data, reliable);
      };
      channel.onclose = () => {
        if (reliable) this.close('channel closed');
      };
    }
    this.reliable.onopen = () => {
      if (this.state !== 'connecting') return;
      this.state = 'open';
      this.openedAt = Date.now();
      clearTimeout(this.connectTimer);
      this.handlers.open();
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close('connection ' + s);
      else if (s === 'disconnected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.connectionState === 'disconnected') this.close('disconnected');
        }, DISCONNECTED_MS);
      }
    };
    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') this.close('timed out connecting');
    }, CONNECT_MS);
  }

  private gathered(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, GATHER_MS);
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      this.pc.addEventListener('icecandidate', (e) => {
        if (!e.candidate) check();
      });
    });
  }

  async offer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    return this.pc.localDescription!.sdp;
  }

  async answer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    return this.pc.localDescription!.sdp;
  }

  async accept(sdp: string): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  send(text: string, reliable: boolean): boolean {
    if (this.state !== 'open') return false;
    const channel = !reliable && this.unreliable.readyState === 'open' ? this.unreliable : this.reliable;
    if (channel.readyState !== 'open') return false;
    // Drop input packets rather than queue them behind a congested channel: the next one carries them again.
    if (!reliable && channel.bufferedAmount > 64 * 1024) return false;
    try {
      channel.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Which kind of route the connection settled on ("host", "srflx", "relay"), when the browser can tell. */
  async route(): Promise<string> {
    try {
      const stats = await this.pc.getStats();
      let pair: { localCandidateId?: string } | null = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
      const local = pair && (pair as { localCandidateId?: string }).localCandidateId ? stats.get((pair as { localCandidateId: string }).localCandidateId) : null;
      return local ? local.candidateType || '' : '';
    } catch {
      return '';
    }
  }

  close(reason?: string): void {
    if (this.state === 'closed') return;
    const was = this.state;
    this.state = 'closed';
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
    this.handlers.close(reason || 'closed', was);
  }
}
