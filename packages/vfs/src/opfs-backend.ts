// SPDX-License-Identifier: Apache-2.0
import type { PersistenceBackend } from './persistence.ts';

/** Directory iteration is missing from some TypeScript DOM lib versions. */
interface IterableDirectory {
  keys(): AsyncIterable<string>;
}

/**
 * {@link PersistenceBackend} on the Origin Private File System, using the async
 * API (works in the kernel worker without sync access handles). Writes go
 * through `createWritable()`, which commits atomically on close.
 *
 * The store lives under `clientvm/v1/` in the instance origin's OPFS.
 * Processes in the same instance can see and modify it; that only affects
 * their own instance, and loading validates everything it reads.
 */
export class OpfsBackend implements PersistenceBackend {
  private readonly root: FileSystemDirectoryHandle;
  private readonly blobs: FileSystemDirectoryHandle;

  private constructor(root: FileSystemDirectoryHandle, blobs: FileSystemDirectoryHandle) {
    this.root = root;
    this.blobs = blobs;
  }

  static async open(path: readonly string[] = ['clientvm', 'v1']): Promise<OpfsBackend> {
    let dir = await navigator.storage.getDirectory();
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
    const blobs = await dir.getDirectoryHandle('blobs', { create: true });
    return new OpfsBackend(dir, blobs);
  }

  private locate(name: string): { dir: FileSystemDirectoryHandle; file: string } {
    if (name.startsWith('blobs/')) return { dir: this.blobs, file: name.slice(6) };
    return { dir: this.root, file: name };
  }

  async read(name: string): Promise<Uint8Array | null> {
    const { dir, file } = this.locate(name);
    try {
      const handle = await dir.getFileHandle(file);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    const { dir, file } = this.locate(name);
    const handle = await dir.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    const { dir, file } = this.locate(name);
    try {
      await dir.removeEntry(file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async listBlobs(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of (this.blobs as unknown as IterableDirectory).keys()) names.push(name);
    return names;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError';
}

/**
 * Takes the exclusive lock for this origin's persisted store, so two tabs never
 * flush (and garbage-collect) the same store concurrently. Resolves with a
 * release function, or null if another context holds it.
 */
export function acquireStoreLock(name = 'clientvm-store'): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      // Hold the lock until released; the worker's death releases it too.
      return new Promise<void>((release) => resolve(release));
    });
  });
}
