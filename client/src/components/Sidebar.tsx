import { Activity, Clock, FolderTree, Hash, Search, Settings, Moon, Sun, Monitor, PanelLeftClose } from 'lucide-react';
import { useStore, type SidebarTab } from '../store.ts';
import { FileTree } from './FileTree.tsx';
import { RecentList } from './RecentList.tsx';
import { SearchPanel } from './SearchPanel.tsx';
import { TagsPanel } from './TagsPanel.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { modKey } from '../lib/format.ts';

const TABS: { id: SidebarTab; icon: typeof FolderTree; label: string; hint?: string }[] = [
  { id: 'files', icon: FolderTree, label: '文件' },
  { id: 'recent', icon: Clock, label: '最近' },
  { id: 'search', icon: Search, label: '搜索', hint: `${modKey}+Shift+F` },
  { id: 'tags', icon: Hash, label: '标签' },
  { id: 'activity', icon: Activity, label: '动态' },
];

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const open = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setSettings = useStore((s) => s.setSettings);
  const activityCount = useStore((s) => s.activity.length);

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const nextTheme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';

  return (
    <aside className={`sidebar ${open ? '' : 'collapsed'}`}>
      <div className="rail">
        {TABS.map((t) => (
          <button key={t.id} className={`rail-btn ${tab === t.id ? 'active' : ''}`} title={t.label + (t.hint ? ` (${t.hint})` : '')} onClick={() => setTab(t.id)}>
            <t.icon size={18} />
            {t.id === 'activity' && activityCount > 0 && <span className="rail-dot" />}
          </button>
        ))}
        <div className="rail-spacer" />
        <button className="rail-btn" title={`主题：${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'} (t)`} onClick={() => setTheme(nextTheme)}><ThemeIcon size={18} /></button>
        <button className="rail-btn" title={`设置 (${modKey}+,)`} onClick={() => setSettings(true)}><Settings size={18} /></button>
        <button className="rail-btn" title={`收起侧栏 (${modKey}+B)`} onClick={toggleSidebar}><PanelLeftClose size={18} /></button>
      </div>
      <div className="panel">
        {tab === 'files' && <FileTree />}
        {tab === 'recent' && <RecentList />}
        {tab === 'search' && <SearchPanel />}
        {tab === 'tags' && <TagsPanel />}
        {tab === 'activity' && <ActivityPanel />}
      </div>
    </aside>
  );
}
