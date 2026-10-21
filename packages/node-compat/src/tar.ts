// SPDX-License-Identifier: Apache-2.0
// Minimal tar (ustar + pax + GNU long names): enough to unpack npm tarballs
// and back the shell's `tar` command. Bytes in, entries out.

export type TarType = 'file' | 'dir' | 'symlink' | 'link' | 'other';

export interface TarEntry {
  path: string;
  type: TarType;
  mode: number;
  size: number;
  mtime: number;
  linkname: string;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function str(b: Uint8Array, off: number, len: number): string {
  const end = b.indexOf(0, off);
  return decoder.decode(b.subarray(off, end < 0 || end > off + len ? off + len : end));
}

function num(b: Uint8Array, off: number, len: number): number {
  if (b[off]! & 0x80) {
    // GNU base-256 for large values.
    let n = b[off]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[off + i]!;
    return n;
  }
  const s = str(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function typeOf(flag: string): TarType {
  if (flag === '0' || flag === '' || flag === '7') return 'file';
  if (flag === '5') return 'dir';
  if (flag === '2') return 'symlink';
  if (flag === '1') return 'link';
  return 'other';
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = decoder.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Parses an uncompressed tar archive. Throws on a corrupt header. */
export function* readTar(bytes: Uint8Array): Generator<TarEntry> {
  let off = 0;
  let pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  while (off + BLOCK <= bytes.length) {
    const h = bytes.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    const stored = num(h, 148, 8);
    if (stored !== sum) throw new Error(`TAR_BAD_ARCHIVE: invalid checksum at offset ${off}`);
    const flag = String.fromCharCode(h[156]!).replace('\0', '');
    let size = num(h, 124, 12);
    const merged = { ...globalPax, ...pax };
    if (merged['size'] !== undefined) size = Number(merged['size']);
    const dataStart = off + BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (flag === 'g') {
      globalPax = { ...globalPax, ...paxRecords(data) };
      continue;
    }
    if (flag === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (flag === 'K') {
      longLink = str(data, 0, data.length);
      continue;
    }
    const magic = str(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : '';
    let path =
      longName ?? merged['path'] ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const linkname = longLink ?? merged['linkpath'] ?? str(h, 157, 100);
    const type = typeOf(flag);
    if (type === 'dir' && !path.endsWith('/')) path += '/';
    yield {
      path,
      type,
      mode: num(h, 100, 8) & 0o7777,
      size,
      mtime: Number(merged['mtime'] ?? num(h, 136, 12)),
      linkname,
      data,
    };
    pax = {};
    longName = null;
    longLink = null;
  }
  if (
    off < bytes.length &&
    off + BLOCK > bytes.length &&
    bytes.subarray(off).some((b) => b !== 0)
  ) {
    throw new Error(`TAR_BAD_ARCHIVE: truncated header at offset ${off}`);
  }
}

/** Builds a ustar archive (pax headers for names that do not fit). */
export function writeTar(entries: Iterable<Omit<TarEntry, 'size'>>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (
    name: string,
    type: string,
    size: number,
    mode: number,
    mtime: number,
    linkname: string,
  ) => {
    const h = new Uint8Array(BLOCK);
    const put = (s: string, off: number, len: number) =>
      h.set(encoder.encode(s).subarray(0, len), off);
    const oct = (n: number, off: number, len: number) =>
      put(n.toString(8).padStart(len - 1, '0'), off, len - 1);
    put(name, 0, 100);
    oct(mode, 100, 8);
    oct(0, 108, 8);
    oct(0, 116, 8);
    oct(size, 124, 12);
    oct(Math.floor(mtime), 136, 12);
    h.fill(32, 148, 156);
    put(type, 156, 1);
    put(linkname, 157, 100);
    put('ustar\x0000', 257, 8);
    put('user', 265, 32);
    put('user', 297, 32);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return h;
  };
  const pushData = (data: Uint8Array) => {
    blocks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(new Uint8Array(pad));
  };
  for (const e of entries) {
    const flag =
      e.type === 'dir' ? '5' : e.type === 'symlink' ? '2' : e.type === 'link' ? '1' : '0';
    const data = e.type === 'file' ? e.data : new Uint8Array(0);
    const nameBytes = encoder.encode(e.path).length;
    if (nameBytes > 100 || encoder.encode(e.linkname).length > 100) {
      let records = '';
      const add = (k: string, v: string) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (String(len).length + encoder.encode(body).length !== len)
          len = String(len).length + encoder.encode(body).length;
        records += `${len}${body}`;
      };
      if (nameBytes > 100) add('path', e.path);
      if (encoder.encode(e.linkname).length > 100) add('linkpath', e.linkname);
      const paxData = encoder.encode(records);
      blocks.push(header('PaxHeader', 'x', paxData.length, 0o644, e.mtime, ''));
      pushData(paxData);
    }
    blocks.push(
      header(e.path.slice(0, 100), flag, data.length, e.mode, e.mtime, e.linkname.slice(0, 100)),
    );
    if (data.length) pushData(data);
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
