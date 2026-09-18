import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import type { FastifyInstance } from 'fastify';
import type { ConfigView, FileEvent, RootInfo, ScanProgress, Stats } from '../../shared/types.ts';
import { buildServer } from './api.ts';
import { ConfigStore, listFixedDrives, type AppConfig } from './config.ts';
import { Index } from './db.ts';
import { DirtySet } from './dirty.ts';
import { EventHub } from './hub.ts';
import { Indexer } from './indexer.ts';
import { openWithDefaultApp } from './open.ts';
import { makeExcludeMatcher, toDisplay, toKey } from './paths.ts';
import { WatchManager } from './watcher.ts';
import { log } from './log.ts';

const VERSION = '0.1.0';
/** True when running as the single-executable build (MDSyncView.exe). */
const IS_SEA = isSea();

if (IS_SEA) {
  // The executable cannot receive Node CLI flags, so filter the noise the same way --no-warnings would.
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w.stack ?? w.message); });
}

/** User arguments without the interpreter/script prefix (differs between `node index.ts …` and the .exe). */
function userArgs(): string[] {
  const a = process.argv.slice(1);
  while (a.length && (a[0] === process.execPath || /\.(ts|js|cjs|mjs|exe)$/i.test(a[0]!))) a.shift();
  return a;
}
const argv = userArgs();
const args = new Set(argv);
const DEV = args.has('--dev');
const NO_OPEN = args.has('--no-open');
const startedAt = Date.now();

/** CLI overrides: --data=<dir> --port=<n> --root=<path> (repeatable). */
function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
    else if (a === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith('--')) out.push(argv[++i]!);
  }
  return out;
}
const dataOverride = argValues('data')[0];
if (dataOverride) process.env.MDSYNCVIEW_DATA = dataOverride;
const store = new ConfigStore();
{
  // session-only overrides: never written back to config.json
  const overrides: Partial<AppConfig> = {};
  const p = Number(argValues('port')[0]);
  if (Number.isInteger(p) && p > 0) overrides.port = p;
  const r = argValues('root');
  if (r.length) overrides.roots = r.map((x) => toDisplay(x));
  store.setOverrides(overrides);
}
const cfg = () => store.config;
const dataDir = store.dataDir;
const dbPath = path.join(dataDir, 'index.db');
/** Built client: next to the executable in the release layout, under dist/ when run from source. */
const clientDir = IS_SEA
  ? path.join(path.dirname(process.execPath), 'client')
  : path.resolve(import.meta.dirname, '../../dist/client');

log.info('main', `MDSyncView ${VERSION} starting (node ${process.version}, ${DEV ? 'dev' : IS_SEA ? 'exe' : 'prod'})`);
log.info('main', `data dir: ${dataDir}`);

const db = new Index(dbPath);
db.open();

let excludeMatcher = makeExcludeMatcher(cfg().excludeNames, [...cfg().excludePaths, dataDir]);
const rebuildExclude = () => { excludeMatcher = makeExcludeMatcher(cfg().excludeNames, [...cfg().excludePaths, dataDir]); };

let drivesCache: string[] | null = null;
const listDrives = async () => (drivesCache ??= await listFixedDrives());

/** Effective roots: configured ones, or every fixed drive when none are configured. */
let effectiveRoots: string[] = [];
const rootState = new Map<string, RootInfo>();

const indexer = new Indexer(db, {
  maxIndexedBytes: () => cfg().maxIndexedBytes,
  exclude: () => excludeMatcher,
  roots: () => effectiveRoots,
});

let port = cfg().port;
const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(DEV ? ['127.0.0.1:5173', 'localhost:5173'] : [])]);
const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(DEV ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [])]);

const hub = new EventHub(
  () => ({ stats: stats(), roots: roots() }),
  (origin) => origin !== undefined && allowedOrigins().has(origin),
);

let activeScans = 0;

function roots(): RootInfo[] {
  const counts = db.countByRoot();
  return effectiveRoots.map((r) => {
    const key = toKey(r);
    const st = rootState.get(key) ?? { key, path: r, status: 'idle' as const, fileCount: 0, lastScanMs: null, lastScanAt: null };
    st.fileCount = counts.get(key) ?? 0;
    rootState.set(key, st);
    return { ...st };
  });
}

