import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Code, Copy, ExternalLink, Eye, FolderOpen, Radio, RefreshCw, ZoomIn, ZoomOut, PanelRight, ArrowLeft, ArrowRight } from 'lucide-react';
import { useStore } from '../store.ts';
import { Article } from './Article.tsx';
import { renderMarkdown, highlightSource } from '../lib/markdown.ts';
import { sanitizeHtml } from '../lib/sanitize.ts';
import { fmtBytes, fmtNumber, readingTime, relTime, splitPath, modKey } from '../lib/format.ts';
import type { Heading } from '../../../shared/types.ts';

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;

export interface RenderedDoc { html: string; headings: Heading[] }

export function Viewer({ onHeadings }: { onHeadings: (h: Heading[]) => void }) {
  const doc = useStore((s) => s.doc);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const contentScale = useStore((s) => s.contentScale);
  const setContentScale = useStore((s) => s.setContentScale);
  const followLatest = useStore((s) => s.followLatest);
  const setFollowLatest = useStore((s) => s.setFollowLatest);
  const railOpen = useStore((s) => s.railOpen);
  const toggleRail = useStore((s) => s.toggleRail);
  const goBack = useStore((s) => s.goBack);
  const goForward = useStore((s) => s.goForward);
  const history = useStore((s) => s.history);
  const historyIndex = useStore((s) => s.historyIndex);
  const openExternal = useStore((s) => s.openExternal);
  const toast = useStore((s) => s.toast);
  const reloadDoc = useStore((s) => s.reloadDoc);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10000); return () => clearInterval(t); }, []);

  const detail = doc?.detail ?? null;
  const rendered = useMemo<RenderedDoc | null>(() => {
    if (!detail) return null;
    const body = detail.content.slice(detail.bodyOffset);
    const t0 = performance.now();
    const r = renderMarkdown(body, detail.file.dir);
    const html = sanitizeHtml(r.html);
    if (performance.now() - t0 > 500) console.info(`[render] ${detail.file.name} took ${(performance.now() - t0).toFixed(0)}ms`);
    return { html, headings: r.headings };
  }, [detail]);

  useEffect(() => { onHeadings(rendered?.headings ?? []); }, [rendered, onHeadings]);

  const lang = useMemo(() => {
    if (!detail) return 'zh-CN';
    const sample = detail.content.slice(0, 4000);
    const cjk = (sample.match(CJK_RE) ?? []).length;
    return cjk / Math.max(1, sample.length) > 0.15 ? 'zh-CN' : 'en';
  }, [detail]);

  const scrollParent = useCallback(() => scrollRef.current, []);

  if (!doc) return <EmptyState />;
  const file = detail?.file;
  const segs = splitPath(doc.path);
  const copyPath = () => { void navigator.clipboard.writeText(doc.path).then(() => toast('路径已复制')); };

  return (
    <section className="viewer">
      <header className="viewer-head">
        <div className="viewer-nav">
          <button className="icon-btn" title={`后退 (Alt+←)`} disabled={historyIndex <= 0} onClick={goBack}><ArrowLeft size={16} /></button>
          <button className="icon-btn" title={`前进 (Alt+→)`} disabled={historyIndex >= history.length - 1} onClick={goForward}><ArrowRight size={16} /></button>
          <nav className="breadcrumb" title={doc.path}>
            {segs.map((s, i) => (
              <span key={i} className={i === segs.length - 1 ? 'crumb crumb-last' : 'crumb'}>{s}{i < segs.length - 1 && <span className="crumb-sep">›</span>}</span>
            ))}
          </nav>
          <div className="viewer-actions">
            <button className={`icon-btn ${followLatest ? 'active' : ''}`} title={`跟随最新变更 (${modKey}+Shift+L)`} onClick={() => setFollowLatest(!followLatest)}><Radio size={16} /></button>
            <button className="icon-btn" title={viewMode === 'rendered' ? `查看源码 (${modKey}+Shift+V)` : `渲染视图 (${modKey}+Shift+V)`} onClick={() => setViewMode(viewMode === 'rendered' ? 'raw' : 'rendered')}>{viewMode === 'rendered' ? <Code size={16} /> : <Eye size={16} />}</button>
            <button className="icon-btn" title="缩小" onClick={() => setContentScale(contentScale - 0.1)}><ZoomOut size={16} /></button>
            <button className="icon-btn" title="放大" onClick={() => setContentScale(contentScale + 0.1)}><ZoomIn size={16} /></button>
            <button className="icon-btn" title="复制路径" onClick={copyPath}><Copy size={16} /></button>
            <button className="icon-btn" title="在资源管理器中显示" onClick={() => void openExternal('reveal')}><FolderOpen size={16} /></button>
            <button className="icon-btn" title={`用默认程序打开 (${modKey}+E)`} onClick={() => void openExternal('default')}><ExternalLink size={16} /></button>
            <button className="icon-btn" title="重新读取 (F5)" onClick={() => void reloadDoc()}><RefreshCw size={16} /></button>
            <button className={`icon-btn ${railOpen ? 'active' : ''}`} title="大纲面板" onClick={toggleRail}><PanelRight size={16} /></button>
          </div>
        </div>
        {file && (
          <div className="viewer-meta">
            <h1 className="viewer-title" title={file.title}>{file.title}</h1>
            <div className="meta-strip">
              <span title={new Date(file.mtime).toLocaleString()}>修改于 {relTime(file.mtime)}</span>
              <span>{fmtBytes(file.size)}</span>
              <span>{fmtNumber(file.wordCount)} 字 · {readingTime(file.wordCount)}</span>
              {detail && detail.encoding !== 'utf-8' && <span className="badge">{detail.encoding}</span>}
              {detail?.truncated && <span className="badge warn">仅显示前 8 MB</span>}
              {file.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
              {doc.status === 'locked' && <span className="badge warn">文件被占用，等待重试…</span>}
            </div>
          </div>
        )}
      </header>

      {doc.status === 'deleted' && (
        <div className="banner banner-danger">
          <span>⛔ 此文件已从磁盘删除{doc.deletedAt ? `（${relTime(doc.deletedAt)}）` : ''}。下面显示的是最后一次读取的内容。</span>
        </div>
      )}
      {doc.status === 'error' && <div className="banner banner-danger">读取失败：{doc.error}</div>}
      {doc.status === 'locked' && !file && <div className="banner banner-warn">⏳ 文件正被其他程序占用，正在等待重试…</div>}

      <div className="viewer-scroll" ref={scrollRef}>
        {!detail && (doc.status === 'loading' || doc.status === 'locked') && <div className="loading">正在读取…</div>}
        {detail && viewMode === 'rendered' && rendered && (
          <div className={`article-wrap ${doc.status === 'deleted' ? 'dimmed' : ''}`} style={{ fontSize: `${contentScale}rem` }}>
            <Article html={rendered.html} revision={doc.revision} docKey={doc.key} scrollParent={scrollParent} lang={lang} />
          </div>
        )}
        {detail && viewMode === 'raw' && (
          <pre className="raw-source" style={{ fontSize: `${contentScale * 0.85}rem` }} dangerouslySetInnerHTML={{ __html: highlightSource(detail.content) }} />
        )}
      </div>
    </section>
  );
}

function EmptyState() {
  const stats = useStore((s) => s.stats);
  const setPalette = useStore((s) => s.setPalette);
  return (
    <section className="viewer empty">
      <div className="empty-card">
        <div className="empty-logo">M</div>
        <h2>MDSyncView</h2>
        <p>本机已索引 <strong>{fmtNumber(stats?.files ?? 0)}</strong> 个 Markdown 文件，并实时监听变更。</p>
        <p>按 <kbd>{modKey}</kbd> + <kbd>P</kbd> 快速打开文件，<kbd>{modKey}</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> 全文搜索，<kbd>{modKey}</kbd> + <kbd>B</kbd> 显示或隐藏侧栏。</p>
        <button className="btn primary" onClick={() => setPalette(true)}>打开文件…</button>
      </div>
    </section>
  );
}
