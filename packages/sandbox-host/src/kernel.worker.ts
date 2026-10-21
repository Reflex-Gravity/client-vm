// SPDX-License-Identifier: Apache-2.0
import { startKernelWorker } from '@clientvm/kernel';
import type { KernelMeasureMemoryMessage, MemoryReply, ProcessWorkerLike } from '@clientvm/kernel';
import { SHELL_COMMAND_NAMES } from '@clientvm/shell';

startKernelWorker(self, {
  // Must match the runtime table in process.worker.ts.
  commands: ['node', 'npm', 'npx', 'clientvm-esbuild', 'clientvm-bench', ...SHELL_COMMAND_NAMES],
  createProcessWorker: () =>
    new Worker(new URL('./process.worker.ts', import.meta.url), {
      type: 'module',
      name: 'clientvm-process',
    }) as unknown as ProcessWorkerLike,
  measureMemory: () =>
    new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (event) => {
        port1.close();
        resolve((event.data as MemoryReply).bytes);
      };
      const msg: KernelMeasureMemoryMessage = { t: 'clientvm:measure-memory', port: port2 };
      self.postMessage(msg, [port2]);
    }),
});
