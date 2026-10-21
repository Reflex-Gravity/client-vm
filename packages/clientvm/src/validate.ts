// SPDX-License-Identifier: Apache-2.0
// Guards for values received from an instance. The instance origin runs
// hostile code, so nothing it sends is trusted, even replies to our requests.
import type {
  FileKind,
  RunResult,
  Signal,
  WireDirEntry,
  WireFsEvent,
  WireStat,
} from '@clientvm/protocol';
import { ClientVMError } from './errors.ts';

const KINDS = new Set<unknown>(['file', 'dir', 'symlink']);

function bad(what: string): never {
  throw new ClientVMError(`instance sent a malformed ${what}`, 'ERR_INSTANCE_PROTOCOL');
}

export function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

export function isPid(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function bytes(v: unknown, what: string): Uint8Array {
  return isUint8Array(v) ? v : bad(what);
}

export function int(v: unknown, what: string): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad(what);
}

export function runResult(v: unknown): {
  code: number;
  signal: Signal | null;
  stdout: string;
  stderr: string;
} {
  const r = v as Partial<RunResult> | null;
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof r.code !== 'number' ||
    typeof r.stdout !== 'string' ||
    typeof r.stderr !== 'string' ||
    !(r.signal === null || SIGNALS.has(r.signal))
  ) {
    bad('run result');
  }
  return { code: r.code, signal: r.signal ?? null, stdout: r.stdout, stderr: r.stderr };
}

const SIGNALS = new Set<unknown>(['SIGHUP', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGTERM']);

export function chunks(v: unknown): Uint8Array[] {
  return Array.isArray(v) && v.every(isUint8Array) ? v : bad('filesystem image');
}

export function stat(v: unknown): WireStat {
  const s = v as Partial<WireStat> | null;
  const nums = ['size', 'mode', 'mtimeMs', 'ctimeMs', 'birthtimeMs'] as const;
  if (
    typeof s !== 'object' ||
    s === null ||
    !KINDS.has(s.type) ||
    !nums.every((k) => typeof s[k] === 'number')
  ) {
    bad('stat');
  }
  return {
    type: s.type as FileKind,
    size: s.size!,
    mode: s.mode!,
    mtimeMs: s.mtimeMs!,
    ctimeMs: s.ctimeMs!,
    birthtimeMs: s.birthtimeMs!,
  };
}

export function dirEntries(v: unknown): WireDirEntry[] {
  if (!Array.isArray(v)) bad('directory listing');
  return v.map((e: Partial<WireDirEntry> | null) => {
    if (typeof e !== 'object' || e === null || typeof e.name !== 'string' || !KINDS.has(e.type)) {
      bad('directory entry');
    }
    return { name: e.name, type: e.type as FileKind };
  });
}

export function fsEvents(v: unknown): WireFsEvent[] | null {
  if (!Array.isArray(v)) return null;
  const out: WireFsEvent[] = [];
  for (const e of v as Record<string, unknown>[]) {
    if (typeof e !== 'object' || e === null) return null;
    if (e['type'] === 'rename' && typeof e['from'] === 'string' && typeof e['to'] === 'string') {
      out.push({ type: 'rename', from: e['from'], to: e['to'] });
    } else if (
      (e['type'] === 'create' || e['type'] === 'modify' || e['type'] === 'delete') &&
      typeof e['path'] === 'string'
    ) {
      out.push({ type: e['type'], path: e['path'] });
    } else {
      return null;
    }
  }
  return out;
}
