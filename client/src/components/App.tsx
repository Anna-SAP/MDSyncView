import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { Sidebar } from './Sidebar.tsx';
import { Viewer } from './Viewer.tsx';
import { RightRail } from './RightRail.tsx';
import { StatusBar } from './StatusBar.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { Toasts } from './Toasts.tsx';
import type { Heading } from '../../../shared/types.ts';

const LS_W = 'mdsv:sidebarWidth';

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const railOpen = useStore((s) => s.railOpen);
  const doc = useStore((s) => s.doc);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [sidebarW, setSidebarW] = useState<number>(() => { try { return Number(localStorage.getItem(LS_W)) || 300; } catch { return 300; } });
  const dragging = useRef(false);

  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const inInput = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (st.paletteOpen) { st.setPalette(false); e.preventDefault(); }
        else if (st.settingsOpen) { st.setSettings(false); e.preventDefault(); }
        else if (st.shortcutsOpen) { st.setShortcuts(false); e.preventDefault(); }
        return;
      }
      if (mod && (e.key === 'p' || e.key === 'P' || e.key === 'k' || e.key === 'K') && !e.shiftKey) { e.preventDefault(); st.setPalette(!st.paletteOpen); return; }
      if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); st.setSidebarTab('search'); requestAnimationFrame(() => document.getElementById('search-input')?.focus()); return; }
      if (mod && (e.key === 'b' || e.key === 'B') && !e.shiftKey) { e.preventDefault(); st.toggleSidebar(); return; }
      if (mod && e.key === '\\') { e.preventDefault(); st.toggleRail(); return; }
      if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) { e.preventDefault(); st.setViewMode(st.viewMode === 'rendered' ? 'raw' : 'rendered'); return; }
      if (mod && e.shiftKey && (e.key === 'L' || e.key === 'l')) { e.preventDefault(); st.setFollowLatest(!st.followLatest); st.toast(st.followLatest ? '已关闭跟随最新变更' : '已开启：任何文件新增/修改时自动打开'); return; }
      if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c') && st.doc) { e.preventDefault(); void navigator.clipboard.writeText(st.doc.path).then(() => st.toast('路径已复制')); return; }
      if (mod && e.shiftKey && (e.key === 'R' || e.key === 'r') && st.doc) { e.preventDefault(); void st.openExternal('reveal'); return; }
      if (mod && (e.key === 'e' || e.key === 'E') && !e.shiftKey && st.doc) { e.preventDefault(); void st.openExternal('default'); return; }
      if (mod && e.key === ',') { e.preventDefault(); st.setSettings(true); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); st.setContentScale(st.contentScale + 0.1); return; }
      if (mod && e.key === '-') { e.preventDefault(); st.setContentScale(st.contentScale - 0.1); return; }
      if (mod && e.key === '0') { e.preventDefault(); st.setContentScale(1); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); st.goBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); st.goForward(); return; }
      if (e.key === 'F5' && !mod) { e.preventDefault(); void st.reloadDoc(); return; }
      if (!inInput && !mod && !e.altKey && e.key === '?') { e.preventDefault(); st.setShortcuts(!st.shortcutsOpen); return; }
      if (!inInput && !mod && !e.altKey && (e.key === 't' || e.key === 'T')) {
        const next = st.theme === 'system' ? 'dark' : st.theme === 'dark' ? 'light' : 'system';
        st.setTheme(next); st.toast(`主题：${next === 'system' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // sidebar resize
  const onDragStart = (e: React.MouseEvent) => {
    dragging.current = true;
    e.preventDefault();
    const onMove = (ev: MouseEvent) => { if (dragging.current) setSidebarW(Math.min(560, Math.max(200, ev.clientX))); };
    const onUp = () => { dragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); try { localStorage.setItem(LS_W, String(sidebarW)); } catch { /* ignore */ } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  useEffect(() => { try { localStorage.setItem(LS_W, String(sidebarW)); } catch { /* ignore */ } }, [sidebarW]);

  useEffect(() => {
    document.title = doc?.detail?.file.title ? `${doc.detail.file.title} · MDSyncView` : 'MDSyncView';
  }, [doc?.detail?.file.title]);

  return (
    <div className="app" style={{ ['--sidebar-w' as string]: sidebarOpen ? `${sidebarW}px` : '44px', ['--rail-w' as string]: railOpen && doc ? '260px' : '0px' }}>
      <Sidebar />
      <div className={`resizer ${sidebarOpen ? '' : 'hidden'}`} onMouseDown={onDragStart} />
      <main className="main">
        <Viewer onHeadings={onHeadings} />
      </main>
      <RightRail headings={headings} />
      <StatusBar />
      <CommandPalette />
      <SettingsDialog />
      <ShortcutsDialog />
      <Toasts />
    </div>
  );
}
