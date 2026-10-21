// SPDX-License-Identifier: Apache-2.0
import { nodeRuntime, npmRuntime } from '@clientvm/node-compat';
import { benchRuntime, startProcessWorker } from '@clientvm/process';
import type { ProcessScopeLike } from '@clientvm/process';
import { shellRuntimes } from '@clientvm/shell';

startProcessWorker(self as unknown as ProcessScopeLike, {
  ...shellRuntimes(),
  node: nodeRuntime,
  npm: npmRuntime('npm'),
  npx: npmRuntime('npx'),
  'clientvm-bench': benchRuntime,
});
