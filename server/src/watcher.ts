import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toKey, type ExcludeMatcher } from './paths.ts';
import { listSubdirs } from './scanner.ts';
import { log } from './log.ts';

export interface WatchEvents {
  /** A path (file or directory) may have changed; the receiver must stat it to learn the truth. */
  onDirty(fullPath: string, root: string): void;
  /** Events under `unitPath` may have been lost (buffer overflow, re-attached handle) — reconcile that subtree. */
  onOverflow(unitPath: string, root: string): void;
  onStatus(root: string, status: 'watching' | 'error', message?: string): void;
}

interface Unit {
  path: string;
  key: string;
  root: string;
  recursive: boolean;
  watcher: fs.FSWatcher | null;
  retry: number;
  timer: NodeJS.Timeout | null;
  /** NTFS file id of the directory when the handle was opened; a different id means the directory was replaced. */
  ino: bigint | null;
  /** hub only: debounce timers for direct children */
  childTimers: Map<string, NodeJS.Timeout>;
}

const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** Liveness check interval; overridable for tests. */
const HEALTH_MS = Number(process.env.MDSYNCVIEW_HEALTH_MS) || 30000;

function identityOf(p: string): bigint | null {
  try { return fs.statSync(p, { bigint: true }).ino; } catch { return null; }
}

/**
 * Manages native recursive fs.watch handles.
 *
 * "Hub" directories (drive roots, X:\Users, user profile dirs) are never watched recursively because their
 * subtrees include system/AppData churn that overflows the OS notification buffer. Instead each hub gets a
 * cheap non-recursive watcher (to notice new/removed top-level folders and loose files) and every non-excluded
 * child directory gets its own recursive watcher. Everything else gets one recursive watcher per root.
 *
 * Windows facts this class is built around (verified on this machine): deleting a watched directory does NOT
 * raise 'error' — the handle floods hundreds of thousands of 'rename' events per second whose filename is the
 * absolute `\\?\` path of the directory; renaming a watched directory keeps the handle following it while
 * events are still reported relative to the old path. Both are handled by identity checks below.
 */
export class WatchManager {
  private units = new Map<string, Unit>();
  private roots: string[] = [];
  private closed = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private getExclude: () => ExcludeMatcher;
  private ev: WatchEvents;
  private maxRecursive: number;

  constructor(getExclude: () => ExcludeMatcher, ev: WatchEvents, maxRecursive = 160) {
    this.getExclude = getExclude;
    this.ev = ev;
    this.maxRecursive = maxRecursive;
    this.healthTimer = setInterval(() => void this.healthTick(), HEALTH_MS);
    this.healthTimer.unref();
  }

  get unitCount(): number { return this.units.size; }
  get recursiveCount(): number { let n = 0; for (const u of this.units.values()) if (u.recursive) n++; return n; }

  isHub(p: string): boolean {
    const key = toKey(p);
    if (/^[a-z]:$/.test(key)) return true;
    if (/^[a-z]:\/users$/.test(key)) return true;
    if (/^[a-z]:\/users\/[^/]+$/.test(key)) return true;
    if (key === toKey(os.homedir())) return true;
    return false;
  }

  private isRootUnit(unit: Unit): boolean {
    return unit.key === toKey(unit.root);
  }

  async setRoots(roots: string[]): Promise<void> {
    if (this.closed) return;
    const next = roots.map((r) => toKey(r));
    // drop units that belong to removed roots
    for (const [key, u] of this.units) {
      if (!next.includes(toKey(u.root))) this.dropUnit(key);
    }
    const added = roots.filter((r) => !this.roots.some((x) => toKey(x) === toKey(r)));
    this.roots = [...roots];
    for (const r of added) {
      try {
        await this.addRoot(r);
        const unit = this.units.get(toKey(r));
        if (unit && !unit.watcher) this.ev.onStatus(r, 'error', 'root directory is not accessible');
        else this.ev.onStatus(r, 'watching');
      } catch (e) {
        this.ev.onStatus(r, 'error', (e as Error).message);
      }
    }
  }

  private async addRoot(root: string): Promise<void> {
    await this.addUnitOrHub(root, root);
  }

  private async addUnitOrHub(p: string, root: string): Promise<void> {
    if (this.closed) return;
    if (!this.isHub(p)) { this.watchUnit(p, root, true); return; }
    const children = await listSubdirs(p);
    const exclude = this.getExclude();
    const wanted = children.filter((c) => !exclude.dir(c.name, toKey(c.path)));
    if (this.recursiveCount + wanted.length > this.maxRecursive) {
      log.warn('watch', `handle budget exceeded at ${p}; watching hub recursively instead`);
      this.watchUnit(p, root, true);
      return;
    }
    this.watchUnit(p, root, false);
    for (const c of wanted) await this.addUnitOrHub(c.path, root);
  }

