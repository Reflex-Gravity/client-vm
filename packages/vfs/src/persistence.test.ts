// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { MemoryVfs } from './memory-vfs.ts';
import { MemoryBackend, Persister, loadPersisted, purgePersisted } from './persistence.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function reload(backend: MemoryBackend): Promise<MemoryVfs> {
  const loaded = await loadPersisted(backend);
  if (!loaded) throw new Error('nothing persisted');
  return MemoryVfs.fromSnapshot(loaded.snapshot);
}

async function persisted(backend = new MemoryBackend()) {
  const vfs = new MemoryVfs();
  const persister = await Persister.attach(vfs, backend, 0, { debounceMs: 10 });
  return { vfs, persister, backend };
}

describe('Persister', () => {
  it('round-trips a tree through checkpoints', async () => {
    const { vfs, persister, backend } = await persisted();
    vfs.mkdir('/app/src', { recursive: true });
    vfs.writeFile('/app/src/index.js', bytes('console.log(1)'));
    vfs.symlink('/app/src', '/app/link');
    vfs.link('/app/src/index.js', '/app/hard.js');
    vfs.chmod('/app/src/index.js', 0o755);
    await persister.flush();

    const restored = await reload(backend);
    expect(restored.readdir('/app')).toEqual(['hard.js', 'link', 'src']);
    expect(text(restored.readFile('/app/link/index.js'))).toBe('console.log(1)');
    expect(restored.stat('/app/hard.js').nlink).toBe(2);
    expect(restored.stat('/app/src/index.js').mode & 0o777).toBe(0o755);
    // The restored tree is writable and keeps persisting.
    const again = await Persister.attach(restored, backend, persister.stats.generation, {
      debounceMs: 10,
    });
    restored.writeFile('/app/new.txt', bytes('later'));
    await again.flush();
    expect(text((await reload(backend)).readFile('/app/new.txt'))).toBe('later');
  });

  it('flushes automatically after the debounce delay', async () => {
    const { vfs, persister, backend } = await persisted();
    const before = persister.stats.flushes;
    for (let i = 0; i < 50; i++) vfs.writeFile(`/f${i}`, bytes(String(i)));
    await new Promise((r) => setTimeout(r, 60));
    expect(persister.stats.flushes).toBe(before + 1);
    expect(text((await reload(backend)).readFile('/f49'))).toBe('49');
  });

  it('writes only new blobs and deduplicates identical contents', async () => {
    const { vfs, persister } = await persisted();
    vfs.writeFile('/a', bytes('same'));
    vfs.writeFile('/b', bytes('same'));
    vfs.writeFile('/big', new Uint8Array(100_000));
    await persister.flush();
    const afterFirst = persister.stats.blobsWritten;
    expect(afterFirst).toBe(2); // 'same' once, plus the zeros

    vfs.writeFile('/c', bytes('new'));
    await persister.flush();
    expect(persister.stats.blobsWritten).toBe(afterFirst + 1);
  });

  it('garbage-collects blobs and old checkpoints', async () => {
    const { vfs, persister, backend } = await persisted();
    vfs.writeFile('/tmp1', bytes('temporary'));
    await persister.flush();
    vfs.unlink('/tmp1');
    await persister.flush();
    expect(await backend.listBlobs()).toEqual([]);
    expect([...backend.files.keys()].filter((n) => n.startsWith('checkpoint-'))).toHaveLength(1);
    expect(persister.stats.blobsDeleted).toBe(1);
  });

  it('survives a crash at any point of a flush', async () => {
    // Find how many backend writes a flush performs, then crash at each one.
    const probe = await persisted();
    probe.vfs.writeFile('/v', bytes('v1'));
    await probe.persister.flush();
    const writesBefore = probe.backend.writes;
    probe.vfs.writeFile('/v', bytes('v2'));
    probe.vfs.writeFile('/w', bytes('w2'));
    await probe.persister.flush();
    const writesPerFlush = probe.backend.writes - writesBefore;

    for (let crashAt = 0; crashAt < writesPerFlush; crashAt++) {
      const { vfs, persister, backend } = await persisted();
      vfs.writeFile('/v', bytes('v1'));
      await persister.flush();
      vfs.writeFile('/v', bytes('v2'));
      vfs.writeFile('/w', bytes('w2'));
      backend.failOnWrite = backend.writes + crashAt;
      await expect(persister.flush()).rejects.toThrow(/simulated crash/);
      // Whatever survived must be a complete, consistent generation: old or new, never mixed.
      const restored = await reload(backend);
      const v = text(restored.readFile('/v'));
      if (v === 'v1') expect(() => restored.stat('/w')).toThrow(/ENOENT/);
      else expect(text(restored.readFile('/w'))).toBe('w2');
    }
  });

  it('retries after a failed flush', async () => {
    const { vfs, persister, backend } = await persisted();
    vfs.writeFile('/x', bytes('1'));
    backend.failOnWrite = backend.writes;
    await expect(persister.flush()).rejects.toThrow();
    await persister.flush();
    expect(text((await reload(backend)).readFile('/x'))).toBe('1');
  });

  it('rejects corrupt stores instead of loading partial state', async () => {
    const { vfs, persister, backend } = await persisted();
    vfs.writeFile('/x', bytes('data'));
    await persister.flush();
    const [blob] = await backend.listBlobs();
    backend.files.delete(`blobs/${blob}`);
    await expect(loadPersisted(backend)).rejects.toThrow(/missing blob/);
    backend.files.set('HEAD', bytes('garbage'));
    await expect(loadPersisted(backend)).rejects.toThrow(/corrupt HEAD/);
  });

  it('purge removes everything', async () => {
    const { vfs, persister, backend } = await persisted();
    vfs.writeFile('/x', bytes('data'));
    await persister.flush();
    await purgePersisted(backend);
    expect(backend.files.size).toBe(0);
    expect(await loadPersisted(backend)).toBeNull();
  });
});
