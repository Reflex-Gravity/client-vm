// SPDX-License-Identifier: Apache-2.0
// Helpers for driving the sandbox-host test page (packages/sandbox-host/src/host.ts).
// The page runs on http://localhost:<port>; instances on http://<id>.localhost:<port>.
import type { Page } from '@playwright/test';

/** Mirrors `RunResult` from @clientvm/protocol (kept local: e2e tests talk to the page, not the packages). */
export interface RunResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnToReadyMs: number | null;
  totalMs: number;
}

type SyscallMode = 'waitAsync' | 'postMessage';

interface HostWindow {
  __clientvm: {
    hostCrossOriginIsolated: boolean;
    createInstance(options?: unknown): Promise<string>;
    run(id: string, request: { argv: string[]; syscallMode?: SyscallMode }): Promise<RunResult>;
    spawnAndCollect(
      id: string,
      cmd: string,
      args: string[],
      killAfterMs?: number,
    ): Promise<{ stdout: string[]; stderr: string; code: number; signal?: string }>;
    writeFile(id: string, path: string, data: string): Promise<void>;
    readFile(id: string, path: string): Promise<string>;
    readdir(id: string, path: string): Promise<string[]>;
    snapshot(id: string): Promise<string>;
    fork(id: string): Promise<string>;
    destroy(id: string): Promise<void>;
    list(): string[];
  };
}

export type HostApi = HostWindow['__clientvm'];

const defaultInstance = new WeakMap<Page, string>();

/** Opens the host page; `coi` serves it with COOP/COEP to test the fallback mode. */
export async function openHost(page: Page, options: { coi?: boolean } = {}): Promise<void> {
  await page.goto(options.coi ? '/?coi=1' : '/');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
}

export function hostIsolated(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as HostWindow).__clientvm.hostCrossOriginIsolated);
}

/** Calls a host API method in the page. */
export function host<K extends Exclude<keyof HostApi, 'hostCrossOriginIsolated'>>(
  page: Page,
  method: K,
  ...args: Parameters<HostApi[K]>
): Promise<Awaited<ReturnType<HostApi[K]>>> {
  return page.evaluate(
    ([method, args]) => {
      const api = (window as unknown as HostWindow).__clientvm;
      return (api[method] as (...a: unknown[]) => unknown)(...args);
    },
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<HostApi[K]>>>;
}

/** Opens the host page and boots a default instance. Returns the boot time in ms. */
export async function openSandbox(page: Page): Promise<number> {
  await openHost(page);
  const started = Date.now();
  const id = await host(page, 'createInstance');
  defaultInstance.set(page, id);
  return Date.now() - started;
}

export function defaultInstanceId(page: Page): string {
  const id = defaultInstance.get(page);
  if (!id) throw new Error('call openSandbox(page) first');
  return id;
}

export function run(
  page: Page,
  argv: string[],
  syscallMode: SyscallMode = 'waitAsync',
): Promise<RunResult> {
  return host(page, 'run', defaultInstanceId(page), { argv, syscallMode });
}

export function writeFile(page: Page, path: string, data: string): Promise<void> {
  return host(page, 'writeFile', defaultInstanceId(page), path, data);
}
