import { useEffect, useMemo, useRef, useState } from 'react';
import fuzzysort from 'fuzzysort';
import type { Prepared as FzPrepared } from 'fuzzysort';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { relTime } from '../lib/format.ts';
import type { FileRecord, SearchHit } from '../../../shared/types.ts';

interface Command { id: string; label: string; hint?: string; run: () => void }

interface Prepared { file: FileRecord; name: FzPrepared; title: FzPrepared; path: FzPrepared }

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setPalette = useStore((s) => s.setPalette);
  const filesVersion = useStore((s) => s.filesVersion);
  const openFile = useStore((s) => s.openFile);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [ftsHits, setFtsHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const prepared = useMemo<Prepared[]>(() => {
    if (!open) return [];
    const out: Prepared[] = [];
    for (const f of useStore.getState().files.values()) {
      out.push({ file: f, name: fuzzysort.prepare(f.name), title: fuzzysort.prepare(f.title), path: fuzzysort.prepare(f.path) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filesVersion]);

  const commands = useMemo<Command[]>(() => {
    const st = useStore.getState();
    return [
      { id: 'theme-dark', label: '主题：深色', run: () => st.setTheme('dark') },
      { id: 'theme-light', label: '主题：浅色', run: () => st.setTheme('light') },
      { id: 'theme-system', label: '主题：跟随系统', run: () => st.setTheme('system') },
      { id: 'rescan', label: '重新扫描全部根目录', run: () => void st.rescan() },
      { id: 'settings', label: '打开设置（根目录 / 排除规则）', hint: 'Ctrl+,', run: () => st.setSettings(true) },
      { id: 'toggle-sidebar', label: '切换侧栏', hint: 'Ctrl+B', run: () => st.toggleSidebar() },
      { id: 'toggle-rail', label: '切换大纲面板', hint: 'Ctrl+\\', run: () => st.toggleRail() },
      { id: 'follow', label: st.followLatest ? '关闭：跟随最新变更' : '开启：跟随最新变更', hint: 'Ctrl+Shift+L', run: () => st.setFollowLatest(!st.followLatest) },
      { id: 'raw', label: st.viewMode === 'rendered' ? '查看源码' : '渲染视图', hint: 'Ctrl+Shift+V', run: () => st.setViewMode(st.viewMode === 'rendered' ? 'raw' : 'rendered') },
      { id: 'reveal', label: '在资源管理器中显示当前文件', hint: 'Ctrl+Shift+R', run: () => void st.openExternal('reveal') },
      { id: 'editor', label: '用 VS Code 打开当前文件', run: () => void st.openExternal('editor') },
      { id: 'shortcuts', label: '键盘快捷键', hint: '?', run: () => st.setShortcuts(true) },
    ];
  }, [open]);

  const mode: 'files' | 'commands' | 'fts' = q.startsWith('>') ? 'commands' : q.startsWith('?') ? 'fts' : 'files';
  const term = mode === 'files' ? q : q.slice(1);

  const fileResults = useMemo(() => {
    if (mode !== 'files') return [];
    if (!term.trim()) {
      return [...useStore.getState().files.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 30).map((file) => ({ file, score: 0 }));
    }
    const r = fuzzysort.go(term, prepared, { keys: ['name', 'title', 'path'], limit: 40, threshold: -10000, scoreFn: (a) => Math.max(a[0]?.score ?? -Infinity, (a[1]?.score ?? -Infinity) - 5, (a[2]?.score ?? -Infinity) - 40) });
    return r.map((x) => ({ file: x.obj.file, score: x.score }));
  }, [mode, term, prepared]);

  const cmdResults = useMemo(() => {
    if (mode !== 'commands') return [];
    if (!term.trim()) return commands;
    return fuzzysort.go(term, commands, { key: 'label', limit: 20 }).map((r) => r.obj);
  }, [mode, term, commands]);

  useEffect(() => {
    if (mode !== 'fts' || !term.trim()) { setFtsHits([]); return; }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => { api.search(term, { limit: 30 }, ctrl.signal).then((r) => setFtsHits(r.hits)).catch(() => undefined); }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [mode, term]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    // the input mounts with the palette (autoFocus); re-assert focus in case another input held it
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.cursor')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);

  if (!open) return null;
  const count = mode === 'files' ? fileResults.length : mode === 'commands' ? cmdResults.length : ftsHits.length;

  const choose = (i: number) => {
    if (mode === 'files') { const r = fileResults[i]; if (r) { openFile(r.file.key); setPalette(false); } }
    else if (mode === 'commands') { const c = cmdResults[i]; if (c) { setPalette(false); c.run(); } }
    else { const h = ftsHits[i]; if (h) { openFile(h.file.key); setPalette(false); } }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(count - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="palette-input" placeholder="输入文件名 / 标题 / 路径…  （> 命令，? 全文搜索）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoFocus />
        <div className="palette-list" ref={listRef}>
          {mode === 'files' && fileResults.map((r, i) => (
            <div key={r.file.key} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}>
              <div className="pi-main"><span className="pi-title">{r.file.title || r.file.name}</span><span className="pi-time">{relTime(r.file.mtime)}</span></div>
              <div className="pi-sub">{r.file.path}</div>
            </div>
          ))}
          {mode === 'commands' && cmdResults.map((c, i) => (
            <div key={c.id} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}>
              <div className="pi-main"><span className="pi-title">{c.label}</span>{c.hint && <span className="pi-time">{c.hint}</span>}</div>
            </div>
          ))}
          {mode === 'fts' && ftsHits.map((h, i) => (
            <div key={h.file.key} className={`palette-item ${i === cursor ? 'cursor' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}>
              <div className="pi-main"><span className="pi-title">{h.file.title || h.file.name}</span><span className="pi-time">{relTime(h.file.mtime)}</span></div>
              <div className="pi-sub snippet" dangerouslySetInnerHTML={{ __html: h.snippet }} />
            </div>
          ))}
          {count === 0 && <div className="empty-hint">{mode === 'fts' && !term.trim() ? '输入关键词进行全文搜索' : '没有匹配项'}</div>}
        </div>
        <div className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭 · 前缀 <kbd>&gt;</kbd> 命令 · <kbd>?</kbd> 全文</div>
      </div>
    </div>
  );
}
