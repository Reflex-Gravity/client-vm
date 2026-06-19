// SPDX-License-Identifier: Apache-2.0
// Client side of syscall-channel.test.ts, run in a Node worker thread (Atomics.wait is
// not allowed where the test server lives). Loaded directly via Node's type stripping.
import { parentPort, workerData } from 'node:worker_threads';
import { SyscallClient, SyscallError } from './syscall-channel.ts';

interface Call {
  op: number;
  request: Uint8Array;
}

const { channel, mode, calls } = workerData as {
  channel: SharedArrayBuffer;
  mode: 'waitAsync' | 'postMessage';
  calls: Call[];
};

const client = new SyscallClient(
  channel,
  mode === 'postMessage' ? { doorbell: () => parentPort!.postMessage({ t: 'doorbell' }) } : {},
);

const results = calls.map(({ op, request }) => {
  try {
    return { ok: true, data: client.call(op, request) };
  } catch (err) {
    if (err instanceof SyscallError) return { ok: false, errno: err.errno };
    throw err;
  }
});
parentPort!.postMessage({ t: 'done', results });
