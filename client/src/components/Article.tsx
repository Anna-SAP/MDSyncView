import { useEffect, useLayoutEffect, useRef } from 'react';
import morphdom from 'morphdom';
import { renderMermaid, mermaidErrorHtml } from '../lib/mermaid.ts';
import { findAnchor } from '../lib/dom.ts';
import { resolveByName, useStore } from '../store.ts';

interface Props {
  /** sanitized HTML */
  html: string;
  /** bumps when the underlying file changed on disk (drives "changed block" tint + follow-tail) */
  revision: number;
  /** identity of the document; a change resets scroll to top (or to the hash anchor) */
  docKey: string;
  scrollParent: () => HTMLElement | null;
  lang: string;
}

interface Anchor { sig: string | null; line: string | null; index: number; offset: number; atBottom: boolean; height: number }

/** Content signature of a block: stable across edits elsewhere in the document (unlike line numbers). */
function blockSig(el: Element): string {
  return el.tagName + '|' + (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function captureAnchor(article: HTMLElement, scroller: HTMLElement): Anchor {
  const top = scroller.scrollTop;
  const atBottom = scroller.scrollHeight - (top + scroller.clientHeight) < 48;
  const children = Array.from(article.children) as HTMLElement[];
  const artTop = article.getBoundingClientRect().top;
  const scTop = scroller.getBoundingClientRect().top;
  for (let i = 0; i < children.length; i++) {
    const el = children[i]!;
    const rect = el.getBoundingClientRect();
    if (rect.bottom - scTop > 0) {
      return { sig: blockSig(el), line: el.getAttribute('data-line'), index: i, offset: rect.top - scTop, atBottom, height: scroller.scrollHeight };
    }
  }
  return { sig: null, line: null, index: 0, offset: artTop - scTop, atBottom, height: scroller.scrollHeight };
}

function restoreAnchor(article: HTMLElement, scroller: HTMLElement, a: Anchor, grew: boolean): void {
  if (a.atBottom && grew) { scroller.scrollTop = scroller.scrollHeight; return; }
  const children = Array.from(article.children) as HTMLElement[];
  let target: HTMLElement | undefined;
  // 1) same content signature, preferring the candidate closest to the old index
  if (a.sig !== null) {
    let bestDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      if (blockSig(children[i]!) === a.sig) {
        const d = Math.abs(i - a.index);
        if (d < bestDist) { bestDist = d; target = children[i]; }
      }
    }
  }
  // 2) same index and same tag (the anchor block itself was edited in place)
  if (!target) {
    const c = children[a.index];
    if (c && a.sig && c.tagName === a.sig.split('|')[0]) target = c;
  }
  // 3) nearest preceding block by source line
  if (!target && a.line !== null) {
    const want = Number(a.line);
    for (const c of children) { const l = Number(c.getAttribute('data-line')); if (!Number.isNaN(l) && l <= want) target = c; else if (!Number.isNaN(l) && l > want) break; }
  }
  target ??= children[Math.min(a.index, children.length - 1)];
  if (!target) return;
  const scTop = scroller.getBoundingClientRect().top;
  const rect = target.getBoundingClientRect();
  scroller.scrollTop += (rect.top - scTop) - a.offset;
}

/** Reuse already-rendered mermaid diagrams whose source did not change, so morphdom leaves them untouched. */
function adoptRenderedDiagrams(article: HTMLElement, tpl: HTMLElement): void {
  const live = new Map<string, Element>();
  for (const el of article.querySelectorAll('.mermaid[data-hash]')) live.set(el.getAttribute('data-hash')!, el);
  if (!live.size) return;
  for (const pre of Array.from(tpl.querySelectorAll('pre.mermaid-src[data-hash]'))) {
    const hit = live.get(pre.getAttribute('data-hash')!);
    if (hit) pre.replaceWith(hit.cloneNode(true));
  }
}

async function hydrateMermaid(article: HTMLElement): Promise<void> {
  const blocks = Array.from(article.querySelectorAll<HTMLPreElement>('pre.mermaid-src'));
  for (const pre of blocks) {
    if (!pre.isConnected) continue;
    const src = pre.textContent ?? '';
    const hash = pre.getAttribute('data-hash') ?? '';
    pre.classList.add('mermaid-pending');
    const { svg, error } = await renderMermaid(src);
    // a re-render may have morphed this <pre> to new source while we were awaiting: leave it to the next pass
    if (!pre.isConnected || pre.getAttribute('data-hash') !== hash || (pre.textContent ?? '') !== src) continue;
    const host = document.createElement('div');
    host.className = 'mermaid';
    host.setAttribute('data-hash', hash);
    host.setAttribute('data-src', src);
    host.innerHTML = error ? mermaidErrorHtml(src, error) : svg;
    pre.replaceWith(host);
  }
}

/** Theme changed: re-render every diagram from its stored source so colors match the new palette. */
async function rethemeMermaid(article: HTMLElement): Promise<void> {
  for (const host of Array.from(article.querySelectorAll<HTMLElement>('.mermaid[data-src]'))) {
    const src = host.getAttribute('data-src') ?? '';
    const { svg, error } = await renderMermaid(src);
    if (!host.isConnected || host.getAttribute('data-src') !== src) continue;
    host.innerHTML = error ? mermaidErrorHtml(src, error) : svg;
  }
}

function flashChanged(el: Element): void {
  el.classList.add('md-changed');
  window.setTimeout(() => el.classList.remove('md-changed'), 900);
}

export function Article({ html, revision, docKey, scrollParent, lang }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastDoc = useRef<string | null>(null);
  const lastRevision = useRef(0);
  const theme = useStore((s) => s.theme);

  // re-theme diagrams when the app theme or the OS color scheme changes
  useEffect(() => {
    const article = ref.current;
    if (!article) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const run = () => { if (ref.current) void rethemeMermaid(ref.current); };
    run();
    mq.addEventListener('change', run);
    return () => mq.removeEventListener('change', run);
  }, [theme]);

  useLayoutEffect(() => {
    const article = ref.current;
    if (!article) return;
    const scroller = scrollParent();
    const sameDoc = lastDoc.current === docKey;
    const isUpdate = sameDoc && revision !== lastRevision.current;
    const tpl = document.createElement('div');
    tpl.className = article.className;
    tpl.innerHTML = html;

    if (!sameDoc || !article.childElementCount) {
      article.innerHTML = html;
      lastDoc.current = docKey;
      lastRevision.current = revision;
      if (scroller) {
        const hash = /#\/f\/[^#]*#(.+)$/.exec(location.hash)?.[1];
        const target = hash ? findAnchor(hash) : null;
        if (target && article.contains(target)) target.scrollIntoView({ block: 'start' });
        else scroller.scrollTop = 0;
      }
      void hydrateMermaid(article);
      return;
    }

    const anchor = scroller ? captureAnchor(article, scroller) : null;
    const changed: Element[] = [];
    adoptRenderedDiagrams(article, tpl);
    morphdom(article, tpl, {
      childrenOnly: true,
      onBeforeElUpdated(from, to) {
        // identical rendered blocks (mermaid diagrams already hydrated) are left alone
        if (from.isEqualNode(to)) return false;
        const fh = from.getAttribute('data-hash');
        if (fh && fh === to.getAttribute('data-hash') && from.classList.contains('mermaid')) return false;
        if (from.tagName === 'VIDEO' || from.tagName === 'AUDIO') {
          if (from.getAttribute('src') === to.getAttribute('src')) return false;
        }
        return true;
      },
      onElUpdated(el) { if (isUpdate && el.parentElement === article) changed.push(el); },
      onNodeAdded(node) { if (isUpdate && node.nodeType === 1 && (node as Element).parentElement === article) changed.push(node as Element); return node; },
    });
    lastRevision.current = revision;
    if (scroller && anchor) restoreAnchor(article, scroller, anchor, scroller.scrollHeight > anchor.height);
    if (isUpdate) for (const el of changed.slice(0, 80)) flashChanged(el);
    void hydrateMermaid(article);
  }, [html, revision, docKey, scrollParent]);

  // interactions: copy buttons, wiki links, in-app nav links, broken media placeholders
  useEffect(() => {
    const article = ref.current;
    if (!article) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const copy = t.closest<HTMLButtonElement>('button.codecopy');
      if (copy) {
        const code = copy.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
        void navigator.clipboard.writeText(code).then(() => { copy.textContent = '已复制'; setTimeout(() => (copy.textContent = '复制'), 1200); });
        e.preventDefault();
        return;
      }
      const wiki = t.closest<HTMLElement>('[data-wikilink]');
      if (wiki) {
        e.preventDefault();
        const st = useStore.getState();
        const a = wiki.dataset.anchor;
        const name = wiki.dataset.wikilink ?? '';
        if (!name && a) { findAnchor(a)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
        const rec = resolveByName(name, st.doc?.detail?.file.dir);
        if (rec) {
          st.openFile(rec.key);
          if (a) setTimeout(() => findAnchor(a)?.scrollIntoView({ block: 'start' }), 300);
        } else st.toast(`找不到笔记 “${name}”`, 'warn');
        return;
      }
      const nav = t.closest<HTMLElement>('[data-nav]');
      if (nav) {
        e.preventDefault();
        const p = nav.dataset.nav ?? '';
        const frag = nav.dataset.navFrag;
        const key = p.replace(/\\/g, '/').toLowerCase();
        const st = useStore.getState();
        if (!st.openFile(key, { path: p })) st.toast(`无法打开 ${p}`, 'warn');
        if (frag) setTimeout(() => findAnchor(frag)?.scrollIntoView({ block: 'start' }), 300);
        return;
      }
      const anchorLink = t.closest<HTMLAnchorElement>('a[href^="#"]');
      if (anchorLink && !anchorLink.dataset.wikilink && !anchorLink.dataset.nav) {
        const el = findAnchor(anchorLink.getAttribute('href')!.slice(1));
        if (el) { e.preventDefault(); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
        return;
      }
      const img = t.closest<HTMLImageElement>('img[data-src-abs]');
      if (img && !img.closest('a')) {
        e.preventDefault();
        openLightbox(img);
      }
    };
    const onError = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLMediaElement)) return;
      if (el.dataset.failed) return;
      el.dataset.failed = '1';
      const box = document.createElement('div');
      box.className = 'media-missing';
      box.textContent = `⚠️ 无法加载资源：${el.dataset.srcAbs ?? el.getAttribute('src') ?? ''}`;
      el.replaceWith(box);
    };
    article.addEventListener('click', onClick);
    article.addEventListener('error', onError, true);
    return () => { article.removeEventListener('click', onClick); article.removeEventListener('error', onError, true); };
  }, []);

  return <div ref={ref} className="prose" lang={lang} />;
}

function openLightbox(img: HTMLImageElement): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  const im = document.createElement('img');
  im.src = img.src;
  im.alt = img.alt;
  dlg.appendChild(im);
  dlg.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
}
