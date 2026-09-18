/**
 * End-to-end real-time sync test: boots the real server against a temporary root, connects a WebSocket
 * client, mutates Markdown files on disk (create / modify / rename / delete, Chinese names, uppercase .MD,
 * atomic tmp+rename replace, nested new directory) and asserts that the expected events arrive.
 *
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { FileEvent, ServerMessage, Snapshot, SearchResponse, FileDetail, RootInfo } from '../../shared/types.ts';

const PORT = 4890;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsv-test-'));
const root = path.join(tmp, 'root');
const dataDir = path.join(tmp, 'data');
let server: ChildProcess;
let ws: WebSocket;
const inbox: ServerMessage[] = [];
const serverLog: string[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function eventsOfType(): FileEvent[] {
  return inbox.flatMap((m) => (m.type === 'events' ? m.events : []));
}

async function waitFor<T>(pred: () => T | undefined | false | null | Promise<T | undefined | false | null>, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${what}\nrecent events: ${JSON.stringify(eventsOfType().slice(-8).map((e) => [e.op, e.key, e.oldKey]))}\nserver log tail:\n${serverLog.slice(-25).join('\n')}`);
}

function waitEvent(op: FileEvent['op'], keySuffix: string, since = 0, timeoutMs = 8000): Promise<FileEvent> {
  const suffix = keySuffix.replace(/\\/g, '/').toLowerCase();
  return waitFor(() => eventsOfType().slice(since).find((e) => e.op === op && e.key.endsWith(suffix)), timeoutMs, `${op} ${keySuffix}`);
}

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + p, { ...init, headers: { 'x-mdsv': '1', 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

before(async () => {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'hello.md'), '# Hello 你好\n\nfirst body with 中文测试 content\n');
  fs.writeFileSync(path.join(root, 'notes', 'UPPER.MD'), '---\ntitle: Upper Case Ext\ntags: [alpha, beta]\n---\n\n# Ignored H1\n\nuppercase extension body\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), '# should be excluded\n');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT, roots: [root], openBrowser: false, reconcileIntervalMin: 0 }));

  server = spawn(process.execPath, ['--no-warnings', path.resolve(import.meta.dirname, '../src/index.ts'), '--no-open'], {
    env: { ...process.env, MDSYNCVIEW_DATA: dataDir, MDSYNCVIEW_HEALTH_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => serverLog.push(...String(d).trimEnd().split('\n')));
  server.stderr!.on('data', (d) => serverLog.push(...String(d).trimEnd().split('\n')));

  await waitFor(() => serverLog.some((l) => l.includes('listening on')), 15000, 'server listening');
  await openMainSocket();
  await waitFor(() => serverLog.some((l) => l.includes('startup reconcile:')), 15000, 'startup reconcile');
});

/** (Re)connect the shared socket that feeds `inbox`; safe to call after a test closed it. */
async function openMainSocket(): Promise<void> {
  const lastSeq = inbox.length ? inbox[inbox.length - 1]!.seq : null;
  const hello = inbox.find((m) => m.type === 'hello') as Extract<ServerMessage, { type: 'hello' }> | undefined;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMessage));
  const helloCount = inbox.filter((m) => m.type === 'hello').length;
  ws.send(JSON.stringify({ type: 'hello', lastSeq, serverId: hello?.serverId ?? null }));
  await waitFor(() => inbox.filter((m) => m.type === 'hello').length > helloCount, 5000, 'hello');
}

after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  server?.kill('SIGTERM');
  await sleep(300);
  try { server?.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('startup scan indexes existing files, honours uppercase .MD and excludes node_modules', async () => {
  const snap = await api<Snapshot>('/api/snapshot');
  const names = snap.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['UPPER.MD', 'hello.md']);
  const upper = snap.files.find((f) => f.name === 'UPPER.MD')!;
  assert.equal(upper.title, 'Upper Case Ext');
  assert.deepEqual(upper.tags, ['alpha', 'beta']);
  const hello = snap.files.find((f) => f.name === 'hello.md')!;
  assert.equal(hello.title, 'Hello 你好');
  assert.equal(snap.roots.length, 1);
});

test('create → add event with Chinese filename', async () => {
  const since = eventsOfType().length;
  fs.writeFileSync(path.join(root, 'notes', '分析报告.md'), '# 分析\n\n这是一份新的报告 🎉\n');
  const ev = await waitEvent('add', '/notes/分析报告.md', since);
  assert.equal(ev.file?.title, '分析');
  assert.equal(ev.file?.name, '分析报告.md');
});

