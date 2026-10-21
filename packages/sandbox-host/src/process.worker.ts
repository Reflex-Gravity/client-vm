// SPDX-License-Identifier: Apache-2.0
import { esbuildRuntime, nodeRuntime, npmRuntime, pnpmRuntime } from '@clientvm/node-compat';
import { benchRuntime, startProcessWorker } from '@clientvm/process';
import type { ProcessScopeLike } from '@clientvm/process';
import { shellRuntimes } from '@clientvm/shell';

startProcessWorker(self as unknown as ProcessScopeLike, {
  ...shellRuntimes(),
  node: nodeRuntime,
  npm: npmRuntime('npm'),
  npx: npmRuntime('npx'),
  pnpm: pnpmRuntime('pnpm'),
  pnpx: pnpmRuntime('pnpx'),
  'clientvm-esbuild': esbuildRuntime,
  'clientvm-bench': benchRuntime,
});