  private watchUnit(p: string, root: string, recursive: boolean): void {
    const key = toKey(p);
    const existing = this.units.get(key);
    if (existing) {
      if (existing.recursive === recursive) return;
      this.dropUnit(key);
    }
    const unit: Unit = { path: p, key, root, recursive, watcher: null, retry: 0, timer: null, ino: null, childTimers: new Map() };
    this.units.set(key, unit);
    this.attach(unit);
  }

  private attach(unit: Unit): boolean {
    if (this.closed || !this.units.has(unit.key)) return false;
    try {
      const w = fs.watch(unit.path, { recursive: unit.recursive, persistent: true, encoding: 'utf8' }, (evt, filename) => {
        this.handle(unit, evt, filename);
      });
      w.on('error', (err) => this.onError(unit, err));
      unit.watcher = w;
      unit.retry = 0;
      unit.ino = identityOf(unit.path);
      return true;
    } catch (err) {
      this.onError(unit, err as Error);
      return false;
    }
  }

  private detach(unit: Unit): void {
    try { unit.watcher?.close(); } catch { /* ignore */ }
    unit.watcher = null;
  }

  private handle(unit: Unit, _evt: string, filename: string | Buffer | null): void {
    if (this.closed || unit.watcher === null) return;
    if (filename === null || filename === undefined) {
      if (unit.recursive) this.ev.onOverflow(unit.path, unit.root);
      else void this.rescanHubChildren(unit);
      return;
    }
    const rel = typeof filename === 'string' ? filename : filename.toString('utf8');
    if (!rel) return;
    // An absolute (\\?\C:\...) filename means the OS is reporting the watched directory itself: it was
    // deleted or replaced. Stop the flood immediately and re-evaluate the unit.
    if (path.isAbsolute(rel) || rel.startsWith('\\\\?\\')) { this.unitVanished(unit); return; }
    const full = path.join(unit.path, rel);
    if (!unit.recursive) { this.hubChildEvent(unit, full); return; }
    if (this.isExcludedRel(unit, rel)) return;
    this.ev.onDirty(full, unit.root);
  }

  /** The watched directory itself went away (or was swapped). */
  private unitVanished(unit: Unit): void {
    this.detach(unit);
    if (!this.units.has(unit.key)) return;
    const exists = fs.existsSync(unit.path);
    log.info('watch', `watched directory ${exists ? 'replaced' : 'vanished'}: ${unit.path}`);
    if (this.isRootUnit(unit)) {
      // keep the unit so the health tick can re-attach when the directory returns
      if (exists) { if (this.attach(unit)) this.ev.onOverflow(unit.path, unit.root); }
      else this.ev.onStatus(unit.root, 'error', 'root directory not found');
      this.ev.onDirty(unit.path, unit.root);
      return;
    }
    this.dropUnit(unit.key);
    this.ev.onDirty(unit.path, unit.root);
    if (exists) void this.addUnitOrHub(unit.path, unit.root).then(() => this.ev.onOverflow(unit.path, unit.root));
  }