test('modify → change event (and identical rewrite → touch, not change)', async () => {
  const p = path.join(root, 'notes', 'hello.md');
  let since = eventsOfType().length;
  fs.writeFileSync(p, '# Hello 你好 v2\n\nsecond body\n');
  const ev = await waitEvent('change', '/notes/hello.md', since);
  assert.equal(ev.file?.title, 'Hello 你好 v2');

  since = eventsOfType().length;
  await sleep(200);
  const now = new Date();
  fs.utimesSync(p, now, now); // mtime-only change, same bytes
  await sleep(1200);
  const changes = eventsOfType().slice(since).filter((e) => e.key.endsWith('/notes/hello.md'));
  assert.ok(changes.every((e) => e.op === 'touch'), `expected only touch events, got ${JSON.stringify(changes.map((e) => e.op))}`);
});

test('atomic replace (tmp + rename) → single change, never a remove', async () => {
  const p = path.join(root, 'notes', 'hello.md');
  const since = eventsOfType().length;
  fs.writeFileSync(p + '.tmp', '# Hello atomic\n\natomic body\n');
  fs.renameSync(p + '.tmp', p);
  const ev = await waitEvent('change', '/notes/hello.md', since);
  assert.equal(ev.file?.title, 'Hello atomic');
  await sleep(700);
  const removes = eventsOfType().slice(since).filter((e) => e.op === 'remove' && e.key.endsWith('/notes/hello.md'));
  assert.equal(removes.length, 0, 'atomic replace must not surface as a remove');
});

test('rename → rename event preserving identity', async () => {
  const since = eventsOfType().length;
  fs.renameSync(path.join(root, 'notes', 'UPPER.MD'), path.join(root, 'notes', 'renamed.md'));
  const ev = await waitEvent('rename', '/notes/renamed.md', since);
  assert.ok(ev.oldKey?.endsWith('/notes/upper.md'), `oldKey was ${ev.oldKey}`);
  assert.equal(ev.file?.name, 'renamed.md');
  await sleep(400);
  const removes = eventsOfType().slice(since).filter((e) => e.op === 'remove' && e.key.endsWith('/notes/upper.md'));
  assert.equal(removes.length, 0, 'a rename must not also surface as a remove of the old path');
});

test('delete → remove event', async () => {
  const since = eventsOfType().length;
  fs.unlinkSync(path.join(root, 'notes', 'renamed.md'));
  await waitEvent('remove', '/notes/renamed.md', since);
});

test('new nested directory with files → files discovered', async () => {
  const since = eventsOfType().length;
  const dir = path.join(root, 'deep', 'er', 'nested');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\n');
  fs.writeFileSync(path.join(dir, 'b.markdown'), '# B\n');
  await waitEvent('add', '/deep/er/nested/a.md', since);
  await waitEvent('add', '/deep/er/nested/b.markdown', since);
});

test('directory delete cascades to remove events', async () => {
  const since = eventsOfType().length;
  fs.rmSync(path.join(root, 'deep'), { recursive: true, force: true });
  await waitEvent('remove', '/deep/er/nested/a.md', since);
  await waitEvent('remove', '/deep/er/nested/b.markdown', since);
});

test('search: trigram CJK substring, short query fallback, filename match', async () => {
  await sleep(300);
  const r1 = await api<SearchResponse>('/api/search?q=' + encodeURIComponent('中文测试'));
  assert.ok(r1.hits.length === 0 || r1.mode === 'fts');
  const r2 = await api<SearchResponse>('/api/search?q=' + encodeURIComponent('新的报告'));
  assert.equal(r2.mode, 'fts');
  assert.ok(r2.hits.some((h) => h.file.name === '分析报告.md'), 'CJK substring should hit 分析报告.md');
  assert.ok(r2.hits[0]!.snippet.includes('<mark>'), 'snippet should be highlighted');
  const r3 = await api<SearchResponse>('/api/search?q=' + encodeURIComponent('分析'));
  assert.equal(r3.mode, 'substring');
  assert.ok(r3.hits.some((h) => h.file.name === '分析报告.md'), 'short CJK query should fall back to substring');
  const r4 = await api<SearchResponse>('/api/search?q=atomic');
  assert.ok(r4.hits.some((h) => h.file.name === 'hello.md'));
});

