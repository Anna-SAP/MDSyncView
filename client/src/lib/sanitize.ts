import DOMPurify from 'dompurify';

/**
 * DOMPurify applies this to every attribute value that is not on its URI-safe list, so it must accept
 * ordinary values ("checkbox", "0 0 320 120", "lazy") and only reject scheme-prefixed values we do not
 * trust. Shape mirrors DOMPurify's default: known schemes, or anything that does not look like "scheme:".
 */
const ALLOWED_URI = /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

const EXTERNAL_HREF = /^(?:https?|mailto|tel):/i;

let configured = false;
/** Set while sanitizing Mermaid output, whose <style> rules are scoped to the diagram id. */
let allowSvgStyle = false;

function configure(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    // <style> inside inline SVG still applies to the whole document (shared cascade), so it is only
    // tolerated for Mermaid output, whose selectors are prefixed with the diagram id.
    if (data.tagName === 'style') {
      const el = node as Element;
      if (!allowSvgStyle || !el.closest || !el.closest('svg')) el.parentNode?.removeChild(el);
    }
  });
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = (node as Element).tagName?.toLowerCase();
    const name = data.attrName.toLowerCase();
    // external resource references inside SVG are a data-exfiltration vector: fragments only
    if ((tag === 'use' || tag === 'image' || tag === 'feimage' || tag === 'pattern' || tag === 'filter') && (name === 'href' || name === 'xlink:href')) {
      if (!data.attrValue.startsWith('#')) { data.keepAttr = false; return; }
    }
    if (name === 'style' && /url\s*\(|expression\s*\(|@import|behavior\s*:/i.test(data.attrValue)) { data.keepAttr = false; return; }
    if (name === 'srcset' && !/^\s*\/raw\?/.test(data.attrValue) && !/^\s*data:image/i.test(data.attrValue)) { data.keepAttr = false; return; }
    if (name === 'target' && data.attrValue !== '_blank') { data.attrValue = '_blank'; }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as HTMLElement;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (EXTERNAL_HREF.test(href)) el.setAttribute('target', '_blank');
      if (el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'INPUT') {
      if (el.getAttribute('type') !== 'checkbox') el.remove();
      else el.setAttribute('disabled', '');
    }
  });
}

const BASE_CONFIG: import('dompurify').Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_TAGS: ['video', 'audio', 'source', 'track', 'picture', 'details', 'summary', 'mark', 'kbd', 'abbr', 'figure', 'figcaption', 'aside', 'style', 'semantics', 'annotation'],
  ADD_ATTR: [
    'controls', 'loop', 'muted', 'poster', 'preload', 'playsinline', 'srclang', 'label', 'kind', 'default', 'open',
    'srcset', 'sizes', 'loading', 'decoding', 'target', 'checked', 'disabled', 'type',
    'data-lang', 'data-hash', 'data-line', 'data-nav', 'data-nav-frag', 'data-wikilink', 'data-anchor', 'data-src-abs', 'data-footnote-backref',
    'encoding', 'xmlns', 'xmlns:xlink', 'xlink:href', 'viewbox', 'preserveaspectratio', 'dominant-baseline',
  ],
  // note: `button` stays allowed (no handlers survive) — the code-block copy control relies on it
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'foreignobject', 'animate', 'set', 'animatemotion', 'animatetransform', 'meta', 'link', 'base', 'textarea', 'select'],
  FORBID_ATTR: ['srcdoc', 'formaction', 'ping', 'autoplay', 'action', 'method', 'form', 'name'],
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
};

export function sanitizeHtml(html: string): string {
  configure();
  allowSvgStyle = false;
  return DOMPurify.sanitize(html, BASE_CONFIG) as string;
}

/** Mermaid output: same policy, but its (id-scoped) <style> block is kept so diagrams keep their theme. */
export function sanitizeSvg(svg: string): string {
  configure();
  allowSvgStyle = true;
  try {
    return DOMPurify.sanitize(svg, BASE_CONFIG) as string;
  } finally {
    allowSvgStyle = false;
  }
}
