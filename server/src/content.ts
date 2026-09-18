import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Encoding } from '../../shared/types.ts';

export interface ReadOk {
  ok: true;
  text: string;
  bytes: number;
  encoding: Encoding;
  truncated: boolean;
  hash: string;
  size: number;
  mtime: number;
  ctime: number;
}
export interface ReadErr { ok: false; error: 'ENOENT' | 'LOCKED' | 'EISDIR' | 'TOO_LARGE' | 'OTHER'; message: string }
export type ReadResult = ReadOk | ReadErr;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LOCK_BACKOFF = [100, 200, 400, 800, 1600];

let gbDecoder: InstanceType<typeof TextDecoder> | null = null;
const CJK_RE = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/g;

/** Strict GB18030 decode, accepted only when the result actually looks like Chinese text. */
function decodeGb18030(buf: Uint8Array): string | null {
  try {
    gbDecoder ??= new TextDecoder('gb18030', { fatal: true });
    const text = gbDecoder.decode(buf);
    const cjk = (text.match(CJK_RE) ?? []).length;
    const sample = text.length;
    // a Windows-1252 "résumé" would decode into a couple of stray CJK glyphs; real GBK text is dense with them
    return sample > 0 && cjk / sample >= 0.05 ? text : null;
  } catch {
    return null;
  }
}

/** Cut a byte buffer back to the last complete UTF-8 sequence (for truncated reads). */
function trimToUtf8Boundary(buf: Buffer): Buffer {
  let end = buf.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i]! & 0xc0) === 0x80) { i--; back++; }
  if (i < 0) return buf;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need > 1 && back + 1 < need) end = i; // dangling lead byte: drop the partial sequence
  return end === buf.length ? buf : buf.subarray(0, end);
}

/** Decode bytes with BOM sniffing, strict UTF-8, then GB18030 fallback (common for Chinese tooling). */
export function decodeText(buf: Buffer, truncated = false): { text: string; encoding: Encoding } {
  if (truncated && !(buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)))) buf = trimToUtf8Boundary(buf);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    const gb = decodeGb18030(buf);
    if (gb !== null) return { text: gb, encoding: 'gb18030' };
    return { text: buf.toString('utf8'), encoding: 'utf-8' };
  }
}

export function hashBytes(buf: Uint8Array): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Read a Markdown file the safe way for a file that another process may be writing:
 * stat → read → stat, retry while the file is still changing, back off on sharing violations.
 */
export async function readMarkdown(filePath: string, opts: { maxBytes: number }): Promise<ReadResult> {
  let lockTries = 0;
  for (let round = 0; round < 8; round++) {
    let st1: fs.Stats;
    try {
      st1 = await fs.promises.stat(filePath);
    } catch (e) {
      return classify(e);
    }
    if (st1.isDirectory()) return { ok: false, error: 'EISDIR', message: 'is a directory' };

    let buf: Buffer;
    try {
      if (st1.size > opts.maxBytes) {
        const fh = await fs.promises.open(filePath, 'r');
        try {
          buf = Buffer.alloc(opts.maxBytes);
          const { bytesRead } = await fh.read(buf, 0, opts.maxBytes, 0);
          buf = buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      } else {
        buf = await fs.promises.readFile(filePath);
      }
    } catch (e) {
      const c = classify(e);
      if (c.error === 'LOCKED' && lockTries < LOCK_BACKOFF.length) {
        await sleep(LOCK_BACKOFF[lockTries++]!);
        continue;
      }
      return c;
    }

    let st2: fs.Stats;
    try {
      st2 = await fs.promises.stat(filePath);
    } catch (e) {
      return classify(e);
    }
    if (st2.size !== st1.size || st2.mtimeMs !== st1.mtimeMs) {
      // writer still in flight; wait a little and try again
      await sleep(120 + round * 60);
      continue;
    }

    const truncated = st1.size > opts.maxBytes;
    const { text, encoding } = decodeText(buf, truncated);
    return {
      ok: true,
      text,
      bytes: buf.length,
      encoding,
      truncated,
      hash: hashBytes(buf),
      size: st1.size,
      mtime: Math.round(st1.mtimeMs),
      ctime: Math.round(st1.birthtimeMs || st1.ctimeMs),
    };
  }
  return { ok: false, error: 'OTHER', message: 'file kept changing' };
}

function classify(e: unknown): ReadErr {
  const code = (e as NodeJS.ErrnoException)?.code;
  const message = (e as Error)?.message ?? String(e);
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'ENOENT', message };
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN') return { ok: false, error: 'LOCKED', message };
  if (code === 'EISDIR') return { ok: false, error: 'EISDIR', message };
  return { ok: false, error: 'OTHER', message };
}
