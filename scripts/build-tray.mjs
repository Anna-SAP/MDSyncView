/**
 * Compile the Windows tray host (tray/Program.cs) with the C# compiler that ships with every Windows
 * install (.NET Framework 4.x csc.exe) — no SDK download required.
 *
 *   node scripts/build-tray.mjs                 → dist/tray/MDSyncView.exe
 *   node scripts/build-tray.mjs --out <dir>     → <dir>/MDSyncView.exe
 *   node scripts/build-tray.mjs --run [args…]   → build, then launch it (source-tree mode: runs node server)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

export function findCsc() {
  const win = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function buildTray(outDir) {
  if (process.platform !== 'win32') throw new Error('the tray host can only be built on Windows');
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe not found (.NET Framework 4.x is part of Windows 10/11; is it missing?)');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'MDSyncView.exe');
  const icon = path.join(root, 'assets', 'icon.ico');
  const args = [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001', '/platform:anycpu',
    `/out:${out}`,
    `/win32manifest:${path.join(root, 'tray', 'app.manifest')}`,
    ...(fs.existsSync(icon) ? [`/win32icon:${icon}`] : []),
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    path.join(root, 'tray', 'Program.cs'),
  ];
  console.log(`$ csc ${args.filter((a) => !a.startsWith('/reference')).join(' ')}`);
  const r = spawnSync(csc, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`csc exited with ${r.status}`);
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(root, 'dist', 'tray');
  const exe = buildTray(outDir);
  console.log(`built ${exe} (${(fs.statSync(exe).size / 1024).toFixed(0)} KB)`);
  if (argv.includes('--run')) {
    const passthrough = argv.filter((a, i) => a !== '--run' && a !== '--out' && !(outIdx >= 0 && i === outIdx + 1));
    const child = spawn(exe, passthrough, { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`launched tray host (pid ${child.pid})`);
  }
}
