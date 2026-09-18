/**
 * Build a self-contained Windows executable (Node Single Executable Application):
 *   1. Vite production build of the client              → dist/client
 *   2. esbuild bundles the server into one CommonJS file → dist/server.cjs
 *   3. node --experimental-sea-config produces the blob  → dist/sea-prep.blob
 *   4. a copy of node.exe gets the blob injected          → dist/release/MDSyncView.exe
 *   5. the client bundle is placed next to the exe        → dist/release/client/
 *   6. everything is zipped                                → dist/MDSyncView-win-x64.zip
 *
 * Usage: node scripts/build-exe.mjs [--skip-client]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const release = path.join(dist, 'release');
const exeName = 'MDSyncView.exe';
const skipClient = process.argv.includes('--skip-client');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function findSigntool() {
  if (process.platform !== 'win32') return null;
  const kits = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const candidates = [];
  try {
    for (const ver of fs.readdirSync(kits).filter((d) => /^\d+\./.test(d)).sort().reverse()) {
      candidates.push(path.join(kits, ver, 'x64', 'signtool.exe'));
    }
  } catch { /* no SDK */ }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
}

const t0 = Date.now();
if (process.platform !== 'win32') console.warn('warning: this script produces a Windows executable; run it on Windows for a usable MDSyncView.exe');

// 1. client
if (!skipClient) run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'client/vite.config.ts']);
if (!fs.existsSync(path.join(dist, 'client', 'index.html'))) throw new Error('client bundle missing (dist/client/index.html)');

// 2. server bundle (CommonJS is required by SEA; top-level await was removed from the entry for this)
console.log('\n$ esbuild server/src/index.ts → dist/server.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(dist, 'server.cjs'),
  define: { 'import.meta.dirname': '__dirname', 'process.env.MDSYNCVIEW_VERSION': JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: '/* MDSyncView single-executable bundle */' },
});

// 3. SEA blob
const seaConfig = { main: 'dist/server.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true, useCodeCache: false };
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json']);

// 4. executable
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release, { recursive: true });
const exePath = path.join(release, exeName);
fs.copyFileSync(process.execPath, exePath);
// node.exe ships signed; injecting the blob invalidates that signature, so strip it first when the
// Windows SDK's signtool is available (as on GitHub's windows runners). Best effort: the exe runs either way.
const signtool = findSigntool();
if (signtool) {
  const r = spawnSync(signtool, ['remove', '/s', exePath], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('warning: signtool could not remove the signature (continuing)');
} else {
  console.log('signtool not found; leaving the (soon invalid) Authenticode signature in place');
}
console.log(`\n$ postject ${exeName} NODE_SEA_BLOB dist/sea-prep.blob`);
await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(path.join(dist, 'sea-prep.blob')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });

// 5. release layout
fs.cpSync(path.join(dist, 'client'), path.join(release, 'client'), { recursive: true });
fs.writeFileSync(path.join(release, 'README.txt'), [
  `MDSyncView ${pkg.version} (Windows x64, Node ${process.version})`,
  '',
  '双击 MDSyncView.exe 启动；服务只监听 127.0.0.1，并自动以 Edge/Chrome 应用窗口打开界面。',
  '首次启动会在后台扫描所有本地固定磁盘上的 Markdown 文件；数据保存在 %LOCALAPPDATA%\\MDSyncView。',
  '',
  '可选参数：MDSyncView.exe [--no-open] [--port=4820] [--data=<数据目录>] [--root=<目录>]...',
  'client\\ 目录必须与 MDSyncView.exe 放在一起。',
  '',
  'https://github.com/Anna-SAP/MDSyncView',
].join('\r\n'));

// 6. zip (PowerShell is always available on Windows runners and workstations)
const zipPath = path.join(dist, 'MDSyncView-win-x64.zip');
fs.rmSync(zipPath, { force: true });
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path (Join-Path $env:MDSV_RELEASE '*') -DestinationPath $env:MDSV_ZIP -CompressionLevel Optimal -Force`],
    { env: { ...process.env, MDSV_RELEASE: release, MDSV_ZIP: zipPath } });
}

const size = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + ' MB';
console.log(`\nbuilt ${exePath} (${size(exePath)})${fs.existsSync(zipPath) ? `, ${path.basename(zipPath)} (${size(zipPath)})` : ''} in ${Math.round((Date.now() - t0) / 1000)}s`);
