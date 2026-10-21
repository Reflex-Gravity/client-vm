// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CapabilityTable, covers, parseCapability } from './capabilities.ts';
import type { Capability, InstanceId } from './types.ts';

const A = 'a' as InstanceId;
const B = 'b' as InstanceId;
const C = 'c' as InstanceId;

describe('capabilities', () => {
  it('validates and normalizes input', () => {
    expect(parseCapability({ kind: 'net', peer: 'b', ports: [80, 3000, 80] })).toEqual({
      kind: 'net',
      peer: 'b',
      ports: [3000, 80].sort(),
    });
    expect(parseCapability({ kind: 'mount', from: 'b', path: '/x/../y/', readOnly: true })).toEqual(
      {
        kind: 'mount',
        from: 'b',
        path: '/y',
        readOnly: true,
      },
    );
    for (const bad of [
      null,
      { kind: 'nope' },
      { kind: 'channel' },
      { kind: 'net', peer: 'b', ports: [0] },
      { kind: 'mount', from: 'b', path: 'rel', readOnly: true },
      { kind: 'spawn-instance', limits: { maxProcesses: -1 } },
    ]) {
      expect(() => parseCapability(bad)).toThrow(/invalid capability/);
    }
  });

  it('coverage: ports, path prefixes, read-only, limits', () => {
    const net = (ports?: number[]): Capability => ({
      kind: 'net',
      peer: B,
      ...(ports ? { ports } : {}),
    });
    expect(covers(net(), net([1]))).toBe(true);
    expect(covers(net([1, 2]), net([2]))).toBe(true);
    expect(covers(net([1]), net([2]))).toBe(false);
    expect(covers(net([1]), net())).toBe(false);
    const mount = (path: string, readOnly: boolean): Capability => ({
      kind: 'mount',
      from: B,
      path,
      readOnly,
    });
    expect(covers(mount('/src', true), mount('/src/lib', true))).toBe(true);
    expect(covers(mount('/src', true), mount('/srcx', true))).toBe(false);
    expect(covers(mount('/src', true), mount('/src', false))).toBe(false);
    expect(covers(mount('/', false), mount('/a', true))).toBe(true);
    const spawn = (maxProcesses?: number): Capability => ({
      kind: 'spawn-instance',
      ...(maxProcesses ? { limits: { maxProcesses } } : {}),
    });
    expect(covers(spawn(), spawn(5))).toBe(true);
    expect(covers(spawn(5), spawn(3))).toBe(true);
    expect(covers(spawn(5), spawn(8))).toBe(false);
    expect(covers(spawn(5), spawn())).toBe(false);
  });

  it('grants, delegation, revocation and dropping an instance', () => {
    const t = new CapabilityTable();
    const chB: Capability = { kind: 'channel', peer: B };
    expect(t.canGrant(B, chB)).toBe(true); // about itself
    expect(t.canGrant(A, chB)).toBe(false);
    t.grant(A, chB);
    t.grant(A, chB);
    expect(t.list(A)).toEqual([chB]);
    expect(t.canGrant(A, chB)).toBe(true); // delegation
    expect(t.canGrant(A, { kind: 'spawn-instance' })).toBe(false);
    t.grant(C, { kind: 'net', peer: A });
    expect(t.revoke(A, chB)).toBe(true);
    expect(t.has(A, chB)).toBe(false);
    t.grant(A, chB);
    t.drop(B);
    expect(t.list(A)).toEqual([]);
    t.drop(C);
    expect(t.list(C)).toEqual([]);
  });
});
