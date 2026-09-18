const start = Date.now();

function stamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export const log = {
  info(scope: string, msg: string, extra?: unknown): void {
    console.log(`${stamp()} [${scope}] ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}`);
  },
  warn(scope: string, msg: string, extra?: unknown): void {
    console.warn(`${stamp()} [${scope}] WARN ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}`);
  },
  error(scope: string, msg: string, extra?: unknown): void {
    console.error(`${stamp()} [${scope}] ERROR ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}`);
  },
  uptimeMs(): number { return Date.now() - start; },
};

function safe(v: unknown): string {
  if (v instanceof Error) return v.message;
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); }
}
