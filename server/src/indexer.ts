import fs from 'node:fs';
import path from 'node:path';
import type { FileEvent, ScanProgress } from '../../shared/types.ts';
import { Index, type FileRow } from './db.ts';
import { readMarkdown } from './content.ts';
import { extractMeta } from './md-meta.ts';
import { isMarkdownPath, isWithin, toDisplay, toKey, type ExcludeMatcher } from './paths.ts';
import { walk, type ScanCandidate } from './scanner.ts';
import { log } from './log.ts';

const MOVE_WINDOW_MS = 3000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const READ_CONCURRENCY = 8;

export type Prepared =
  | { kind: 'row'; row: FileRow; body: string; existed: boolean }
  | { kind: 'touch'; key: string; size: number; mtime: number; ctime: number; display: string }
  | { kind: 'remove'; key: string };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface IndexerOptions {
  maxIndexedBytes: () => number;
  exclude: () => ExcludeMatcher;
  /** Configured roots (display paths). */
  roots: () => string[];
}

/**
 * Turns filesystem observations into index mutations and FileEvents.
 * Principle: events are hints; stat + content hash is the truth.
 */
export class Indexer {
  private recentlyRemoved = new Map<string, { key: string; path: string; at: number }>();
  private recentlyAdded = new Map<string, { key: string; path: string; at: number }>();

  private db: Index;
  private opts: IndexerOptions;

  constructor(db: Index, opts: IndexerOptions) {
    this.db = db;
    this.opts = opts;
  }

  /** Longest configured root containing `key`, or null when the path is outside every root. */
  rootOf(key: string): string | null {
    let best: string | null = null;
    let bestLen = -1;
    for (const r of this.opts.roots()) {
      const rk = toKey(r);
      if (isWithin(rk, key) && rk.length > bestLen) { best = r; bestLen = rk.length; }
    }
    return best;
  }

