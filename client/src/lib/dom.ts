/**
 * Heading ids that collide with `document`/form property names ("links", "images", "title"…) would be
 * stripped by DOMPurify's clobbering protection, so the renderer prefixes those with "h-". Anchor lookups
 * therefore try the literal id first and the prefixed form second.
 */
export function findAnchor(id: string): HTMLElement | null {
  if (!id) return null;
  let decoded = id;
  try { decoded = decodeURIComponent(id); } catch { /* keep raw */ }
  return document.getElementById(decoded) ?? document.getElementById('h-' + decoded) ?? document.getElementById(id) ?? null;
}

let formProbe: HTMLFormElement | null = null;

/** Mirrors DOMPurify's SANITIZE_DOM check: an id equal to a document or form property would be removed. */
export function clobbersDom(id: string): boolean {
  formProbe ??= document.createElement('form');
  return id in document || id in formProbe;
}