  /** Cheap per-event filter: any path segment that is an excluded directory name means "ignore". */
  private isExcludedRel(unit: Unit, rel: string): boolean {
    const exclude = this.getExclude();
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    let key = unit.key;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      key += '/' + s.toLowerCase();
      // last segment may be a file; only treat as a dir-name exclusion when it has no markdown extension
      if (i < segs.length - 1 || !/\.(md|markdown|mdown|mkd|mdx)$/i.test(s)) {
        if (exclude.dir(s, key)) return true;
      }
    }
    return false;
  }

  private hubChildEvent(unit: Unit, full: string): void {
    const key = toKey(full);
    const prev = unit.childTimers.get(key);
    if (prev) clearTimeout(prev);
    unit.childTimers.set(key, setTimeout(() => {
      unit.childTimers.delete(key);
      void this.resolveHubChild(unit, full, key);
    }, 300));
  }

  private async resolveHubChild(unit: Unit, full: string, key: string): Promise<void> {
    if (this.closed) return;
    let st: fs.BigIntStats | null = null;
    try { st = await fs.promises.lstat(full, { bigint: true }); } catch { st = null; }
    if (!st) {
      if (this.units.has(key)) this.dropUnit(key);
      this.ev.onDirty(full, unit.root);
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      const name = path.basename(full);
      if (this.getExclude().dir(name, key)) return;
      const existing = this.units.get(key);
      if (existing && existing.ino !== null && existing.ino !== st.ino) {
        // the child was swapped (rename A→A.old; rename A.new→A): the old handle follows the wrong directory
        log.info('watch', `directory replaced under hub, re-watching: ${full}`);
        this.dropUnit(key);
      } else if (existing) {
        return;
      }
      await this.addUnitOrHub(full, unit.root);
      this.ev.onDirty(full, unit.root);
      return;
    }
    this.ev.onDirty(full, unit.root);
  }

  private async rescanHubChildren(unit: Unit): Promise<void> {
    const children = await listSubdirs(unit.path);
    const exclude = this.getExclude();
    for (const c of children) {
      const key = toKey(c.path);
      if (exclude.dir(c.name, key) || this.units.has(key)) continue;
      await this.addUnitOrHub(c.path, unit.root);
      this.ev.onDirty(c.path, unit.root);
    }
    for (const [key, u] of this.units) {
      if (u.root === unit.root && key.startsWith(unit.key + '/') && !key.slice(unit.key.length + 1).includes('/')) {
        if (!fs.existsSync(u.path)) { this.dropUnit(key); this.ev.onDirty(u.path, unit.root); }
      }
    }
    this.ev.onDirty(unit.path, unit.root);
  }

  /**
   * Periodic liveness check: re-attach root units whose directory came back, notice directories that were
   * renamed/replaced underneath a live handle (identity change), and drop units whose directory is gone.
   */
  private async healthTick(): Promise<void> {
    if (this.closed) return;
    for (const unit of [...this.units.values()]) {
      if (!this.units.has(unit.key)) continue;
      const exists = fs.existsSync(unit.path);
      const isRoot = this.isRootUnit(unit);
      if (!exists) {
        if (unit.watcher) { this.detach(unit); this.ev.onDirty(unit.path, unit.root); }
        if (isRoot) this.ev.onStatus(unit.root, 'error', 'root directory not found');
        else this.dropUnit(unit.key);
        continue;
      }
      if (!unit.watcher) {
        if (unit.timer) continue; // a retry is already scheduled
        if (this.attach(unit)) {
          if (isRoot) this.ev.onStatus(unit.root, 'watching');
          this.ev.onOverflow(unit.path, unit.root);
        }
        continue;
      }
      const ino = identityOf(unit.path);
      if (ino !== null && unit.ino !== null && ino !== unit.ino) {
        log.info('watch', `directory identity changed, re-watching: ${unit.path}`);
        this.detach(unit);
        if (this.attach(unit)) this.ev.onOverflow(unit.path, unit.root);
      }
    }
  }

  private onError(unit: Unit, err: Error): void {
    this.detach(unit);
    if (this.closed || !this.units.has(unit.key)) return;
    const isRootUnit = this.isRootUnit(unit);
    if (!fs.existsSync(unit.path)) {
      log.info('watch', `unit vanished: ${unit.path}`);
      if (isRootUnit) this.ev.onStatus(unit.root, 'error', 'root directory not found');
      else this.dropUnit(unit.key);
      this.ev.onDirty(unit.path, unit.root);
      return;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === 'EPERM' || code === 'EACCES') && !isRootUnit) {
      // Inaccessible subtree (another user's profile, protected system folder): nothing to watch here.
      log.info('watch', `skipping inaccessible ${unit.path} (${code})`);
      this.dropUnit(unit.key);
      return;
    }
    const delay = RETRY_MS[Math.min(unit.retry, RETRY_MS.length - 1)]!;
    unit.retry++;
    log.warn('watch', `watcher error on ${unit.path} (${code ?? err.message}); retry in ${delay}ms`);
    if (unit.retry >= 3) this.ev.onStatus(unit.root, 'error', `${unit.path}: ${err.message}`);
    unit.timer = setTimeout(() => {
      unit.timer = null;
      if (this.attach(unit)) {
        this.ev.onStatus(unit.root, 'watching');
        this.ev.onOverflow(unit.path, unit.root); // we may have missed events while detached
      }
    }, delay);
  }

  private dropUnit(key: string): void {
    const u = this.units.get(key);
    if (!u) return;
    this.units.delete(key);
    if (u.timer) clearTimeout(u.timer);
    for (const t of u.childTimers.values()) clearTimeout(t);
    this.detach(u);
    // drop nested units too (a hub's children)
    for (const [k] of this.units) if (k.startsWith(key + '/')) this.dropUnit(k);
  }

  describe(): { path: string; root: string; recursive: boolean; alive: boolean }[] {
    return [...this.units.values()].map((u) => ({ path: u.path, root: u.root, recursive: u.recursive, alive: !!u.watcher }));
  }

  close(): void {
    this.closed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const key of [...this.units.keys()]) this.dropUnit(key);
  }
}
