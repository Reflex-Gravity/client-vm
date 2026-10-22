// SPDX-License-Identifier: Apache-2.0
// Values from an instance are hostile: every guard must either return a
// well-formed value or throw ERR_INSTANCE_PROTOCOL, never anything else.
import { describe, expect, it } from 'vitest';
import { ClientVMError } from './errors.ts';
import * as v from './validate.ts';

let seed = 99;
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const LEAVES: unknown[] = [
  undefined,
  null,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  2 ** 53,
  65536,
  '',
  'GET',
  '/x',
  'file',
  'dir',
  'SIGTERM',
  'rename',
  true,
  new Uint8Array(3),
  Symbol('s'),
  () => 1,
  new Date(0),
];

/** A random value, sometimes shaped like a protocol object with random fields. */
function junk(depth = 0): unknown {
  const r = rand();
  if (depth > 2 || r < 0.4) return pick(LEAVES);
  if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => junk(depth + 1));
  const keys = [
    'code',
    'signal',
    'stdout',
    'stderr',
    'type',
    'size',
    'mode',
    'mtimeMs',
    'ctimeMs',
    'birthtimeMs',
    'name',
    'path',
    'from',
    'to',
    'port',
    'method',
    'headers',
    'body',
    'status',
    'statusText',
    'seq',
    'time',
    'durationMs',
    '__proto__',
    'constructor',
  ];
  const o: Record<string, unknown> = {};
  for (const k of keys) if (rand() < 0.5) o[k] = junk(depth + 1);
  return o;
}

const GUARDS: [string, (x: unknown) => unknown][] = [
  ['bytes', (x) => v.bytes(x, 'bytes')],
  ['int', (x) => v.int(x, 'int')],
  ['runResult', v.runResult],
  ['chunks', v.chunks],
  ['stat', v.stat],
  ['dirEntries', v.dirEntries],
  ['fsEvents', v.fsEvents],
  ['wireRequest', v.wireRequest],
  ['wireResponse', v.wireResponse],
  ['networkLog', v.networkLog],
];

describe('instance value guards', () => {
  it.each(GUARDS)('%s accepts or rejects junk with ERR_INSTANCE_PROTOCOL only', (_name, guard) => {
    for (let i = 0; i < 3000; i++) {
      const value = junk();
      try {
        guard(value);
      } catch (err) {
        expect(err).toBeInstanceOf(ClientVMError);
        expect((err as ClientVMError).code).toBe('ERR_INSTANCE_PROTOCOL');
      }
    }
  });

  it('accepted values have the promised shape', () => {
    expect(v.runResult({ code: 0, signal: null, stdout: 'a', stderr: '' })).toEqual({
      code: 0,
      signal: null,
      stdout: 'a',
      stderr: '',
    });
    expect(() => v.runResult({ code: 0, signal: 'SIGBOGUS', stdout: '', stderr: '' })).toThrow(
      ClientVMError,
    );
    expect(() =>
      v.wireRequest({ port: 70000, method: 'GET', path: '/', headers: [], body: null }),
    ).toThrow(ClientVMError);
    expect(() =>
      v.wireRequest({ port: 80, method: 'GET', path: 'http://x/', headers: [], body: null }),
    ).toThrow(ClientVMError);
    expect(v.dirEntries([{ name: 'a', type: 'file', extra: 1 }])).toEqual([
      { name: 'a', type: 'file' },
    ]);
    expect(v.fsEvents([{ type: 'create', path: '/a' }, { type: 'evil' }])).toBeNull();
  });
});
