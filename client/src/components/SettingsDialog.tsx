import { useEffect, useState } from 'react';
import { FolderPlus, Trash2, X } from 'lucide-react';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import type { BrowseResponse, ConfigView } from '../../../shared/types.ts';

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const setSettings = useStore((s) => s.setSettings);
  const toast = useStore((s) => s.toast);
  const saveConfig = useStore((s) => s.saveConfig);
  const rescan = useStore((s) => s.rescan);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const [names, setNames] = useState('');
  const [paths, setPaths] = useState('');
  const [interval, setIntervalMin] = useState(30);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.config().then((c) => {
      setCfg(c); setRoots(c.roots); setAuto(c.autoRoots); setNames(c.excludeNames.join('\n')); setPaths(c.excludePaths.join('\n')); setIntervalMin(c.reconcileIntervalMin);
    }).catch((e) => toast(`读取配置失败：${(e as Error).message}`, 'error'));
  }, [open, toast]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    try {
      await saveConfig({
        roots: auto ? [] : roots,
        excludeNames: names.split('\n').map((s) => s.trim()).filter(Boolean),
        excludePaths: paths.split('\n').map((s) => s.trim()).filter(Boolean),
        reconcileIntervalMin: interval,
      });
      toast('设置已保存，正在应用…');
      setSettings(false);
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => setSettings(false)}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h2>设置</h2><button className="icon-btn" onClick={() => setSettings(false)}><X size={16} /></button></div>
        {!cfg ? <div className="loading">读取中…</div> : (
          <div className="dialog-body">
            <section>
              <h3>扫描根目录</h3>
              <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动：接管本机所有固定磁盘（{cfg.drives.join(', ')}）</label>
              {!auto && (
                <div className="roots-edit">
                  {roots.map((r) => (
                    <div key={r} className="root-row"><span className="mono">{r}</span><button className="icon-btn" title="移除" onClick={() => setRoots(roots.filter((x) => x !== r))}><Trash2 size={14} /></button></div>
                  ))}
                  <button className="btn" onClick={() => setPicker(true)}><FolderPlus size={14} /> 添加目录…</button>
                  {roots.length === 0 && <div className="hint">未添加任何目录时等同于"自动"。</div>}
                </div>
              )}
              <div className="hint">当前生效：{cfg.effectiveRoots.join('；')}</div>
            </section>
            <section>
              <h3>排除的目录名（每行一个，不区分大小写）</h3>
              <textarea rows={6} value={names} onChange={(e) => setNames(e.target.value)} spellCheck={false} />
            </section>
            <section>
              <h3>排除的绝对路径（每行一个）</h3>
              <textarea rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} spellCheck={false} placeholder={'C:\\Users\\me\\Archive'} />
            </section>
            <section className="row">
              <h3>定期全量核对（分钟，0 = 关闭）</h3>
              <input type="number" min={0} max={1440} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))} className="num" />
            </section>
            <section>
              <h3>索引</h3>
              <div className="hint mono">{cfg.dbPath}</div>
              <button className="btn" onClick={() => void rescan()}>立即重新扫描全部根目录</button>
            </section>
          </div>
        )}
        <div className="dialog-foot">
          <button className="btn" onClick={() => setSettings(false)}>取消</button>
          <button className="btn primary" disabled={!cfg || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存并应用'}</button>
        </div>
        {picker && <FolderPicker onClose={() => setPicker(false)} onPick={(p) => { if (!roots.includes(p)) setRoots([...roots, p]); setPicker(false); }} />}
      </div>
    </div>
  );
}

function FolderPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: string) => void }) {
  const [state, setState] = useState<BrowseResponse | null>(null);
  const [err, setErr] = useState('');
  const go = (p?: string) => api.browse(p).then((r) => { setState(r); setErr(''); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void go(); }, []);
  return (
    <div className="modal-backdrop inner" onMouseDown={onClose}>
      <div className="dialog small" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h2>选择目录</h2><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="picker-path">
          <button className="btn" disabled={!state?.parent && !state?.path} onClick={() => void go(state?.parent ?? undefined)}>↑ 上级</button>
          <span className="mono">{state?.path ?? '我的电脑'}</span>
        </div>
        <div className="picker-list">
          {err && <div className="empty-hint">{err}</div>}
          {state?.entries.map((e) => <div key={e.path} className="picker-row" onDoubleClick={() => void go(e.path)} onClick={() => void go(e.path)}>📁 {e.name}</div>)}
          {state && state.entries.length === 0 && <div className="empty-hint">没有子目录</div>}
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!state?.path} onClick={() => state?.path && onPick(state.path)}>选择此目录</button>
        </div>
      </div>
    </div>
  );
}
