import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { dayBucket, fmtBytes, relTime } from '../lib/format.ts';
import type { FileRecord } from '../../../shared/types.ts';

const LIMIT = 300;

export function RecentList() {
  const filesVersion = useStore((s) => s.filesVersion);
  const currentKey = useStore((s) => s.currentKey);
  const openFile = useStore((s) => s.openFile);
  const recentChanges = useStore((s) => s.recentChanges);
  const [tickCount, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(t); }, []);

  const groups = useMemo(() => {
    const all = [...useStore.getState().files.values()].sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT);
    const now = Date.now();
    const live: FileRecord[] = [];
    const rest = new Map<string, FileRecord[]>();
    for (const f of all) {
      const changedAt = recentChanges.get(f.key);
      if (changedAt !== undefined && now - changedAt < 600000) { live.push(f); continue; }
      const b = dayBucket(f.mtime, now);
      if (!rest.has(b)) rest.set(b, []);
      rest.get(b)!.push(f);
    }
    return { live, rest: [...rest.entries()] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesVersion, recentChanges, tickCount]);

  const Row = ({ f, live }: { f: FileRecord; live?: boolean }) => (
    <div className={`list-row ${currentKey === f.key ? 'active' : ''} ${live ? 'live' : ''}`} onClick={() => openFile(f.key)} title={f.path}>
      <div className="row-main">
        <span className="row-title">{f.title || f.name}</span>
        <span className="row-time">{relTime(f.mtime)}</span>
      </div>
      <div className="row-sub">
        <span className="row-path">{f.dir}</span>
        <span className="row-size">{fmtBytes(f.size)}</span>
      </div>
    </div>
  );

  return (
    <div className="list-panel">
      {groups.live.length > 0 && (
        <>
          <div className="group-head live"><span className="live-dot" /> 实时变更（10 分钟内）</div>
          {groups.live.map((f) => <Row key={f.key} f={f} live />)}
        </>
      )}
      {groups.rest.map(([bucket, files]) => (
        <div key={bucket}>
          <div className="group-head">{bucket}<span className="count">{files.length}</span></div>
          {files.map((f) => <Row key={f.key} f={f} />)}
        </div>
      ))}
      {groups.live.length === 0 && groups.rest.length === 0 && <div className="empty-hint">尚未发现 Markdown 文件</div>}
    </div>
  );
}