  /** True when a directory key lives inside an excluded directory (any ancestor segment). */
  isExcludedKey(key: string, rootKey: string): boolean {
    if (!isWithin(rootKey, key)) return false;
    const rel = key.slice(rootKey.length).replace(/^\//, '');
    if (!rel) return false;
    const segs = rel.split('/');
    let cur = rootKey;
    const exclude = this.opts.exclude();
    for (let i = 0; i < segs.length; i++) {
      cur += '/' + segs[i];
      const isLast = i === segs.length - 1;
      if (isLast && isMarkdownPath(segs[i]!)) break;
      if (exclude.dir(segs[i]!, cur)) return true;
    }
    return false;
  }

  /** Index one discovered file if it differs from what the index knows. */
  async indexCandidate(c: ScanCandidate, root: string, force = false): Promise<FileEvent | null> {
    const p = await this.prepareCandidate(c, root, force);
    if (!p) return null;
    return this.db.transaction(() => this.applyPrepared(p));
  }

  /**
   * Phase 1 (async I/O + CPU, no DB writes): decide what a discovered file needs.
   * Returns null when the index is already current.
   */
  async prepareCandidate(c: ScanCandidate, root: string, force = false): Promise<Prepared | null> {
    const existing = this.db.getLite(c.key);
    const display = toDisplay(c.path);
    if (existing && !force && existing.size === c.size && existing.mtime === c.mtime) {
      // unchanged content; a case-only rename still needs its display path refreshed
      if (existing.path !== display) return { kind: 'touch', key: c.key, size: c.size, mtime: c.mtime, ctime: c.ctime, display };
      return null;
    }

    const r = await readMarkdown(c.path, { maxBytes: MAX_READ_BYTES });
    if (!r.ok) {
      if (r.error === 'ENOENT') return { kind: 'remove', key: c.key };
      if (r.error === 'EISDIR') return null;
      log.warn('index', `cannot read ${c.path}: ${r.error} ${r.message}`);
      return null;
    }
    if (existing && existing.hash === r.hash) {
      return { kind: 'touch', key: c.key, size: r.size, mtime: r.mtime, ctime: r.ctime, display };
    }
    const now = Date.now();
    const meta = extractMeta(display, r.text);
    const row: FileRow = {
      key: c.key,
      path: display,
      name: path.basename(display),
      dir: path.dirname(display),
      root: toKey(this.rootOf(c.key) ?? root),
      size: r.size,
      mtime: r.mtime,
      ctime: r.ctime,
      hash: r.hash,
      title: meta.title,
      excerpt: meta.excerpt,
      tags: meta.tags,
      wordCount: meta.wordCount,
      headingCount: meta.headings.length,
      headings: meta.headings,
      frontmatter: meta.frontmatter,
      wikiLinks: meta.wikiLinks,
      indexedAt: now,
    };
    const cap = this.opts.maxIndexedBytes();
    const body = (r.text.length > cap ? r.text.slice(0, cap) : r.text).slice(meta.bodyOffset);
    return { kind: 'row', row, body, existed: existing !== null };
  }

  /** Phase 2 (sync DB mutation): apply a prepared change and produce the event. Call inside a transaction. */
  applyPrepared(p: Prepared): FileEvent | null {
    const now = Date.now();
    if (p.kind === 'remove') return this.removeKey(p.key);
    if (p.kind === 'touch') {
      this.db.touch(p.key, p.size, p.mtime, p.ctime, p.display);
      const file = this.db.getRecord(p.key);
      return file ? { op: 'touch', key: p.key, file, at: now } : null;
    }
    this.db.upsert(p.row, p.body);
    const file = this.db.getRecord(p.row.key)!;
    if (p.existed) return { op: 'change', key: p.row.key, file, at: now };

    const hk = `${p.row.hash}:${p.row.size}`;
    const moved = this.recentlyRemoved.get(hk);
    if (moved && moved.key === p.row.key) this.recentlyRemoved.delete(hk); // the same file came back: plain add
    // A rename is only claimed for non-trivial content whose old path is really gone (empty/template files
    // collide on hash+size all the time).
    else if (moved && now - moved.at <= MOVE_WINDOW_MS && p.row.size > 0 && !fs.existsSync(moved.path)) {
      this.recentlyRemoved.delete(hk);
      return { op: 'rename', key: p.row.key, oldKey: moved.key, file, at: now };
    }
    this.recentlyAdded.set(hk, { key: p.row.key, path: p.row.path, at: now });
    this.gc(now);
    return { op: 'add', key: p.row.key, file, at: now };
  }

  /** Remove one key from the index (no-op if unknown). Detects "add then remove" rename pairs. */
  removeKey(key: string): FileEvent | null {
    const row = this.db.remove(key);
    if (!row) return null;
    const now = Date.now();
    const hk = `${row.hash}:${row.size}`;
    const added = this.recentlyAdded.get(hk);
    if (added && added.key === key) this.recentlyAdded.delete(hk);
    else if (added && now - added.at <= MOVE_WINDOW_MS && row.size > 0 && this.db.getLite(added.key) !== null && fs.existsSync(added.path)) {
      this.recentlyAdded.delete(hk);
      const file = this.db.getRecord(added.key);
      if (file) return { op: 'rename', key: added.key, oldKey: key, file, at: now };
    }
    this.recentlyRemoved.set(hk, { key, path: row.path, at: now });
    this.gc(now);
    return { op: 'remove', key, at: now };
  }

  /** Remove `prefixKey` itself and every indexed file beneath it. */
  removeUnder(prefixKey: string): FileEvent[] {
    const rows = this.db.underLite(prefixKey);
    const out: FileEvent[] = [];
    for (const r of rows) { const ev = this.removeKey(r.key); if (ev) out.push(ev); }
    return out;
  }

  /**
   * Resolve a dirty path against reality: missing → removals; directory → subtree reconcile; file → index.
   */
  async verifyPath(fullPath: string, root: string, emit: (events: FileEvent[]) => void, onProgress?: (p: ScanProgress) => void, opts: { forceWalk?: boolean; noGrace?: boolean } = {}): Promise<void> {
    const key = toKey(fullPath);
    const rootKey = toKey(root);
    if (this.isExcludedKey(key, rootKey)) return;
    const known = this.db.hasUnder(key);
    const st = await this.statWithGrace(fullPath, known && !opts.noGrace);
    if (st === 'transient') return; // EPERM/EBUSY: a later event or reconcile will settle it
    if (st === null) {
      const evs = this.removeUnder(key);
      if (evs.length) emit(evs);
      return;
    }
    if (st.isSymbolicLink()) return; // never follow junctions/symlinks (the walk does not either)
    if (st.isDirectory()) {
      // Child events already describe changes inside a directory we know about; a walk is only needed
      // when the directory is new to us (created / renamed in) or explicitly requested.
      if (!opts.forceWalk && known) return;
      await this.reconcile(fullPath, root, emit, onProgress);
      return;
    }
    if (st.isFile()) {
      if (!isMarkdownPath(fullPath)) return;
      const ev = await this.indexCandidate({ path: fullPath, key, size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.birthtimeMs || st.ctimeMs) }, root);
      if (ev) emit([ev]);
    }
  }

