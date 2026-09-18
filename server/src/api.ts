import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { openInEditor, openWithDefaultApp, revealInFileManager } from './open.ts';
import fastifyStatic from '@fastify/static';
import type { BrowseResponse, ConfigView, FileDetail, RootInfo, SearchResponse, Snapshot, Stats, TagCount } from '../../shared/types.ts';
import type { Index } from './db.ts';
import type { Indexer } from './indexer.ts';
import type { EventHub } from './hub.ts';
import { readMarkdown } from './content.ts';
import { extractMeta } from './md-meta.ts';
import { isMarkdownPath, isWithin, toDisplay, toKey } from './paths.ts';
import { listSubdirs } from './scanner.ts';
import { log } from './log.ts';

export interface AppContext {
  db: Index;
  indexer: Indexer;
  hub: EventHub;
  dev: boolean;
  clientDir: string;
  dataDir: string;
  maxContentBytes: () => number;
  stats: () => Stats;
  roots: () => RootInfo[];
  configView: () => Promise<ConfigView>;
  updateConfig: (patch: { roots?: string[]; excludeNames?: string[]; excludePaths?: string[]; reconcileIntervalMin?: number }) => Promise<ConfigView>;
  rescan: (root?: string) => Promise<void>;
  listDrives: () => Promise<string[]>;
  isHostAllowed: (host: string | undefined) => boolean;
  isOriginAllowed: (origin: string | undefined) => boolean;
  cspHeader: () => string;
  /** Open (or re-open) the UI window with the machine's browser. */
  openUi: () => void;
  /** Graceful shutdown; the promise resolves after the response has been sent. */
  shutdown: () => void;
}

const MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg', '.apng',
  '.mp4', '.webm', '.m4v', '.ogv', '.mov',
  '.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.opus', '.aac',
  '.pdf', '.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt', '.csv', '.json',
]);

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function q(req: FastifyRequest, name: string): string | undefined {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : undefined;
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });

  // --- security hooks -------------------------------------------------------------------------
  app.addHook('onRequest', (req, reply, done) => {
    if (!ctx.isHostAllowed(req.headers.host)) {
      reply.code(421).send({ error: { code: 'BAD_HOST', message: 'Host header not allowed' } });
      return;
    }
    // Reads too: a hostile page must not be able to <img src="http://127.0.0.1:port/raw?path=…"> or probe
    // the API. Browsers label such requests cross-site; the app's own requests are same-origin (or none).
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') {
      reply.code(403).send({ error: { code: 'CROSS_SITE', message: 'cross-site requests are not allowed' } });
      return;
    }
    const originHdr = req.headers.origin;
    if (originHdr !== undefined && !ctx.isOriginAllowed(originHdr)) {
      reply.code(403).send({ error: { code: 'BAD_ORIGIN', message: 'Origin not allowed' } });
      return;
    }
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (req.headers['x-mdsv'] !== '1') {
        reply.code(403).send({ error: { code: 'MISSING_HEADER', message: 'X-MDSV header required' } });
        return;
      }
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    done();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error('http', 'unhandled', err);
    reply.code(status).send({ error: { code: 'INTERNAL', message: (err as Error).message } });
  });

  // --- static client ----------------------------------------------------------------------------
  const hasClient = fs.existsSync(path.join(ctx.clientDir, 'index.html'));
  await app.register(fastifyStatic, {
    root: hasClient ? ctx.clientDir : ctx.dataDir,
    serve: hasClient,
    prefix: '/',
    index: ['index.html'],
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const raw = (res as unknown as { raw?: { setHeader(n: string, v: string): void }; setHeader?: (n: string, v: string) => void });
      const set = (n: string, v: string) => (raw.raw ? raw.raw.setHeader(n, v) : raw.setHeader?.(n, v));
      if (filePath.endsWith('index.html')) set('Content-Security-Policy', ctx.cspHeader());
      else if (/[\\/]assets[\\/]/.test(filePath)) set('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && hasClient && !req.url.startsWith('/api') && !req.url.startsWith('/raw') && !req.url.startsWith('/ws')) {
      reply.header('Content-Security-Policy', ctx.cspHeader());
      return reply.sendFile('index.html', ctx.clientDir);
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}` } });
  });

  // --- API ----------------------------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, serverId: ctx.hub.serverId, seq: ctx.hub.seq }));

  app.get('/api/stats', async () => ctx.stats());

  app.get('/api/snapshot', async (): Promise<Snapshot> => {
    ctx.hub.flushAll();
    return { seq: ctx.hub.seq, serverId: ctx.hub.serverId, files: ctx.db.all(), roots: ctx.roots(), stats: ctx.stats() };
  });

  app.get('/api/roots', async () => ctx.roots());

  app.get('/api/tags', async (): Promise<TagCount[]> => ctx.db.tags());

  app.get('/api/file', async (req): Promise<FileDetail> => {
    const p = q(req, 'path') ?? '';
    const key = validateAbsolutePath(p);
    let rec = ctx.db.getRecord(key);
    const display = rec?.path ?? toDisplay(p);
    if (!rec) {
      // Not indexed (yet): allow on-demand viewing when it is a markdown file inside a root.
      const root = ctx.indexer.rootOf(key);
      if (!root || !isMarkdownPath(display)) throw new HttpError(404, 'NOT_FOUND', 'file is not indexed');
      await ctx.indexer.verifyPath(display, root, (evs) => ctx.hub.emitFileEvents(evs));
      rec = ctx.db.getRecord(key);
      if (!rec) throw new HttpError(404, 'NOT_FOUND', 'file not found');
    }
    // same containment guard as /raw: a junction inside a root must not read files outside every root
    const root = ctx.indexer.rootOf(key);
    if (!root) throw new HttpError(403, 'OUTSIDE_ROOTS', 'path is outside every configured root');
    try {
      const real = await fs.promises.realpath(rec.path);
      if (!isWithin(toKey(root), toKey(real))) throw new HttpError(403, 'OUTSIDE_ROOTS', 'resolved path escapes the root');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const evs = ctx.indexer.removeUnder(key);
      if (evs.length) ctx.hub.emitFileEvents(evs);
      throw new HttpError(404, 'GONE', 'file no longer exists');
    }
    const r = await readMarkdown(rec.path, { maxBytes: ctx.maxContentBytes() });
    if (!r.ok) {
      if (r.error === 'ENOENT') {
        const evs = ctx.indexer.removeUnder(key);
        if (evs.length) ctx.hub.emitFileEvents(evs);
        throw new HttpError(404, 'GONE', 'file no longer exists');
      }
      if (r.error === 'LOCKED') throw new HttpError(423, 'LOCKED', 'file is locked by another process');
      throw new HttpError(500, 'READ_FAILED', r.message);
    }
    const meta = extractMeta(rec.path, r.text);
    const stem = rec.name.replace(/\.[^.]+$/, '');
    return {
      file: rec,
      content: r.text,
      encoding: r.encoding,
      truncated: r.truncated,
      headings: meta.headings,
      frontmatter: meta.frontmatter,
      wikiLinks: meta.wikiLinks,
      bodyOffset: meta.bodyOffset,
      backlinks: ctx.db.backlinks(key, stem, meta.title),
    };
  });

  app.get('/api/search', async (req): Promise<SearchResponse> => {
    const query = (q(req, 'q') ?? '').trim();
    const limit = Number(q(req, 'limit') ?? 50) || 50;
    const offset = Number(q(req, 'offset') ?? 0) || 0;
    const root = q(req, 'root') || null;
    const t0 = performance.now();
    if (!query) return { query, total: 0, hits: [], tookMs: 0, mode: 'fts' };
    try {
      const r = ctx.db.search(query, { limit, offset, root: root ? toKey(root) : null });
      return { query, total: r.total, hits: r.hits, tookMs: Math.round((performance.now() - t0) * 10) / 10, mode: r.mode };
    } catch (e) {
      log.warn('search', `query failed for "${query}"`, e);
      return { query, total: 0, hits: [], tookMs: Math.round((performance.now() - t0) * 10) / 10, mode: 'fts' };
    }
  });

  app.get('/api/config', async () => ctx.configView());

  app.put('/api/config', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<AppContext['updateConfig']>[0] = {};
    if (Array.isArray(body.roots)) {
      const roots: string[] = [];
      for (const r of body.roots) {
        if (typeof r !== 'string' || !r.trim()) continue;
        const abs = toDisplay(r.trim());
        if (!path.isAbsolute(abs)) throw new HttpError(400, 'BAD_ROOT', `not an absolute path: ${r}`);
        let st: fs.Stats;
        try { st = await fs.promises.stat(abs); } catch { throw new HttpError(400, 'BAD_ROOT', `directory does not exist: ${abs}`); }
        if (!st.isDirectory()) throw new HttpError(400, 'BAD_ROOT', `not a directory: ${abs}`);
        const k = toKey(abs);
        const nested = roots.find((x) => isWithin(toKey(x), k) || isWithin(k, toKey(x)));
        if (nested && toKey(nested) !== k) throw new HttpError(400, 'NESTED_ROOT', `${abs} overlaps ${nested}; roots must not contain each other`);
        if (!roots.some((x) => toKey(x) === k)) roots.push(abs);
      }
      patch.roots = roots;
    }
    if (Array.isArray(body.excludeNames)) patch.excludeNames = body.excludeNames.map(String).map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(body.excludePaths)) patch.excludePaths = body.excludePaths.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof body.reconcileIntervalMin === 'number' && Number.isFinite(body.reconcileIntervalMin)) {
      patch.reconcileIntervalMin = Math.max(0, Math.min(24 * 60, Math.round(body.reconcileIntervalMin)));
    }
    return ctx.updateConfig(patch);
  });

  // Used by the tray host (and a second launch) to bring the app window up.
  app.post('/api/open-ui', async () => {
    ctx.openUi();
    return { ok: true };
  });

  // Used by the tray host's "Quit": answer first, then shut down cleanly.
  app.post('/api/shutdown', async () => {
    setTimeout(() => ctx.shutdown(), 50);
    return { ok: true };
  });

  app.post('/api/rescan', async (req) => {
    const body = (req.body ?? {}) as { root?: string };
    void ctx.rescan(typeof body.root === 'string' ? body.root : undefined);
    return { started: true };
  });

  app.get('/api/browse', async (req): Promise<BrowseResponse> => {
    const drives = await ctx.listDrives();
    const p = q(req, 'path');
    if (!p) return { path: null, parent: null, entries: drives.map((d) => ({ name: d, path: d })), drives };
    const abs = toDisplay(p);
    if (!path.isAbsolute(abs)) throw new HttpError(400, 'BAD_PATH', 'absolute path required');
    const entries = await listSubdirs(abs);
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, entries, drives };
  });

  app.post('/api/open', async (req) => {
    const body = (req.body ?? {}) as { path?: string; mode?: string };
    const key = validateAbsolutePath(body.path ?? '');
    const rec = ctx.db.getRecord(key);
    if (!rec) throw new HttpError(404, 'NOT_FOUND', 'only indexed files can be opened');
    const mode = body.mode === 'reveal' || body.mode === 'editor' ? body.mode : 'default';
    try {
      if (mode === 'reveal') revealInFileManager(rec.path);
      else if (mode === 'editor') openInEditor(rec.path);
      else openWithDefaultApp(rec.path);
    } catch (e) {
      throw new HttpError(500, 'OPEN_FAILED', (e as Error).message);
    }
    return { ok: true };
  });

  // --- raw media/file bytes (images, svg, video, audio, md transclusion) ---------------------------
  app.get('/raw', async (req, reply) => {
    const p = q(req, 'path') ?? '';
    const key = validateAbsolutePath(p);
    const abs = toDisplay(p);
    const ext = path.extname(abs).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) throw new HttpError(415, 'TYPE_NOT_ALLOWED', `${ext || '(none)'} is not a servable type`);
    const root = ctx.indexer.rootOf(key);
    if (!root) throw new HttpError(403, 'OUTSIDE_ROOTS', 'path is outside every configured root');
    let real: string;
    try { real = await fs.promises.realpath(abs); } catch { throw new HttpError(404, 'NOT_FOUND', 'file not found'); }
    if (!isWithin(toKey(root), toKey(real))) throw new HttpError(403, 'OUTSIDE_ROOTS', 'resolved path escapes the root');
    let st: fs.Stats;
    try { st = await fs.promises.stat(real); } catch { throw new HttpError(404, 'NOT_FOUND', 'file not found'); }
    if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'not a file');
    if (ext === '.svg') reply.header('Content-Security-Policy', "sandbox; script-src 'none'");
    if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd' || ext === '.mdx') reply.type('text/markdown; charset=utf-8');
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    return sendRanged(reply, real, st);
  });

  return app;
}

function validateAbsolutePath(p: string): string {
  if (!p || p.length > 4096 || p.includes('\0')) throw new HttpError(400, 'BAD_PATH', 'invalid path');
  if (p.startsWith('\\\\') || p.startsWith('//')) throw new HttpError(403, 'BAD_PATH', 'UNC paths are not allowed');
  const abs = toDisplay(p);
  if (!path.isAbsolute(abs)) throw new HttpError(400, 'BAD_PATH', 'absolute path required');
  return toKey(abs);
}

function sendRanged(reply: FastifyReply, file: string, st: fs.Stats): FastifyReply {
  const total = st.size;
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  reply.header('ETag', etag);
  reply.header('Last-Modified', st.mtime.toUTCString());
  reply.header('Accept-Ranges', 'bytes');
  if (!reply.getHeader('content-type')) {
    const type = mimeFor(path.extname(file).toLowerCase());
    reply.type(type);
  }
  const inm = reply.request.headers['if-none-match'];
  if (inm && inm === etag) return reply.code(304).send();
  const range = reply.request.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : NaN;
      if (Number.isNaN(start)) { start = Math.max(0, total - end); end = total - 1; }
      else if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.code(416).send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.send(fs.createReadStream(file, { start, end }));
    }
  }
  reply.header('Content-Length', String(total));
  return reply.send(fs.createReadStream(file));
}

function mimeFor(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    case '.bmp': return 'image/bmp';
    case '.ico': return 'image/x-icon';
    case '.svg': return 'image/svg+xml';
    case '.apng': return 'image/apng';
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.ogv': return 'video/ogg';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.ogg': case '.oga': return 'audio/ogg';
    case '.flac': return 'audio/flac';
    case '.opus': return 'audio/opus';
    case '.aac': return 'audio/aac';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
