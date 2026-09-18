import { X } from 'lucide-react';
import { useStore } from '../store.ts';
import { modKey } from '../lib/format.ts';

const ROWS: [string, string][] = [
  [`${modKey} + P / ${modKey} + K`, '快速打开 / 命令面板'],
  [`${modKey} + Shift + F`, '全文搜索'],
  [`${modKey} + B`, '切换侧栏'],
  [`${modKey} + \\`, '切换大纲面板'],
  [`${modKey} + Shift + V`, '渲染 / 源码切换'],
  [`${modKey} + Shift + L`, '跟随最新变更'],
  [`${modKey} + E`, '用默认程序打开'],
  [`${modKey} + Shift + R`, '在资源管理器中显示'],
  [`${modKey} + Shift + C`, '复制路径'],
  [`${modKey} + = / ${modKey} + - / ${modKey} + 0`, '放大 / 缩小 / 重置'],
  ['Alt + ← / Alt + →', '后退 / 前进'],
  ['F5', '重新读取当前文件'],
  ['t', '切换主题'],
  ['?', '本帮助'],
  ['Esc', '关闭面板'],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  const setShortcuts = useStore((s) => s.setShortcuts);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => setShortcuts(false)}>
      <div className="dialog small" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h2>键盘快捷键</h2><button className="icon-btn" onClick={() => setShortcuts(false)}><X size={16} /></button></div>
        <table className="shortcuts">
          <tbody>{ROWS.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
