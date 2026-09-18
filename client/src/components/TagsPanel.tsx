import { useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { collator, relTime } from '../lib/format.ts';
import type { FileRecord } from '../../../shared/types.ts';

export function TagsPanel() {
  const filesVersion = useStore((s) => s.filesVersion);
  const openFile = useStore((s) => s.openFile);
  const currentKey = useStore((s) => s.currentKey);
  const [selected, setSelected] = useState<string | null>(null);

  const { tags, byTag } = useMemo(() => {
    const byTag = new Map<string, FileRecord[]>();
    for (const f of useStore.getState().files.values()) {
      for (const t of f.tags) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t)!.push(f); }
    }
    const tags = [...byTag.entries()].map(([tag, files]) => ({ tag, count: files.length })).sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
    for (const arr of byTag.values()) arr.sort((a, b) => b.mtime - a.mtime);
    return { tags, byTag };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesVersion]);

  const files = selected ? byTag.get(selected) ?? [] : [];

  return (
    <div className="tags-panel">
      <div className="tag-cloud">
        {tags.length === 0 && <div className="empty-hint">没有在 front-matter 中声明 tags 的文件</div>}
        {tags.map((t) => (
          <button key={t.tag} className={`tag-chip ${selected === t.tag ? 'active' : ''}`} onClick={() => setSelected(selected === t.tag ? null : t.tag)}>#{t.tag}<span className="count">{t.count}</span></button>
        ))}
      </div>
      <div className="list-panel">
        {selected && files.map((f) => (
          <div key={f.key} className={`list-row ${currentKey === f.key ? 'active' : ''}`} onClick={() => openFile(f.key)} title={f.path}>
            <div className="row-main"><span className="row-title">{f.title || f.name}</span><span className="row-time">{relTime(f.mtime)}</span></div>
            <div className="row-sub"><span className="row-path">{f.dir}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
