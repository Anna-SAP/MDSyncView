> **说明**：本文是设计评审工作流（三位架构师提案 → 两位评委打分 → 综合）的产出，作为实现依据与参考。
> 实际实现按其主干落地，但在以下方面刻意简化：索引器运行在主线程（小事务 + 并发读取），无墓碑（tombstone）表，
> 移动检测基于哈希+大小并校验旧路径已消失，WebSocket 重放环保存在内存中（服务重启后客户端自动重取快照）。
> 以 `README.md` 与源码为准。

# MDSyncView — Final Implementation Design

Base: Proposal 1 (Scale & Performance). Grafted: every `must_graft` item from both judgments. Every contradiction listed by the judges is resolved inline and marked **[Resolved]**.

---

## 1. Architecture overview

MDSyncView is one Node 24 process bound to `127.0.0.1` that serves a Vite/React 19 PWA, a JSON API and a WebSocket event stream from a single port, and opens itself in Edge `--app` mode (chromeless window; no Electron download). The design principle is **events are hints, stat + hash is truth**: the Windows watcher only marks paths dirty; a verifier derives created / modified / moved / deleted / no-op from `stat({bigint:true})`, a content hash and a diff against the persisted SQLite catalog.

Three threads:

| Thread | Owns | Never does |
|---|---|---|
| **main** | Fastify 5 HTTP + WS, all `fs.watch` handles, DirtySet coalescer, WS fan-out, a **read-only** `node:sqlite` connection (WAL) for search/list | Writes to the DB, reads file bodies |
| **indexer worker** | The **single write** connection; verify/read/hash/extract; transactions of ≤200 files that atomically write `files`, `docs`, FTS, `changelog`, `meta.last_seq` | HTTP, watching |
| **scanner worker** | Directory walks (hot reconcile, island reconcile, cold sweep, subtree walks) emitting `(path,size,mtime_ns,ctime_ns)` batches | DB access |

**[Resolved] Writer placement:** worker thread from day one (P1/P3), not main thread (P2). `DatabaseSync` is synchronous; a 200-row FTS transaction on main would stall WS latency.

Client: React 19 + zustand 5; a **render Web Worker** (markdown-it + highlighter + KaTeX) returns hashed top-level blocks; main thread sanitizes with DOMPurify and patches with morphdom; a **fuzzy Web Worker** runs fuzzysort + pinyin over the tuple manifest for instant quick-open. Truth for the UI is always derivable from `GET /api/manifest` at a given `seq`, and every WS batch carries a strictly increasing `seq` backed by a persisted `changelog` table.

---

## 2. Process model & startup

**Port [Resolved]:** `41733`, fallback `+1..+20`. Instance file: `%LOCALAPPDATA%\MDSyncView\instance.json` `{pid, port, token, instanceId, startedAt}`. On launch: read it, `process.kill(pid,0)`, probe `GET /api/status` (500 ms timeout) and compare `instanceId`; if alive, launch the browser at the existing port and exit; if stale, take over.

