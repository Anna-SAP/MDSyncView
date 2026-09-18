import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { fmtBytes, fmtDateTime, fmtNumber } from '../lib/format.ts';
import { findAnchor } from '../lib/dom.ts';
import type { Heading } from '../../../shared/types.ts';

type RailTab = 'outline' | 'backlinks' | 'props' | 'info';

export function RightRail({ headings }: { headings: Heading[] }) {
  const doc = useStore((s) => s.doc);
  const railOpen = useStore((s) => s.railOpen);
  const openFile = useStore((s) => s.openFile);
  const [tab, setTab] = useState<RailTab>('outline');
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  // scroll-spy
  useEffect(() => {
    if (!railOpen || !doc) return;
    const scroller = document.querySelector<HTMLElement>('.viewer-scroll');
    if (!scroller) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = scroller.getBoundingClientRect().top + 8;
      let cur: string | null = null;
      for (const h of headings) {
        const el = findAnchor(h.slug);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= top + 60) cur = h.slug; else break;
      }
      setActiveSlug(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { scroller.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [headings, railOpen, doc]);

  const detail = doc?.detail;
  const props = useMemo(() => detail ? Object.entries(detail.frontmatter) : [], [detail]);
  if (!railOpen || !doc) return <aside className="rightrail collapsed" />;

  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);

  return (
    <aside className="rightrail">
      <div className="rail-tabs">
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>大纲{headings.length ? ` ${headings.length}` : ''}</button>
        <button className={tab === 'backlinks' ? 'active' : ''} onClick={() => setTab('backlinks')}>反链{detail?.backlinks.length ? ` ${detail.backlinks.length}` : ''}</button>
        <button className={tab === 'props' ? 'active' : ''} onClick={() => setTab('props')}>属性{props.length ? ` ${props.length}` : ''}</button>
        <button className={tab === 'info' ? 'active' : ''} onClick={() => setTab('info')}>信息</button>
      </div>
      <div className="rail-body">
        {tab === 'outline' && (
          <nav className="outline">
            {headings.length === 0 && <div className="empty-hint">此文档没有标题</div>}
            {headings.map((h, i) => (
              <a key={h.slug + i} href={'#' + h.slug} className={`ol-item ${activeSlug === h.slug ? 'active' : ''}`} style={{ paddingLeft: 8 + (h.level - minLevel) * 12 }}
                onClick={(e) => { e.preventDefault(); findAnchor(h.slug)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
                {h.text}
              </a>
            ))}
          </nav>
        )}
        {tab === 'backlinks' && (
          <div className="list-panel">
            {(!detail || detail.backlinks.length === 0) && <div className="empty-hint">没有其他笔记通过 [[wiki 链接]] 引用此文件</div>}
            {detail?.backlinks.map((f) => (
              <div key={f.key} className="list-row" onClick={() => openFile(f.key)} title={f.path}>
                <div className="row-main"><span className="row-title">{f.title || f.name}</span></div>
                <div className="row-sub"><span className="row-path">{f.dir}</span></div>
              </div>
            ))}
          </div>
        )}
        {tab === 'props' && (
          <div className="props">
            {props.length === 0 && <div className="empty-hint">没有 front-matter</div>}
            {props.map(([k, v]) => (
              <div key={k} className="prop"><div className="prop-k">{k}</div><div className="prop-v">{formatProp(v)}</div></div>
            ))}
            {detail && detail.wikiLinks.length > 0 && (
              <div className="prop"><div className="prop-k">wiki 链接</div><div className="prop-v">{detail.wikiLinks.join('、')}</div></div>
            )}
          </div>
        )}
        {tab === 'info' && detail && (
          <div className="props">
            <div className="prop"><div className="prop-k">路径</div><div className="prop-v mono">{detail.file.path}</div></div>
            <div className="prop"><div className="prop-k">大小</div><div className="prop-v">{fmtBytes(detail.file.size)}（{fmtNumber(detail.file.size)} 字节）</div></div>
            <div className="prop"><div className="prop-k">字数</div><div className="prop-v">{fmtNumber(detail.file.wordCount)}</div></div>
            <div className="prop"><div className="prop-k">标题数</div><div className="prop-v">{detail.file.headingCount}</div></div>
            <div className="prop"><div className="prop-k">编码</div><div className="prop-v">{detail.encoding}</div></div>
            <div className="prop"><div className="prop-k">修改时间</div><div className="prop-v">{fmtDateTime(detail.file.mtime)}</div></div>
            <div className="prop"><div className="prop-k">创建时间</div><div className="prop-v">{fmtDateTime(detail.file.ctime)}</div></div>
            <div className="prop"><div className="prop-k">索引时间</div><div className="prop-v">{fmtDateTime(detail.file.indexedAt)}</div></div>
            <div className="prop"><div className="prop-k">根目录</div><div className="prop-v mono">{detail.file.root}</div></div>
          </div>
        )}
      </div>
    </aside>
  );
}

function formatProp(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.map((x) => formatProp(x)).join('、');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
