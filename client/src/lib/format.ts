export const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' });

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** "3 秒前", "5 分钟前", "昨天 14:02", "9月3日" */
export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86400000);
  const hhmm = d.toTimeString().slice(0, 5);
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayBucket(ms: number, now = Date.now()): '今天' | '昨天' | '本周' | '更早' {
  const d = new Date(ms);
  const n = new Date(now);
  if (sameDay(d, n)) return '今天';
  if (sameDay(d, new Date(now - 86400000))) return '昨天';
  if (now - ms < 7 * 86400000) return '本周';
  return '更早';
}

export function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 0 ? p : p.slice(0, i);
}

export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const parts = splitPath(dir);
  const isDrive = /^[A-Za-z]:$/.test(parts[0] ?? '');
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > (isDrive ? 1 : 0)) parts.pop(); continue; }
    parts.push(seg);
  }
  const joined = parts.join(sep);
  return isDrive || sep === '\\' ? joined : sep + joined;
}

export function readingTime(words: number): string {
  const min = Math.max(1, Math.round(words / 400));
  return `约 ${min} 分钟`;
}

/** Simple non-cryptographic hash for memo keys. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export const modKey = isMac() ? '⌘' : 'Ctrl';
