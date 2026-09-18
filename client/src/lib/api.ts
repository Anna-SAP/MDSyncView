import type { BrowseResponse, ConfigView, FileDetail, SearchResponse, Snapshot, Stats, TagCount } from '../../../shared/types.ts';

const HEADERS = { 'x-mdsv': '1' };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let code = 'HTTP_' + res.status;
  let message = res.statusText;
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    if (j?.error) { code = j.error.code ?? code; message = j.error.message ?? message; }
  } catch { /* not json */ }
  throw new ApiError(res.status, code, message);
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return handle<T>(await fetch(url, { headers: HEADERS, signal, cache: 'no-store' }));
}
async function sendJson<T>(method: 'POST' | 'PUT', url: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(url, { method, headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }));
}

export const api = {
  snapshot: () => getJson<Snapshot>('/api/snapshot'),
  stats: () => getJson<Stats>('/api/stats'),
  file: (path: string, signal?: AbortSignal) => getJson<FileDetail>('/api/file?path=' + encodeURIComponent(path), signal),
  search: (q: string, opts: { limit?: number; offset?: number; root?: string | null } = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams({ q });
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    if (opts.root) p.set('root', opts.root);
    return getJson<SearchResponse>('/api/search?' + p.toString(), signal);
  },
  tags: () => getJson<TagCount[]>('/api/tags'),
  config: () => getJson<ConfigView>('/api/config'),
  updateConfig: (patch: Partial<Pick<ConfigView, 'roots' | 'excludeNames' | 'excludePaths' | 'reconcileIntervalMin'>>) => sendJson<ConfigView>('PUT', '/api/config', patch),
  rescan: (root?: string) => sendJson<{ started: boolean }>('POST', '/api/rescan', root ? { root } : {}),
  browse: (path?: string) => getJson<BrowseResponse>('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '')),
  open: (path: string, mode: 'default' | 'reveal' | 'editor') => sendJson<{ ok: boolean }>('POST', '/api/open', { path, mode }),
};

/** URL that serves the raw bytes of an absolute local path (images, svg, video, audio, md). */
export function rawUrl(absPath: string): string {
  return '/raw?path=' + encodeURIComponent(absPath);
}
