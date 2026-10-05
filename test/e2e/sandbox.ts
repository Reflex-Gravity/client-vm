// SPDX-License-Identifier: Apache-2.0
import type { Page } from '@playwright/test';

/** Mirrors `RunResult` from @clientvm/kernel (kept local: e2e tests talk to the page, not the packages). */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnToReadyMs: number | null;
  totalMs: number;
}

interface SandboxWindow {
  __clientvm: {
    crossOriginIsolated: boolean;
    ready: Promise<number>;
    run(
      argv: string[],
      options?: { syscallMode?: 'waitAsync' | 'postMessage' },
    ): Promise<RunResult>;
    writeFile(path: string, data: string): Promise<void>;
  };
}

export async function openSandbox(page: Page): Promise<number> {
  await page.goto('/');
  return page.evaluate(() => (window as unknown as SandboxWindow).__clientvm.ready);
}

export function run(
  page: Page,
  argv: string[],
  syscallMode: 'waitAsync' | 'postMessage' = 'waitAsync',
): Promise<RunResult> {
  return page.evaluate(
    ([argv, syscallMode]) =>
      (window as unknown as SandboxWindow).__clientvm.run(argv, { syscallMode }),
    [argv, syscallMode] as const,
  );
}

export function writeFile(page: Page, path: string, data: string): Promise<void> {
  return page.evaluate(
    ([path, data]) => (window as unknown as SandboxWindow).__clientvm.writeFile(path, data),
    [path, data] as const,
  );
}

export function isCrossOriginIsolated(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as SandboxWindow).__clientvm.crossOriginIsolated);
}
