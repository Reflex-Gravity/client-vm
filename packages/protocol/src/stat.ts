// SPDX-License-Identifier: Apache-2.0

/** Raw stat fields, shared by the VFS, the kernel and the Node `fs.Stats` shim. */
export interface StatData {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

/** Field order of the fixed-size binary stat encoding (one float64 per field). */
export const StatLayout = [
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'blksize',
  'blocks',
  'atimeMs',
  'mtimeMs',
  'ctimeMs',
  'birthtimeMs',
] as const satisfies readonly (keyof StatData)[];

export function encodeStat(s: StatData): Uint8Array {
  const out = new Float64Array(StatLayout.length);
  StatLayout.forEach((key, i) => {
    out[i] = s[key];
  });
  return new Uint8Array(out.buffer);
}

export function decodeStat(bytes: Uint8Array): StatData {
  // Copy to guarantee 8-byte alignment regardless of the source offset.
  const f = new Float64Array(bytes.slice().buffer);
  const out = {} as StatData;
  StatLayout.forEach((key, i) => {
    out[key] = f[i] ?? 0;
  });
  return out;
}
