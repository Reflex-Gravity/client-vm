// SPDX-License-Identifier: Apache-2.0
import { decode, encode } from '@clientvm/protocol';
import { decodeInodes, encodeInodes } from './image.ts';
import type { Snapshot as SnapshotT } from './memory-vfs.ts';
import type { MemoryVfs, Snapshot } from './memory-vfs.ts';

/**
 * Durable storage for a persisted VFS. `write` must replace a file atomically:
 * a crash leaves either the old or the new contents, never a mix.
 */
export interface PersistenceBackend {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
  /** Names of stored blobs (without the `blobs/` prefix). */
  listBlobs(): Promise<string[]>;
}

/**
 * On-disk layout (all under the backend's root):
 *   HEAD                 generation number of the current checkpoint (decimal)
 *   checkpoint-<gen>     codec-encoded inode table; files reference blobs by hash
 *   blobs/<sha256-hex>   file contents, content-addressed and shared by all checkpoints
 *
 * A flush writes missing blobs, then the new checkpoint, then HEAD, then
 * deletes the previous checkpoint and unreferenced blobs. A crash at any
 * point leaves HEAD pointing at a complete checkpoint.
 */
const FORMAT_VERSION = 2;
/** Inodes per checkpoint part; the flush yields to the event loop between parts. */
const INODES_PER_PART = 500;
const HEAD = 'HEAD';
const checkpointName = (gen: number) => `checkpoint-${gen}`;
const blobName = (hash: string) => `blobs/${hash}`;

export interface PersisterOptions {
  /** Delay between the first change and the flush it triggers. Default 250 ms. */
  debounceMs?: number;
}

export interface PersistStats {
  generation: number;
  flushes: number;
  lastFlushMs: number;
  blobsWritten: number;
  bytesWritten: number;
  blobsDeleted: number;
}

/** Loads the latest checkpoint, or returns null if the store is empty. Throws if it is corrupt. */
export async function loadPersisted(
  backend: PersistenceBackend,
): Promise<{ snapshot: Snapshot; generation: number } | null> {
  const head = await backend.read(HEAD);
  if (!head) return null;
  const generation = Number(new TextDecoder().decode(head));
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error('persistence: corrupt HEAD');
  const raw = await backend.read(checkpointName(generation));
  if (!raw) throw new Error(`persistence: missing checkpoint ${generation}`);
  const meta = decode(raw) as { v?: unknown; nextIno?: unknown; parts?: unknown } | null;
  if (meta?.v !== FORMAT_VERSION || !Array.isArray(meta.parts)) {
    throw new Error('persistence: unsupported checkpoint version');
  }
  const inodes: unknown[] = [];
  for (const part of meta.parts as unknown[]) {
    if (!(part instanceof Uint8Array)) throw new Error('persistence: corrupt checkpoint');
    const records = decode(part);
    if (!Array.isArray(records)) throw new Error('persistence: corrupt checkpoint');
    for (const r of records) inodes.push(r);
  }

  // Fetch every referenced blob (deduplicated), then build the tree synchronously.
  const hashes = new Set<string>();
  for (const record of inodes) {
    if (Array.isArray(record) && record[0] === 0 && typeof record[8] === 'string')
      hashes.add(record[8]);
  }
  const blobs = new Map<string, Uint8Array>();
  await mapLimit([...hashes], 16, async (hash) => {
    const data = await backend.read(blobName(hash));
    if (!data) throw new Error(`persistence: missing blob ${hash}`);
    blobs.set(hash, data);
  });
  const snapshot = decodeInodes(inodes, meta.nextIno, (ref) => {
    const data = typeof ref === 'string' ? blobs.get(ref) : undefined;
    if (!data) throw new Error('persistence: bad blob reference');
    return data;
  });
  return { snapshot, generation };
}

/** Removes everything a persister wrote. */
export async function purgePersisted(backend: PersistenceBackend): Promise<void> {
  const head = await backend.read(HEAD);
  await backend.delete(HEAD);
  if (head) await backend.delete(checkpointName(Number(new TextDecoder().decode(head))));
  for (const blob of await backend.listBlobs()) await backend.delete(blobName(blob));
}

/**
 * Write-behind persistence for a {@link MemoryVfs}. Syscalls never wait on
 * storage: changes mark the persister dirty and a debounced flush writes a
 * new checkpoint in the background.
 *
 * Writes after the last completed flush can be lost on a crash or tab close;
 * {@link flush} is the durability point.
 */
export class Persister {
  private readonly vfs: MemoryVfs;
  private readonly backend: PersistenceBackend;
  private readonly debounceMs: number;
  private generation: number;
  private storedBlobs = new Set<string>();
  /** Blob hashes by buffer identity and size. Buffers captured by a snapshot are never mutated again. */
  private readonly hashCache = new WeakMap<Uint8Array, Map<number, string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private running: Promise<void> | null = null;
  private closed = false;
  private failure: unknown = null;
  readonly stats: PersistStats;

  private constructor(
    vfs: MemoryVfs,
    backend: PersistenceBackend,
    generation: number,
    options: PersisterOptions,
  ) {
    this.vfs = vfs;
    this.backend = backend;
    this.generation = generation;
    this.debounceMs = options.debounceMs ?? 250;
    this.stats = {
      generation,
      flushes: 0,
      lastFlushMs: 0,
      blobsWritten: 0,
      bytesWritten: 0,
      blobsDeleted: 0,
    };
  }

