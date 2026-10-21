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

/** Mirrors `Capability` from @clientvm/clientvm. */
export type Capability =
  | { kind: 'mount'; from: string; path: string; readOnly: boolean }
  | { kind: 'channel'; peer: string }
  | { kind: 'net'; peer: string; ports?: number[] }
  | { kind: 'spawn-instance'; limits?: { maxProcesses?: number; quotaBytes?: number } };

export type Outcome = { ok: true; value?: unknown } | { ok: false; code: string; message: string };

interface HostWindow {
  __clientvm: {
    hostCrossOriginIsolated: boolean;
    createInstance(options?: unknown): Promise<string>;
    run(id: string, request: { argv: string[]; syscallMode?: SyscallMode }): Promise<RunResult>;
    exec(
      id: string,
      commandLine: string,
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      },
    ): Promise<{ code: number; signal?: string; stdout: string; stderr: string }>;
    spawnAndCollect(
      id: string,
      cmd: string,
      args: string[],
      killAfterMs?: number,
    ): Promise<{ stdout: string[]; stderr: string; code: number; signal?: string }>;
    startServer(
      id: string,
      cmd: string,
      args: string[],
      opts: { cwd?: string; env?: Record<string, string> },
      port: number,
    ): Promise<{ pid: number; url: string }>;
    output(pid: number): string;
    kill(id: string, pid: number): Promise<void>;
    writeFile(id: string, path: string, data: string): Promise<void>;
    readFile(id: string, path: string): Promise<string>;
    readdir(id: string, path: string): Promise<string[]>;
    snapshot(id: string): Promise<string>;
    fork(id: string, options?: unknown): Promise<string>;
    grant(to: string, cap: Capability): void;
    /** `op` is grant/revoke (to, cap), send (to, message) or fork (options). */
    as(
      id: string,
      op: 'grant' | 'revoke' | 'send' | 'fork' | 'mount' | 'unmount',
      ...args: unknown[]
    ): Promise<Outcome>;
    capabilities(id: string): Capability[];
    recordMail(id: string): void;
    mail(id: string): { from: string; message: unknown }[];
    drive(id: string, port: number, path?: string): Promise<number>;
    previewCall(handle: number, method: string, ...args: unknown[]): Promise<unknown>;
    agent(id: string): number;
    agentCall(
      handle: number,
      tool: string,
      input: unknown,
    ): Promise<{
      content: { type: string; text?: string; source?: { data: string } }[];
      is_error?: boolean;
    }>;
    networkLog(
      id: string,
      since?: number,
    ): Promise<
      {
        seq: number;
        method: string;
        path: string;
        status: number;
        port: number | null;
        from?: string;
      }[]
    >;
    destroy(id: string, purge?: boolean): Promise<void>;
    flush(id: string): Promise<void>;
    serveStatic(id: string, port: number, dir: string): Promise<string>;
    openPreview(url: string): Promise<void>;
    usage(id: string): Promise<{
      processes: number;
      persist: { generation: number; restored: boolean } | null;
    }>;
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