function stats(): Stats {
  const s = db.stats();
  return {
    files: s.files,
    roots: effectiveRoots.length,
    watchers: watch.unitCount,
    totalBytes: s.bytes,
    totalWords: s.words,
    lastEventAt: hub.lastEventAt,
    startedAt,
    seq: hub.seq,
    indexing: activeScans > 0,
    dbPath,
    version: VERSION,
  };
}

function setRootStatus(rootPath: string, status: RootInfo['status'], error?: string): void {
  const key = toKey(rootPath);
  const st = rootState.get(key) ?? { key, path: rootPath, status, fileCount: 0, lastScanMs: null, lastScanAt: null };
  st.status = status;
  st.error = error;
  rootState.set(key, st);
  hub.broadcast({ type: 'roots', roots: roots() });
}

const emit = (events: FileEvent[]) => hub.emitFileEvents(events);

// --- reconcile scheduling ---------------------------------------------------------------------------
const reconcileTimers = new Map<string, NodeJS.Timeout>();
const runningReconciles = new Map<string, Promise<void>>();
/** Keys whose reconcile was requested again while one was already running: run once more afterwards. */
const rerunRequested = new Set<string>();

async function reconcilePath(dirPath: string, root: string, reason: string): Promise<void> {
  const key = toKey(dirPath);
  const running = runningReconciles.get(key);
  if (running) { rerunRequested.add(key); return running; }
  const isRoot = key === toKey(root);
  const p = (async () => {
    activeScans++;
    if (isRoot) setRootStatus(root, 'scanning');
    const t0 = Date.now();
    let lastProgressSent = 0;
    try {
      const res = await indexer.reconcile(dirPath, root, emit, (prog: ScanProgress) => {
        const now = Date.now();
        if (prog.phase === 'progress' && now - lastProgressSent < 400) return;
        lastProgressSent = now;
        hub.broadcast({ type: 'scan', progress: { ...prog, root: isRoot ? root : dirPath } });
      });
      log.info('scan', `${reason}: ${dirPath} → ${res.dirs} dirs, ${res.files} md, ${res.changed} changed, ${res.removed} removed in ${res.elapsedMs}ms`);
      if (isRoot) {
        const st = rootState.get(key);
        if (st) { st.lastScanMs = res.elapsedMs; st.lastScanAt = Date.now(); }
      }
    } catch (e) {
      log.error('scan', `${reason} failed for ${dirPath}`, e);
      if (isRoot) setRootStatus(root, 'error', (e as Error).message);
    } finally {
      activeScans--;
      runningReconciles.delete(key);
      if (isRoot && rootState.get(key)?.status === 'scanning') setRootStatus(root, watch.unitCount ? 'watching' : 'idle');
      hub.broadcast({ type: 'stats', stats: stats() });
      log.info('scan', `done in ${Date.now() - t0}ms; ${db.stats().files} files indexed`);
      if (rerunRequested.delete(key)) void reconcilePath(dirPath, root, reason + ' (rerun)');
    }
  })();
  runningReconciles.set(key, p);
  return p;
}

function scheduleReconcile(dirPath: string, root: string, delayMs: number, reason: string): void {
  const key = toKey(dirPath);
  const prev = reconcileTimers.get(key);
  if (!prev) log.warn('watch', `${reason}: scheduling reconcile of ${dirPath} in ${delayMs}ms`);
  if (prev) clearTimeout(prev);
  reconcileTimers.set(key, setTimeout(() => {
    reconcileTimers.delete(key);
    void reconcilePath(dirPath, root, reason);
  }, delayMs));
}

// --- dirty set → verify → events ----------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirty = new DirtySet(async (batch) => {
  const exists = async (p: string) => { try { await fs.promises.lstat(p); return true; } catch { return false; } };
  const checked = await Promise.all(batch.map(async (b) => ({ ...b, exists: await exists(b.path) })));
  let missing = checked.filter((b) => !b.exists);
  const present = checked.filter((b) => b.exists);
  // Delete-grace, applied ONCE per batch (not per path): editors and agents delete-then-recreate within
  // milliseconds; a path that reappears is processed as a change, the rest as removals.
  if (missing.length) {
    for (const wait of [150, 300]) {
      await sleep(wait);
      const again = await Promise.all(missing.map(async (b) => ({ ...b, exists: await exists(b.path) })));
      for (const b of again) if (b.exists) present.push(b);
      missing = again.filter((b) => !b.exists);
      if (!missing.length) break;
    }
  }
  // Vanished paths first so add/remove pairs inside one batch resolve into renames.
  for (const b of [...missing, ...present]) {
    try {
      await indexer.verifyPath(b.path, b.root, emit, undefined, { noGrace: true });
    } catch (e) {
      log.warn('sync', `verify failed for ${b.path}`, e);
    }
  }
}, 150, 600);

