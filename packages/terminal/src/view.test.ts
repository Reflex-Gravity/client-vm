// SPDX-License-Identifier: Apache-2.0
import type { Disposable, ProcessEvent } from '@clientvm/clientvm';
import { describe, expect, it } from 'vitest';
import { createActivityFeed } from './feed.ts';
import { attachActivityView, formatDuration } from './view.ts';

/** An `onProcess` source that replays what was emitted before a listener attached. */
function fakeInstance() {
  const history: ProcessEvent[] = [];
  const listeners = new Set<(e: ProcessEvent) => void>();
  const bytes = (s: string) => new TextEncoder().encode(s);
  const emit = (e: ProcessEvent) => {
    history.push(e);
    for (const cb of listeners) cb(e);
  };
  return {
    onProcess(cb: (e: ProcessEvent) => void): Disposable {
      for (const e of history) cb(e);
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
    listeners,
    spawn: (pid: number, argv: string[], tag?: Record<string, string>) =>
      emit({ type: 'spawn', process: { pid, argv, ...(tag ? { tag } : {}), startedAt: 1000 } }),
    out: (pid: number, s: string | Uint8Array, fd: 1 | 2 = 1) =>
      emit({ type: 'output', pid, fd, data: typeof s === 'string' ? bytes(s) : s }),
    exit: (pid: number, code: number, exitedAt = 2500, signal?: 'SIGTERM') =>
      emit({ type: 'exit', pid, code, exitedAt, ...(signal ? { signal } : {}) }),
  };
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('attachActivityView', () => {
  it('writes each command, its output with CRLF line ends, and its status', () => {
    const vm = fakeInstance();
    let screen = '';
    attachActivityView({ write: (d) => void (screen += d) }, vm);
    vm.spawn(1, ['sh', '-c', 'npm install']);
    vm.out(1, 'added 1 package\n');
    vm.out(1, 'warn\r\n', 2);
    vm.exit(1, 0);
    vm.spawn(2, ['sh', '-c', 'false']);
    vm.exit(2, 1, 1200);
    expect(plain(screen)).toBe(
      '$ npm install\r\nadded 1 package\r\nwarn\r\n✔ 1.5 s\r\n$ false\r\n✖ exit 1 200 ms\r\n',
    );
  });

  it('labels output when it switches between running processes', () => {
    const vm = fakeInstance();
    let screen = '';
    attachActivityView({ write: (d) => void (screen += d) }, vm);
    vm.spawn(1, ['sh', '-c', 'npm run dev']);
    vm.out(1, 'ready');
    vm.spawn(2, ['ls']);
    vm.out(2, 'a.txt\n');
    vm.exit(2, 0);
    vm.out(1, 'hmr update\n');
    vm.exit(1, 143, 61_000, 'SIGTERM');
    expect(plain(screen)).toBe(
      [
        '$ npm run dev',
        'ready',
        '$ ls',
        'a.txt',
        '✔ 1.5 s',
        '[npm run dev]',
        'hmr update',
        '✖ SIGTERM 1m 00s',
        '',
      ].join('\r\n'),
    );
  });

  it('replays history, filters, sanitizes, and decodes UTF-8 split across chunks', () => {
    const vm = fakeInstance();
    vm.spawn(1, ['sh', '-c', 'echo é'], { source: 'agent' });
    const e = new TextEncoder().encode('é\x1b]52;c;AA\x07\n');
    vm.out(1, e.slice(0, 1));
    vm.spawn(2, ['sh', '-c', 'user thing'], { source: 'user' });
    let screen = '';
    const sub = attachActivityView({ write: (d) => void (screen += d) }, vm, {
      filter: (p) => p.tag?.['source'] === 'agent',
      label: (p) => (p.tag?.['source'] === 'agent' ? '[agent] ' : undefined),
    });
    vm.out(1, e.slice(1));
    vm.out(2, 'hidden\n');
    vm.exit(1, 0);
    expect(plain(screen)).toBe('[agent] $ echo é\r\né\r\n✔ 1.5 s\r\n');
    sub.dispose();
    expect(vm.listeners.size).toBe(0);
  });

  it('draws control characters in commands harmlessly', () => {
    const vm = fakeInstance();
    let screen = '';
    attachActivityView({ write: (d) => void (screen += d) }, vm);
    vm.spawn(1, ['sh', '-c', 'cat <<EOF\n\x1b]52;c;AA\x07hi\nEOF']);
    expect(plain(screen)).toBe('$ cat <<EOF\r\n> ]52;c;AAhi\r\n> EOF\r\n');
  });
});

describe('createActivityFeed', () => {
  it('keeps immutable command snapshots and notifies subscribers', () => {
    const vm = fakeInstance();
    vm.spawn(1, ['sh', '-c', 'npm test'], { source: 'agent' });
    const feed = createActivityFeed(vm);
    let changes = 0;
    feed.subscribe(() => changes++);
    const before = feed.getSnapshot();
    vm.out(1, 'ok\n');
    vm.exit(1, 0);
    expect(before[0]).toMatchObject({ status: 'running', output: '' });
    expect(feed.getSnapshot()).toEqual([
      {
        pid: 1,
        command: 'npm test',
        argv: ['sh', '-c', 'npm test'],
        tag: { source: 'agent' },
        startedAt: 1000,
        status: 'exited',
        code: 0,
        exitedAt: 2500,
        output: 'ok\n',
      },
    ]);
    expect(changes).toBe(2);
    feed.dispose();
    expect(vm.listeners.size).toBe(0);
  });

  it('bounds commands and output, dropping finished commands first', () => {
    const vm = fakeInstance();
    const feed = createActivityFeed(vm, { maxCommands: 2, maxOutputChars: 5 });
    vm.spawn(1, ['server']);
    vm.spawn(2, ['a']);
    vm.exit(2, 0);
    vm.spawn(3, ['b']);
    vm.out(3, '123456789');
    expect(feed.getSnapshot().map((b) => [b.pid, b.output])).toEqual([
      [1, ''],
      [3, '56789'],
    ]);
  });
});

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect([999, 1000, 59_949, 60_000, 3_725_000].map(formatDuration)).toEqual([
      '999 ms',
      '1.0 s',
      '59.9 s',
      '1m 00s',
      '62m 05s',
    ]);
  });
});
