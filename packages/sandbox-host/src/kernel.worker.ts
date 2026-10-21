// SPDX-License-Identifier: Apache-2.0
import { startKernelWorker } from '@clientvm/kernel';
import type { ProcessWorkerLike } from '@clientvm/kernel';
import { SHELL_COMMAND_NAMES } from '@clientvm/shell';

startKernelWorker(self, {
  // Must match the runtime table in process.worker.ts.
  commands: ['node', 'clientvm-bench', ...SHELL_COMMAND_NAMES],
  createProcessWorker: () =>
    new Worker(new URL('./process.worker.ts', import.meta.url), {
      type: 'module',
      name: 'clientvm-process',
    }) as unknown as ProcessWorkerLike,
});
