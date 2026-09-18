import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, FileEvent, RootInfo, ServerMessage, Stats } from '../../shared/types.ts';
import { log } from './log.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Outgoing = DistributiveOmit<Extract<ServerMessage, { type: 'events' | 'scan' | 'roots' | 'stats' }>, 'seq'>;

const RING_MAX = 5000;
const EVENT_CHUNK = 400;
/**
 * A remove is held back briefly so that the rename it may be half of (the "new path" side is often
 * discovered a little later, in another dirty batch) can cancel it. Clients never see remove+add for a rename.
 */
const REMOVE_HOLD_MS = 400;

/**
 * WebSocket fan-out with monotonically increasing sequence numbers and a replay ring so clients that
 * reconnect (sleep, tab suspension, network blip) can catch up exactly, or are told to resync.
 */
export class EventHub {
  readonly serverId = randomUUID();
  seq = 0;
  lastEventAt: number | null = null;
  private ring: ServerMessage[] = [];
  private clients = new Set<WebSocket>();
  private pending: FileEvent[] = [];
  private heldRemoves: { ev: FileEvent; at: number }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private wss: WebSocketServer | null = null;

  private hello: () => { stats: Stats; roots: RootInfo[] };
  private isOriginAllowed: (origin: string | undefined) => boolean;

  constructor(
    hello: () => { stats: Stats; roots: RootInfo[] },
    isOriginAllowed: (origin: string | undefined) => boolean,
  ) {
    this.hello = hello;
    this.isOriginAllowed = isOriginAllowed;
  }

  get clientCount(): number { return this.clients.size; }

  attach(server: http.Server, wsPath = '/ws'): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== wsPath) return;
      if (!this.isOriginAllowed(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('message', (data) => {
      let msg: ClientMessage | null = null;
      try { msg = JSON.parse(data.toString()) as ClientMessage; } catch { msg = null; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') this.handleHello(ws, msg);
      else if (msg.type === 'ping') this.sendTo(ws, { type: 'pong', seq: this.seq, at: Date.now() });
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private handleHello(ws: WebSocket, msg: Extract<ClientMessage, { type: 'hello' }>): void {
    const { stats, roots } = this.hello();
    if (msg.serverId === this.serverId && typeof msg.lastSeq === 'number') {
      const oldest = this.ring.length ? this.ring[0]!.seq : this.seq + 1;
      if (msg.lastSeq >= this.seq) {
        // nothing missed
      } else if (msg.lastSeq >= oldest - 1) {
        for (const m of this.ring) if (m.seq > msg.lastSeq) this.sendTo(ws, m);
      } else {
        this.sendTo(ws, { type: 'resync', seq: this.seq, reason: 'gap-too-large' });
      }
    } else {
      this.sendTo(ws, { type: 'resync', seq: this.seq, reason: msg.serverId ? 'server-restarted' : 'initial' });
    }
    this.sendTo(ws, { type: 'hello', seq: this.seq, stats, roots, serverId: this.serverId });
  }

  private sendTo(ws: WebSocket, m: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(m)); } catch { /* ignore */ }
  }

  /** Queue file events; they are coalesced into one message per ~80ms (removes are held a bit longer). */
  emitFileEvents(events: FileEvent[]): void {
    if (!events.length) return;
    const now = Date.now();
    for (const e of events) {
      if (e.op === 'remove') this.heldRemoves.push({ ev: e, at: now });
      else this.pending.push(e);
    }
    this.lastEventAt = now;
    this.schedule(80);
  }

  private schedule(ms: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushEvents(), ms);
  }

  flushEvents(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const now = Date.now();
    // A rename supersedes the remove of its old path, whether that remove is still held or arrived together.
    const renamedFrom = new Set<string>();
    for (const e of this.pending) if (e.op === 'rename' && e.oldKey) renamedFrom.add(e.oldKey);
    if (renamedFrom.size) this.heldRemoves = this.heldRemoves.filter((h) => !renamedFrom.has(h.ev.key));
    const due: FileEvent[] = [];
    const stillHeld: { ev: FileEvent; at: number }[] = [];
    for (const h of this.heldRemoves) { if (now - h.at >= REMOVE_HOLD_MS) due.push(h.ev); else stillHeld.push(h); }
    this.heldRemoves = stillHeld;
    const events = [...due, ...this.pending];
    this.pending = [];
    for (let i = 0; i < events.length; i += EVENT_CHUNK) {
      this.broadcast({ type: 'events', events: events.slice(i, i + EVENT_CHUNK) });
    }
    if (stillHeld.length) this.schedule(Math.max(10, REMOVE_HOLD_MS - (now - stillHeld[0]!.at) + 5));
  }

  /** Everything queued, including held removes, goes out now (shutdown / snapshot consistency). */
  flushAll(): void {
    for (const h of this.heldRemoves) h.at = 0;
    this.flushEvents();
  }

  broadcast(msg: Outgoing): void {
    const m = { ...msg, seq: ++this.seq } as ServerMessage;
    this.ring.push(m);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    if (!this.clients.size) return;
    const data = JSON.stringify(m);
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch (e) { log.warn('ws', 'send failed', e); }
      }
    }
  }

  close(): void {
    this.flushAll();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const c of this.clients) { try { c.close(1001, 'server shutting down'); } catch { /* ignore */ } }
    this.clients.clear();
    this.wss?.close();
  }
}
