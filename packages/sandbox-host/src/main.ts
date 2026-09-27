// SPDX-License-Identifier: Apache-2.0
import { RpcEndpoint } from '@clientvm/protocol';
import type { KernelRpc, RunOptions, RunResult } from '@clientvm/kernel';

/** Test/automation surface exposed on `window.__clientvm`. Not a public API. */
export interface SandboxApi {
  crossOriginIsolated: boolean;
  /** Resolves with the kernel boot time in ms once the kernel answers. */
  ready: Promise<number>;
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}

declare global {
  interface Window {
    __clientvm: SandboxApi;
  }
}

const statusEl = document.getElementById('status');
const setStatus = (text: string) => {
  if (statusEl) statusEl.textContent = text;
};

if (!globalThis.crossOriginIsolated) {
  setStatus('error: page is not cross-origin isolated (COOP/COEP headers missing)');
}

const bootStart = performance.now();
const worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), {
  type: 'module',
  name: 'clientvm-kernel',
});
const kernel = new RpcEndpoint<Record<string, never>, KernelRpc>(worker, {});

const ready = kernel.call('ping').then(() => performance.now() - bootStart);

window.__clientvm = {
  crossOriginIsolated: globalThis.crossOriginIsolated,
  ready,
  run: (argv, options) => kernel.call('run', argv, options),
  writeFile: (path, data) => kernel.call('writeFile', path, data),
  readFile: (path) => kernel.call('readFile', path),
  mkdir: (path, recursive) => kernel.call('mkdir', path, recursive),
};

void ready.then((ms) => setStatus(`ready (kernel boot ${ms.toFixed(1)} ms)`));
