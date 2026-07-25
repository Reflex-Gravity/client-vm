// SPDX-License-Identifier: Apache-2.0
import { RpcEndpoint, decodeUtf8, encodeUtf8 } from '@clientvm/protocol';
import type { PortLike, SyscallMode } from '@clientvm/protocol';
import { Kernel } from './kernel.ts';
import type { KernelOptions } from './kernel.ts';

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  syscallMode?: SyscallMode;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Milliseconds from spawn until the process runtime reported ready. */
  spawnToReadyMs: number | null;
  /** Milliseconds from spawn until exit, measured in the kernel. */
  totalMs: number;
}

/** Methods the kernel worker serves to its controller (the sandbox page). */
export type KernelRpc = {
  ping(): 'pong';
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  mkdir(path: string, recursive?: boolean): void;
};

/** Boots a kernel inside a dedicated worker and serves {@link KernelRpc} on `scope`. */
export function startKernelWorker(scope: PortLike, options: KernelOptions): Kernel {
  const kernel = new Kernel(options);

  const methods: KernelRpc = {
    ping: () => 'pong',
    async run(argv, runOptions = {}) {
      const out: Uint8Array[] = [];
      const err: Uint8Array[] = [];
      const proc = kernel.spawn(argv, {
        ...runOptions,
        onStdout: (d) => out.push(d),
        onStderr: (d) => err.push(d),
      });
      const code = await proc.exit;
      const { spawnedAt, readyAt, exitedAt } = proc.timing;
      return {
        code,
        stdout: decodeUtf8(concat(out)),
        stderr: decodeUtf8(concat(err)),
        spawnToReadyMs: readyAt === undefined ? null : readyAt - spawnedAt,
        totalMs: (exitedAt ?? performance.now()) - spawnedAt,
      };
    },
    writeFile(path, data) {
      kernel.vfs.writeFile(path, typeof data === 'string' ? encodeUtf8(data) : data);
    },
    readFile: (path) => kernel.vfs.readFile(path).slice(),
    mkdir(path, recursive = false) {
      kernel.vfs.mkdir(path, { recursive });
    },
  };

  new RpcEndpoint<KernelRpc, Record<string, never>>(scope, methods);
  return kernel;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
