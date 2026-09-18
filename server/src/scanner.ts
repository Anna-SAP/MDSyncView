import fs from 'node:fs';
import path from 'node:path';
import { isMarkdownPath, toKey, type ExcludeMatcher } from './paths.ts';

export interface ScanCandidate { path: string; key: string; size: number; mtime: number; ctime: number }

export interface WalkOptions {
  exclude: ExcludeMatcher;
  /** Concurrent readdir operations. */
  concurrency?: number;
  onFiles: (batch: ScanCandidate[]) => void | Promise<void>;
  onProgress?: (p: { dirs: number; files: number }) => void;
  /** Called when onFiles throws (the batch is lost); default logs to console. */
  onError?: (e: unknown) => void;
  signal?: AbortSignal;
}

export interface WalkResult {
  dirs: number;
  files: number;
  errors: number;
  elapsedMs: number;
  aborted: boolean;
  /** The root directory itself could not be listed (missing, unplugged, EPERM): results are not authoritative. */
  rootFailed: boolean;
}

/**
 * Breadth-first directory walk (shallow files surface first), bounded concurrency, never follows
 * reparse points (junctions/symlinks), skips excluded directories before descending.
 */
export async function walk(root: string, opts: WalkOptions): Promise<WalkResult> {
  const started = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? 16);
  const queue: string[] = [root];
  let head = 0;
  let active = 0;
  let dirs = 0;
  let files = 0;
  let errors = 0;
  let rootFailed = false;
  let batch: ScanCandidate[] = [];
  let lastProgress = 0;
  let flushing: Promise<void> = Promise.resolve();

  const flush = () => {
    if (!batch.length) return flushing;
    const b = batch;
    batch = [];
    flushing = flushing.then(() => opts.onFiles(b)).catch((e) => {
      errors++;
      if (opts.onError) opts.onError(e);
      else console.error('[walk] onFiles failed', e);
    });
    return flushing;
  };

  const progress = (force = false) => {
    const now = Date.now();
    if (!opts.onProgress) return;
    if (force || now - lastProgress >= 250) {
      lastProgress = now;
      opts.onProgress({ dirs, files });
    }
  };

  const processDir = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      errors++;
      if (dir === root) rootFailed = true;
      return;
    }
    dirs++;
    const statJobs: Promise<void>[] = [];
    for (const ent of entries) {
      if (opts.signal?.aborted) return;
      const name = ent.name;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (!opts.exclude.dir(name, toKey(full))) queue.push(full);
      } else if (ent.isFile() && isMarkdownPath(name)) {
        statJobs.push(
          fs.promises.stat(full).then((st) => {
            if (!st.isFile()) return;
            files++;
            batch.push({ path: full, key: toKey(full), size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.birthtimeMs || st.ctimeMs) });
          }, () => { errors++; }),
        );
      }
    }
    if (statJobs.length) await Promise.all(statJobs);
    if (batch.length >= 64) await flush();
    progress();
  };

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const pump = () => {
      if (done) return;
      if (opts.signal?.aborted) { if (active === 0) finish(); return; }
      while (active < concurrency && head < queue.length) {
        const dir = queue[head++]!;
        if (head > 4096) { queue.splice(0, head); head = 0; }
        active++;
        processDir(dir).finally(() => { active--; pump(); });
      }
      if (active === 0 && head >= queue.length) finish();
    };
    pump();
  });

  await flush();
  await flushing;
  progress(true);
  return { dirs, files, errors, elapsedMs: Date.now() - started, aborted: !!opts.signal?.aborted, rootFailed };
}

/** Immediate non-symlink subdirectories of `dir` (for watch topology and the folder picker). */
export async function listSubdirs(dir: string): Promise<{ name: string; path: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' });
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));
}
