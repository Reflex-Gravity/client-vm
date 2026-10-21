// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { exportImage, importImage } from './image.ts';
import { O_RDWR } from './inode.ts';
import { MemoryVfs } from './memory-vfs.ts';
import type { FsEvent } from './watch.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

function populate(vfs: MemoryVfs): void {
  vfs.mkdir('/src/lib', { recursive: true });
  vfs.writeFile('/src/index.js', bytes('main'));
  vfs.writeFile('/src/lib/util.js', bytes('util'));
  vfs.symlink('/src/lib', '/lib');
  vfs.link('/src/index.js', '/hard.js');
}

describe('copy-on-write snapshots', () => {
  it('keeps the snapshot intact while the live tree changes', () => {
    const vfs = new MemoryVfs();
    populate(vfs);
    const snap = vfs.snapshot();

    vfs.writeFile('/src/index.js', bytes('changed'));
    vfs.unlink('/src/lib/util.js');
    vfs.mkdir('/new');
    vfs.rename('/src', '/moved');
    const ino = vfs.open('/hard.js', O_RDWR);
    vfs.writeAt(ino, bytes('X'), 0);
    vfs.release(ino);

    const fork = MemoryVfs.fromSnapshot(snap);
    expect(fork.readdir('/')).toEqual(['hard.js', 'lib', 'src']);
    expect(text(fork.readFile('/src/index.js'))).toBe('main');
    expect(text(fork.readFile('/lib/util.js'))).toBe('util');
    expect(fork.stat('/hard.js').nlink).toBe(2);

    expect(vfs.readdir('/')).toEqual(['hard.js', 'lib', 'moved', 'new']);
    expect(text(vfs.readFile('/hard.js'))).toBe('Xhanged');
  });

  it('forks diverge independently in both directions', () => {
    const vfs = new MemoryVfs();
    populate(vfs);
    const fork = MemoryVfs.fromSnapshot(vfs.snapshot());
    fork.writeFile('/src/index.js', bytes('fork'));
    vfs.writeFile('/src/index.js', bytes('origin'));
    fork.mkdir('/only-in-fork');
    expect(text(fork.readFile('/src/index.js'))).toBe('fork');
    expect(text(vfs.readFile('/src/index.js'))).toBe('origin');
    expect(codeOf(() => vfs.stat('/only-in-fork'))).toBe('ENOENT');
  });

  it('shares unchanged file data by identity', () => {
    const vfs = new MemoryVfs();
    vfs.writeFile('/big', new Uint8Array(1 << 20));
    const fork = MemoryVfs.fromSnapshot(vfs.snapshot());
    expect(fork.readFile('/big').buffer).toBe(vfs.readFile('/big').buffer);
  });

  it('copies shared data before an in-place write', () => {
    const vfs = new MemoryVfs();
    vfs.writeFile('/f', bytes('aaaa'));
    const fork = MemoryVfs.fromSnapshot(vfs.snapshot());
    const ino = fork.open('/f', O_RDWR);
    fork.writeAt(ino, bytes('b'), 1);
    fork.release(ino);
    expect(text(fork.readFile('/f'))).toBe('abaa');
    expect(text(vfs.readFile('/f'))).toBe('aaaa');
  });

  it('snapshot cost does not depend on file sizes', () => {
    const vfs = new MemoryVfs();
    for (let i = 0; i < 2000; i++) vfs.writeFile(`/f${i}`, new Uint8Array(4096));
    const t = performance.now();
    for (let i = 0; i < 10; i++) vfs.snapshot();
    expect((performance.now() - t) / 10).toBeLessThan(20);
  });
});

