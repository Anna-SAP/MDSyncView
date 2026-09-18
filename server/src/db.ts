import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { FileRecord, Heading, SearchHit, TagCount } from '../../shared/types.ts';
import { log } from './log.ts';

export interface FileRow extends FileRecord {
  hash: string;
  headings: Heading[];
  frontmatter: Record<string, unknown>;
  wikiLinks: string[];
}

export interface LiteRow { key: string; size: number; mtime: number; hash: string; path: string }

const SCHEMA_VERSION = '4';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  root TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  ctime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  tags TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  heading_count INTEGER NOT NULL,
  headings TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  wiki_links TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime DESC);
CREATE INDEX IF NOT EXISTS files_root ON files(root);
CREATE INDEX IF NOT EXISTS files_hash ON files(hash, size);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  key UNINDEXED, name, title, headings, tags, body,
  tokenize='trigram case_sensitive 0'
);
CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (src, target));
CREATE INDEX IF NOT EXISTS links_target ON links(target);
`;

const COLS = 'key,path,name,dir,root,size,mtime,ctime,hash,title,excerpt,tags,word_count,heading_count,headings,frontmatter,wiki_links,indexed_at';

type RawRow = {
  key: string; path: string; name: string; dir: string; root: string; size: number; mtime: number; ctime: number;
  hash: string; title: string; excerpt: string; tags: string; word_count: number; heading_count: number;
  headings: string; frontmatter: string; wiki_links: string; indexed_at: number;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function charLen(s: string): number {
  return [...s].length;
}

export class Index {
  private db!: DatabaseSync;
  private s!: {
    upsert: StatementSync; ftsDel: StatementSync; ftsIns: StatementSync; linkDel: StatementSync; linkIns: StatementSync;
    rowid: StatementSync;
    touch: StatementSync; get: StatementSync; getLite: StatementSync; remove: StatementSync; all: StatementSync;
    under: StatementSync; underLite: StatementSync; hasUnder: StatementSync; byHash: StatementSync; stats: StatementSync; tags: StatementSync;
    backlinks: StatementSync; metaGet: StatementSync; metaSet: StatementSync; countRoot: StatementSync;
    siblings: StatementSync;
  };

  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  open(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    let ok = false;
    try {
      this.connect();
      const qc = this.db.prepare('PRAGMA quick_check').get() as { quick_check: string };
      if (qc.quick_check !== 'ok') throw new Error('quick_check: ' + qc.quick_check);
      this.db.exec(SCHEMA);
      const ver = this.getMetaRaw('schema_version');
      if (ver !== null && ver !== SCHEMA_VERSION) throw new Error(`schema ${ver} != ${SCHEMA_VERSION}`);
      ok = true;
    } catch (e) {
      log.warn('db', 'index unusable, rebuilding', e);
    }
    if (!ok) this.rebuild();
    this.db.exec(SCHEMA);
    this.db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    this.prepare();
  }

  private connect(): void {
    this.db = new DatabaseSync(this.dbPath);
    // SQLite's lower() only folds ASCII; substring search needs Unicode-aware folding for CJK/accents
    this.db.function('ulower', { deterministic: true }, (v: unknown) => (v === null || v === undefined ? null : String(v).toLowerCase()));
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA cache_size=-65536');
    this.db.exec('PRAGMA temp_store=MEMORY');
  }

  private rebuild(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(this.dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
    this.connect();
    this.db.exec(SCHEMA);
    log.info('db', 'index rebuilt from scratch');
  }

  private getMetaRaw(k: string): string | null {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return row ? row.v : null;
  }

  private prepare(): void {
    const d = this.db;
    this.s = {
      upsert: d.prepare(`INSERT INTO files(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET path=excluded.path, name=excluded.name, dir=excluded.dir, root=excluded.root,
        size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, hash=excluded.hash, title=excluded.title,
        excerpt=excluded.excerpt, tags=excluded.tags, word_count=excluded.word_count, heading_count=excluded.heading_count,
        headings=excluded.headings, frontmatter=excluded.frontmatter, wiki_links=excluded.wiki_links, indexed_at=excluded.indexed_at`),
      // fts rows share the rowid of their files row, so delete/replace never scans the FTS content table
      ftsDel: d.prepare('DELETE FROM fts WHERE rowid = ?'),
      ftsIns: d.prepare('INSERT INTO fts(rowid, key, name, title, headings, tags, body) VALUES (?,?,?,?,?,?,?)'),
      rowid: d.prepare('SELECT rowid AS id FROM files WHERE key = ?'),
      linkDel: d.prepare('DELETE FROM links WHERE src = ?'),
      linkIns: d.prepare('INSERT OR IGNORE INTO links(src, target) VALUES (?, ?)'),
      touch: d.prepare('UPDATE files SET size = ?, mtime = ?, ctime = ?, path = ?, name = ?, dir = ?, indexed_at = ? WHERE key = ?'),
      get: d.prepare(`SELECT ${COLS} FROM files WHERE key = ?`),
      getLite: d.prepare('SELECT key, size, mtime, hash, path FROM files WHERE key = ?'),
      remove: d.prepare('DELETE FROM files WHERE key = ?'),
      all: d.prepare(`SELECT ${COLS} FROM files ORDER BY mtime DESC`),
      under: d.prepare(`SELECT ${COLS} FROM files WHERE key = ? OR (key >= ? AND key < ?)`),
      underLite: d.prepare('SELECT key, size, mtime, hash, path FROM files WHERE key = ? OR (key >= ? AND key < ?)'),
      hasUnder: d.prepare('SELECT 1 AS one FROM files WHERE key = ? OR (key >= ? AND key < ?) LIMIT 1'),
      byHash: d.prepare('SELECT key FROM files WHERE hash = ? AND size = ?'),
      stats: d.prepare('SELECT count(*) AS files, coalesce(sum(size),0) AS bytes, coalesce(sum(word_count),0) AS words FROM files'),
      tags: d.prepare("SELECT tags FROM files WHERE tags != '[]'"),
      backlinks: d.prepare(`SELECT ${COLS.split(',').map((c) => 'f.' + c).join(',')} FROM links l JOIN files f ON f.key = l.src WHERE l.target IN (?, ?) AND f.key != ? ORDER BY f.mtime DESC LIMIT 200`),
      metaGet: d.prepare('SELECT v FROM meta WHERE k = ?'),
      metaSet: d.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)'),
      countRoot: d.prepare('SELECT root, count(*) AS n FROM files GROUP BY root'),
      siblings: d.prepare('SELECT key, name, title FROM files WHERE dir = ? ORDER BY name COLLATE NOCASE LIMIT 500'),
    };
  }

  close(): void {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { this.db.close(); } catch { /* ignore */ }
  }

  getMeta(k: string): string | null {
    const row = this.s.metaGet.get(k) as { v: string } | undefined;
    return row ? row.v : null;
  }
  setMeta(k: string, v: string): void { this.s.metaSet.run(k, v); }

  private inTx = false;

  /** Run `fn` inside a write transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      begun = true;
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  private toRecord(r: RawRow): FileRecord {
    return {
      key: r.key, path: r.path, name: r.name, dir: r.dir, root: r.root, size: r.size, mtime: r.mtime, ctime: r.ctime,
      title: r.title, excerpt: r.excerpt, tags: safeJson<string[]>(r.tags, []), wordCount: r.word_count,
      headingCount: r.heading_count, indexedAt: r.indexed_at,
    };
  }
  private toRow(r: RawRow): FileRow {
    return {
      ...this.toRecord(r),
      hash: r.hash,
      headings: safeJson<Heading[]>(r.headings, []),
      frontmatter: safeJson<Record<string, unknown>>(r.frontmatter, {}),
      wikiLinks: safeJson<string[]>(r.wiki_links, []),
    };
  }

  upsert(row: FileRow, body: string): void {
    this.transaction(() => {
      this.s.upsert.run(
        row.key, row.path, row.name, row.dir, row.root, row.size, row.mtime, row.ctime, row.hash, row.title, row.excerpt,
        JSON.stringify(row.tags), row.wordCount, row.headings.length, JSON.stringify(row.headings),
        safeStringify(row.frontmatter), JSON.stringify(row.wikiLinks), row.indexedAt,
      );
      const rid = (this.s.rowid.get(row.key) as { id: number }).id;
      this.s.ftsDel.run(rid);
      this.s.ftsIns.run(rid, row.key, row.name, row.title, row.headings.map((h) => h.text).join('\n'), row.tags.join(' '), body);
      this.s.linkDel.run(row.key);
      for (const t of row.wikiLinks) this.s.linkIns.run(row.key, t.toLowerCase());
    });
  }

  touch(key: string, size: number, mtime: number, ctime: number, displayPath: string): void {
    this.s.touch.run(size, mtime, ctime, displayPath, path.basename(displayPath), path.dirname(displayPath), Date.now(), key);
  }

  get(key: string): FileRow | null {
    const r = this.s.get.get(key) as RawRow | undefined;
    return r ? this.toRow(r) : null;
  }
  getRecord(key: string): FileRecord | null {
    const r = this.s.get.get(key) as RawRow | undefined;
    return r ? this.toRecord(r) : null;
  }
  getLite(key: string): LiteRow | null {
    return (this.s.getLite.get(key) as unknown as LiteRow | undefined) ?? null;
  }

  /** Delete one file; returns the deleted row (for move detection) or null. */
  remove(key: string): FileRow | null {
    const row = this.get(key);
    if (!row) return null;
    this.transaction(() => {
      const rid = (this.s.rowid.get(key) as { id: number } | undefined)?.id;
      this.s.remove.run(key);
      if (rid !== undefined) this.s.ftsDel.run(rid);
      this.s.linkDel.run(key);
    });
    return row;
  }

  all(): FileRecord[] {
    return (this.s.all.all() as RawRow[]).map((r) => this.toRecord(r));
  }

  /** All rows whose key equals `prefixKey` or lives beneath it. */
  under(prefixKey: string): FileRecord[] {
    return (this.s.under.all(prefixKey, prefixKey + '/', prefixKey + '0') as RawRow[]).map((r) => this.toRecord(r));
  }
  underLite(prefixKey: string): LiteRow[] {
    return this.s.underLite.all(prefixKey, prefixKey + '/', prefixKey + '0') as unknown as LiteRow[];
  }
  /** True when `prefixKey` itself or anything beneath it is indexed (cheap existence test). */
  hasUnder(prefixKey: string): boolean {
    return this.s.hasUnder.get(prefixKey, prefixKey + '/', prefixKey + '0') !== undefined;
  }

  keysByHash(hash: string, size: number): string[] {
    return (this.s.byHash.all(hash, size) as { key: string }[]).map((r) => r.key);
  }

  stats(): { files: number; bytes: number; words: number } {
    return this.s.stats.get() as { files: number; bytes: number; words: number };
  }

  countByRoot(): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.s.countRoot.all() as { root: string; n: number }[]) m.set(r.root, r.n);
    return m;
  }

  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const r of this.s.tags.all() as { tags: string }[]) {
      for (const t of safeJson<string[]>(r.tags, [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  backlinks(key: string, stem: string, title: string): FileRecord[] {
    return (this.s.backlinks.all(stem.toLowerCase(), title.toLowerCase(), key) as RawRow[]).map((r) => this.toRecord(r));
  }

  siblings(dir: string): { key: string; name: string; title: string }[] {
    return this.s.siblings.all(dir) as { key: string; name: string; title: string }[];
  }

  /**
   * Full-text search. Terms with >= 3 characters use FTS5 trigram (CJK-safe, substring semantics);
   * shorter terms are applied as LIKE filters. If no term is long enough, a pure substring scan runs.
   */
  search(query: string, opts: { limit: number; offset: number; root?: string | null }): { hits: SearchHit[]; total: number; mode: 'fts' | 'substring' } {
    const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return { hits: [], total: 0, mode: 'fts' };
    const long = terms.filter((t) => charLen(t) >= 3);
    const short = terms.filter((t) => charLen(t) < 3);
    const limit = Math.max(1, Math.min(200, opts.limit));
    const offset = Math.max(0, opts.offset);
    const rootFilter = opts.root ? ' AND f.root = ? ' : '';
    const fcols = COLS.split(',').map((c) => 'f.' + c).join(',');

    if (long.length) {
      const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
      const likeClauses = short.map(() => "(ulower(f.name) LIKE ? ESCAPE '\\' OR ulower(f.title) LIKE ? ESCAPE '\\' OR ulower(fts.body) LIKE ? ESCAPE '\\')").join(' AND ');
      const where = `fts MATCH ? ${rootFilter} ${likeClauses ? ' AND ' + likeClauses : ''}`;
      const params: (string | number)[] = [match];
      if (opts.root) params.push(opts.root);
      for (const t of short) { const p = `%${likeEscape(t.toLowerCase())}%`; params.push(p, p, p); }
      const sql = `SELECT ${fcols}, snippet(fts, 5, char(1), char(2), '…', 22) AS snip, bm25(fts, 0, 12.0, 8.0, 4.0, 6.0, 1.0) AS score
        FROM fts JOIN files f ON f.rowid = fts.rowid WHERE ${where} ORDER BY score LIMIT ? OFFSET ?`;
      const rows = this.db.prepare(sql).all(...params, limit, offset) as (RawRow & { snip: string; score: number })[];
      const total = (this.db.prepare(`SELECT count(*) AS n FROM fts JOIN files f ON f.rowid = fts.rowid WHERE ${where}`).get(...params) as { n: number }).n;
      const hits = rows.map((r) => ({
        file: this.toRecord(r),
        snippet: escapeHtml(r.snip ?? '').replace(//g, '<mark>').replace(//g, '</mark>'),
        score: -r.score,
        matchedIn: matchedIn(r, terms),
      }));
      return { hits, total, mode: 'fts' };
    }

    // Substring-only path (1–2 character queries, very common for Chinese).
    const q = terms.join(' ').toLowerCase();
    const like = `%${likeEscape(q)}%`;
    const where = `(ulower(f.name) LIKE ? ESCAPE '\\' OR ulower(f.title) LIKE ? ESCAPE '\\' OR ulower(fts.body) LIKE ? ESCAPE '\\') ${rootFilter}`;
    const params: (string | number)[] = [like, like, like];
    if (opts.root) params.push(opts.root);
    const sql = `SELECT ${fcols},
        substr(fts.body, max(1, instr(ulower(fts.body), ?) - 60), 180) AS snip,
        (CASE WHEN ulower(f.name) LIKE ? ESCAPE '\\' THEN 0 WHEN ulower(f.title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END) AS rank
      FROM files f JOIN fts ON fts.rowid = f.rowid WHERE ${where} ORDER BY rank, f.mtime DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(q, like, like, ...params, limit, offset) as (RawRow & { snip: string; rank: number })[];
    const total = (this.db.prepare(`SELECT count(*) AS n FROM files f JOIN fts ON fts.rowid = f.rowid WHERE ${where}`).get(...params) as { n: number }).n;
    // highlight on the raw text, then escape each piece (never regex over already-escaped entities)
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    const hits = rows.map((r) => ({
      file: this.toRecord(r),
      snippet: (r.snip ?? '').replace(/\s+/g, ' ').trim().split(re).map((piece, i) => (i % 2 ? `<mark>${escapeHtml(piece)}</mark>` : escapeHtml(piece))).join(''),
      score: 3 - r.rank,
      matchedIn: matchedIn(r, terms),
    }));
    return { hits, total, mode: 'substring' };
  }
}

function matchedIn(r: RawRow & { snip?: string }, terms: string[]): SearchHit['matchedIn'] {
  const out: SearchHit['matchedIn'] = [];
  const lc = terms.map((t) => t.toLowerCase());
  const has = (s: string) => lc.some((t) => s.toLowerCase().includes(t));
  const headingText = safeJson<Heading[]>(r.headings, []).map((h) => h.text).join('\n');
  const tagText = safeJson<string[]>(r.tags, []).join(' ');
  if (has(r.name)) out.push('name');
  if (has(r.title)) out.push('title');
  if (has(headingText)) out.push('headings');
  if (has(tagText)) out.push('tags');
  if (r.snip && has(r.snip.replace(/[]/g, ''))) out.push('body');
  if (!out.length) out.push('body');
  return out;
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
function safeStringify(v: unknown): string {
  try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
}
