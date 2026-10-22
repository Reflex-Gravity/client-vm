// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ProcessLog } from './process-log.ts';
import type { ProcessEvent } from './types.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (events: ProcessEvent[]) =>
  events.map((e) => (e.type === 'output' ? new TextDecoder().decode(e.data) : `<${e.type}>`));

describe('ProcessLog', () => {
  it('reports spawn, output and exit to listeners', () => {
    const log = new ProcessLog();
    const seen: ProcessEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.spawn({ pid: 7, argv: ['sh', '-c', 'echo hi'], tag: { source: 'agent' }, startedAt: 1 });
    log.output(7, 1, bytes('hi\n'));
    log.exit(7, 0, null);
    expect(seen[0]).toEqual({
      type: 'spawn',
      process: { pid: 7, argv: ['sh', '-c', 'echo hi'], tag: { source: 'agent' }, startedAt: 1 },
    });
    expect(text(seen)).toEqual(['<spawn>', 'hi\n', '<exit>']);
    expect(seen[2]).toMatchObject({ type: 'exit', pid: 7, code: 0 });
    expect(seen[2]).not.toHaveProperty('signal');
  });

  it('replays history to late listeners, then streams', () => {
    const log = new ProcessLog();
    log.spawn({ pid: 1, argv: ['a'], startedAt: 0 });
    log.output(1, 2, bytes('err'));
    log.exit(1, 1, 'SIGTERM');
    log.spawn({ pid: 2, argv: ['b'], startedAt: 0 });
    const seen: ProcessEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.output(2, 1, bytes('live'));
    expect(text(seen)).toEqual(['<spawn>', 'err', '<exit>', '<spawn>', 'live']);
    expect(seen[2]).toMatchObject({ code: 1, signal: 'SIGTERM' });
  });

  it('keeps the most recent output per process and says how much it dropped', () => {
    const log = new ProcessLog({ maxBytesPerProcess: 10 });
    log.spawn({ pid: 1, argv: ['a'], startedAt: 0 });
    for (const s of ['aaaa', 'bbbb', 'cccc', 'dddd']) log.output(1, 1, bytes(s));
    const seen: ProcessEvent[] = [];
    log.subscribe((e) => seen.push(e));
    expect(text(seen)).toEqual([
      '<spawn>',
      '[clientvm: 8 earlier bytes not kept]\n',
      'cccc',
      'dddd',
    ]);
  });

  it('forgets the oldest exited processes, never running ones', () => {
    const log = new ProcessLog({ maxProcesses: 2 });
    log.spawn({ pid: 1, argv: ['running'], startedAt: 0 });
    log.spawn({ pid: 2, argv: ['done'], startedAt: 0 });
    log.exit(2, 0, null);
    log.spawn({ pid: 3, argv: ['new'], startedAt: 0 });
    const pids: number[] = [];
    log.subscribe((e) => e.type === 'spawn' && pids.push(e.process.pid));
    expect(pids).toEqual([1, 3]);
  });

  it('ignores events for unknown or exited processes', () => {
    const log = new ProcessLog();
    const seen: ProcessEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.output(9, 1, bytes('x'));
    log.spawn({ pid: 1, argv: ['a'], startedAt: 0 });
    log.exit(1, 0, null);
    log.output(1, 1, bytes('late'));
    log.exit(1, 1, null);
    expect(text(seen)).toEqual(['<spawn>', '<exit>']);
  });

  it('keeps delivering when a listener throws, and stops after dispose', () => {
    const log = new ProcessLog();
    const seen: string[] = [];
    const rethrow = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {});
    log.subscribe(() => {
      throw new Error('bad listener');
    });
    const sub = log.subscribe((e) => seen.push(e.type));
    log.spawn({ pid: 1, argv: ['a'], startedAt: 0 });
    sub.dispose();
    log.exit(1, 0, null);
    expect(seen).toEqual(['spawn']);
    // Each throw is rethrown asynchronously (reported, not swallowed).
    expect(rethrow).toHaveBeenCalledTimes(2);
    rethrow.mockRestore();
  });
});
