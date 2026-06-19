// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { Errno, SystemError } from './errors.ts';
import { SyscallServer, createChannelBuffer } from './syscall-channel.ts';
import type { SyscallHandler } from './syscall-channel.ts';

const ECHO = 1;
const FAIL = 2;
const BIG = 3;
const ASYNC_ECHO = 4;

const handler: SyscallHandler = (op, request) => {
  switch (op) {
    case ECHO:
      return request.slice().reverse();
    case FAIL:
      throw new SystemError('ENOENT', 'open', '/x');
    case BIG: {
      const size = new DataView(request.buffer, request.byteOffset).getUint32(0, true);
      return pattern(size);
    }
    case ASYNC_ECHO:
      return new Promise((resolve) => setTimeout(() => resolve(request.slice()), 1));
    default:
      throw new Error('unexpected op');
  }
};

function pattern(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 13 + 5) & 0xff;
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

type Result = { ok: true; data: Uint8Array } | { ok: false; errno: number };

async function runClient(
  mode: 'waitAsync' | 'postMessage',
  calls: { op: number; request: Uint8Array }[],
  payloadBytes = 1024,
): Promise<Result[]> {
  const channel = createChannelBuffer(payloadBytes);
  const server = new SyscallServer(channel, handler);
  if (mode === 'waitAsync') void server.listen();
  const worker = new Worker(new URL('./syscall-channel.fixture.ts', import.meta.url), {
    workerData: { channel, mode, calls },
  });
  try {
    return await new Promise<Result[]>((resolve, reject) => {
      worker.on('message', (msg: { t: string; results?: Result[] }) => {
        if (msg.t === 'doorbell') void server.service();
        else if (msg.t === 'done') resolve(msg.results!);
      });
      worker.on('error', reject);
    });
  } finally {
    server.close();
    await worker.terminate();
  }
}

for (const mode of ['waitAsync', 'postMessage'] as const) {
  describe(`SyscallClient <-> SyscallServer (${mode})`, () => {
    it('round-trips small requests, including empty ones', async () => {
      const results = await runClient(mode, [
        { op: ECHO, request: new Uint8Array([1, 2, 3]) },
        { op: ECHO, request: new Uint8Array(0) },
      ]);
      expect(results).toEqual([
        { ok: true, data: new Uint8Array([3, 2, 1]) },
        { ok: true, data: new Uint8Array(0) },
      ]);
    });

    it('reports handler errors as errno', async () => {
      const results = await runClient(mode, [{ op: FAIL, request: new Uint8Array(0) }]);
      expect(results).toEqual([{ ok: false, errno: Errno.ENOENT }]);
    });

    it('streams requests and responses larger than the payload region', async () => {
      const big = pattern(10_000);
      const results = await runClient(
        mode,
        [
          { op: ECHO, request: big },
          { op: BIG, request: u32(5_000) },
          { op: BIG, request: u32(1024) }, // exactly one full chunk
          { op: ECHO, request: new Uint8Array([9]) }, // channel is clean after streaming
        ],
        1024,
      );
      expect(results[0]).toEqual({ ok: true, data: big.slice().reverse() });
      expect(results[1]).toEqual({ ok: true, data: pattern(5_000) });
      expect(results[2]).toEqual({ ok: true, data: pattern(1024) });
      expect(results[3]).toEqual({ ok: true, data: new Uint8Array([9]) });
    });

    it('supports async handlers', async () => {
      const results = await runClient(mode, [{ op: ASYNC_ECHO, request: new Uint8Array([4, 5]) }]);
      expect(results).toEqual([{ ok: true, data: new Uint8Array([4, 5]) }]);
    });
  });
}
