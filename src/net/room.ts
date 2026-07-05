/**
 * Serverless peer-to-peer room for head-to-head play. Two transports run
 * together behind one interface, and whichever finds the opponent first wins:
 *
 *  - BroadcastChannel: instant, zero-infra signaling for two players in the
 *    SAME browser (two tabs / same device split-screen) — and how the netcode
 *    is tested locally.
 *  - trystero (WebRTC over public relays): cross-device play with no server
 *    hosting the session — the data flows peer-to-peer once connected.
 *
 * Three logical channels — message (reliable control), input (guest→host live
 * inputs), state (host→guest snapshots) — are multiplexed over both transports.
 */
import { joinRoom as trysteroJoin, type DataPayload } from 'trystero/nostr';

export type NetRole = 'host' | 'guest';
type Channel = 'msg' | 'input' | 'state';

export interface RoomHandle {
  role: NetRole;
  code: string;
  onPeer(cb: (connected: boolean) => void): void;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  sendInput(input: unknown): void;
  onInput(cb: (input: unknown) => void): void;
  sendState(state: unknown): void;
  onState(cb: (state: unknown) => void): void;
  isConnected(): boolean;
  leave(): void;
}

const APP_ID = 'override-silverstone-2026';

export function joinRoom(code: string, role: NetRole): RoomHandle {
  let connected = false;
  let peerCb: ((c: boolean) => void) | null = null;
  const cbs: Record<Channel, ((data: unknown) => void) | null> = { msg: null, input: null, state: null };

  const markConnected = (): void => { if (!connected) { connected = true; peerCb?.(true); } };
  const markGone = (): void => { if (connected) { connected = false; peerCb?.(false); } };

  // -- transport 1: BroadcastChannel (same-browser)
  const bc = new BroadcastChannel(`ovr-${code}`);
  bc.onmessage = (e: MessageEvent): void => {
    const d = e.data as { __sys?: string; __ch?: Channel; data?: unknown };
    if (d.__sys === 'hello') { markConnected(); bc.postMessage({ __sys: 'ack' }); }
    else if (d.__sys === 'ack') markConnected();
    else if (d.__sys === 'bye') markGone();
    else if (d.__ch) cbs[d.__ch]?.(d.data);
  };
  bc.postMessage({ __sys: 'hello' });

  // -- transport 2: trystero (cross-device, best-effort)
  let room: ReturnType<typeof trysteroJoin> | null = null;
  const tActions: Partial<Record<Channel, { send: (d: DataPayload) => Promise<void> }>> = {};
  try {
    room = trysteroJoin({ appId: APP_ID }, code);
    (['msg', 'input', 'state'] as Channel[]).forEach((ch) => {
      const a = room!.makeAction(ch);
      a.onMessage = (data) => cbs[ch]?.(data);
      tActions[ch] = a;
    });
    room.onPeerJoin = () => markConnected();
    room.onPeerLeave = () => markGone();
  } catch {
    room = null; // trystero unavailable — BroadcastChannel still works
  }

  const out = (ch: Channel, data: unknown): void => {
    bc.postMessage({ __ch: ch, data });
    void tActions[ch]?.send(data as DataPayload);
  };

  return {
    role,
    code,
    onPeer(cb): void { peerCb = cb; },
    send(m): void { out('msg', m); },
    onMessage(cb): void { cbs.msg = cb; },
    sendInput(i): void { out('input', i); },
    onInput(cb): void { cbs.input = cb; },
    sendState(s): void { out('state', s); },
    onState(cb): void { cbs.state = cb; },
    isConnected(): boolean { return connected; },
    leave(): void {
      try { bc.postMessage({ __sys: 'bye' }); bc.close(); } catch { /* closed */ }
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
