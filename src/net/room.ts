/**
 * Serverless N-peer room for 2-4 player head-to-head. Two transports run
 * together behind one interface:
 *
 *  - BroadcastChannel: instant, zero-infra signaling for players in the SAME
 *    browser (multiple tabs) — how the netcode is tested locally.
 *  - trystero (WebRTC over public relays): cross-device play, no server hosting
 *    the session — data flows peer-to-peer once connected.
 *
 * Every message carries the sender's stable `selfId`, so peers are deduped by
 * identity even if both transports see them, and messages are idempotent (the
 * host's snapshots and guests' inputs are last-write-wins), so duplicate
 * delivery across transports is harmless. Presence is a hello/welcome/bye
 * handshake tracked by selfId.
 *
 * Three logical channels: message (reliable control — roster, ready, start,
 * finish), input (guest -> host live inputs), state (host -> guests snapshots).
 */
import { joinRoom as trysteroJoin, type DataPayload } from 'trystero/nostr';

export type NetRole = 'host' | 'guest';
type Channel = 'msg' | 'input' | 'state';
interface Envelope { from: string; to?: string; ch?: Channel; sys?: 'hello' | 'welcome' | 'bye'; data?: unknown }

export interface RoomHandle {
  role: NetRole;
  code: string;
  selfId: string;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  peers(): string[];
  send(msg: unknown, to?: string): void;
  onMessage(cb: (msg: unknown, from: string) => void): void;
  sendInput(input: unknown, to?: string): void;
  onInput(cb: (input: unknown, from: string) => void): void;
  sendState(state: unknown, to?: string): void;
  onState(cb: (state: unknown, from: string) => void): void;
  leave(): void;
}

const APP_ID = 'override-silverstone-2026';

function randomId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function joinRoom(code: string, role: NetRole): RoomHandle {
  const selfId = randomId();
  const peerSet = new Set<string>();
  const chCbs: Record<Channel, ((data: unknown, from: string) => void) | null> = { msg: null, input: null, state: null };
  let joinCb: ((id: string) => void) | null = null;
  let leaveCb: ((id: string) => void) | null = null;
  /** trystero peerId -> our selfId, so a trystero disconnect maps to a leave */
  const trysteroToSelf = new Map<string, string>();

  const addPeer = (id: string): void => { if (id !== selfId && !peerSet.has(id)) { peerSet.add(id); joinCb?.(id); } };
  const dropPeer = (id: string): void => { if (peerSet.delete(id)) leaveCb?.(id); };

  const handle = (env: Envelope): void => {
    if (!env || env.from === selfId) return;
    if (env.sys === 'hello') { addPeer(env.from); broadcast({ from: selfId, sys: 'welcome', to: env.from }); return; }
    if (env.sys === 'welcome') { if (!env.to || env.to === selfId) addPeer(env.from); return; }
    if (env.sys === 'bye') { dropPeer(env.from); return; }
    if (env.to && env.to !== selfId) return;
    if (env.ch) { addPeer(env.from); chCbs[env.ch]?.(env.data, env.from); }
  };

  // -- transport 1: BroadcastChannel (same-browser)
  const bc = new BroadcastChannel(`ovr-${code}`);
  bc.onmessage = (e: MessageEvent): void => handle(e.data as Envelope);

  // -- transport 2: trystero (cross-device, best-effort)
  let room: ReturnType<typeof trysteroJoin> | null = null;
  const tActions: { env?: { send: (d: DataPayload) => Promise<void> } } = {};
  try {
    room = trysteroJoin({ appId: APP_ID }, code);
    const act = room.makeAction('env');
    act.onMessage = (data, ctx) => {
      const env = data as unknown as Envelope;
      if (env?.from) trysteroToSelf.set(ctx.peerId, env.from);
      handle(env);
    };
    tActions.env = { send: (d) => act.send(d) };
    room.onPeerJoin = () => { void act.send({ from: selfId, sys: 'hello' } as unknown as DataPayload); };
    room.onPeerLeave = (peerId) => { const sid = trysteroToSelf.get(peerId); if (sid) dropPeer(sid); };
  } catch {
    room = null; // trystero unavailable — BroadcastChannel still works
  }

  function broadcast(env: Envelope): void {
    bc.postMessage(env);
    void tActions.env?.send(env as unknown as DataPayload);
  }

  // announce ourselves
  broadcast({ from: selfId, sys: 'hello' });

  const out = (ch: Channel, data: unknown, to?: string): void => broadcast({ from: selfId, ch, to, data });

  return {
    role,
    code,
    selfId,
    onPeerJoin(cb): void { joinCb = cb; },
    onPeerLeave(cb): void { leaveCb = cb; },
    peers(): string[] { return [...peerSet]; },
    send(m, to): void { out('msg', m, to); },
    onMessage(cb): void { chCbs.msg = cb; },
    sendInput(i, to): void { out('input', i, to); },
    onInput(cb): void { chCbs.input = cb; },
    sendState(s, to): void { out('state', s, to); },
    onState(cb): void { chCbs.state = cb; },
    leave(): void {
      try { broadcast({ from: selfId, sys: 'bye' }); } catch { /* ignore */ }
      try { bc.close(); } catch { /* closed */ }
      try { room?.leave(); } catch { /* gone */ }
    },
  };
}

/** Random, easy-to-read 5-char room code (no ambiguous chars). */
export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
