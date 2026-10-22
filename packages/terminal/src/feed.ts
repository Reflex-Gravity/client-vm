// SPDX-License-Identifier: Apache-2.0
import type {
  Disposable,
  Instance,
  ProcessEvent,
  ProcessInfo,
  ProcessTag,
  Signal,
} from '@clientvm/clientvm';
import { displayCommand } from './command.ts';

/** One command an instance ran, as a UI would list it. */
export interface CommandBlock {
  readonly pid: number;
  /** The command line, e.g. `npm install` (see {@link displayCommand}). */
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly tag?: ProcessTag;
  readonly startedAt: number;
  readonly status: 'running' | 'exited';
  readonly code?: number;
  readonly signal?: Signal;
  readonly exitedAt?: number;
  /**
   * stdout and stderr as they interleaved, ANSI sequences included (pass
   * through {@link stripAnsi} to show plain text). Only the end is kept.
   */
  readonly output: string;
}

export interface ActivityFeedOptions {
  /** Which processes to list, e.g. `(p) => p.tag?.source === 'agent'`. Default: all. */
  filter?: (process: ProcessInfo) => boolean;
  /** Commands kept; the oldest finished ones go first (default 100). */
  maxCommands?: number;
  /** Characters of output kept per command (default 200,000). */
  maxOutputChars?: number;
}

/**
 * The commands an instance runs, as immutable snapshots. `subscribe` and
 * `getSnapshot` fit React's `useSyncExternalStore` and similar stores.
 */
export interface ActivityFeed extends Disposable {
  /** The commands, oldest first. Replaced (never mutated) on every change. */
  getSnapshot(): readonly CommandBlock[];
  subscribe(onChange: () => void): Disposable;
}

export function createActivityFeed(
  instance: Pick<Instance, 'onProcess'>,
  opts: ActivityFeedOptions = {},
): ActivityFeed {
  const maxCommands = opts.maxCommands ?? 100;
  const maxOutputChars = opts.maxOutputChars ?? 200_000;
  let blocks: readonly CommandBlock[] = [];
  const decoders = new Map<number, { 1: TextDecoder; 2: TextDecoder }>();
  const listeners = new Set<() => void>();

  const update = (pid: number, change: (b: CommandBlock) => CommandBlock) => {
    const i = blocks.findLastIndex((b) => b.pid === pid);
    if (i < 0) return;
    const next = blocks.slice();
    next[i] = change(blocks[i]!);
    blocks = next;
    for (const cb of listeners) cb();
  };

  const onEvent = (e: ProcessEvent) => {
    if (e.type === 'spawn') {
      const p = e.process;
      if (opts.filter && !opts.filter(p)) return;
      decoders.set(p.pid, { 1: new TextDecoder(), 2: new TextDecoder() });
      const block: CommandBlock = {
        pid: p.pid,
        command: displayCommand(p.argv),
        argv: p.argv,
        ...(p.cwd === undefined ? {} : { cwd: p.cwd }),
        ...(p.tag === undefined ? {} : { tag: p.tag }),
        startedAt: p.startedAt,
        status: 'running',
        output: '',
      };
      let next = [...blocks, block];
      while (next.length > maxCommands) {
        const i = next.findIndex((b) => b.status === 'exited');
        if (i < 0) break;
        next = next.toSpliced(i, 1);
      }
      blocks = next;
      for (const cb of listeners) cb();
      return;
    }
    const decoder = decoders.get(e.pid);
    if (!decoder) return;
    if (e.type === 'output') {
      const text = decoder[e.fd].decode(e.data, { stream: true });
      if (text)
        update(e.pid, (b) => {
          const output = b.output + text;
          return {
            ...b,
            output: output.length > maxOutputChars ? output.slice(-maxOutputChars) : output,
          };
        });
      return;
    }
    decoders.delete(e.pid);
    update(e.pid, (b) => ({
      ...b,
      output: b.output + decoder[1].decode() + decoder[2].decode(),
      status: 'exited',
      code: e.code,
      ...(e.signal ? { signal: e.signal } : {}),
      exitedAt: e.exitedAt,
    }));
  };

  const sub = instance.onProcess(onEvent);
  return {
    getSnapshot: () => blocks,
    subscribe(onChange) {
      listeners.add(onChange);
      return { dispose: () => void listeners.delete(onChange) };
    },
    dispose() {
      sub.dispose();
      listeners.clear();
    },
  };
}
