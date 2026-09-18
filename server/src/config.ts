import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { DEFAULT_EXCLUDE_NAMES, IS_WIN, toDisplay, toLongPath } from './paths.ts';

export interface AppConfig {
  host: string;
  port: number;
  /** Explicit roots. Empty array => auto: every fixed local drive. */
  roots: string[];
  excludeNames: string[];
  excludePaths: string[];
  /** Max bytes of a file's body that are indexed for full-text search. */
  maxIndexedBytes: number;
  /** Max bytes of a file served through the content API (larger files are truncated with a notice). */
  maxContentBytes: number;
  /** Periodic background reconcile (full walk) interval, minutes. 0 disables. */
  reconcileIntervalMin: number;
  openBrowser: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  host: '127.0.0.1',
  port: 4820,
  roots: [],
  excludeNames: [...DEFAULT_EXCLUDE_NAMES],
  excludePaths: [],
  maxIndexedBytes: 2 * 1024 * 1024,
  maxContentBytes: 8 * 1024 * 1024,
  reconcileIntervalMin: 30,
  openBrowser: true,
};

export function resolveDataDir(): string {
  const env = process.env.MDSYNCVIEW_DATA;
  if (env && env.trim()) return path.resolve(env);
  const base = IS_WIN
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'MDSyncView');
}

export class ConfigStore {
  readonly dataDir: string;
  readonly file: string;
  /** What is persisted in config.json. */
  private saved: AppConfig;
  /** Session-only overrides (CLI flags); they win over `saved` but are never written to disk. */
  private overrides: Partial<AppConfig> = {};

  constructor(dataDir = resolveDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = toLongPath(dataDir); // %TEMP%/%LOCALAPPDATA% may be handed to us as 8.3 short names
    this.file = path.join(this.dataDir, 'config.json');
    this.saved = this.load();
  }

  get config(): AppConfig {
    return { ...this.saved, ...this.overrides };
  }

  setOverrides(o: Partial<AppConfig>): void {
    this.overrides = { ...o };
  }

  private load(): AppConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppConfig>;
      const cfg: AppConfig = { ...DEFAULT_CONFIG, ...raw };
      cfg.roots = Array.isArray(raw.roots) ? raw.roots.map((r) => toDisplay(String(r))) : [];
      cfg.excludeNames = Array.isArray(raw.excludeNames) ? raw.excludeNames.map(String) : [...DEFAULT_EXCLUDE_NAMES];
      cfg.excludePaths = Array.isArray(raw.excludePaths) ? raw.excludePaths.map(String) : [];
      return cfg;
    } catch {
      return { ...DEFAULT_CONFIG, excludeNames: [...DEFAULT_EXCLUDE_NAMES] };
    }
  }

  save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Persist a change made by the user; an explicit change also retires any CLI override for that key. */
  update(patch: Partial<AppConfig>): AppConfig {
    for (const k of Object.keys(patch) as (keyof AppConfig)[]) delete this.overrides[k];
    this.saved = { ...this.saved, ...patch };
    this.save();
    return this.config;
  }
}

/** Enumerate fixed local drives (Windows) or `/` elsewhere. Never throws; falls back to the system drive. */
export async function listFixedDrives(): Promise<string[]> {
  if (!IS_WIN) return ['/'];
  const fallback = [toDisplay((process.env.SystemDrive || 'C:') + '\\')];
  const viaPs = await new Promise<string[] | null>((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const drives = stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Z]:$/i.test(s)).map((s) => s.toUpperCase() + '\\');
        resolve(drives.length ? drives : null);
      },
    );
    child.on('error', () => resolve(null));
  });
  if (viaPs) return viaPs;
  // Fallback: probe letters (fixed drives only are not distinguishable here, so keep it conservative).
  const found: string[] = [];
  for (const letter of 'CDEFGH') {
    const p = `${letter}:\\`;
    try { if (fs.statSync(p).isDirectory()) found.push(p); } catch { /* absent */ }
  }
  return found.length ? found : fallback;
}