describe('images', () => {
  it('round-trips a tree including symlinks, hard links and modes', () => {
    const vfs = new MemoryVfs();
    populate(vfs);
    vfs.chmod('/src/index.js', 0o755);
    const restored = MemoryVfs.fromSnapshot(importImage(exportImage(vfs.snapshot())));
    expect(restored.readdir('/')).toEqual(['hard.js', 'lib', 'src']);
    expect(text(restored.readFile('/lib/util.js'))).toBe('util');
    expect(restored.readlink('/lib')).toBe('/src/lib');
    expect(restored.stat('/hard.js').ino).toBe(restored.stat('/src/index.js').ino);
    expect(restored.stat('/src/index.js').mode & 0o777).toBe(0o755);
    expect(restored.realpath('/lib/../index.js')).toBe('/src/index.js');
    // The restored tree is fully writable.
    restored.writeFile('/src/index.js', bytes('new'));
    expect(text(restored.readFile('/hard.js'))).toBe('new');
  });

  it('stores data shared by hard links once', () => {
    const vfs = new MemoryVfs();
    vfs.writeFile('/a', new Uint8Array(1000));
    vfs.link('/a', '/b');
    const chunks = exportImage(vfs.snapshot());
    expect(chunks.length).toBe(2); // metadata + one blob
  });

  it('rejects malformed images', () => {
    const good = exportImage(new MemoryVfs().snapshot());
    expect(() => importImage([])).toThrow(/missing metadata/);
    expect(() => importImage([new Uint8Array([9])])).toThrow();
    expect(() => importImage([good[0]!, new Uint8Array(1)])).toThrow(/malformed/);
  });
});

describe('quotas', () => {
  it('enforces quotaBytes and maxInodes with ENOSPC', () => {
    const vfs = new MemoryVfs({ quotaBytes: 4096 });
    vfs.writeFile('/a', new Uint8Array(1000));
    expect(codeOf(() => vfs.writeFile('/b', new Uint8Array(4000)))).toBe('ENOSPC');
    const ino = vfs.open('/a', O_RDWR);
    expect(codeOf(() => vfs.writeAt(ino, new Uint8Array(4000), 1000))).toBe('ENOSPC');
    vfs.release(ino);
    vfs.unlink('/a');
    vfs.writeFile('/b', new Uint8Array(3000));

    const limited = new MemoryVfs({ maxInodes: 3 });
    limited.mkdir('/d');
    limited.writeFile('/d/f', new Uint8Array(0));
    expect(codeOf(() => limited.writeFile('/g', new Uint8Array(0)))).toBe('ENOSPC');
  });

  it('frees unlinked files only after the last descriptor closes', () => {
    const vfs = new MemoryVfs();
    vfs.writeFile('/tmpfile', bytes('still here'));
    const before = vfs.used.inodes;
    const ino = vfs.open('/tmpfile', O_RDWR);
    vfs.unlink('/tmpfile');
    expect(text(vfs.readAt(ino, 100, 0))).toBe('still here');
    expect(vfs.used.inodes).toBe(before);
    vfs.release(ino);
    expect(vfs.used.inodes).toBe(before - 1);
  });
});

describe('watchers', () => {
  const collect = (vfs: MemoryVfs, path: string, recursive: boolean) => {
    const events: FsEvent[] = [];
    const stop = vfs.watch(path, { recursive }, (batch) => events.push(...batch));
    return { events, stop };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('reports direct children, or the whole subtree when recursive', async () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/w/sub', { recursive: true });
    const shallow = collect(vfs, '/w', false);
    const deep = collect(vfs, '/w', true);
    vfs.writeFile('/w/a', bytes('1'));
    vfs.writeFile('/w/sub/b', bytes('2'));
    vfs.writeFile('/outside', bytes('3'));
    await tick();
    expect(shallow.events).toEqual([{ type: 'create', path: '/w/a' }]);
    expect(deep.events).toEqual([
      { type: 'create', path: '/w/a' },
      { type: 'create', path: '/w/sub/b' },
    ]);
  });

  it('coalesces repeated modifications and reports renames and deletes', async () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/w');
    vfs.writeFile('/w/f', bytes(''));
    const { events, stop } = collect(vfs, '/w', true);
    const ino = vfs.open('/w/f', O_RDWR);
    for (let i = 0; i < 10; i++) vfs.writeAt(ino, bytes('x'), i);
    vfs.release(ino);
    vfs.rename('/w/f', '/w/g');
    vfs.unlink('/w/g');
    await tick();
    expect(events).toEqual([
      { type: 'modify', path: '/w/f' },
      { type: 'rename', from: '/w/f', to: '/w/g' },
      { type: 'delete', path: '/w/g' },
    ]);
    stop();
    vfs.writeFile('/w/h', bytes(''));
    await tick();
    expect(events).toHaveLength(3);
  });

  it('resolves the watched path through symlinks', async () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/real');
    vfs.symlink('/real', '/alias');
    const { events } = collect(vfs, '/alias', false);
    vfs.writeFile('/alias/x', bytes(''));
    await tick();
    expect(events).toEqual([{ type: 'create', path: '/real/x' }]);
  });
});