  /**
   * Walk `dirPath` and make the index match the disk beneath it: index new/changed files, drop vanished ones.
   */
  async reconcile(dirPath: string, root: string, emit: (events: FileEvent[]) => void, onProgress?: (p: ScanProgress) => void, signal?: AbortSignal): Promise<{ dirs: number; files: number; changed: number; removed: number; elapsedMs: number; aborted: boolean }> {
    const started = Date.now();
    const prefixKey = toKey(dirPath);
    const seen = new Set<string>();
    let changed = 0;
    let pending: FileEvent[] = [];
    const flushPending = () => { if (pending.length) { emit(pending); pending = []; } };
    const report = (phase: ScanProgress['phase'], dirs: number, files: number, error?: string) =>
      onProgress?.({ root, phase, dirsScanned: dirs, filesFound: files, elapsedMs: Date.now() - started, error });

    report('start', 0, 0);
    const res = await walk(dirPath, {
      exclude: this.opts.exclude(),
      concurrency: 16,
      signal,
      onError: (e) => log.error('index', `batch failed under ${dirPath} (files in it stay unindexed until the next reconcile)`, e),
      onProgress: (p) => report('progress', p.dirs, p.files),
      onFiles: async (batch) => {
        for (const c of batch) seen.add(c.key);
        if (signal?.aborted) return;
        // Phase 1: read + parse concurrently (bounded so Defender/real-time scanning does not choke us).
        const prepared = await mapLimit(batch, READ_CONCURRENCY, async (c) => {
          try { return await this.prepareCandidate(c, root); } catch (e) { log.warn('index', `failed on ${c.path}`, e); return null; }
        });
        const todo = prepared.filter((p): p is Prepared => p !== null);
        if (!todo.length) return;
        // Phase 2: one transaction per batch.
        const events = this.db.transaction(() => todo.map((p) => this.applyPrepared(p)).filter((e): e is FileEvent => e !== null));
        for (const ev of events) { pending.push(ev); if (ev.op !== 'touch') changed++; }
        flushPending();
      },
    });
    let removed = 0;
    if (res.rootFailed) {
      // the directory itself could not be listed (unplugged drive, EPERM): an empty result is not the truth
      log.warn('index', `cannot list ${dirPath}; keeping its ${this.db.underLite(prefixKey).length} indexed files`);
      flushPending();
      report('error', res.dirs, res.files, 'directory not accessible');
      return { dirs: res.dirs, files: res.files, changed, removed, elapsedMs: Date.now() - started, aborted: true };
    }
    if (!res.aborted) {
      for (const r of this.db.underLite(prefixKey)) {
        if (seen.has(r.key)) continue;
        // a file indexed by the watcher after its directory was already listed is not stale: confirm on disk
        try { await fs.promises.lstat(r.path); continue; } catch { /* really gone */ }
        const ev = this.removeKey(r.key);
        if (ev) { pending.push(ev); removed++; }
      }
    }
    flushPending();
    report('done', res.dirs, res.files);
    return { dirs: res.dirs, files: res.files, changed, removed, elapsedMs: Date.now() - started, aborted: res.aborted };
  }

  /**
   * stat with a delete-grace period: editors and agents often delete-then-recreate (safe write,
   * tmp+rename). A known path that vanishes is re-checked at +150ms and +300ms before we believe it.
   */
  private async statWithGrace(fullPath: string, withGrace: boolean): Promise<fs.Stats | null | 'transient'> {
    const delays = withGrace ? [0, 150, 300] : [0];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
      try {
        return await fs.promises.lstat(fullPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'transient';
      }
    }
    return null;
  }

  private gc(now: number): void {
    if (this.recentlyAdded.size > 2000 || this.recentlyRemoved.size > 2000) {
      for (const [k, v] of this.recentlyAdded) if (now - v.at > MOVE_WINDOW_MS) this.recentlyAdded.delete(k);
      for (const [k, v] of this.recentlyRemoved) if (now - v.at > MOVE_WINDOW_MS) this.recentlyRemoved.delete(k);
    }
  }
}
