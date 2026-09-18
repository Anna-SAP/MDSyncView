import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { fmtBytes, relTime } from '../lib/format.ts';

const OP_LABEL: Record<string, { text: string; cls: string }> = {
  add: { text: '新增', cls: 'op-add' },
  change: { text: '修改', cls: 'op-change' },
  remove: { text: '删除', cls: 'op-remove' },
  rename: { text: '重命名', cls: 'op-rename' },
  touch: { text: '触碰', cls: 'op-touch' },
};

export function ActivityPanel() {
  const activity = useStore((s) => s.activity);
  const openFile = useStore((s) => s.openFile);
  const files = useStore((s) => s.files);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10000); return () => clearInterval(t); }, []);

  return (
    <div className="list-panel activity">
      {activity.length === 0 && <div className="empty-hint">连接后，磁盘上的每一次 Markdown 变更都会实时出现在这里。</div>}
      {activity.map((a) => {
        const op = OP_LABEL[a.op] ?? OP_LABEL.change!;
        const exists = files.has(a.key);
        return (
          <div key={a.id} className={`list-row activity-row ${exists ? '' : 'gone'}`} onClick={() => exists && openFile(a.key)} title={a.path}>
            <div className="row-main">
              <span className={`op ${op.cls}`}>{op.text}</span>
              <span className="row-title">{a.name}</span>
              <span className="row-time">{relTime(a.at)}</span>
            </div>
            <div className="row-sub">
              <span className="row-path">{a.op === 'rename' && a.oldKey ? `${a.oldKey.split('/').pop()} → ${a.name}` : a.path}</span>
              {a.size !== undefined && <span className="row-size">{fmtBytes(a.size)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