**Startup invariant (hard rule, tested):**
1. Open DB (WAL, `mmap_size=256MB`, `cache_size=-65536`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`). Read `meta.schema_version`, `meta.last_seq`, `meta.clean_shutdown`. **[Resolved]** `PRAGMA quick_check` runs *only* if `clean_shutdown != 1`, and runs in the indexer worker *after* the UI is served; failure → rename `index.db` to `.corrupt-<ts>` and rebuild (the catalog is derived data).
2. Bind HTTP/WS (~60 ms). Serve the manifest from the catalog immediately (last-known state, ~150 ms to first paint).
3. **Start every `fs.watch` handle before any reconcile**, so no unobserved window exists. Run the watcher self-test (§4).
4. Hot-root reconcile (scanner N=48) — done in 0.3–1 s for ~1.8k files.
5. Island reconcile, then the cold sweep 30 s later at N=16, low priority, paused during bursts.

Because the pipeline is idempotent, a path examined by both a watcher event and a reconcile yields one change (second pass sees equal hash → no-op).

**Browser launch [Resolved]:** locate `msedge.exe` (`%ProgramFiles(x86)%\Microsoft\Edge\Application`, `%ProgramFiles%\...`) or `chrome.exe`; `execFile(exe, ['--app=http://127.0.0.1:<port>/', '--window-size=1440,960'])` with the **default profile** (keeps "Install app", extensions, PWA scope). Fallback: `execFile('rundll32', ['url.dll,FileProtocolHandler', url])`. Never `cmd /c start` with a URL string; never a token in the URL. `--no-open` flag for service use.

PWA: `vite-plugin-pwa` manifest (`display: standalone`); service worker precaches **hashed assets only**; `index.html` is NetworkFirst (it carries the per-launch token meta tag); `/api`, `/raw`, `/ws` are NetworkOnly. Protocol version in WS `hello` → mismatch forces a page reload.

Autostart: `mdsyncview install-startup` creates a Task Scheduler logon task (`powershell -WindowStyle Hidden -c "node <path>\server.js --no-open"`). Refuse to run elevated. Logging: pino 9 → `%LOCALAPPDATA%\MDSyncView\logs\` daily rotation; raw watcher events at trace level into a 2,000-entry ring exposed at `/api/debug/events`. Graceful SIGINT/SIGTERM: stop watchers, drain indexer, `wal_checkpoint(TRUNCATE)`, set `meta.clean_shutdown=1`. Packaging: esbuild single-file server; optional Node SEA `.exe`. Electron: deferred; a later shell would be a `BrowserWindow` at the same port.

---

## 3. Discovery

**Drives:** probe `C:..Z:` with `fs.stat` (2 s timeout), classify once via `Get-CimInstance Win32_LogicalDisk` (execFile, `-NoProfile`). DriveType 3 fixed → swept + watched; 2 removable → opt-in; 4 network → excluded by default, addable as `kind='polled'`; 5 skipped. Here: exactly `C:`.

**Roots table kinds:** `hot` (seeded defaults: `C:\@markdowns`, `C:\@daily`, `C:\@QA`, `C:\@repo`, `%USERPROFILE%\Documents`, `Downloads`, `Desktop`; seeded on first run only if they exist), `island` (auto-derived), `manual`, `polled`, plus the internal `sweep` root `C:\` which is **never** a containment root and never watched.

**Island derivation [Resolved]:** for every indexed `.md` outside a watched root, watch root = the child of its deepest *hub* ancestor, hubs = `{drive root, C:\Users, C:\Users\<user>, C:\ProgramData}` (P3), e.g. `C:\Users\<user>\.claude`, `C:\tools`. Nested islands merge into the shallower one. Ordered by md count (P1); cap **48 islands** + hot roots (≈ 55 handles max). Beyond the cap → `kind='polled'` (reconcile-only), shown in the status bar. Islands empty for 30 days are dropped.

**Exclusions** (picomatch 4, case-insensitive, evaluated on the *directory name/path before `readdir`*; editable in Settings with a "what would this exclude" preview and a "test this path" box):
1. Absolute: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, `C:\$Recycle.Bin`, `C:\System Volume Information`, `C:\Recovery`, `C:\PerfLogs`, `C:\$WinREAgent`, `C:\Config.Msi`, `C:\Users\Default*`, `C:\Users\Public\Libraries`, `C:\Users\All Users`, `%LOCALAPPDATA%\MDSyncView`.
2. Per-user: `**\AppData\**` (opt-in allow-list e.g. `AppData\Roaming\Code\User`), `**\.cache`, `.npm`, `.nvm`, `.pnpm-store`, `.yarn`, `.nuget`, `.gradle`, `.m2`, `.cargo`, `.rustup`, `.vscode\extensions`, `.vscode-server`, `.conda`, `anaconda3`, `miniconda3`, `.pyenv`, `.docker`, `.ollama`.
3. Names anywhere: `node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `.next`, `.nuxt`, `.turbo`, `.parcel-cache`, `site-packages`, `jspm_packages`, `bower_components`, `.terraform`, `coverage`, `.idea`, `.vs`, `$RECYCLE.BIN`. **[Resolved] Conditional rules (P1):** `target` only with sibling `Cargo.toml`/`pom.xml`; `bin`/`obj` only with sibling `*.csproj`/`*.sln`; `dist`/`build`/`out` only with sibling `package.json`/`tsconfig.json`/`CMakeLists.txt`. `tmp`/`temp`/`Python3*` are **not** excluded by name. `node_modules` and `.git` are **per-root toggles** (default on).
4. Reparse points: never descend `Dirent.isSymbolicLink()` (covers junctions); track visited `(dev,ino)` of directories; roots canonicalized with `fs.realpath.native`.
5. File ignore patterns: `*.tmp`, `*~`, `~$*`, `.#*`, `*.swp`, `*.crswap`, `*.part`, `*.partial`, `*.download`, `*.md.~lock`.

**Extensions:** `name.slice(lastIndexOf('.')).toLowerCase()` ∈ `{.md,.markdown,.mdown,.mkd,.mkdn,.mdx}` — `.MD` matches. **[Resolved]** `.mdx` on by default, rendered as markdown with JSX blocks shown as code.

**Walk (scanner worker):** iterative explicit stack, DFS per root; `fs.promises.readdir(dir,{withFileTypes:true})` (one `NtQueryDirectoryFile` batch, no per-entry stat); `stat({bigint:true})` only for md candidates; concurrency 48 for hot/island, 16 for the sweep; `setImmediate` yield every 64 directories; `fs.opendir({bufferSize:1024})` for directories >50k entries; per-directory `EPERM/EBUSY/ENOENT` counted, never fatal. **Long paths [Resolved]:** one `fsx` helper namespaces (`\\?\`) proactively above 240 chars and retries on `ENAMETOOLONG`/`ENOENT`; the prefix is stripped for storage/display. The walker also records media filenames into `media(name_key, path_key, dir_key)` **only inside md-bearing directories under watched roots**, never during the drive sweep (P2's whole-drive media table is rejected).

**OneDrive [Resolved]:** roots under `%OneDrive%`/`%OneDriveCommercial%` are scanned; once per sweep `attrib.exe /S /D` runs bounded to that root (off the hot path) and files flagged `O`/`U` get `state='cloud_only'` (filename/title indexed, body never read). Per-root "index content" switch; a cloud-only file is hydrated only when the user opens it and clicks "Download & open".

**Progress:** scanner posts `{phase, rootId, dirs, files, changed, errors, etaMs}` every 250 ms → WS `scan`; ETA from `roots.last_dir_count`. Files surface per indexer batch, not at the end.

**Reconcile cadence [Resolved]:** (a) cheap **stat-sweep of known files** every 5 min (compare `(size, mtime_ns, ctime_ns)`, hash only on mismatch); (b) hot + island directory walk every 15 min (staggered `rootId*7 s`); (c) full sweep every 6 h **and** only when idle ≥5 min — never "idle alone"; (d) immediately on watcher overflow/error, on clock jump >30 s (sleep/resume), and on demand. The sweep pauses while the DirtySet has >500 pending paths and is abortable. Files under a vanished fixed-drive root → `missing` after two consecutive 30 s health ticks, tombstoned only after two completed walks; removable/polled roots → `unavailable`, restored on return.

---

## 4. Watcher

**API:** `fs.watch(root,{recursive:true,persistent:true,encoding:'utf8'})`, one handle per hot/island root on main. Corrected fact: libuv's `ReadDirectoryChangesW` buffer is **4 KB** (`uv_directory_watcher_buffer_size`), not 64 KB; overflow surfaces as `'change'` with `filename === null` and is **routine** on `C:\@repo` during `npm install`/`git checkout`. Therefore `C:\` is never watched, overflow → reconcile is a normal path, and `@parcel/watcher@2` (64 KB buffer, win32 prebuilds) is an opt-in setting behind the same watcher interface.

**Facts the pipeline assumes:** create/delete/both halves of a rename all arrive as `'rename'`; directory rename/delete emits one event for the directory and none for children; `'change'` also fires for attribute/Defender scans; OLD/NEW rename halves can straddle a flush.

**Pipeline (main thread):**
1. Raw event → `full = join(root, filename)`; `key = full.normalize('NFC').toLowerCase()` (prefix stripped). `filename===null` → `scheduleRootReconcile(root, 2000 ms debounce)`. Ignore-pattern names are dropped but recorded in `recentTmp[dirKey]=now` for 2 s (atomic-replace hint). Non-md extension → kept as `kind:'maybe-dir'` (never dropped).
2. **DirtySet** `Map<key,{full,kind,firstSeen,lastSeen,count}>`. **Timings [Resolved]:** file quiet **150 ms**, max-hold **500 ms** from `firstSeen`; directory quiet **300 ms**; global flush tick 100 ms draining ≤200 keys per batch to the indexer. **Burst mode:** >200 raw events/s → switch to 750 ms batch flushes until <20/s for 2 s.
3. **Indexer verify per path:** `stat1 = stat({bigint:true})`. `ENOENT` → **delete-grace**: re-stat at 150 ms and 300 ms; still missing → vanished candidate. `EBUSY/EPERM/EACCES` → backoff 50,100,200,400,800,1600 ms; after 6 failures `state='locked'`, WS `doc.locked`, re-verify in 10 s. Directory → subtree walk (scanner) + diff vs `files WHERE path_key >= P AND path_key < P||'\uffff'`. File → if `(size,mtime_ns,ctime_ns)` equal to the row → no-op. Else read (≤20 MB, 8 concurrent reads), `stat2`; if size/mtime changed mid-read → re-enqueue 200 ms (≤10 rounds, then index what we have). Zero-byte immediately after create → hold one extra 100 ms tick. **Hash [Resolved]:** `crypto.hash('sha256', bytes)` truncated to 16 bytes over **raw bytes**; normalization (BOM, CRLF, NFC, full-width folding) is applied only to the FTS copy. Equal hash → silent metadata update, no `doc` push. Decode: BOM sniff → `TextDecoder('utf-8',{fatal:true})` → `gb18030` fallback; encoding stored.
4. **Move pairing [Resolved]:** vanished set V (spans batches via a **2 s vanished buffer**) vs appeared set N. Pair by `(dev,ino)` equality (BigInt strings) **first**, then `(size,hash)`, tie-break same parent then most recent → `moved {id preserved, from, to}`. Case-only/NFC-only renames share a key → metadata update. Atomic `x.md.tmp`→`x.md` → path exists with new hash → `modified`, same id. Unmatched V → tombstone (`state='deleted', deleted_at`), retained 30 days for rename-back matching and the "Recently deleted" view. Unmatched N → `created`; a tombstone with equal hash → restored with its old id.
5. **Directory cascade:** deleted dir → prefix-range rows stat-confirmed 16-way, tombstoned in one transaction, one WS batch. Renamed dir → V(old subtree from DB) + N(new walk) paired by relative path + hash → per-child `moved`; 300 notes rename in <1 s with no re-indexing.
6. **Failure ladder:** `error`/`close` → `watch_state='degraded'`, WS `watch`, reopen with backoff 1→60 s; while degraded, poll-reconcile that root every 30 s. Root health tick every 30 s (`stat` each root). **Self-test at startup:** watch `%LOCALAPPDATA%\MDSyncView\selftest`, write a file, expect an event within 2 s; failure → status warning + 30 s polling for all roots. **Sentinel watchdog:** every 10 min, touch the sentinel; no event in 3 s → recreate all handles. A dead handle never survives >10 min. Client `focus` → server stat-checks subscribed docs.
7. **Fan-out:** the indexer commits `changelog` rows in the same transaction; main appends to an in-memory ring (50,000) and broadcasts `{t:'batch', seq, ...}` coalesced at 50 ms / ≤100 upserts (<32 KB). Per-subscribed-doc pushes throttled to 300 ms/id. **Backpressure:** client acks every 500 ms; if >5,000 behind or `socket.bufferedAmount > 4 MB` → stop streaming, send `resync`. Heartbeat 15 s; two missed pongs → drop.

Timing table: quiet 150 / hold 500 / dir 300 / delete-grace 150+300 / vanished 2 s / lock backoff 50→1600 / mid-write 200×10 / doc throttle 300 / burst 750 / overflow debounce 2 s / reopen 1→60 s / degraded poll 30 s / health 30 s / stat-sweep 5 min / hot walk 15 min / sweep 6 h idle-gated / changelog 50k or 7 d / tombstone 30 d.

---

## 5. Index & search

`%LOCALAPPDATA%\MDSyncView\index.db`. Writer in the indexer worker; reader on main. Startup smoke test creates an in-memory FTS5 trigram table (failure → unicode61 + LIKE fallback with a status warning).

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_seq, instance_id, clean_shutdown, last_sweep_at
CREATE TABLE roots(id INTEGER PRIMARY KEY, path TEXT, path_key TEXT UNIQUE, kind TEXT CHECK(kind IN('hot','island','manual','polled','sweep')),
  enabled INT DEFAULT 1, index_content INT DEFAULT 1, watch_state TEXT, exclude_json TEXT,
  last_walk_at INT, last_dir_count INT, md_count INT, node_modules_excluded INT DEFAULT 1, git_excluded INT DEFAULT 1);
CREATE TABLE dirs(id INTEGER PRIMARY KEY, path_key TEXT UNIQUE, path TEXT, parent_id INT, root_id INT, depth INT, md_count INT);
CREATE TABLE files(id INTEGER PRIMARY KEY, root_id INT, dir_id INT, path TEXT NOT NULL, path_key TEXT UNIQUE NOT NULL,
  name TEXT, stem TEXT, stem_pinyin TEXT, ext TEXT, size INT, mtime_ns TEXT, ctime_ns TEXT, birthtime_ms INT, ino TEXT, dev TEXT,
  hash BLOB, encoding TEXT, title TEXT, headings TEXT, frontmatter TEXT, tags TEXT, lang TEXT, word_count INT,
  has_math INT, has_mermaid INT, has_media INT,
  state TEXT CHECK(state IN('ok','deleted','locked','too_large','partial','cloud_only','unreadable','missing','unavailable')),
  deleted_at INT, indexed_at INT, version INT);
CREATE INDEX files_mtime ON files(mtime_ns DESC); CREATE INDEX files_dir ON files(dir_id);
CREATE INDEX files_state ON files(state, deleted_at); CREATE INDEX files_ino ON files(dev, ino); CREATE INDEX files_stem ON files(stem);
CREATE TABLE docs(file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  title TEXT, headings TEXT, body TEXT, tags TEXT, pathwords TEXT);   -- real table (external content must be a table, not a view)
CREATE VIRTUAL TABLE fts_tri USING fts5(title, headings, body, tags, pathwords, content='docs', content_rowid='file_id',
  tokenize='trigram case_sensitive 0 remove_diacritics 1');
CREATE VIRTUAL TABLE fts_word USING fts5(title, headings, body, tags, pathwords, content='docs', content_rowid='file_id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_@#.'");
-- standard external-content triggers (ai/ad/au) on docs keep BOTH fts tables in sync inside the same transaction
CREATE TABLE tags(tag TEXT, file_id INT, PRIMARY KEY(tag,file_id)); CREATE INDEX tags_tag ON tags(tag);
CREATE TABLE links(src_id INT, target_key TEXT, anchor TEXT, kind TEXT, target_id INT, PRIMARY KEY(src_id,target_key,anchor));
CREATE TABLE media(name_key TEXT, path_key TEXT PRIMARY KEY, dir_key TEXT); CREATE INDEX media_name ON media(name_key);
CREATE TABLE open_history(file_id INT PRIMARY KEY, opened_at INT, count INT);
CREATE TABLE changelog(seq INTEGER PRIMARY KEY, ts INT, file_id INT, type TEXT CHECK(type IN('created','modified','moved','deleted','meta','restored')),
  path TEXT, from_path TEXT, hash BLOB, size INT, mtime_ns TEXT);
```

**[Resolved] FTS layout:** dual tables (trigram + unicode61) over one real external-content table `docs`, trigger-synced. **[Resolved] Caps:** body 2 MB (`state='partial'` badge beyond), file 20 MB (metadata only), binary-looking (>5 % NUL) → `unreadable`; `excludeFromContent` globs (e.g. `**/secrets/**`) keep metadata but never store bodies. **Changelog** rows are written in the same transaction as `files`/`docs`/`meta.last_seq`; `seq` = rowid, gap-free and crash-consistent; retention 50,000 rows or 7 days.

**Indexed per file:** frontmatter (yaml 2, failsafe; malformed → raw); `title` = frontmatter.title → first H1 → stem; headings with line numbers; tags = frontmatter tags ∪ inline `#tag` outside code (unicode-aware); body = markdown minus frontmatter, fence markers removed, NFC + full-width→half-width folded, LF-normalized; **pathwords** = path split on `\ / _ - .` plus date runs plus raw path, so `20260819_ANY-27206_BugFix_分析.md` hits on `ANY-27206`, `BugFix`, `分析`; `stem_pinyin` = full pinyin + initials via pinyin-pro 3 (only when the stem contains CJK); `lang` by CJK ratio.

**Query router [Resolved]:** parse `"phrase"`, `-term`, `tag:`, `path:`, `title:`, `heading:`, `root:`, `dir:`, `ext:`, `after:`, `before:`. Every free token is double-quoted with internal quotes doubled (never raw into MATCH). Per term: CJK ≥3 chars → `fts_tri`; CJK 1–2 chars → tiered LIKE fallback: `lower(name)`, `lower(title)`, `lower(headings)` first, then bounded `docs.body` (LIMIT 200) — labelled "substring scan" in the UI; Latin/ASCII → `fts_word` with trailing `*` on the last term OR `fts_tri` substring when ≥3 chars. Candidate sets intersect by rowid. Ranking: `bm25(fts_word, 12,6,1,8,4)` (title, headings, body, tags, pathwords), combined with `bm25(fts_tri, ...)` where used; JS post-pass: recency boost `1+0.25·e^(−ageDays/30)`, open-history familiarity ≤1.2, exact title/stem match pinned. Snippets: `snippet(fts, 2, '\u0001','\u0002','…', 20)` widened in JS to sentence/line boundaries (≤200 chars), marks merged; control chars become `<mark>` **after** HTML escaping; same for `highlight()` on title. Budget: <15 ms server, <50 ms end-to-end; server caches per `(q,filters)` for 2 s, invalidated on any seq advance.

**Quick-open** never hits the server: the tuple manifest lives in a Web Worker with fuzzysort 3 + pinyin-pro (lazy) targets over `stem`, `title`, `stem_pinyin`; incrementally patched from WS.

**Incremental writes:** per file `INSERT … ON CONFLICT(path_key) DO UPDATE`, `INSERT OR REPLACE INTO docs` (triggers refresh both FTS), replace `tags`/`links`, `INSERT INTO changelog`; moves update path columns and re-write `docs.pathwords` only; deletes remove the `docs` row (removing FTS) and set the tombstone. Bulk first load: 500/txn with `synchronous=OFF`, then `optimize` on both tables; `optimize` nightly at idle; `wal_checkpoint(TRUNCATE)` after 60 s idle.

---

## 6. Render pipeline

**[Resolved] Always in the render Web Worker** (comlink 4); main thread only sanitizes and patches. Worker in: `{id, text, dirKey, settings}`; out: `{blocks:[{key,hash,html,line}], headings, frontmatter, stats, hasMermaid, hasMath}`. Blocks are top-level markdown-it token groups keyed by `xxhash(blockSource + occurrenceIndex + pluginConfigHash)` (xxhash-wasm 1, FNV-1a fallback). Streaming for >300 KB: chunks of 200 blocks via callbacks; first chunk mounted synchronously, rest in `requestIdleCallback` ≤8 ms slices; `content-visibility:auto; contain-intrinsic-size:auto 120px` on every block; >20 MB → metadata + first 64 KB raw.

**markdown-it 14** `{html:true, linkify:true, typographer:false, breaks:false}` (**[Resolved]** typographer off — developer notes contain `--flags`; per-doc `breaks` via frontmatter). Plugins in order: `markdown-it-front-matter` → custom **github-alerts** core rule (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` → `<aside class="admonition …">`) → `markdown-it-container` (`::: note|tip|info|warning|danger|abstract`, `::: details Title` → `<details><summary>`) → `markdown-it-anchor` (custom slugger: NFC, lowercase, keep CJK/letters/digits, dedupe `-n`; heading collector with `line`) → `task-lists` → `footnote` → `emoji` (full set) → **`@vscode/markdown-it-katex` + katex 0.16** (**[Resolved]**; `throwOnError:false, output:'htmlAndMathml', trust:false, strict:'ignore'`) → `attrs` (class/id/width/height/title/hl only) → `mark`, `sub`, `sup`, `ins`, `deflist`, `abbr` → `multimd-table` (setting, default off) → custom **wikilink** (`[[Name]]`, `[[Name#Heading|Alias]]`, `![[Name]]` transclusion depth ≤2 cycle-guarded, `![[image.png|300]]`) → custom **media** renderer (`.mp4/.webm/.m4v/.mov/.ogv` → `<video controls preload=metadata playsinline>`; `.mp3/.wav/.ogg/.m4a/.flac/.opus` → `<audio>`; `.pdf` → link + sandboxed `<iframe>` preview toggle to `/raw`; `.svg` → `<img>` by default, "open inline" affordance; others `<img loading=lazy decoding=async>`) → custom **path-rewrite** core rule (**[Resolved]** rewriting happens here, pre-sanitize, not in a DOMPurify hook): any `src/href/poster/<source src>` in markdown or raw HTML tokens with no scheme (or `file:///C:/…` / `C:\…`) becomes `/raw/<docId>/<encoded rel>`, absolute forms become `/raw/<docId>/~abs/<encoded>`; `![[name]]` → `/raw/<docId>/~/<name>`; `.md` links → `data-nav` in-app route; external links `target=_blank rel="noopener noreferrer"`. Fences: `mermaid` → `<pre class="mermaid-src" data-hash>`; others → **highlight.js 11** default (**[Resolved]**; core + on-demand grammar chunks, never 40 bundled) with **Shiki 3** (JS engine, dual-theme CSS variables) as the opt-in path in the same worker; a plain `<pre data-lang>` with identical metrics is emitted first so the swap causes no layout shift; header with language badge, copy, wrap toggle, `{title=}`/`{hl=3-5}`; >20k chars unhighlighted; every block has `data-line` from `token.map`.

**Sanitizer (main, DOMPurify 3):** `USE_PROFILES:{html,svg,svgFilters,mathMl}`; `ADD_TAGS: video audio source track picture details summary mark kbd abbr figure figcaption aside`; `ADD_ATTR: controls loop muted poster preload playsinline srclang label kind default open srcset sizes loading decoding target data-lang data-hash data-line data-nav data-wikilink data-mermaid disabled checked type`; `FORBID_TAGS: script iframe object embed form input(except type=checkbox via hook) foreignObject animate set meta link base` and `style` **in HTML context only**; `FORBID_ATTR: srcdoc formaction ping autoplay` + all `on*`; `ALLOWED_URI_REGEXP` = `^(https?|mailto|tel):|^/raw/|^/api/|^#|^data:image/(png|gif|jpe?g|webp|avif);base64,`; hooks: `<use>/<image>/<feImage>` href must start with `#`; `style` attributes containing `url(`/`expression(` dropped; iframe allowed only for allow-listed hosts (default empty; YouTube/Vimeo/bilibili suggested) with `sandbox="allow-scripts allow-same-origin" referrerpolicy=no-referrer`. **[Resolved] Inline SVG isolation:** each inline `<svg>` is mounted into an `<md-svg>` custom element with an open Shadow Root; `<style>` is kept **only** when its ancestor is `svg` (draw.io/Excalidraw/PlantUML exports keep styling, ids and CSS cannot leak); SMIL `animate/set` forbidden. Mermaid output is re-sanitized with the same profile and mounted the same way. **[Resolved] Trusted Types:** report-only (`Content-Security-Policy-Report-Only: require-trusted-types-for 'script'`), not enforced — Mermaid/KaTeX/morphdom sinks would break.

**Patch:** keyed diff on block hashes (LCS on the key sequence); morphdom 2 on changed blocks with `onBeforeElUpdated` returning false when `data-hash` matches, so rendered Mermaid SVGs, highlighted fences, open `<details>`, playing media and selection survive. Scroll: record the first block whose top ≥ `scrollTop` plus offset; restore after patch; numeric fallback; Chromium `overflow-anchor` on. Mermaid 11 lazy (`securityLevel:'strict'`, theme mapped from tokens, source ≤50 KB, LRU 200 by `hash(src+theme)`, errors → source with red caption). Image intrinsic sizes cached (localStorage by src) and reapplied as width/height; `<dialog>` lightbox with wheel/pinch zoom and arrow navigation; broken media → placeholder with resolved path + Reveal.

**Emoji:** shortcodes → Unicode; `.prose` font stack `Inter, "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"` + `font-variant-emoji: emoji`; post-render pass appends U+FE0F to bare keycap/symbol sequences; a canvas-measured undrawable-grapheme check (once per unique emoji) swaps flags and undrawables for locally bundled `@twemoji/api` SVGs; "Twemoji everywhere" setting.

Properties card (frontmatter grid, tags as chips → `tag:` search, dates humanized, raw YAML toggle); TOC from worker headings with IntersectionObserver scroll-spy; raw view = `<pre>` with hljs markdown + line numbers; split source|rendered with scroll synced via `data-line`; `GET /api/export/:id` standalone HTML (inlined CSS, base64 media ≤25 MB) + print stylesheet.

---

## 7. UI spec

**Shell:** three resizable panes (react-resizable-panels 3) + status bar; below 900 px the side panes become drawers; 16 px gutters at phone width.

**Left sidebar** (280 px, 200–420, Ctrl+B) icon-rail views: **Files** (tree built client-side from the manifest, flattened + virtualized with `@tanstack/react-virtual` at 26 px rows, compact single-child chains, md counts, hot roots pinned, islands under "Elsewhere on C:", unread dot on files changed since last open, `Intl.Collator('zh-Hans-CN',{numeric:true})` sort, context menu: open / open to side / reveal / copy path / open in editor / pin as root / exclude folder; type-to-filter via the fuzzy worker), **Recent** ("Live — changed in last 10 min" with pulsing dot, then Today/Yesterday/This week/Older; new rows FLIP-animate in with a 1.5 s highlight; change badges new/modified/moved; **Recently deleted** group from tombstones), **Search** (results with title highlight, breadcrumb, `<mark>` snippet, facets root/tag/date, sort rank/mtime, "took 7 ms", J/K + Enter, Ctrl+Enter opens to the side), **Tags**, **Activity** (live feed with `seq`, byte delta, type, click-to-open; doubles as the sync-debug console).

**Center:** tab strip (Ctrl+Tab, Ctrl+W, Ctrl+Shift+T reopen, middle-click, drag reorder, pin; orange dot while a file is being rewritten, ⊘ badge when deleted; tabs persisted); sticky header: breadcrumb (segments focus the tree), title, live "modified 12 s ago", root chip, encoding badge if not UTF-8, "partially indexed"/"cloud-only"/"locked" badges, actions (Open in editor Ctrl+E, Reveal, Copy path, Rendered/Raw/Split Ctrl+Shift+V, Outline, Export), live pill (● Live / Reconnecting / Watcher degraded). Article: measure presets 62/72/88 ch/full; base 16 px, line-height 1.75, **1.9 for `lang='zh'`**; `text-spacing-trim`, `hanging-punctuation`; tables with sticky headers; admonitions; footnote hover cards; Ctrl+= / Ctrl+- content zoom. Split view (drag a tab right) v1.

**Right rail** (240 px, Ctrl+\): Outline, Backlinks (from `links`), Properties, Info (path, size, encoding, words, created/modified, hash, duplicates "≡2" badge via equal hash).

**Live-update UX:** modified → block patch with scroll preserved, 600 ms tint on changed blocks (toggle); **follow-tail**: within 48 px of the bottom and the file grew → stay pinned, show a "Following ↓" pill; any upward scroll cancels, click re-enables; updates coalesced client-side to ≤3/s. Deleted → content stays readable (dimmed 10 %) with banner "Deleted from disk · 5 s ago [Keep] [Close]"; tree row strikes through and fades after 3 s; reappearance within 30 s clears the banner. Moved → tab/breadcrumb/URL `#/f/<id>` update in place, 4 s toast with Reveal. Bursts → one toast per batch (>20 events: "37 files updated in C:\@repo"). **Follow latest** (Ctrl+Shift+L): any created/modified file becomes the active tab. Root degraded → amber dot + Retry/Rescan; nothing modal ever appears.

**Command layer:** cmdk palette Ctrl+K / Ctrl+P: default = fuzzy file finder (stem/title/path + pinyin full and initials, "fx" → 分析, recent pre-listed); `>` commands, `#` headings in doc, `@` tags, `?` full-text. Keyboard: Ctrl+Shift+F search, Ctrl+B, Ctrl+\, Ctrl+E editor, Ctrl+Shift+V view cycle, Ctrl+Shift+O outline, Ctrl+Shift+L follow latest, Alt+←/→ history, Alt+↑ parent, J/K or ↑/↓ lists, `[`/`]` prev/next heading, `/` filter, Ctrl+1..9 tabs, Ctrl+Shift+C copy path, Ctrl+Shift+R reveal, Ctrl+, settings, F5 force re-read, `t` theme, `?` cheat sheet, Esc.

**Theme:** light / dark / sepia / system via tokens on `:root` + `data-theme`; accent presets; `forced-colors` respected; View Transitions on switch; dark mode dims images 8 % (hover restores); hljs/Shiki/Mermaid themes paired. Fonts: Inter Variable (bundled) + Microsoft YaHei UI; Cascadia Code → JetBrains Mono → Consolas.

**Settings** (`settings.json`, hot-reloaded, zod-validated): roots (add with existence check, kind, per-root exclusions, `node_modules`/`.git` toggles, index-content switch), exclusion globs with "would exclude N files" preview + "test a path", extensions, reconcile intervals, content caps + excludeFromContent globs, rendering toggles (mermaid, math, multimd, iframe allow-list, twemoji mode, inline SVG), typography, live-update options (highlight, follow-tail, delete grace, toast verbosity), external editor (validated executable path + fixed argv template), startup (auto-open, autostart), index stats + Rescan/Rebuild/Optimize, diagnostics (handles, event rate, queue depth, last errors), shortcuts.

**Status bar:** WS dot, "Watching 14 roots (1 degraded)", file count, scan progress "Scanning C:\ 128k dirs · 1,802 md · ~40 s", last event "2 s ago", search timing, seq. Empty states: onboarding with live counters; no selection → cheat sheet + recent; no results → tips incl. "2-char queries use substring scan"; locked → "waiting for writer… retry"; cloud-only → "Download & open"; offline → "Reconnecting…" with last content read-only.

---

## 8. API + WebSocket contract

Base `http://127.0.0.1:<port>`. Ids are integers; clients never send absolute paths except `POST /api/roots`. Errors `{error:{code,message}}`. `mtimeNs` is a decimal string.

`FileRow` columns (manifest tuple order and WS objects share it): `["id","path","name","title","size","mtimeNs","rootId","state","hash","lang","tags"]`.

- `GET /api/status` → `{version, protocol, instanceId, seq, indexed:{files,dirs,dbBytes}, roots:[{id,path,kind,enabled,watchState,mdCount,lastWalkAt}], scan:{phase,rootId,dirs,files,changed,etaMs}|null, workers:{indexQueue,readInFlight}, watcherSelfTest:'ok'|'failed'}`
- `GET /api/manifest` → ETag `"seq"`, 304 on match; `{seq, roots, cols, rows:[[…]]}` gzipped.
- `GET /api/files?since=<seq>` → `{seq, changed:FileRow[], deleted:number[], resync:boolean}` from `changelog`, deduplicated per id.
- `GET /api/files/:id` → `FileRow & {headings, frontmatter, encoding, wordCount, backlinks, links, duplicates, deletedAt?}`
- `GET /api/files/:id/content` → `text/markdown`, ETag `"<hash>"`, `X-Encoding`, `X-Mtime-Ns`; 304; 423 locked; 413 too_large unless `?head=65536`; tombstones 404 unless `?tombstone=1`.
- `GET /api/search?q&limit&offset&sort&root&dir&tag&after&before` → `{seq, mode:'fts'|'substring', total, tookMs, parsed, hits:[{id,path,title,titleHl,snippet,score,mtimeNs,size,tags,matchedIn}]}`
- `GET /api/suggest?q&limit=20`, `GET /api/tags`, `GET /api/recent?kind=opened|modified`, `GET /api/backlinks/:id`, `GET /api/resolve?from=<id>&target=<rel|[[wiki]]>` → `{id|null, candidates}`, `GET /api/changelog?since&limit`, `GET /api/export/:id?format=html`, `GET /api/debug/events?limit`, `GET /healthz`.
- `GET /raw/:id/*rel` — **[Resolved]** media by document id + relative segment; `~/name` = resolve-by-name via `media`; `~abs/<encoded>` = absolute reference from the document. Headers: Content-Type from extension only, `Accept-Ranges`, 206, ETag `"mtime-size"`, `Cache-Control: private, no-cache`, `nosniff`, `Content-Disposition: inline; filename*=UTF-8''…`; SVG adds `Content-Security-Policy: sandbox; script-src 'none'`. 403/404/415.
- Mutations (`X-MDSV-Token` required): `POST /api/roots {path,kind}`, `DELETE /api/roots/:id`, `POST /api/roots/:id/rescan`, `POST /api/rescan {mode:'hot'|'full'}`, `POST /api/index/optimize|rebuild`, `POST /api/open {id, with:'editor'|'explorer'|'default'}`, `POST /api/opened {id}`, `PUT /api/settings`, `POST /api/dialog/folder`.

**WebSocket `/ws`** (JSON, `t` field, 64 KB cap, unknown types ignored, zod-validated):
- client→server: `{t:'hello', protocol:1, clientId, lastSeq|null, token}`, `{t:'sub', ids}`, `{t:'unsub', ids}`, `{t:'ack', seq}`, `{t:'focus'}`, `{t:'pong'}`, `{t:'resync-done', seq}`.
- server→client: `{t:'hello', instanceId, seq, resync:boolean, status}` followed by replay batches if `resync:false`; `{t:'batch', seq, events:[{seq,ts,type:'created'|'modified'|'moved'|'deleted'|'meta'|'restored', file:FileRow, from?, delta?}]}` (≤100 per frame, seq strictly increasing); `{t:'doc', id, seq, hash, mtimeNs, size, encoding, text?, fetch?:true}` (inline ≤256 KB, throttled 300 ms/id); `{t:'doc.locked', id, retryInMs}`; `{t:'scan', …}` (≤4/s); `{t:'watch', rootId, state, reason?}`; `{t:'resync', seq}`; `{t:'settings', settingsHash}`; `{t:'toast', level, text, ttlMs}`; `{t:'ping'}`; `{t:'error', code}` (protocol mismatch → reload).

Ordering guarantee: applying every event from `lastSeq` forward yields exactly `GET /api/manifest` at that seq. Reconnect: backoff 250 ms→8 s with jitter; replay from `changelog` within retention (50k / 7 d), else `resync` → `/api/files?since=` or full manifest. Restart does **not** force a full refetch.

---

## 9. Security

Threat model: hostile Markdown/SVG on disk; a foreign web page in the same browser (DNS rebinding, CSRF, `<img>` probing); path traversal through media; process spawning.

- **Network:** bind `127.0.0.1` only (`::1` deliberately unbound). Every request must carry `Host ∈ {127.0.0.1:<port>, localhost:<port>}` else 421. **[Resolved] All routes** (including GET `/api/*` and `/raw`) require `Sec-Fetch-Site ∈ {same-origin, none}`; WS upgrades and non-GET additionally require `Origin` equal to the server origin. No CORS headers ever.
- **[Resolved] Auth:** a 32-byte per-launch token in `instance.json`, injected as `<meta name="mdsv-token">` into `index.html` at serve time (NetworkFirst, never precached), sent as `X-MDSV-Token` on mutations and in WS `hello`; constant-time compare. No token in URLs or cookies; survives restart for installed PWAs (the page refetches `index.html`). The custom header also forces a preflight we never answer.
- **CSP** on the shell: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:<port>; frame-src <allow-list|'none'>; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` + `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin, minimal `Permissions-Policy`. Trusted Types report-only.
- **`/raw` policy:** decode once; reject NUL, >4,096 chars, `\\` UNC/device prefixes, `\\?\`, `:` anywhere except index 1 (NTFS ADS), reserved basenames (`CON PRN AUX NUL COM1-9 LPT1-9`); `path.win32.resolve(dirname(doc.path), rel)`; `fs.realpath.native`; **containment [Resolved]:** realpath must be inside the document's ancestor directory chain OR any enabled hot/island/manual root — the `sweep` root never counts — and not inside a system exclusion; segment-wise prefix match. **Extension allow-list [Resolved]:** media + pdf only (`png jpg jpeg gif webp avif bmp ico svg mp4 webm m4v mov ogv mp3 wav ogg oga m4a flac opus pdf`); text formats (`.md .txt .json .csv .env`) are never served here — markdown transclusion goes through `/api/files/:id/content` by id. Regular files only, ≤2 GB, streamed with Range. Optional HMAC-signed asset URLs (`&s=hmac(path,hour)`).
- **Sanitizer:** as §6; SVG files only via `<img>` under a sandboxed CSP; inline SVG in Shadow DOM with fragment-only `href`; KaTeX `trust:false`; Mermaid `strict`.
- **Spawning:** `/api/open` resolves paths by id only; `execFile('explorer.exe', ['/select,', path])` or the validated editor executable with a fixed argv template; no shell. Refuse to run elevated. Settings, roots and WS messages zod-validated; excluded system dirs cannot become roots.
- **Data at rest:** `index.db` (contains bodies), `settings.json`, logs under `%LOCALAPPDATA%` (user ACL); logs never contain file contents; "Rebuild index" VACUUMs; `excludeFromContent` globs; no telemetry, all assets bundled. v1 is read-only: no endpoint writes a Markdown file.

---

## 10. Dependency list

Verify exact versions against npm at implementation time; `engines: node >=24.19 <25`.

Server: `fastify@5`, `@fastify/websocket@11` (ws 8 transitive), `@fastify/static@8`, `@fastify/compress@8`, `picomatch@4`, `yaml@2`, `zod@3`, `pino@9`, `pino-roll@3`, `p-limit@6`, `pinyin-pro@3`, optional `@parcel/watcher@2`, optional fallback `better-sqlite3@12`.
Build/dev: `typescript@5`, `esbuild@0.25`, `tsx@4`, `vite@7`, `@vitejs/plugin-react@4`, `vite-plugin-pwa@1`, `vitest@3`, `@types/node@24`, `playwright@1` (e2e).
Client: `react@19`, `react-dom@19`, `zustand@5`, `react-resizable-panels@3`, `@tanstack/react-virtual@3`, `cmdk@1`, `lucide-react`, `comlink@4`, `fuzzysort@3`, `pinyin-pro@3`, `markdown-it@14`, `markdown-it-anchor@9`, `markdown-it-front-matter@0.2`, `markdown-it-emoji@3`, `markdown-it-task-lists@2`, `markdown-it-footnote@4`, `markdown-it-container@4`, `markdown-it-attrs@4`, `markdown-it-mark@4`, `markdown-it-sub@2`, `markdown-it-sup@2`, `markdown-it-ins@4`, `markdown-it-deflist@3`, `markdown-it-abbr@2`, `markdown-it-multimd-table@4`, `@vscode/markdown-it-katex@1`, `katex@0.16`, `highlight.js@11`, `shiki@3` + `@shikijs/engine-javascript@3` (lazy opt-in), `mermaid@11` (lazy), `dompurify@3`, `morphdom@2`, `xxhash-wasm@1`, `@twemoji/api@16` (bundled assets), `yaml@2`, `dayjs@1`, `@fontsource-variable/inter@5`, `@fontsource-variable/jetbrains-mono@5`.

---

## 11. File/module layout

```
MDSyncView/
  package.json  tsconfig.base.json  vitest.config.ts  playwright.config.ts
  server/
    src/main.ts                 # bootstrap, instance lock, startup invariant, browser launch
    src/config/{settings.ts, schema.ts (zod), defaults.ts, exclusions.ts}
    src/db/{open.ts, schema.sql, migrations.ts, reader.ts, writer.ts, changelog.ts}
    src/fsx/{index.ts (long-path helper, bigint stat), drives.ts, onedrive.ts}
    src/discovery/{roots.ts, islands.ts, walker.ts, scanner.worker.ts, reconcile.ts, sweep.ts}
    src/watch/{watcher.ts, dirtyset.ts, verify.ts, moves.ts, selftest.ts, health.ts, parcel.ts (opt-in)}
    src/index/{indexer.worker.ts, extract.ts, decode.ts, hash.ts, pathwords.ts, pinyin.ts, fts.ts}
    src/http/{app.ts, security.ts (host/sec-fetch/token), routes/{status,manifest,files,search,raw,roots,settings,open,export,debug}.ts}
    src/ws/{hub.ts, protocol.ts, replay.ts, backpressure.ts}
    src/util/{log.ts, launch.ts, autostart.ts, clock.ts}
    test/{unit,integration}/...
  client/
    index.html  vite.config.ts  public/{manifest.webmanifest, twemoji/, fonts/}
    src/main.tsx  src/app/{Shell,Sidebar,Viewer,RightRail,StatusBar,Palette,Settings}.tsx
    src/state/{manifest.ts, tabs.ts, ws.ts, settings.ts, activity.ts}
    src/workers/{render.worker.ts, fuzzy.worker.ts}
    src/render/{markdown.ts, plugins/{alerts,wikilink,media,pathRewrite,containers}.ts, sanitize.ts, patch.ts, svgHost.ts, mermaid.ts, emoji.ts, highlight.ts, shiki.ts}
    src/components/{Tree,Recent,Search,Tags,Activity,Tabs,Article,Toc,Properties,Lightbox,Toast}.tsx
    src/styles/{tokens.css, themes.css, prose.css}
    test/...
  e2e/{sync.spec.ts, chinese-names.spec.ts, security.spec.ts}
  shared/protocol.ts            # FileRow cols, WS message types, zod schemas (imported by both)
```

---

## 12. Risks & mitigations

- **4 KB libuv buffer overflow on `C:\@repo`** → `filename===null` routed to a 2 s-debounced root reconcile that skips excluded subtrees; never watch `C:\`; per-root `node_modules`/`.git` toggles; `@parcel/watcher` opt-in.
- **Ambiguous `'rename'`, no child events on dir rename** → stat/hash truth, `maybe-dir` handling, prefix cascade, `(dev,ino)`→`(size,hash)` pairing, 2 s vanished buffer, delete-grace.
- **Partial writes / locks / Defender** → 150/500 ms debounce, stat-read-stat, retry ladder, `locked` state, 8 concurrent reads, hash suppresses no-op re-renders; docs recommend excluding `%LOCALAPPDATA%\MDSyncView` from Defender.
- **Silently dead handles** → startup self-test, 10-min sentinel, 30 s health tick, 5-min stat-sweep.
- **Case/Unicode/long paths** → NFC-lowercased `path_key`, original spelling kept, `fsx` namespacing helper.
- **Junctions, OneDrive placeholders** → never descend reparse points, `attrib.exe` cloud-only detection, per-root content switch, 5 s read AbortSignal.
- **Encoding** → BOM sniff, fatal UTF-8, gb18030 fallback, badge.
- **Non-monotonic mtime** → inequality + ctime as filter, hash as arbiter, bigint stats.
- **`node:sqlite` experimental** → pinned major, thin repository module, smoke test, `better-sqlite3` fallback, rebuild-on-mismatch.
- **Crash consistency** → WAL, single transaction per batch including changelog + last_seq, quick_check after unclean shutdown, startup reconcile.
- **Short CJK queries** → tiered LIKE fallback, full-width folding, pinyin quick-open.
- **Trigram index size** (≈3× body) → 2 MB cap, `optimize`, `excludeFromContent`.
- **Mermaid/KaTeX cost and errors** → lazy import, idle rendering, per-block try/catch, LRU, 50 KB cap.
- **Emoji flags on Windows** → canvas-measured Twemoji fallback.
- **XSS via inline HTML/SVG** → DOMPurify profiles, Shadow DOM, fragment-only `use`, CSP, sandboxed SVG files.
- **`/raw` as a file reader** → id-based addressing, ancestor/root containment excluding the sweep root, ADS/UNC/device rejection, media-only extensions, GET gating by `Sec-Fetch-Site`.
- **Double launch / port clash** → instance file with live probe, fallback range.
- **Stale SW** → hashed assets only, `index.html` NetworkFirst, protocol version reload.
- **Sleep/resume** → clock-jump detector, heartbeats, changelog replay, focus stat-check.
- **Client memory at 10k+ files** → tuple manifest, virtualized lists, LRU of 10 rendered docs, worker isolation.

---

## 13. Test plan

**Unit (vitest):** exclusion matcher incl. conditional `target/bin/obj/dist` rules; `path_key` for `.MD`, NFC/NFD and case-only variants; pathwords tokenizer on `20260819_ANY-27206_BugFix_分析.md`; query router (CJK 1–2 vs ≥3, Latin prefix, quoting/injection: `q = '" OR 1'`); snippet widening; DirtySet timing with fake timers (quiet 150, hold 500, burst mode); move pairer (ino first, then hash; case-only); decode ladder (BOM, UTF-16LE, GBK bytes); `/raw` validator table (ADS, UNC, `..` escapes, junction realpath, sweep-root non-containment); DOMPurify profile snapshots (script/foreignObject/external `use` stripped, svg `<style>` kept, html `<style>` dropped); block hashing/LCS diff.

**Integration (real FS under a temp root, real `node:sqlite`):**
1. Startup invariant: assert watcher handles exist before the first reconcile call (spy ordering).
2. Create `分析报告.MD`, `20260819_ANY-27206_BugFix_分析.md` → `created` events within 700 ms; manifest tuples carry original casing; search `分析` (substring tier), `ANY-27206` (fts_word), `BugFix` and `分析报告` (trigram) all hit.
3. Modify with a streaming writer (append every 50 ms for 5 s) → `doc` pushes at ≤3/s, final hash equals disk, no `deleted`.
4. Atomic replace (`x.md.tmp` + `rename`) and VS Code safe-write → exactly one `modified`, same id, no `deleted`.
5. Rename `a.md`→`b.md`, case-only `a.md`→`A.md`, directory rename with 300 files → `moved` events, ids preserved, no FTS re-index (hash unchanged).
6. Delete → tombstone; recreate identical content 10 s later → `restored` with the old id.
7. Lock the file with an exclusive handle (PowerShell `[IO.File]::Open(...,'None')`) → `locked` then `modified` after release.
8. Burst: write 500 files in 3 s → coalesced batches ≤100, no dropped file (diff manifest vs disk), sweep pauses.
9. Force overflow (write 5,000 files rapidly in a watched root) → `filename===null` observed → reconcile → manifest equals disk.
10. Crash test: `process.kill` mid-batch → restart → quick_check runs, `changelog.seq` continuous, reconcile repairs drift; client with `lastSeq` receives exact replay.
11. Watcher death: close the handle out-of-band → sentinel recreates within 10 min (fake timers).
12. Long path (>260 chars) and junction loop fixtures; OneDrive `attrib` parser fixture.
13. Security: request with foreign `Host`/`Sec-Fetch-Site: cross-site` → 421/403; `/raw` traversal cases → 403; SVG file response carries sandbox CSP.

**E2E (Playwright against the built app in Edge):** open the app; write a file from a separate process → appears in Recent within 1 s and renders; edit → changed block highlighted, scroll position and an open `<details>` preserved, Mermaid diagram not re-rendered (DOM node identity check); follow-tail pill appears when pinned to bottom; delete → banner, content still visible; rename → tab retargets; Chinese filename quick-open via `fx` pinyin initials; theme switch keeps Shiki dual-theme without re-highlight; reconnect after server restart → no full reload, replay applied, seq continuous; PWA install manifest valid. Performance gates: manifest ≤200 ms for 10k synthetic files, search p95 <50 ms, first render of a 300 KB doc <150 ms main-thread time, 60 fps tree scroll with 10k rows (Playwright tracing).