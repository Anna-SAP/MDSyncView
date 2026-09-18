import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical long form of an existing directory path. On Windows this expands 8.3 short names
 * (C:\Users\RUNNER~1) to their long form: libuv's recursive watcher asserts (and aborts the process)
 * when the watched path is a short name because change notifications carry long names.
 */
export function toLongPath(p: string): string {
  if (process.platform !== 'win32') return p;
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/** Extensions treated as Markdown (compared case-insensitively). */
export const MD_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx']);

export const IS_WIN = process.platform === 'win32';

export function isMarkdownPath(p: string): boolean {
  return MD_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * Canonical identity key for a filesystem path.
 * Absolute, normalized, forward slashes; lower-cased on Windows (NTFS is case-insensitive).
 * Use this for Map keys / DB primary keys; keep the original `path` for display.
 */
export function toKey(p: string): string {
  let n = path.resolve(p).replace(/\\/g, '/');
  if (IS_WIN) n = n.toLowerCase();
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

/** Normalize for display: absolute, native separators, no trailing slash (except drive roots). */
export function toDisplay(p: string): string {
  let n = path.resolve(p);
  if (n.length > 3 && n.endsWith(path.sep)) n = n.slice(0, -1);
  return n;
}

/** True if `childKey` equals `parentKey` or lives under it (both canonical keys). */
export function isWithin(parentKey: string, childKey: string): boolean {
  if (childKey === parentKey) return true;
  const base = parentKey.endsWith('/') ? parentKey : parentKey + '/';
  return childKey.startsWith(base);
}

/** Directory basenames that are never scanned (case-insensitive). */
export const DEFAULT_EXCLUDE_NAMES: readonly string[] = [
  // VCS / package managers / build caches
  'node_modules', '.git', '.hg', '.svn', '.cache', '.npm', '.yarn', '.pnpm-store', '.pnpm',
  'bower_components', '__pycache__', '.venv', 'venv', '.tox', 'site-packages', '.next', '.nuxt',
  '.turbo', '.gradle', '.m2', '.terraform', '.idea', '.vs', '.parcel-cache', '.angular', '.svelte-kit',
  // tool installs / caches living in the user profile
  '.vscode', '.vscode-server', '.vscode-insiders', '.nuget', '.cargo', '.rustup', '.conda', '.docker',
  '.ollama', '.nvm', '.bun', '.deno', '.pyenv', 'scoop', '.gem', '.dotnet', '.android', '.gradle-cache',
  // Windows system
  '$recycle.bin', 'system volume information', 'windows', 'windows.old', 'program files',
  'program files (x86)', 'programdata', 'appdata', 'config.msi', 'perflogs', 'recovery',
  '$winreagent', 'msocache', 'documents and settings', 'intel', 'dell', 'inetpub', 'onedrivetemp',
  '$sysreset', 'boot', 'efi',
];

export interface ExcludeMatcher {
  /** Return true if a directory with this basename (and canonical key) must be skipped. */
  dir(basename: string, key: string): boolean;
}

export function makeExcludeMatcher(names: readonly string[], pathKeys: readonly string[]): ExcludeMatcher {
  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const paths = pathKeys.map((p) => toKey(p));
  return {
    dir(basename, key) {
      if (nameSet.has(basename.toLowerCase())) return true;
      for (const p of paths) if (isWithin(p, key)) return true;
      return false;
    },
  };
}
