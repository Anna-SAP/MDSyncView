import { create } from 'zustand';
import type { ConfigView, FileDetail, FileEvent, FileRecord, RootInfo, ScanProgress, ServerMessage, Stats } from '../../shared/types.ts';
import { api, ApiError } from './lib/api.ts';
import { SyncClient, type ConnectionState } from './lib/ws.ts';

export type SidebarTab = 'files' | 'recent' | 'search' | 'tags' | 'activity';
export type Theme = 'system' | 'light' | 'dark';
export type ViewMode = 'rendered' | 'raw';
export type DocStatus = 'loading' | 'ok' | 'deleted' | 'locked' | 'error';

export interface ActivityItem {
  id: number;
  op: FileEvent['op'];
  key: string;
  oldKey?: string;
  name: string;
  path: string;
  title: string;
  at: number;
  size?: number;
}

export interface Toast { id: number; text: string; kind: 'info' | 'warn' | 'error'; action?: { label: string; run: () => void }; until: number }

export interface DocState {
  key: string;
  path: string;
  detail: FileDetail | null;
  status: DocStatus;
  error?: string;
  loadedAt: number;
  /** increments every time content changed on disk while open */
  revision: number;
  deletedAt?: number;
}

interface State {
  files: Map<string, FileRecord>;
  filesVersion: number;
  roots: RootInfo[];
  stats: Stats | null;
  scans: Record<string, ScanProgress>;
  connection: ConnectionState;
  resyncing: boolean;
  activity: ActivityItem[];
  /** keys touched (add/change) in the last minute, for "live" highlighting */
  recentChanges: Map<string, number>;

  currentKey: string | null;
  doc: DocState | null;
  history: string[];
  historyIndex: number;
  followLatest: boolean;

  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  railOpen: boolean;
  theme: Theme;
  viewMode: ViewMode;
  paletteOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  contentScale: number;
  treeExpanded: Set<string>;
  toasts: Toast[];
  config: ConfigView | null;

  // actions
  openFile(key: string, opts?: { push?: boolean; path?: string }): boolean;
  reloadDoc(): Promise<void>;
  goBack(): void;
  goForward(): void;
  setSidebarTab(t: SidebarTab): void;
  toggleSidebar(): void;
  toggleRail(): void;
  setTheme(t: Theme): void;
  setViewMode(v: ViewMode): void;
  setPalette(open: boolean): void;
  setSettings(open: boolean): void;
  setShortcuts(open: boolean): void;
  setFollowLatest(v: boolean): void;
  setContentScale(v: number): void;
  toggleDir(key: string): void;
  expandDirs(keys: string[]): void;
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  loadConfig(): Promise<ConfigView>;
  saveConfig(patch: Parameters<typeof api.updateConfig>[0]): Promise<ConfigView>;
  rescan(root?: string): Promise<void>;
  openExternal(mode: 'default' | 'reveal' | 'editor'): Promise<void>;
}

