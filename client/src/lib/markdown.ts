import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance, Env, StateInline, Token } from 'markdown-it';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import mark from 'markdown-it-mark';
import container from 'markdown-it-container';
import { full as emoji } from 'markdown-it-emoji';
import { alert } from '@mdit/plugin-alert';
import { katex } from '@mdit/plugin-katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import plaintext from 'highlight.js/lib/languages/plaintext';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import { rawUrl } from './api.ts';
import { escapeHtml, fnv1a, joinPath } from './format.ts';
import { clobbersDom } from './dom.ts';
import type { Heading } from '../../../shared/types.ts';

const LANGS: Record<string, unknown> = {
  javascript, js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
  typescript, ts: typescript, tsx: typescript,
  json, jsonc: json, json5: json,
  bash, sh: bash, shell: bash, zsh: bash, console: bash,
  powershell, ps1: powershell, pwsh: powershell,
  python, py: python,
  yaml, yml: yaml,
  markdown, md: markdown,
  css, scss: css,
  xml, html: xml, svg: xml, vue: xml,
  sql, java, go, golang: go, rust, rs: rust, c, h: c, cpp, 'c++': cpp, cc: cpp, hpp: cpp,
  csharp, cs: csharp, diff, patch: diff, ini, toml: ini, dockerfile, docker: dockerfile,
  plaintext, text: plaintext, txt: plaintext, plain: plaintext,
  kotlin, kt: kotlin, swift, ruby, rb: ruby, php,
};
for (const [name, def] of Object.entries(LANGS)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, def as any);
}

