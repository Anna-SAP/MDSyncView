import type { ClientMessage, ServerMessage } from '../../../shared/types.ts';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface SyncHandlers {
  onMessage(m: ServerMessage): void;
  onState(s: ConnectionState): void;
}

/** Thin WebSocket client with exponential reconnect and hello/lastSeq handshake. Only one socket at a time. */
export class SyncClient {
  lastSeq: number | null = null;
  serverId: string | null = null;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private closed = false;
  private handlers: SyncHandlers;

  constructor(handlers: SyncHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopPing();
    this.handlers.onState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) { ws.close(); return; }
      this.attempts = 0;
      this.send({ type: 'hello', lastSeq: this.lastSeq, serverId: this.serverId });
      this.handlers.onState('live');
      this.stopPing();
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25000);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      this.handlers.onMessage(m);
    };
    ws.onclose = () => { if (ws === this.ws) this.dropped(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private dropped(): void {
    this.stopPing();
    this.ws = null;
    if (this.closed) { this.handlers.onState('offline'); return; }
    this.handlers.onState('reconnecting');
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempts, 5));
    this.attempts++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.connect(); }, delay);
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Force an immediate reconnect attempt (e.g. when the tab regains focus). No-op while connecting/open. */
  nudge(): void {
    if (this.ws?.readyState === WebSocket.OPEN) { this.send({ type: 'ping' }); return; }
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.stopPing();
    this.ws?.close();
  }
}
