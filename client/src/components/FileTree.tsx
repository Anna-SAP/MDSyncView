import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, FileText, FolderOpen, Folder, HardDrive, RefreshCw } from 'lucide-react';
import { useStore } from '../store.ts';
import { buildTree, flattenTree, ancestorKeys } from '../lib/tree.ts';
import { relTime } from '../lib/format.ts';
import type { FileRecord } from '../../../shared/types.ts';

export function FileTree() {
  const filesVersion = useStore((s) => s.filesVersion);
  const roots = useStore((s) => s.roots);
  const expanded = useStore((s) => s.treeExpanded);
  const toggleDir = useStore((s) => s.toggleDir);
  const expandDirs = useStore((s) => s.expandDirs);
  const currentKey = useStore((s) => s.currentKey);
  const openFile = useStore((s) => s.openFile);
  const recentChanges = useStore((s) => s.recentChanges);
  const rescan = useStore((s) => s.rescan);
  const scans = useStore((s) => s.scans);
  const [filter, setFilter] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  const tree = useMemo(() => buildTree(useStore.getState().files.values(), roots), [filesVersion, roots]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const pred = q ? (f: FileRecord) => f.name.toLowerCase().includes(q) || f.title.toLowerCase().includes(q) : undefined;
    return flattenTree(tree, expanded, pred);
  }, [tree, expanded, filter]);

  // auto-expand ancestors of the open file and scroll it into view (also when the file list arrives later)
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => { pendingReveal.current = currentKey; }, [currentKey]);
  useEffect(() => {
    const key = pendingReveal.current;
    if (!key) return;
    const f = useStore.getState().files.get(key);
    if (!f) return;
    expandDirs([f.root, ...ancestorKeys(f)]);
  }, [currentKey, filesVersion, expandDirs]);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 26, overscan: 20 });

  useEffect(() => {
    const key = pendingReveal.current;
    if (!key) return;
    const idx = rows.findIndex((r) => r.kind === 'file' && r.file.key === key);
    if (idx >= 0) {
      pendingReveal.current = null;
      virt.scrollToIndex(idx, { align: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const now = Date.now();
  const anyScan = Object.values(scans).some((p) => p.phase === 'start' || p.phase === 'progress');

  return (
    <div className="tree-panel">
      <div className="panel-head">
        <input className="filter-input" placeholder="筛选文件名…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title="重新扫描全部根目录" onClick={() => void rescan()} disabled={anyScan}><RefreshCw size={14} className={anyScan ? 'spin' : ''} /></button>
      </div>
      <div className="tree-scroll" ref={parentRef}>
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            const style: React.CSSProperties = { position: 'absolute', top: 0, left: 0, width: '100%', height: vi.size, transform: `translateY(${vi.start}px)` };
            if (row.kind === 'dir') {
              const n = row.node;
              const rootInfo = n.isRoot ? roots.find((r) => r.key === n.key) : undefined;
              const Icon = n.isRoot ? HardDrive : row.expanded ? FolderOpen : Folder;
              return (
                <div key={row.key} className={`tree-row dir ${n.isRoot ? 'root' : ''}`} style={{ ...style, paddingLeft: 8 + row.depth * 14 }} onClick={() => toggleDir(n.key)} title={n.path}>
                  {row.expanded ? <ChevronDown size={14} className="chev" /> : <ChevronRight size={14} className="chev" />}
                  <Icon size={14} className="ico" />
                  <span className="label">{row.label}</span>
                  {rootInfo?.status === 'scanning' && <span className="pill scanning">扫描中</span>}
                  {rootInfo?.status === 'error' && <span className="pill error" title={rootInfo.error}>异常</span>}
                  <span className="count">{n.count}</span>
                </div>
              );
            }
            const f = row.file;
            const changedAt = recentChanges.get(f.key);
            const live = changedAt !== undefined && now - changedAt < 600000;
            return (
              <div key={row.key} className={`tree-row file ${currentKey === f.key ? 'active' : ''} ${live ? 'live' : ''}`} style={{ ...style, paddingLeft: 8 + row.depth * 14 }} onClick={() => openFile(f.key)} title={`${f.path}\n${f.title}\n修改于 ${relTime(f.mtime)}`}>
                <FileText size={14} className="ico" />
                <span className="label">{f.name}</span>
                {live && <span className="live-dot" />}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="empty-hint">{filter ? '没有匹配的文件' : '尚未发现 Markdown 文件'}</div>}
      </div>
    </div>
  );
}
