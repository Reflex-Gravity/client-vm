// SPDX-License-Identifier: Apache-2.0
import { startKernelWorker } from '@clientvm/kernel';
import type { ProcessWorkerLike } from '@clientvm/kernel';

startKernelWorker(self, {
  // Must match the runtime table in process.worker.ts.
  commands: ['node', 'clientvm-bench'],
  createProcessWorker: () =>
    new Worker(new URL('./process.worker.ts', import.meta.url), {
      type: 'module',
      name: 'clientvm-process',
    }) as unknown as ProcessWorkerLike,
});