const watch = new WatchManager(() => excludeMatcher, {
  onDirty: (p, root) => dirty.mark(p, root),
  onOverflow: (unitPath, root) => scheduleReconcile(unitPath, root, 1500, 'event buffer overflow'),
  onStatus: (root, status, message) => {
    if (status === 'error') setRootStatus(root, 'error', message);
    else if (rootState.get(toKey(root))?.status !== 'scanning') setRootStatus(root, 'watching');
  },
});

// --- roots management ---------------------------------------------------------------------------------
async function computeEffectiveRoots(): Promise<string[]> {
  const configured = cfg().roots.map((r) => toDisplay(r));
  if (configured.length) return configured;
  return (await listDrives()).map((d) => toDisplay(d));
}

async function applyRoots(initial: boolean): Promise<void> {
  const next = await computeEffectiveRoots();
  const prevKeys = new Set(effectiveRoots.map((r) => toKey(r)));
  const nextKeys = new Set(next.map((r) => toKey(r)));
  effectiveRoots = next;
  // drop files whose root disappeared, unless another (possibly nested) surviving root still covers them
  for (const pk of prevKeys) {
    if (nextKeys.has(pk)) continue;
    rootState.delete(pk);
    const survivors = [...nextKeys];
    const evs: FileEvent[] = [];
    for (const r of db.underLite(pk)) {
      if (survivors.some((nk) => r.key === nk || r.key.startsWith(nk + '/'))) continue;
      const ev = indexer.removeKey(r.key);
      if (ev) evs.push(ev);
    }
    if (evs.length) emit(evs);
  }
  await watch.setRoots(next);
  hub.broadcast({ type: 'roots', roots: roots() });
  const toScan = initial ? next : next.filter((r) => !prevKeys.has(toKey(r)));
  for (const r of toScan) void reconcilePath(r, r, initial ? 'startup reconcile' : 'new root');
}

async function configView(): Promise<ConfigView> {
  return {
    roots: cfg().roots,
    autoRoots: cfg().roots.length === 0,
    effectiveRoots,
    drives: await listDrives(),
    excludeNames: cfg().excludeNames,
    excludePaths: cfg().excludePaths,
    reconcileIntervalMin: cfg().reconcileIntervalMin,
    dataDir,
    dbPath,
  };
}

let periodicTimer: NodeJS.Timeout | null = null;
function schedulePeriodic(): void {
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = null;
  const min = cfg().reconcileIntervalMin;
  if (!min) return;
  periodicTimer = setInterval(() => {
    for (const r of effectiveRoots) void reconcilePath(r, r, 'periodic reconcile');
  }, min * 60_000);
}

/** Prove that native recursive fs.watch delivers events on this machine; warn loudly if not. */
async function watcherSelfTest(): Promise<void> {
  const dir = path.join(dataDir, 'selftest');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const got = await new Promise<boolean>((resolve) => {
      let w: fs.FSWatcher | null = null;
      const timer = setTimeout(() => { w?.close(); resolve(false); }, 2500);
      try {
        w = fs.watch(dir, { recursive: true }, () => { clearTimeout(timer); w?.close(); resolve(true); });
        w.on('error', () => { clearTimeout(timer); resolve(false); });
        void fs.promises.writeFile(path.join(dir, 'probe.md'), `# probe ${Date.now()}\n`);
      } catch { clearTimeout(timer); resolve(false); }
    });
    if (got) log.info('watch', 'self-test passed: filesystem events are flowing');
    else log.warn('watch', 'self-test FAILED: no filesystem event within 2.5s — real-time sync may not work; periodic reconcile still runs');
  } catch (e) {
    log.warn('watch', 'self-test could not run', e);
  }
}