const VIDEO_EXT = /\.(mp4|webm|m4v|ogv|mov)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|oga|flac|opus|aac)(\?.*)?$/i;
const PDF_EXT = /\.pdf(\?.*)?$/i;
const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;
const MD_WITH_ANCHOR = /^(.*\.(?:md|markdown|mdown|mkd|mdx))(#.*)?$/i;

export type RenderEnv = {
  /** Absolute directory of the document (for resolving relative assets). */
  docDir: string;
  headings: Heading[];
  slugCounts: Map<string, number>;
};

const asEnv = (env: Env | undefined): RenderEnv => env as unknown as RenderEnv;

export interface RenderResult {
  html: string;
  headings: Heading[];
  hasMermaid: boolean;
}

/** Same algorithm as the server's slugify, so anchors are stable across both. */
export function slugify(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~[\]()!#.,:;'"?<>{}|\\/^$+=]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url) && !/^[a-z]:[\\/]/i.test(url);
}

function isWindowsAbs(url: string): boolean {
  return /^[a-z]:[\\/]/i.test(url) || /^\\\\/.test(url);
}

export interface ResolvedAsset {
  kind: 'external' | 'raw' | 'anchor' | 'nav' | 'other';
  url: string;
  /** absolute local path (raw / nav) */
  abs?: string;
  /** heading fragment for nav links, without '#' */
  frag?: string;
}

/** Turn a src/href found in the document into a URL the app can load. */
export function resolveAsset(url: string, docDir: string): ResolvedAsset {
  const trimmed = url.trim();
  if (!trimmed) return { kind: 'other', url: trimmed };
  if (trimmed.startsWith('#')) return { kind: 'anchor', url: trimmed };
  if (/^(data|blob):/i.test(trimmed)) return { kind: 'other', url: trimmed };
  if (isExternal(trimmed)) return { kind: 'external', url: trimmed };
  let local = trimmed;
  if (/^file:\/\/\//i.test(local)) local = safeDecode(local.slice(8));
  else if (/^file:\/\//i.test(local)) local = safeDecode(local.slice(7));
  else local = safeDecode(local);
  const m = MD_WITH_ANCHOR.exec(local);
  if (m) {
    const abs = isWindowsAbs(m[1]!) ? m[1]! : joinPath(docDir, m[1]!);
    return { kind: 'nav', url: abs, abs, frag: m[2] ? m[2].slice(1) : undefined };
  }
  // cache-busting query strings are common in exported docs; the file on disk has none
  const noQuery = local.replace(/\?[^#]*$/, '');
  const abs = isWindowsAbs(noQuery) ? noQuery : joinPath(docDir, noQuery.replace(/^\.\//, ''));
  return { kind: 'raw', url: rawUrl(abs), abs };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function mediaTag(src: string, alt: string, title: string | null, docDir: string, attrs: Record<string, string> = {}): string {
  const r = resolveAsset(src, docDir);
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  const extra = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
  const url = escapeHtml(r.url);
  const orig = escapeHtml(r.abs ?? src);
  if (VIDEO_EXT.test(src)) return `<video controls preload="metadata" playsinline src="${url}" data-src-abs="${orig}"${t}${extra}></video>`;
  if (AUDIO_EXT.test(src)) return `<audio controls preload="metadata" src="${url}" data-src-abs="${orig}"${t}${extra}></audio>`;
  if (PDF_EXT.test(src)) return `<a class="pdf-link" href="${url}" target="_blank" rel="noopener">${escapeHtml(alt || src)} (PDF)</a>`;
  return `<img src="${url}" alt="${escapeHtml(alt)}" data-src-abs="${orig}" loading="lazy" decoding="async"${t}${extra}>`;
}

/** Rewrite src/href/poster attributes inside raw HTML so local media loads through /raw. */
function rewriteRawHtml(html: string, docDir: string): string {
  return html.replace(/\b(src|href|poster|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr: string, _q, dq?: string, sq?: string) => {
    const val = dq ?? sq ?? '';
    if (!val || val.startsWith('#') || /^(data|blob):/i.test(val)) return m;
    if (attr.toLowerCase() === 'xlink:href') return m; // svg internal refs stay (sanitizer restricts them to fragments)
    const r = resolveAsset(val, docDir);
    if (r.kind === 'raw') return `${attr}="${escapeHtml(r.url)}"`;
    if (r.kind === 'nav') return `${attr}="#" data-nav="${escapeHtml(r.abs ?? r.url)}"${r.frag ? ` data-nav-frag="${escapeHtml(r.frag)}"` : ''}`;
    return m;
  });
}

// ---- wiki links: [[Target]], [[Target|Alias]], [[Target#Heading]], ![[image.png|300]] ------------------
function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21 /* ! */ && src.charCodeAt(pos + 1) === 0x5b;
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end < 0 || end > state.posMax) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes('[[') || inner.includes('\n')) return false;
  if (!silent) {
    const [targetPart, aliasPart] = inner.split('|');
    const [target, anchorPart] = (targetPart ?? '').split('#');
    const t = (target ?? '').trim();
    const anchorTxt = (anchorPart ?? '').trim();
    const alias = (aliasPart ?? '').trim();
    const token = state.push('wikilink', '', 0);
    token.meta = { target: t, anchor: anchorTxt, alias, embed };
  }
  state.pos = end + 2;
  return true;
}

function renderWikilink(tokens: Token[], idx: number, _o: unknown, envIn: Env | undefined): string {
  const env = asEnv(envIn);
  const { target, anchor: a, alias, embed } = tokens[idx]!.meta as { target: string; anchor: string; alias: string; embed: boolean };
  if (embed) {
    if (MD_EXT.test(target) || !/\.[a-z0-9]{2,5}$/i.test(target)) {
      return `<span class="wikilink-embed" data-wikilink="${escapeHtml(target)}">📄 ${escapeHtml(alias || target)}</span>`;
    }
    const width: Record<string, string> = /^\d+$/.test(alias) ? { width: alias } : {};
    return mediaTag(target, alias && !/^\d+$/.test(alias) ? alias : target, null, env.docDir, width);
  }
  const label = alias || (a ? `${target || ''}${target ? ' › ' : ''}${a}` : target);
  const slug = a ? headingSlug(a) : '';
  // [[#Heading]] targets the current document: a plain fragment link handled by the anchor click path
  if (!target && slug) return `<a class="wikilink" href="#${escapeHtml(slug)}">${escapeHtml(label)}</a>`;
  return `<a class="wikilink" href="#" data-wikilink="${escapeHtml(target)}"${slug ? ` data-anchor="${escapeHtml(slug)}"` : ''}>${escapeHtml(label)}</a>`;
}

/** Slug used for heading ids: like slugify(), but avoids ids DOMPurify would strip as DOM-clobbering. */
export function headingSlug(text: string): string {
  const s = slugify(text);
  return clobbersDom(s) ? 'h-' + s : s;
}

function renderFence(md: MarkdownItInstance): (tokens: Token[], idx: number, _o: unknown, _e: unknown, self: { renderAttrs(t: Token): string }) => string {
  return (tokens, idx, _o, _e, self) => {
    const token = tokens[idx]!;
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase();
    const code = token.content;
    const attrs = self.renderAttrs(token); // carries data-line for scroll anchoring
    if (lang === 'mermaid') {
      return `<pre class="mermaid-src" data-hash="${fnv1a(code)}"${attrs}>${escapeHtml(code)}</pre>\n`;
    }
    const known = lang && hljs.getLanguage(lang) ? lang : '';
    let body: string;
    if (code.length > 60000) body = escapeHtml(code);
    else if (known) { try { body = hljs.highlight(code, { language: known, ignoreIllegals: true }).value; } catch { body = escapeHtml(code); } }
    else body = escapeHtml(code);
    const label = lang || 'text';
    return `<div class="codeblock" data-lang="${escapeHtml(label)}"${attrs}><div class="codebar"><span class="codelang">${escapeHtml(label)}</span><button type="button" class="codecopy" title="复制代码">复制</button></div><pre class="hljs"><code class="language-${escapeHtml(label)}">${body}</code></pre></div>\n`;
  };
}

// ---- markdown-it instance --------------------------------------------------------------------------
function makeInstance(): MarkdownItInstance {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  // fenced code: our own block markup (markdown-it would wrap a highlighter result in <pre><code>)
  md.renderer.rules.fence = renderFence(md) as never;

  md.use(anchor, {
    level: [1, 2, 3, 4, 5, 6],
    slugify: headingSlug,
    uniqueSlugStartIndex: 1,
    tabIndex: false,
    permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'after', class: 'heading-anchor', ariaHidden: true }),
  });
  md.use(taskLists, { enabled: false, label: true });
  md.use(footnote);
  md.use(deflist);
  md.use(sub);
  md.use(sup);
  md.use(mark);
  md.use(emoji);
  md.use(alert, { deep: true });
  md.use(katex, { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' } as never);
  for (const name of ['note', 'tip', 'info', 'warning', 'danger', 'abstract', 'success', 'question', 'quote']) {
    md.use(container, name, {
      render(tokens: Token[], idx: number) {
        const t = tokens[idx]!;
        if (t.nesting === 1) {
          const title = t.info.trim().slice(name.length).trim();
          return `<div class="admonition admonition-${name}"><p class="admonition-title">${escapeHtml(title || name.toUpperCase())}</p>\n`;
        }
        return '</div>\n';
      },
    });
  }
  md.use(container, 'details', {
    render(tokens: Token[], idx: number) {
      const t = tokens[idx]!;
      if (t.nesting === 1) {
        const title = t.info.trim().slice('details'.length).trim();
        return `<details class="admonition-details"><summary>${escapeHtml(title || '详情')}</summary>\n`;
      }
      return '</details>\n';
    },
  });

  md.inline.ruler.before('link', 'wikilink', wikiLinkRule);
  md.renderer.rules.wikilink = renderWikilink;

  // media: images may be video/audio/pdf; local paths go through /raw
  md.renderer.rules.image = (tokens, idx, _opts, env) => {
    const t = tokens[idx]!;
    const src = String(t.attrGet('src') ?? '');
    const alt = t.content || '';
    const titleAttr = t.attrGet('title');
    const title = titleAttr === null ? null : String(titleAttr);
    return mediaTag(src, alt, title, asEnv(env).docDir);
  };

  // links: .md → in-app navigation, local files → /raw, external → new tab
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx]!;
    const href = String(t.attrGet('href') ?? '');
    const r = resolveAsset(href, asEnv(env).docDir);
    if (r.kind === 'external') { t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener noreferrer'); }
    else if (r.kind === 'nav') { t.attrSet('href', '#'); t.attrSet('data-nav', r.abs ?? r.url); if (r.frag) t.attrSet('data-nav-frag', r.frag); t.attrJoin('class', 'nav-link'); }
    else if (r.kind === 'raw') { t.attrSet('href', r.url); t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener'); }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  // raw html: rewrite local asset references
  md.renderer.rules.html_block = (tokens, idx, _o, env) => rewriteRawHtml(tokens[idx]!.content, asEnv(env).docDir);
  md.renderer.rules.html_inline = (tokens, idx, _o, env) => rewriteRawHtml(tokens[idx]!.content, asEnv(env).docDir);

  // data-line on top-level blocks (scroll anchoring + source sync) and heading collection for the outline.
  // Runs after markdown-it-anchor, so heading ids are final here.
  md.core.ruler.push('mdsv_lines', (state) => {
    const env = asEnv(state.env);
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i]!;
      if (tok.map && tok.level === 0 && tok.nesting !== -1 && tok.type !== 'inline') tok.attrSet('data-line', String(tok.map[0]));
      if (tok.type === 'heading_open') {
        const id = tok.attrGet('id');
        const inline = toks[i + 1];
        if (id !== null && inline && inline.type === 'inline') {
          const text = (inline.children ?? [])
            .filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'emoji')
            .map((c) => c.content)
            .join('')
            .trim();
          env.headings.push({ level: Number(tok.tag.slice(1)) || 1, text: text || inline.content, slug: String(id) });
        }
      }
    }
  });

  return md;
}

let instance: MarkdownItInstance | null = null;

export function renderMarkdown(source: string, docDir: string): RenderResult {
  instance ??= makeInstance();
  const env: RenderEnv = { docDir, headings: [], slugCounts: new Map() };
  const html = instance.render(source, env as unknown as Env);
  return { html, headings: env.headings, hasMermaid: html.includes('class="mermaid-src"') };
}

/** Highlight raw markdown source for the "source" view. */
export function highlightSource(source: string): string {
  if (source.length > 200000) return escapeHtml(source);
  try { return hljs.highlight(source, { language: 'markdown', ignoreIllegals: true }).value; } catch { return escapeHtml(source); }
}