test('file detail + raw endpoint + path traversal is refused', async () => {
  const p = path.join(root, 'notes', 'hello.md');
  const d = await api<FileDetail>('/api/file?path=' + encodeURIComponent(p));
  assert.equal(d.file.name, 'hello.md');
  assert.ok(d.content.includes('atomic body'));
  assert.equal(d.encoding, 'utf-8');

  const raw = await fetch(BASE + '/raw?path=' + encodeURIComponent(p));
  assert.equal(raw.status, 200);
  assert.ok((raw.headers.get('content-type') ?? '').includes('text/markdown'));

  const outside = await fetch(BASE + '/raw?path=' + encodeURIComponent(path.join(tmp, 'data', 'config.json')));
  assert.equal(outside.status, 403);
  const traversal = await fetch(BASE + '/raw?path=' + encodeURIComponent(path.join(root, '..', 'data', 'config.json')));
  assert.equal(traversal.status, 403);
  const badHostStatus = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/stats', method: 'GET', headers: { Host: 'evil.example:80' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 421);
  const noHeader = await fetch(BASE + '/api/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('reconnect with lastSeq replays missed events', async () => {
  const hello = inbox.find((m) => m.type === 'hello') as Extract<ServerMessage, { type: 'hello' }>;
  const lastSeq = inbox.at(-1)!.seq;
  ws.close();
  await sleep(100);
  fs.writeFileSync(path.join(root, 'notes', 'offline.md'), '# written while disconnected\n');
  await sleep(1500);
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  const got: ServerMessage[] = [];
  await new Promise<void>((resolve, reject) => { ws2.once('open', resolve); ws2.once('error', reject); });
  ws2.on('message', (d) => got.push(JSON.parse(d.toString()) as ServerMessage));
  ws2.send(JSON.stringify({ type: 'hello', lastSeq, serverId: hello.serverId }));
  await waitFor(() => got.find((m) => m.type === 'hello'), 5000, 'hello after reconnect');
  const replayed = got.flatMap((m) => (m.type === 'events' ? m.events : []));
  assert.ok(replayed.some((e) => e.op === 'add' && e.key.endsWith('/notes/offline.md')), 'missed add must be replayed');
  assert.ok(!got.some((m) => m.type === 'resync'), 'small gap must not force a resync');
  ws2.close();
  await openMainSocket(); // later tests read events from the shared inbox again
});

test('cross-site GET reads are refused, same-origin reads pass', async () => {
  const cross = await fetch(BASE + '/api/stats', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const same = await fetch(BASE + '/api/stats', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(same.status, 200);
  const badOrigin = await fetch(BASE + '/api/stats', { headers: { origin: 'http://evil.example' } });
  assert.equal(badOrigin.status, 403);
});

test('bulk delete of many files settles in seconds, not minutes', async () => {
  const dir = path.join(root, 'bulk');
  fs.mkdirSync(dir, { recursive: true });
  let since = eventsOfType().length;
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `b${i}.md`), `# bulk ${i}\n\nline ${i}\n`);
  await waitFor(() => eventsOfType().slice(since).filter((e) => e.op === 'add' && e.key.includes('/bulk/')).length >= 60, 15000, '60 adds');
  since = eventsOfType().length;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) fs.unlinkSync(path.join(dir, `b${i}.md`));
  await waitFor(() => eventsOfType().slice(since).filter((e) => e.op === 'remove' && e.key.includes('/bulk/')).length >= 60, 15000, '60 removes');
  const took = Date.now() - t0;
  assert.ok(took < 8000, `bulk delete took ${took}ms`);
});

test('deleting the watched root itself does not storm and the root recovers when it returns', async () => {
  const since = eventsOfType().length;
  const before = (await api<Snapshot>('/api/snapshot')).files.length;
  assert.ok(before > 0);
  fs.rmSync(root, { recursive: true, force: true });
  await waitFor(() => eventsOfType().slice(since).filter((e) => e.op === 'remove').length >= before, 12000, 'all files removed');
  // the process must stay responsive (a runaway event flood would pin the event loop)
  const t0 = Date.now();
  await api('/api/health');
  assert.ok(Date.now() - t0 < 1500, 'server unresponsive after root deletion');
  await waitFor(() => serverLog.some((l) => /vanished|not found/.test(l)), 5000, 'vanish logged');
  const roots = await api<RootInfo[]>('/api/roots');
  assert.equal(roots[0]?.status, 'error');
  // bring the root back: the health tick re-attaches and rescans
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'back.md'), '# back again\n');
  await waitEvent('add', '/notes/back.md', eventsOfType().length, 15000);
  await waitFor(async () => (await api<RootInfo[]>('/api/roots'))[0]?.status === 'watching' ? true : undefined, 8000, 'root watching again').catch(() => undefined);
});

test('bad origin on websocket is rejected', async () => {
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: 'http://evil.example' } });
  const result = await new Promise<string>((resolve) => {
    bad.once('open', () => resolve('open'));
    bad.once('error', () => resolve('error'));
    bad.once('unexpected-response', () => resolve('rejected'));
  });
  assert.notEqual(result, 'open');
});
