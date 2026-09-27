// SPDX-License-Identifier: Apache-2.0
import { startKernelWorker } from '@clientvm/kernel';
import type { ProcessWorkerLike } from '@clientvm/kernel';
import type { PortLike } from '@clientvm/protocol';

startKernelWorker(self as unknown as PortLike, {
  createProcessWorker: () =>
    new Worker(new URL('./process.worker.ts', import.meta.url), {
      type: 'module',
      name: 'clientvm-process',
    }) as unknown as ProcessWorkerLike,
});
