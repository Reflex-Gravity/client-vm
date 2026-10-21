// SPDX-License-Identifier: Apache-2.0
import { assertModule } from './assert.ts';
import { bufferModule } from './buffer.ts';
import type { createConsole } from './console.ts';
import { eventsModule } from './events.ts';
import type { NodeFs } from './fs.ts';
import { createOs } from './os.ts';
import type { PosixPath } from './path.ts';
import type { NodeProcess } from './process-object.ts';
import { querystringModule } from './querystring.ts';
import { stringDecoderModule } from './string-decoder.ts';
import { urlModule } from './url.ts';
import { utilModule } from './util.ts';

export interface BuiltinDeps {
  fs: NodeFs;
  path: PosixPath;
  process: NodeProcess;
  console: ReturnType<typeof createConsole>;
  timers: Record<string, unknown>;
  env: () => Record<string, string>;
}

/**
 * The builtin module table for one process (`require('fs')`, `node:fs`).
 * Modules not listed here fail with MODULE_NOT_FOUND until implemented; see
 * docs/compatibility.md.
 */
export function createBuiltins(deps: BuiltinDeps): Record<string, unknown> {
  const { fs, path, process } = deps;
  const url = {
    ...urlModule,
    pathToFileURL: (p: string) => urlModule.pathToFileURL(p, (x) => path.resolve(x)),
  };
  const timersPromises = {
    setTimeout: (ms?: number, value?: unknown) =>
      new Promise((r) =>
        (deps.timers['setTimeout'] as (f: () => void, ms?: number) => void)(() => r(value), ms),
      ),
    setImmediate: (value?: unknown) =>
      new Promise((r) => (deps.timers['setImmediate'] as (f: () => void) => void)(() => r(value))),
    scheduler: {
      wait: (ms: number) =>
        new Promise((r) =>
          (deps.timers['setTimeout'] as (f: () => void, ms?: number) => void)(r as () => void, ms),
        ),
      yield: () =>
        new Promise((r) =>
          (deps.timers['setImmediate'] as (f: () => void) => void)(r as () => void),
        ),
    },
  };
  const table: Record<string, unknown> = {
    assert: assertModule,
    'assert/strict': assertModule.strict,
    buffer: bufferModule,
    console: deps.console,
    constants: { ...fs.constants, ...createOs(deps.env).constants.signals },
    events: eventsModule,
    fs,
    os: createOs(deps.env),
    path,
    'path/posix': path,
    process,
    querystring: querystringModule,
    string_decoder: stringDecoderModule,
    timers: deps.timers,
    'timers/promises': timersPromises,
    url,
    util: utilModule,
    'util/types': utilModule['types'],
  };
  return table;
}
