import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { fmtNumber, relTime } from '../lib/format.ts';

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const stats = useStore((s) => s.stats);
  const roots = useStore((s) => s.roots);
  const scans = useStore((s) => s.scans);
  const activity = useStore((s) => s.activity);
  const filesVersion = useStore((s) => s.filesVersion);
  const fileCount = useMemo(() => useStore.getState().files.size, [filesVersion]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, []);

  const running = Object.values(scans).filter((p) => p.phase === 'start' || p.phase === 'progress');
  const errors = roots.filter((r) => r.status === 'error');
  const last = activity[0];
  const connLabel = connection === 'live' ? '实时同步' : connection === 'connecting' ? '连接中' : connection === 'reconnecting' ? '重新连接中…' : '离线';

  return (
    <footer className="statusbar">
      <span className={`conn conn-${connection}`} title={`WebSocket：${connLabel}`}><span className="dot" />{connLabel}</span>
      <span title={roots.map((r) => `${r.path} — ${r.status}${r.error ? ': ' + r.error : ''}`).join('\n')}>
        监听 {roots.length} 个根目录{errors.length ? ` · ${errors.length} 个异常` : ''}{stats ? ` · ${stats.watchers} 个句柄` : ''}
      </span>
      <span>{fmtNumber(fileCount || (stats?.files ?? 0))} 个文件</span>
      {running.map((p) => (
        <span key={p.root} className="scanning">扫描 {p.root} · {fmtNumber(p.dirsScanned)} 目录 · {fmtNumber(p.filesFound)} md · {Math.round(p.elapsedMs / 1000)}s</span>
      ))}
      <span className="spacer" />
      {last && <span title={last.path}>最近变更：{last.name} · {relTime(last.at)}</span>}
      {stats && <span className="dim">seq {stats.seq}</span>}
    </footer>
  );
}
