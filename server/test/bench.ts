/**
 * Indexing throughput benchmark: walks a directory and indexes every markdown file into a scratch DB,
 * reporting where time goes (walk / read+hash / meta / db).
 *
 * node --no-warnings server/test/bench.ts <dir> [--fresh]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Index } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { DEFAULT_EXCLUDE_NAMES, makeExcludeMatcher } from '../src/paths.ts';
import { walk } from '../src/scanner.ts';
import { readMarkdown } from '../src/content.ts';
import { extractMeta } from '../src/md-meta.ts';

const dir = process.argv[2] ?? 'C:\\@repo';
const fresh = process.argv.includes('--fresh');
const walkOnly = process.argv.includes('--walk-only');
if (walkOnly) {
  const t = performance.now();
  let n = 0;
  let lastLog = t;
  const r = await walk(dir, { exclude: makeExcludeMatcher(DEFAULT_EXCLUDE_NAMES, []), concurrency: 16, onFiles: (b) => { n += b.length; }, onProgress: (p) => { if (performance.now() - lastLog > 10000) { lastLog = performance.now(); console.log(`  … ${p.dirs} dirs, ${p.files} md, ${Math.round((performance.now() - t) / 1000)}s`); } } });
  console.log(`walk only: ${r.dirs} dirs, ${n} md, errors ${r.errors}, ${Math.round(performance.now() - t)}ms`);
  process.exit(0);
}
const dbPath = path.join(os.tmpdir(), 'mdsv-bench', 'index.db');
if (fresh) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Index(dbPath);
db.open();
const exclude = makeExcludeMatcher(DEFAULT_EXCLUDE_NAMES, []);
const indexer = new Indexer(db, { maxIndexedBytes: () => 2 * 1024 * 1024, exclude: () => exclude, roots: () => [dir] });

// 1) pure walk
let t0 = performance.now();
let found = 0;
const w = await walk(dir, { exclude, concurrency: 16, onFiles: (b) => { found += b.length; } });
console.log(`walk only: ${w.dirs} dirs, ${found} md, errors ${w.errors}, ${Math.round(performance.now() - t0)}ms`);

// 2) read+hash+meta only (no db)
t0 = performance.now();
let readMs = 0, metaMs = 0, bytes = 0, n = 0;
await walk(dir, {
  exclude, concurrency: 16,
  onFiles: async (batch) => {
    for (const c of batch) {
      const a = performance.now();
      const r = await readMarkdown(c.path, { maxBytes: 64 * 1024 * 1024 });
      const b = performance.now();
      readMs += b - a;
      if (r.ok) { extractMeta(c.path, r.text); metaMs += performance.now() - b; bytes += r.bytes; n++; }
    }
  },
});
console.log(`read+meta: ${n} files, ${(bytes / 1048576).toFixed(1)}MB, read ${Math.round(readMs)}ms, meta ${Math.round(metaMs)}ms, total ${Math.round(performance.now() - t0)}ms`);

// 3) full reconcile through the indexer (fresh db → all inserts)
t0 = performance.now();
let events = 0;
const res = await indexer.reconcile(dir, dir, (evs) => { events += evs.length; });
console.log(`reconcile #1 (inserts): ${res.files} files, ${res.changed} changed, ${events} events, ${res.elapsedMs}ms`);

// 4) second reconcile (all unchanged → stat-only skip)
t0 = performance.now();
const res2 = await indexer.reconcile(dir, dir, () => undefined);
console.log(`reconcile #2 (no-op): ${res2.files} files, ${res2.changed} changed, ${res2.elapsedMs}ms`);

const st = db.stats();
console.log(`db: ${st.files} files, ${(fs.statSync(dbPath).size / 1048576).toFixed(1)}MB on disk`);
db.close();
