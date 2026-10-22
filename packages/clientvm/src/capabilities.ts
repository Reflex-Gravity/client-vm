// SPDX-License-Identifier: Apache-2.0
// The controller's capability table (docs/phase4-plan.md). Every
// cross-instance operation is checked here; kernels never see the table.

import { ClientVMError } from './errors.ts';
import type { Capability, InstanceId, Limits } from './types.ts';

/** Normalizes and validates a capability from untrusted or host input. */
export function parseCapability(input: unknown): Capability {
  const bad = (why: string) =>
    new ClientVMError(`invalid capability: ${why}`, 'ERR_INVALID_CAPABILITY');
  if (typeof input !== 'object' || input === null) throw bad('not an object');
  const c = input as Record<string, unknown>;
  const id = (key: string): InstanceId => {
    const v = c[key];
    if (typeof v !== 'string' || v === '') throw bad(`${key} must be an instance id`);
    return v as InstanceId;
  };
  switch (c['kind']) {
    case 'channel':
      return { kind: 'channel', peer: id('peer') };
    case 'net': {
      const ports = c['ports'];
      if (ports === undefined) return { kind: 'net', peer: id('peer') };
      if (
        !Array.isArray(ports) ||
        !ports.every((p) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535)
      ) {
        throw bad('ports must be port numbers');
      }
      return { kind: 'net', peer: id('peer'), ports: [...new Set(ports as number[])].sort() };
    }
    case 'mount': {
      const path = c['path'];
      if (typeof path !== 'string' || !path.startsWith('/')) throw bad('path must be absolute');
      if (typeof c['readOnly'] !== 'boolean') throw bad('readOnly must be a boolean');
      return { kind: 'mount', from: id('from'), path: normalize(path), readOnly: c['readOnly'] };
    }
    case 'spawn-instance': {
      const limits = c['limits'];
      if (limits === undefined) return { kind: 'spawn-instance' };
      if (typeof limits !== 'object' || limits === null) throw bad('limits must be an object');
      const out: Limits = {};
      for (const key of ['maxProcesses', 'maxMemoryMB', 'quotaBytes', 'maxCpuMs'] as const) {
        const v = (limits as Record<string, unknown>)[key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !(v > 0)) throw bad(`limits.${key} must be positive`);
        out[key] = v;
      }
      return { kind: 'spawn-instance', limits: out };
    }
    default:
      throw bad('unknown kind');
  }
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}

const within = (path: string, root: string) =>
  root === '/' || path === root || path.startsWith(`${root}/`);

/** Whether `a` is at least as strict as `b` (undefined = unlimited). */
function limitsWithin(a: Limits | undefined, b: Limits | undefined): boolean {
  if (!b) return true;
  return (['maxProcesses', 'maxMemoryMB', 'quotaBytes', 'maxCpuMs'] as const).every((k) => {
    const limit = b[k];
    if (limit === undefined) return true;
    const v = a?.[k];
    return v !== undefined && v <= limit;
  });
}

/** Whether holding `held` permits everything `wanted` does. */
export function covers(held: Capability, wanted: Capability): boolean {
  switch (wanted.kind) {
    case 'channel':
      return held.kind === 'channel' && held.peer === wanted.peer;
    case 'net':
      if (held.kind !== 'net' || held.peer !== wanted.peer) return false;
      if (!held.ports) return true;
      return wanted.ports !== undefined && wanted.ports.every((p) => held.ports!.includes(p));
    case 'mount':
      return (
        held.kind === 'mount' &&
        held.from === wanted.from &&
        within(wanted.path, held.path) &&
        (!held.readOnly || wanted.readOnly)
      );
    case 'spawn-instance':
      return held.kind === 'spawn-instance' && limitsWithin(wanted.limits, held.limits);
  }
}

/** The instance a capability is about (its owner may grant it freely), or null. */
export function subjectOf(cap: Capability): InstanceId | null {
  switch (cap.kind) {
    case 'channel':
    case 'net':
      return cap.peer;
    case 'mount':
      return cap.from;
    case 'spawn-instance':
      return null;
  }
}

const same = (a: Capability, b: Capability) => covers(a, b) && covers(b, a);

export class CapabilityTable {
  private readonly held = new Map<InstanceId, Capability[]>();

  list(holder: InstanceId): Capability[] {
    return [...(this.held.get(holder) ?? [])];
  }

  /** Whether `holder` may do what `wanted` describes. */
  has(holder: InstanceId, wanted: Capability): boolean {
    return (this.held.get(holder) ?? []).some((c) => covers(c, wanted));
  }

  /** Whether `granter` may give `cap` to another instance (it owns the resource, or delegates). */
  canGrant(granter: InstanceId, cap: Capability): boolean {
    return subjectOf(cap) === granter || this.has(granter, cap);
  }

  grant(holder: InstanceId, cap: Capability): void {
    const list = this.held.get(holder) ?? [];
    if (!list.some((c) => same(c, cap))) list.push(cap);
    this.held.set(holder, list);
  }

  /** Removes grants equal to `cap`; returns whether any were removed. */
  revoke(holder: InstanceId, cap: Capability): boolean {
    const list = this.held.get(holder);
    if (!list) return false;
    const kept = list.filter((c) => !same(c, cap));
    this.held.set(holder, kept);
    return kept.length !== list.length;
  }

  /** Forgets an instance: what it held, and every grant about it. */
  drop(id: InstanceId): void {
    this.held.delete(id);
    for (const [holder, list] of this.held) {
      this.held.set(
        holder,
        list.filter((c) => subjectOf(c) !== id),
      );
    }
  }
}
