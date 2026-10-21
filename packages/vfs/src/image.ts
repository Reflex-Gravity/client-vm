// SPDX-License-Identifier: Apache-2.0
import { decode, encode } from '@clientvm/protocol';
import type { Value } from '@clientvm/protocol';
import type { DirInode, FileInode, Inode, SymlinkInode } from './inode.ts';
import type { Snapshot } from './memory-vfs.ts';

const Kind = { file: 0, dir: 1, symlink: 2 } as const;

/**
 * Encodes a snapshot's inode table as codec values. File contents are
 * replaced by whatever `blobRef` returns (an index into an image, or a
 * content hash in a checkpoint).
 */
export function encodeInodes(
  snapshot: Snapshot,
  blobRef: (data: Uint8Array, size: number) => Value,
): Value[] {
  const records: Value[] = [];
  for (const node of snapshot.inodes.values()) {
    const common = [
      node.ino,
      node.mode,
      node.nlink,
      node.atimeMs,
      node.mtimeMs,
      node.ctimeMs,
      node.birthtimeMs,
    ];
    switch (node.kind) {
      case 'file':
        records.push([Kind.file, ...common, blobRef(node.data, node.size), node.size]);
        break;
      case 'dir':
        records.push([Kind.dir, ...common, node.parent, node.name, [...node.entries].flat()]);
        break;
      case 'symlink':
        records.push([Kind.symlink, ...common, node.target]);
        break;
    }
  }
  return records;
}

/**
 * Rebuilds a snapshot from {@link encodeInodes} output. Validates structure,
 * so it is safe on untrusted input; `resolveBlob` must return at least
 * `size` bytes or throw.
 */
export function decodeInodes(
  records: unknown,
  nextIno: unknown,
  resolveBlob: (ref: unknown, size: number) => Uint8Array,
): Snapshot {
  if (!Array.isArray(records) || typeof nextIno !== 'number')
    throw new Error('image: malformed metadata');
  const inodes = new Map<number, Inode>();
  for (const raw of records as unknown[]) {
    if (!Array.isArray(raw)) throw new Error('image: malformed inode');
    const [kind, ino, mode, nlink, atimeMs, mtimeMs, ctimeMs, birthtimeMs, ...rest] =
      raw as unknown[];
    const nums = [ino, mode, nlink, atimeMs, mtimeMs, ctimeMs, birthtimeMs];
    if (!nums.every((n) => typeof n === 'number')) throw new Error('image: malformed inode');
    const base = {
      ino: ino as number,
      mode: mode as number,
      nlink: nlink as number,
      atimeMs: atimeMs as number,
      mtimeMs: mtimeMs as number,
      ctimeMs: ctimeMs as number,
      birthtimeMs: birthtimeMs as number,
      epoch: 0,
    };
    if (inodes.has(base.ino)) throw new Error('image: duplicate inode');
    if (kind === Kind.file) {
      const [ref, size] = rest;
      if (typeof size !== 'number' || size < 0) throw new Error('image: bad file size');
      const data = resolveBlob(ref, size);
      if (data.length < size) throw new Error('image: bad file blob');
      inodes.set(base.ino, {
        ...base,
        kind: 'file',
        data,
        size,
        dataShared: true,
      } satisfies FileInode);
    } else if (kind === Kind.dir) {
      const [parent, name, flat] = rest;
      if (typeof parent !== 'number' || typeof name !== 'string' || !Array.isArray(flat)) {
        throw new Error('image: bad directory');
      }
      const entries = new Map<string, number>();
      for (let i = 0; i < flat.length; i += 2) {
        const [n, child] = [flat[i], flat[i + 1]];
        if (typeof n !== 'string' || typeof child !== 'number') {
          throw new Error('image: bad directory entry');
        }
        entries.set(n, child);
      }
      inodes.set(base.ino, { ...base, kind: 'dir', entries, parent, name } satisfies DirInode);
    } else if (kind === Kind.symlink) {
      const [target] = rest;
      if (typeof target !== 'string') throw new Error('image: bad symlink');
      inodes.set(base.ino, { ...base, kind: 'symlink', target } satisfies SymlinkInode);
    } else {
      throw new Error('image: unknown inode kind');
    }
  }

  // Every directory entry and parent pointer must reference an inode in the image.
  if (inodes.get(1)?.kind !== 'dir') throw new Error('image: missing root');
  for (const node of inodes.values()) {
    if (node.kind !== 'dir') continue;
    const parent = inodes.get(node.parent);
    if (!parent || parent.kind !== 'dir') throw new Error('image: dangling parent');
    for (const child of node.entries.values()) {
      if (!inodes.has(child)) throw new Error('image: dangling entry');
    }
  }
  let maxIno = nextIno - 1;
  for (const ino of inodes.keys()) if (ino > maxIno) maxIno = ino;
  return { inodes, nextIno: maxIno + 1, epoch: 0 };
}

/**
 * Filesystem image: a portable, self-contained copy of a snapshot, used to
 * fork an instance into another origin (where memory cannot be shared).
 *
 * Layout: chunk 0 is codec-encoded metadata; chunk i+1 is blob i. Blobs are
 * deduplicated by identity, so data shared through copy-on-write is written
 * once. Chunks are separate buffers so they can be transferred individually.
 */
const IMAGE_VERSION = 1;

export function exportImage(snapshot: Snapshot): Uint8Array[] {
  const blobs: Uint8Array[] = [];
  const sizes: number[] = [];
  const blobIndex = new Map<Uint8Array, number>();
  const inodes = encodeInodes(snapshot, (data, size) => {
    let index = blobIndex.get(data);
    if (index === undefined) {
      index = blobs.length;
      blobIndex.set(data, index);
      blobs.push(data);
      sizes.push(0);
    }
    // Files sharing a blob may have different sizes; keep the largest.
    sizes[index] = Math.max(sizes[index]!, size);
    return index;
  });
  const meta = encode({ v: IMAGE_VERSION, nextIno: snapshot.nextIno, blobs: blobs.length, inodes });
  return [meta, ...blobs.map((b, i) => b.slice(0, sizes[i]))];
}

/** Rebuilds a snapshot from {@link exportImage} chunks. Validates structure; treat input as untrusted. */
export function importImage(chunks: readonly Uint8Array[]): Snapshot {
  const [metaChunk, ...blobs] = chunks;
  if (!metaChunk) throw new Error('image: missing metadata chunk');
  const meta = decode(metaChunk) as {
    v?: unknown;
    nextIno?: unknown;
    blobs?: unknown;
    inodes?: unknown;
  };
  if (meta?.v !== IMAGE_VERSION) throw new Error(`image: unsupported version ${String(meta?.v)}`);
  if (meta.blobs !== blobs.length) throw new Error('image: malformed metadata');
  return decodeInodes(meta.inodes, meta.nextIno, (ref) => {
    const data = typeof ref === 'number' ? blobs[ref] : undefined;
    if (!data) throw new Error('image: bad file blob');
    return data;
  });
}