function openBrowser(target: string): void {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const exe = process.platform === 'win32' ? candidates.find((c) => fs.existsSync(c)) : undefined;
  try {
    if (exe) {
      spawn(exe, [`--app=${target}`, '--window-size=1480,960'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log.info('main', `opened app window via ${path.basename(exe)}`);
      return;
    }
    openWithDefaultApp(target);
  } catch (e) {
    log.warn('main', 'could not open browser automatically', e);
  }
}

// --- HTTP server + lifecycle -----------------------------------------------------------------------------
let app: FastifyInstance | null = null;

async function listen(): Promise<void> {
  const basePort = cfg().port;
  for (let i = 0; i < 12; i++) {
    port = basePort + i;
    try {
      await app!.listen({ port, host: cfg().host });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      // Is it another MDSyncView? Then just open it and exit.
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          const j = (await res.json()) as { serverId?: string };
          if (j.serverId) {
            log.info('main', `MDSyncView already running on port ${port}; opening it`);
            if (!NO_OPEN) openBrowser(`http://127.0.0.1:${port}/`);
            process.exit(0);
          }
        }
      } catch { /* not ours */ }
      log.warn('main', `port ${port} busy, trying next`);
    }
  }
  throw new Error('no free port found');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) { log.warn('main', `${signal} received again, forcing exit`); process.exit(1); }
  shuttingDown = true;
  log.info('main', `${signal} received, shutting down`);
  // an in-flight /raw media stream can keep app.close() waiting forever: never hang the console
  setTimeout(() => { log.warn('main', 'shutdown watchdog fired, forcing exit'); process.exit(1); }, 3000).unref();
  if (periodicTimer) clearInterval(periodicTimer);
  for (const t of reconcileTimers.values()) clearTimeout(t);
  watch.close();
  dirty.clear();
  hub.close();
  try { await app?.close(); } catch { /* ignore */ }
  db.close();
  process.exit(0);
}

async function main(): Promise<void> {
  app = await buildServer({
    db,
    indexer,
    hub,
    dev: DEV,
    clientDir,
    dataDir,
    maxContentBytes: () => cfg().maxContentBytes,
    stats,
    roots,
    configView,
    updateConfig: async (patch) => {
      const rootsChanged = patch.roots !== undefined;
      const excludesChanged = patch.excludeNames !== undefined || patch.excludePaths !== undefined;
      store.update(patch);
      if (excludesChanged) rebuildExclude();
      if (rootsChanged || excludesChanged) {
        if (excludesChanged) {
          // exclusions affect the watch topology and which files count: re-plan and rescan everything
          await watch.setRoots([]);
          effectiveRoots = [];
        }
        await applyRoots(excludesChanged);
      }
      if (patch.reconcileIntervalMin !== undefined) schedulePeriodic();
      return configView();
    },
    rescan: async (root) => {
      const targets = root ? effectiveRoots.filter((r) => toKey(r) === toKey(root)) : effectiveRoots;
      await Promise.all(targets.map((r) => reconcilePath(r, r, 'manual rescan')));
    },
    listDrives,
    isHostAllowed: (host) => !!host && allowedHosts().has(host.toLowerCase()),
    isOriginAllowed: (origin) => origin !== undefined && allowedOrigins().has(origin),
    cspHeader: () => [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });

  await listen();
  hub.attach(app.server);
  const url = `http://127.0.0.1:${port}/`;
  log.info('main', `listening on ${url}`);
  if (!fs.existsSync(path.join(clientDir, 'index.html'))) log.warn('main', `client bundle not found at ${clientDir}; the API works but the UI will not load (run "npm run build")`);
  void listDrives(); // warm the drive list (PowerShell spawn) so the settings dialog opens instantly

  // Attach watchers first so nothing is missed while the startup reconcile runs.
  await applyRoots(true);
  schedulePeriodic();
  void watcherSelfTest();

  if (!NO_OPEN && cfg().openBrowser) openBrowser(DEV ? 'http://127.0.0.1:5173/' : url);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { log.error('main', 'uncaught exception', e); });
process.on('unhandledRejection', (e) => { log.error('main', 'unhandled rejection', e); });

main().catch((e) => {
  log.error('main', 'fatal startup error', e);
  process.exit(1);
});
