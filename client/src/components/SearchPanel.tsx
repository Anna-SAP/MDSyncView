import { useEffect, useRef, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useStore } from '../store.ts';
import { relTime } from '../lib/format.ts';
import type { SearchResponse } from '../../../shared/types.ts';

export function SearchPanel() {
  const [q, setQ] = useState(() => { try { return sessionStorage.getItem('mdsv:q') ?? ''; } catch { return ''; } });
  const [root, setRoot] = useState<string>('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const roots = useStore((s) => s.roots);
  const filesVersion = useStore((s) => s.filesVersion);
  const openFile = useStore((s) => s.openFile);
  const currentKey = useStore((s) => s.currentKey);
  const abortRef = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);

  const run = (query: string, rootKey: string) => {
    abortRef.current?.abort();
    if (!query.trim()) { setRes(null); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    api.search(query, { limit: 100, root: rootKey || null }, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) { setRes(r); setCursor(0); } })
      .catch(() => { /* aborted or failed */ })
      .finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
  };

  useEffect(() => {
    try { sessionStorage.setItem('mdsv:q', q); } catch { /* ignore */ }
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => run(q, root), 180);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, root]);

  // re-run when the index changes (debounced harder)
  useEffect(() => {
    if (!q.trim()) return;
    const t = window.setTimeout(() => run(q, root), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesVersion]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!res) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(res.hits.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { const h = res.hits[cursor]; if (h) openFile(h.file.key); }
  };

  return (
    <div className="search-panel">
      <div className="panel-head col">
        <div className="search-box">
          <SearchIcon size={14} />
          <input id="search-input" className="filter-input" placeholder="全文搜索（支持中文子串、文件名、标题）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoFocus />
        </div>
        {roots.length > 1 && (
          <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
            <option value="">所有根目录</option>
            {roots.map((r) => <option key={r.key} value={r.path}>{r.path}</option>)}
          </select>
        )}
      </div>
      <div className="list-panel">
        {res && (
          <div className="search-meta">
            {res.total} 个结果 · {res.tookMs} ms · {res.mode === 'fts' ? '全文索引' : '子串扫描（2 字以内）'}{busy ? ' · 更新中…' : ''}
          </div>
        )}
        {res?.hits.map((h, i) => (
          <div key={h.file.key} className={`list-row ${currentKey === h.file.key ? 'active' : ''} ${i === cursor ? 'cursor' : ''}`} onClick={() => openFile(h.file.key)} title={h.file.path}>
            <div className="row-main">
              <span className="row-title">{h.file.title || h.file.name}</span>
              <span className="row-time">{relTime(h.file.mtime)}</span>
            </div>
            <div className="row-sub"><span className="row-path">{h.file.dir}</span><span className="matched">{h.matchedIn.join(' · ')}</span></div>
            {h.snippet && <div className="snippet" dangerouslySetInnerHTML={{ __html: h.snippet }} />}
          </div>
        ))}
        {res && res.hits.length === 0 && <div className="empty-hint">没有找到 “{res.query}”。提示：1–2 个字使用子串扫描，3 个字以上使用全文索引。</div>}
        {!res && !q && <div className="empty-hint">输入关键词开始搜索。示例：<code>分析</code>、<code>ANY-27206</code>、<code>bugfix 排查</code></div>}
      </div>
    </div>
  );
}