  /** Attaches to `vfs`, which must have been loaded from `generation` of `backend` (0 if new). */
  static async attach(
    vfs: MemoryVfs,
    backend: PersistenceBackend,
    generation: number,
    options: PersisterOptions = {},
  ): Promise<Persister> {
    const persister = new Persister(vfs, backend, generation, options);
    persister.storedBlobs = new Set(await backend.listBlobs());
    vfs.onMutate(() => persister.markDirty());
    // A new store gets its first checkpoint right away.
    if (generation === 0) await persister.flush();
    return persister;
  }

  markDirty(): void {
    if (this.closed) return;
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, this.debounceMs);
  }

  /** Writes all changes made so far. Resolves once they are durable. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Serialize flushes; a change during a flush triggers another one after it.
    while (this.running) await this.running.catch(() => {});
    if (!this.dirty && this.generation > 0) {
      if (this.failure) throw this.failure;
      return;
    }
    this.running = this.writeCheckpoint();
    try {
      await this.running;
      this.failure = null;
    } catch (err) {
      this.failure = err;
      this.dirty = true;
      throw err;
    } finally {
      this.running = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private async writeCheckpoint(): Promise<void> {
    const started = performance.now();
    this.dirty = false;
    const snapshot = this.vfs.snapshot();

    // Hash file contents, reusing hashes for buffers seen in earlier flushes.
    const pending: { data: Uint8Array; size: number }[] = [];
    let n = 0;
    for (const node of snapshot.inodes.values()) {
      if (++n % 2000 === 0) await yieldToEventLoop();
      if (node.kind === 'file' && this.hashCache.get(node.data)?.get(node.size) === undefined) {
        pending.push({ data: node.data, size: node.size });
      }
    }
    await mapLimit(pending, 8, async ({ data, size }) => {
      const hash = await sha256Hex(data.subarray(0, size));
      let bySize = this.hashCache.get(data);
      if (!bySize) this.hashCache.set(data, (bySize = new Map()));
      bySize.set(size, hash);
    });
    const hashOf = (data: Uint8Array, size: number) => this.hashCache.get(data)!.get(size)!;

    // Blobs first, so the checkpoint never references a missing blob.
    const referenced = new Set<string>();
    const toWrite = new Map<string, Uint8Array>();
    n = 0;
    for (const node of snapshot.inodes.values()) {
      if (++n % 2000 === 0) await yieldToEventLoop();
      if (node.kind !== 'file') continue;
      const hash = hashOf(node.data, node.size);
      referenced.add(hash);
      if (!this.storedBlobs.has(hash)) toWrite.set(hash, node.data.subarray(0, node.size));
    }
    await mapLimit([...toWrite], 8, async ([hash, data]) => {
      await this.backend.write(blobName(hash), data);
      this.storedBlobs.add(hash);
      this.stats.blobsWritten++;
      this.stats.bytesWritten += data.length;
    });

    const parts: Uint8Array[] = [];
    for (const slice of sliceInodes(snapshot, INODES_PER_PART)) {
      parts.push(encode(encodeInodes(slice, hashOf)));
      await yieldToEventLoop();
    }
    const checkpoint = encode({ v: FORMAT_VERSION, nextIno: snapshot.nextIno, parts });
    const previous = this.generation;
    const next = previous + 1;
    await this.backend.write(checkpointName(next), checkpoint);
    await this.backend.write(HEAD, new TextEncoder().encode(String(next)));
    this.generation = next;
    this.stats.bytesWritten += checkpoint.length;

    // Garbage: the old checkpoint and blobs no longer referenced.
    if (previous > 0) await this.backend.delete(checkpointName(previous));
    for (const hash of [...this.storedBlobs]) {
      if (referenced.has(hash)) continue;
      await this.backend.delete(blobName(hash));
      this.storedBlobs.delete(hash);
      this.stats.blobsDeleted++;
    }

    this.stats.generation = next;
    this.stats.flushes++;
    this.stats.lastFlushMs = performance.now() - started;
  }
}

/** Splits a snapshot's inode table into snapshots of at most `size` inodes (for incremental encoding). */
function* sliceInodes(snapshot: SnapshotT, size: number): Generator<SnapshotT> {
  let batch = new Map<
    number,
    SnapshotT['inodes'] extends ReadonlyMap<number, infer I> ? I : never
  >();
  for (const [ino, node] of snapshot.inodes) {
    batch.set(ino, node);
    if (batch.size === size) {
      yield { inodes: batch, nextIno: snapshot.nextIno, epoch: snapshot.epoch };
      batch = new Map();
    }
  }
  if (batch.size > 0) yield { inodes: batch, nextIno: snapshot.nextIno, epoch: snapshot.epoch };
}

/** Lets the kernel service syscalls between chunks of flush work (a macrotask, not a microtask). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // subtle.digest rejects views onto SharedArrayBuffers; VFS data is never shared, but copy defensively.
  const input =
    data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** In-memory backend for tests. Records operations so tests can simulate crashes. */
export class MemoryBackend implements PersistenceBackend {
  readonly files = new Map<string, Uint8Array>();
  /** When set, the write with this (0-based) index throws, simulating a crash. */
  failOnWrite: number | null = null;
  writes = 0;

  async read(name: string): Promise<Uint8Array | null> {
    return this.files.get(name)?.slice() ?? null;
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    if (this.failOnWrite === this.writes++) throw new Error('simulated crash');
    this.files.set(name, data.slice());
  }

  async delete(name: string): Promise<void> {
    this.files.delete(name);
  }

  async listBlobs(): Promise<string[]> {
    return [...this.files.keys()].filter((n) => n.startsWith('blobs/')).map((n) => n.slice(6));
  }
}
