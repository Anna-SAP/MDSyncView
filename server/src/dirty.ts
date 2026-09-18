import { toKey } from './paths.ts';

interface Entry { path: string; root: string; firstAt: number; lastAt: number; hits: number }

/**
 * Coalesces raw watcher events per path. A path is flushed once it has been quiet for `quietMs`
 * or `maxHoldMs` after it was first seen (so a file being streamed to still refreshes periodically).
 */
export class DirtySet {
  private entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  private flushFn: (batch: { path: string; root: string; hits: number }[]) => Promise<void>;
  private quietMs: number;
  private maxHoldMs: number;
  private tickMs: number;

  constructor(
    flushFn: (batch: { path: string; root: string; hits: number }[]) => Promise<void>,
    quietMs = 150,
    maxHoldMs = 1000,
    tickMs = 50,
  ) {
    this.flushFn = flushFn;
    this.quietMs = quietMs;
    this.maxHoldMs = maxHoldMs;
    this.tickMs = tickMs;
  }

  get size(): number { return this.entries.size; }

  mark(fullPath: string, root: string): void {
    const key = toKey(fullPath);
    const now = Date.now();
    const e = this.entries.get(key);
    if (e) { e.lastAt = now; e.hits++; e.path = fullPath; }
    else this.entries.set(key, { path: fullPath, root, firstAt: now, lastAt: now, hits: 1 });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, this.tickMs);
  }

  private async tick(): Promise<void> {
    if (this.flushing) { this.schedule(); return; }
    const now = Date.now();
    const ready: { path: string; root: string; hits: number }[] = [];
    for (const [key, e] of this.entries) {
      if (now - e.lastAt >= this.quietMs || now - e.firstAt >= this.maxHoldMs) {
        ready.push({ path: e.path, root: e.root, hits: e.hits });
        this.entries.delete(key);
      }
    }
    if (ready.length) {
      this.flushing = true;
      try { await this.flushFn(ready); } catch { /* flushFn logs */ } finally { this.flushing = false; }
    }
    if (this.entries.size) this.schedule();
  }

  clear(): void {
    this.entries.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
