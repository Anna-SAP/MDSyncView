import path from 'node:path';
import matter from 'gray-matter';

export interface Heading { level: number; text: string; slug: string }

export interface MdMeta {
  title: string;
  headings: Heading[];
  excerpt: string;
  wordCount: number;
  tags: string[];
  frontmatter: Record<string, unknown>;
  /** Wiki-link targets found in the body ([[Target]] / [[Target|alias]] / [[Target#sec]]), raw target text. */
  wikiLinks: string[];
  /** Character offset where the body (after front-matter) starts. */
  bodyOffset: number;
}

const CJK = /[⺀-⿟぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/g;

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

function stripInline(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => (b ?? a))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = text.replace(CJK, ' ').split(/[^\p{L}\p{N}'-]+/u).filter(Boolean).length;
  return cjk + latin;
}

/** Parse front-matter + structural metadata from a Markdown document. Never throws. */
export function extractMeta(filePath: string, content: string): MdMeta {
  let fm: Record<string, unknown> = {};
  let body = content;
  let bodyOffset = 0;
  try {
    // an explicit options object disables gray-matter's global, never-evicted content cache
    const parsed = matter(content, {});
    fm = parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>) : {};
    body = parsed.content;
    bodyOffset = content.length - body.length;
  } catch {
    // malformed YAML: treat the whole file as body
    fm = {};
    body = content;
    bodyOffset = 0;
  }

  const headings: Heading[] = [];
  const excerptParts: string[] = [];
  const wikiLinks: string[] = [];
  const slugCounts = new Map<string, number>();
  let inFence = false;
  let fenceMarker = '';
  let excerptLen = 0;
  const lines = body.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) { inFence = true; fenceMarker = marker[0]!; continue; }
      if (marker[0] === fenceMarker) { inFence = false; fenceMarker = ''; continue; }
    }
    if (inFence) continue;

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const text = stripInline(h[2]!);
      if (!text) continue;
      let slug = slugify(text);
      const seen = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, seen + 1);
      if (seen > 0) slug = `${slug}-${seen}`;
      headings.push({ level: h[1]!.length, text, slug });
      continue;
    }

    for (const m of line.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1]!.trim();
      if (t) wikiLinks.push(t);
    }

    if (excerptLen < 240) {
      const t = stripInline(line);
      if (t && !/^[-=*_]{3,}$/.test(t) && !/^\|/.test(t)) {
        excerptParts.push(t);
        excerptLen += t.length + 1;
      }
    }
  }

  const h1 = headings.find((h) => h.level === 1);
  const fmTitle = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : '';
  const title = fmTitle || h1?.text || path.basename(filePath).replace(/\.[^.]+$/, '');

  let tags: string[] = [];
  const rawTags = fm.tags ?? fm.tag ?? fm.keywords;
  if (Array.isArray(rawTags)) tags = rawTags.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof rawTags === 'string') tags = rawTags.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  tags = [...new Set(tags.map((t) => t.replace(/^#/, '')))];

  let excerpt = excerptParts.join(' ');
  if (excerpt.length > 240) excerpt = excerpt.slice(0, 237).trimEnd() + '…';

  return {
    title,
    headings,
    excerpt,
    wordCount: countWords(stripInline(body)),
    tags,
    frontmatter: fm,
    wikiLinks: [...new Set(wikiLinks)],
    bodyOffset,
  };
}