const LS = {
  get<T>(k: string, fallback: T): T {
    try { const v = localStorage.getItem('mdsv:' + k); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
  },
  set(k: string, v: unknown): void {
    try { localStorage.setItem('mdsv:' + k, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

let activityId = 0;
let toastId = 0;
let sync: SyncClient | null = null;
let buffered: ServerMessage[] = [];
let docAbort: AbortController | null = null;
let reloadTimer: number | null = null;

export const useStore = create<State>((set, get) => ({
  files: new Map(),
  filesVersion: 0,
  roots: [],
  stats: null,
  scans: {},
  connection: 'connecting',
  resyncing: false,
  activity: [],
  recentChanges: new Map(),

  currentKey: null,
  doc: null,
  history: [],
  historyIndex: -1,
  followLatest: LS.get('followLatest', false),

  sidebarTab: LS.get<SidebarTab>('sidebarTab', 'files'),
  sidebarOpen: LS.get('sidebarOpen', true),
  railOpen: LS.get('railOpen', true),
  theme: LS.get<Theme>('theme', 'system'),
  viewMode: 'rendered',
  paletteOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  contentScale: LS.get('contentScale', 1),
  treeExpanded: new Set(LS.get<string[]>('treeExpanded', [])),
  toasts: [],
  config: null,

  openFile(key, opts = {}) {
    const { files, history, historyIndex } = get();
    const rec = files.get(key);
    const path = rec?.path ?? opts.path;
    if (!path) return false;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    const push = opts.push !== false;
    let h = history;
    let hi = historyIndex;
    if (push && history[historyIndex] !== key) {
      h = [...history.slice(0, historyIndex + 1), key].slice(-200);
      hi = h.length - 1;
    }
    const same = get().doc?.key === key;
    set({ currentKey: key, history: h, historyIndex: hi, doc: { key, path, detail: same ? get().doc!.detail : null, status: 'loading', loadedAt: 0, revision: same ? get().doc!.revision : 0 } });
    const wanted = '#/f/' + encodeURIComponent(path);
    if (location.hash !== wanted && !location.hash.startsWith(wanted + '#')) window.history.replaceState(null, '', wanted);
    void get().reloadDoc();
    return true;
  },

  async reloadDoc() {
    const d = get().doc;
    if (!d) return;
    docAbort?.abort();
    const ctrl = new AbortController();
    docAbort = ctrl;
    try {
      const detail = await api.file(d.path, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const cur = get().doc;
      if (!cur || cur.key !== d.key) return;
      const changed = cur.detail !== null && cur.detail.content !== detail.content;
      // adopt the server's canonical key (a hash/link-derived key may differ, e.g. "..", case)
      const canon = detail.file.key;
      const patch: Partial<State> = { doc: { ...cur, key: canon, path: detail.file.path, detail, status: 'ok', error: undefined, loadedAt: Date.now(), revision: changed ? cur.revision + 1 : cur.revision, deletedAt: undefined } };
      if (canon !== cur.key) {
        patch.currentKey = canon;
        patch.history = get().history.map((k) => (k === cur.key ? canon : k));
      }
      set(patch);
      // keep the index copy fresh too (covers files opened via URL before the snapshot arrived)
      const files = get().files;
      if (!files.has(canon)) { files.set(canon, detail.file); set({ filesVersion: get().filesVersion + 1 }); }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const cur = get().doc;
      if (!cur || cur.key !== d.key) return;
      if (e instanceof ApiError && (e.status === 404)) set({ doc: { ...cur, status: 'deleted', deletedAt: Date.now(), error: e.message } });
      else if (e instanceof ApiError && e.status === 423) { set({ doc: { ...cur, status: 'locked', error: e.message } }); scheduleReload(1500); }
      else set({ doc: { ...cur, status: 'error', error: (e as Error).message } });
    }
  },

  goBack() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const key = history[historyIndex - 1]!;
    if (get().openFile(key, { push: false })) set({ historyIndex: historyIndex - 1 });
    else set({ history: history.filter((k) => k !== key), historyIndex: Math.max(0, historyIndex - 1) });
  },
  goForward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const key = history[historyIndex + 1]!;
    if (get().openFile(key, { push: false })) set({ historyIndex: historyIndex + 1 });
    else set({ history: history.filter((k) => k !== key) });
  },

  setSidebarTab(t) { LS.set('sidebarTab', t); set({ sidebarTab: t, sidebarOpen: true }); LS.set('sidebarOpen', true); },
  toggleSidebar() { const v = !get().sidebarOpen; LS.set('sidebarOpen', v); set({ sidebarOpen: v }); },
  toggleRail() { const v = !get().railOpen; LS.set('railOpen', v); set({ railOpen: v }); },
  setTheme(t) { LS.set('theme', t); set({ theme: t }); applyTheme(t); },
  setViewMode(v) { set({ viewMode: v }); },
  setPalette(open) { set({ paletteOpen: open }); },
  setSettings(open) { set({ settingsOpen: open }); },
  setShortcuts(open) { set({ shortcutsOpen: open }); },
  setFollowLatest(v) { LS.set('followLatest', v); set({ followLatest: v }); },
  setContentScale(v) { const s = Math.min(1.6, Math.max(0.8, Math.round(v * 100) / 100)); LS.set('contentScale', s); set({ contentScale: s }); },
  toggleDir(key) {
    const s = new Set(get().treeExpanded);
    if (s.has(key)) s.delete(key); else s.add(key);
    LS.set('treeExpanded', [...s].slice(-2000));
    set({ treeExpanded: s });
  },
  expandDirs(keys) {
    const s = new Set(get().treeExpanded);
    let changed = false;
    for (const k of keys) if (!s.has(k)) { s.add(k); changed = true; }
    if (changed) { LS.set('treeExpanded', [...s].slice(-2000)); set({ treeExpanded: s }); }
  },
  toast(text, kind = 'info', action) {
    const id = ++toastId;
    const t: Toast = { id, text, kind, action, until: Date.now() + (kind === 'error' ? 8000 : 4500) };
    set({ toasts: [...get().toasts.slice(-4), t] });
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4500);
  },
  dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },
  async loadConfig() { const c = await api.config(); set({ config: c }); return c; },
  async saveConfig(patch) { const c = await api.updateConfig(patch); set({ config: c }); return c; },
  async rescan(root) { await api.rescan(root); get().toast(root ? `正在重新扫描 ${root}` : '正在重新扫描全部根目录'); },
  async openExternal(mode) {
    const d = get().doc;
    if (!d) return;
    try { await api.open(d.path, mode); } catch (e) { get().toast(`打开失败：${(e as Error).message}`, 'error'); }
  },
}));

function scheduleReload(ms: number): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => { reloadTimer = null; void useStore.getState().reloadDoc(); }, ms);
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

// ---------------------------------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------------------------------

/** Canonical key of a display path, mirroring the server's toKey() (Windows: lower-case, forward slashes). */
export function keyOfPath(p: string): string {
  let k = p.replace(/\\/g, '/').toLowerCase();
  if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
  return k;
}

function applyEvents(events: FileEvent[]): void {
  const st = useStore.getState();
  const files = st.files;
  const activity = st.activity;
  const recent = st.recentChanges;
  const now = Date.now();
  let curKey = st.currentKey;
  let doc = st.doc;
  let history = st.history;
  let docChanged = false;
  let followTarget: FileRecord | null = null;
  // roots (canonical keys) with a scan in progress: their "add" events are discovery, not user activity
  const scanning = new Set(Object.entries(st.scans).filter(([, p]) => p.phase === 'start' || p.phase === 'progress').map(([r]) => keyOfPath(r)));
  const items: ActivityItem[] = [];

  for (const ev of events) {
    const rec = ev.file;
    const isScanNoise = !!rec && ev.op === 'add' && scanning.has(rec.root);
    switch (ev.op) {
      case 'add':
      case 'change':
      case 'touch':
        if (rec) files.set(ev.key, rec);
        if (ev.op !== 'touch' && !isScanNoise) recent.set(ev.key, now);
        break;
      case 'remove':
        files.delete(ev.key);
        recent.delete(ev.key);
        break;
      case 'rename':
        if (ev.oldKey) { files.delete(ev.oldKey); recent.delete(ev.oldKey); }
        if (rec) files.set(ev.key, rec);
        recent.set(ev.key, now);
        if (ev.oldKey && history.includes(ev.oldKey)) history = history.map((k) => (k === ev.oldKey ? ev.key : k));
        break;
    }
    if (!isScanNoise && ev.op !== 'touch') {
      items.push({ id: ++activityId, op: ev.op, key: ev.key, oldKey: ev.oldKey, name: rec?.name ?? ev.key.split('/').pop() ?? ev.key, path: rec?.path ?? ev.key, title: rec?.title ?? '', at: ev.at, size: rec?.size });
    }
    if (!isScanNoise && rec && (ev.op === 'add' || ev.op === 'change') && st.followLatest && !(st.doc?.key === ev.key)) followTarget = rec;

    // current document bookkeeping
    if (doc) {
      if (ev.op === 'rename' && ev.oldKey === doc.key && rec) {
        doc = { ...doc, key: ev.key, path: rec.path, status: doc.status === 'deleted' ? 'loading' : doc.status, deletedAt: undefined };
        curKey = ev.key;
        docChanged = true;
        window.history.replaceState(null, '', '#/f/' + encodeURIComponent(rec.path));
        useStore.getState().toast(`文件已重命名为 ${rec.name}`);
      } else if ((ev.op === 'change' || ev.op === 'add' || ev.op === 'rename') && ev.key === doc.key) {
        // content changed, or something was moved/re-created at the open path
        docChanged = true;
      } else if (ev.op === 'remove' && ev.key === doc.key) {
        doc = { ...doc, status: 'deleted', deletedAt: now };
      } else if (ev.op === 'touch' && ev.key === doc.key && rec && doc.detail) {
        doc = { ...doc, detail: { ...doc.detail, file: rec } };
      }
    }
  }
  // prune "recent" older than 10 minutes
  for (const [k, t] of recent) if (now - t > 600000) recent.delete(k);

  useStore.setState({
    filesVersion: st.filesVersion + 1,
    activity: items.length ? [...items.reverse(), ...activity].slice(0, 500) : activity,
    currentKey: curKey,
    doc,
    history,
  });
  if (docChanged) scheduleReload(120);
  if (followTarget && followTarget.key !== curKey) {
    useStore.getState().openFile(followTarget.key);
  }
}

function applySnapshot(files: FileRecord[], roots: RootInfo[], stats: Stats): void {
  const map = new Map<string, FileRecord>();
  for (const f of files) map.set(f.key, f);
  useStore.setState({ files: map, filesVersion: useStore.getState().filesVersion + 1, roots, stats });
}

function handleMessage(m: ServerMessage): void {
  const st = useStore.getState();
  if (m.type === 'resync') { requestResync(); return; }
  if (m.type === 'hello' && sync && sync.serverId !== null && m.serverId !== sync.serverId) {
    // a different server process: sequence numbers are not comparable any more
    sync.serverId = m.serverId;
    sync.lastSeq = null;
    requestResync();
  }
  if (st.resyncing) { buffered.push(m); return; }
  if (sync && sync.lastSeq !== null && m.seq <= sync.lastSeq && m.type !== 'hello' && m.type !== 'pong') return;
  switch (m.type) {
    case 'hello':
      if (sync) sync.serverId = m.serverId;
      useStore.setState({ stats: m.stats, roots: m.roots });
      break;
    case 'events':
      applyEvents(m.events);
      break;
    case 'scan': {
      const scans = { ...st.scans, [m.progress.root]: m.progress };
      useStore.setState({ scans });
      if (m.progress.phase === 'done' && (m.progress.filesFound > 0 || m.progress.elapsedMs > 3000)) {
        // a finished scan means many rows may have changed: refresh derived views
        useStore.setState({ filesVersion: useStore.getState().filesVersion + 1 });
      }
      break;
    }
    case 'roots':
      useStore.setState({ roots: m.roots });
      break;
    case 'stats':
      useStore.setState({ stats: m.stats });
      break;
    case 'pong':
      break;
  }
  if (sync && m.type !== 'pong') sync.lastSeq = Math.max(sync.lastSeq ?? 0, m.seq);
}

let resyncInFlight: Promise<void> | null = null;
let resyncAgain = false;

/** Run at most one snapshot resync at a time; a request during a run schedules exactly one more. */
function requestResync(): void {
  if (resyncInFlight) { resyncAgain = true; return; }
  resyncInFlight = resync().finally(() => {
    resyncInFlight = null;
    if (resyncAgain) { resyncAgain = false; requestResync(); }
  });
}

async function resync(): Promise<void> {
  useStore.setState({ resyncing: true });
  buffered = [];
  try {
    const snap = await api.snapshot();
    applySnapshot(snap.files, snap.roots, snap.stats);
    if (sync) { sync.lastSeq = snap.seq; sync.serverId = snap.serverId; }
    const pending = buffered;
    buffered = [];
    useStore.setState({ resyncing: false });
    for (const m of pending) {
      if (m.type === 'hello' || m.type === 'pong') { handleMessage(m); continue; }
      if (m.seq > snap.seq) handleMessage(m);
    }
    // re-validate the open document after a resync
    const d = useStore.getState().doc;
    if (d) scheduleReload(50);
  } catch (e) {
    buffered = [];
    useStore.setState({ resyncing: false });
    useStore.getState().toast(`同步快照失败：${(e as Error).message}`, 'error');
    setTimeout(() => requestResync(), 3000);
  }
}

let booted = false;
export function bootstrap(): void {
  if (booted) return;
  booted = true;
  applyTheme(useStore.getState().theme);
  sync = new SyncClient({
    onMessage: handleMessage,
    onState: (s) => useStore.setState({ connection: s }),
  });
  sync.connect();
  requestResync();

  const openFromHash = () => {
    const m = /^#\/f\/(.+)$/.exec(location.hash);
    if (!m) return;
    // "#/f/<encoded path>#<heading-slug>": the path never contains a raw '#', it is percent-encoded
    const [encoded] = m[1]!.split('#');
    let path = '';
    try { path = decodeURIComponent(encoded!); } catch { return; }
    const key = keyOfPath(path);
    const st = useStore.getState();
    if (st.currentKey === key) return;
    st.openFile(key, { path });
  };
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync?.nudge(); });
  window.addEventListener('online', () => sync?.nudge());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useStore.getState().theme));
}

/** Resolve a wiki-link / bare name to a file: same dir first, then anywhere (by stem or title, case-insensitive). */
export function resolveByName(name: string, fromDir?: string): FileRecord | null {
  const target = name.trim().toLowerCase().replace(/\.(md|markdown|mdx)$/i, '');
  if (!target) return null;
  const files = useStore.getState().files;
  let best: FileRecord | null = null;
  const dirKey = fromDir ? fromDir.replace(/\\/g, '/').toLowerCase() : '';
  for (const f of files.values()) {
    const s = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (s === target || f.title.toLowerCase() === target || (target.includes('/') && f.key.endsWith('/' + target + '.md'))) {
      if (dirKey && f.dir.replace(/\\/g, '/').toLowerCase() === dirKey) return f;
      if (!best) best = f;
    }
  }
  return best;
}
