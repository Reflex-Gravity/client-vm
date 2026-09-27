// SPDX-License-Identifier: Apache-2.0
import { nodeRuntime } from '@clientvm/node-compat';
import { benchRuntime, startProcessWorker } from '@clientvm/process';
import type { ProcessScopeLike } from '@clientvm/process';

startProcessWorker(self as unknown as ProcessScopeLike, {
  node: nodeRuntime,
  'clientvm-bench': benchRuntime,
});
