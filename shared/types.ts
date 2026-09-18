/**
 * Shared wire types between the MDSyncView server and client.
 * Keep this file dependency-free: it is imported by both sides.
 */

export interface Heading { level: number; text: string; slug: string }

/** One indexed Markdown file. `key` is the canonical identity; `path` is for display. */
export interface FileRecord {
  key: string;
  path: string;
  name: string;
  dir: string;
  root: string;
  size: number;
  mtime: number;
  ctime: number;
  title: string;
  excerpt: string;
  tags: string[];
  wordCount: number;
  headingCount: number;
  indexedAt: number;
}

export type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface FileDetail {
  file: FileRecord;
  content: string;
  encoding: Encoding;
  truncated: boolean;
  headings: Heading[];
  frontmatter: Record<string, unknown>;
  wikiLinks: string[];
  bodyOffset: number;
  backlinks: FileRecord[];
}

export type RootStatus = 'scanning' | 'watching' | 'error' | 'idle';

export interface RootInfo {
  key: string;
  path: string;
  status: RootStatus;
  fileCount: number;
  lastScanMs: number | null;
  lastScanAt: number | null;
  error?: string;
}

export interface Stats {
  files: number;
  roots: number;
  watchers: number;
  totalBytes: number;
  totalWords: number;
  lastEventAt: number | null;
  startedAt: number;
  seq: number;
  indexing: boolean;
  dbPath: string;
  version: string;
}

export interface SearchHit {
  file: FileRecord;
  /** HTML-escaped snippet with <mark> around matches. */
  snippet: string;
  score: number;
  matchedIn: ('name' | 'title' | 'headings' | 'body' | 'tags')[];
}

export interface SearchResponse {
  query: string;
  total: number;
  hits: SearchHit[];
  tookMs: number;
  mode: 'fts' | 'substring';
}

export type FileOp = 'add' | 'change' | 'remove' | 'rename' | 'touch';

export interface FileEvent {
  op: FileOp;
  key: string;
  /** Present for add/change/rename/touch (the current record). */
  file?: FileRecord;
  /** Present for rename: the previous key. */
  oldKey?: string;
  at: number;
}

export interface ScanProgress {
  root: string;
  phase: 'start' | 'progress' | 'done' | 'error';
  dirsScanned: number;
  filesFound: number;
  elapsedMs: number;
  error?: string;
}

/** Server → client WebSocket messages. Every message carries a monotonically increasing `seq`. */
export type ServerMessage =
  | { type: 'hello'; seq: number; stats: Stats; roots: RootInfo[]; serverId: string }
  | { type: 'events'; seq: number; events: FileEvent[] }
  | { type: 'scan'; seq: number; progress: ScanProgress }
  | { type: 'roots'; seq: number; roots: RootInfo[] }
  | { type: 'stats'; seq: number; stats: Stats }
  | { type: 'resync'; seq: number; reason: 'initial' | 'gap-too-large' | 'server-restarted' }
  | { type: 'pong'; seq: number; at: number };

/** Client → server WebSocket messages. */
export type ClientMessage =
  | { type: 'hello'; lastSeq: number | null; serverId: string | null }
  | { type: 'ping' };

export interface Snapshot {
  seq: number;
  serverId: string;
  files: FileRecord[];
  roots: RootInfo[];
  stats: Stats;
}

export interface BrowseEntry { name: string; path: string }
export interface BrowseResponse { path: string | null; parent: string | null; entries: BrowseEntry[]; drives: string[] }

export interface ConfigView {
  roots: string[];
  autoRoots: boolean;
  effectiveRoots: string[];
  drives: string[];
  excludeNames: string[];
  excludePaths: string[];
  reconcileIntervalMin: number;
  dataDir: string;
  dbPath: string;
}

export interface TagCount { tag: string; count: number }
