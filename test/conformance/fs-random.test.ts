// SPDX-License-Identifier: Apache-2.0
// Seeded random-operation differential: random op sequences over a small path
// namespace (so ops collide often) run against node:fs and MemoryVfs, with
// identical outcomes required at every step. Deterministic; no dependencies.
// Reproduce a failure with FS_RANDOM_SEED=<seed>.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVfs } from '@clientvm/vfs';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeTarget, outcome, vfsTarget } from './fs-harness.ts';
import type { Outcome, Step } from './fs-harness.ts';

const isLinux = process.platform === 'linux';
const SEEDS = Number(process.env['FS_RANDOM_SEEDS'] ?? (isLinux ? 60 : 30));
const STEPS = 150;
const ONLY_SEED = process.env['FS_RANDOM_SEED'];

/** mulberry32: tiny, fast, good enough for test-case generation. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed: number) {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const names = ['a', 'b', 'c'];
  // At most one '..', never first, and none inside symlink targets: then a path can never
  // climb above the root, which the reference (a temp dir, not a chroot) can't emulate.
  const path = (allowDotDot = true): string => {
    const depth = 1 + Math.floor(rand() * 3);
    const parts = Array.from({ length: depth }, () => pick(names));
    if (allowDotDot && depth >= 2 && rand() < 0.25)
      parts[1 + Math.floor(rand() * (depth - 1))] = '..';
    // Trailing slashes behave differently on macOS; only generate them on Linux.
    const trailing = isLinux && rand() < 0.05 ? '/' : '';
    return '/' + parts.join('/') + trailing;
  };
  const data = () => 'x'.repeat(Math.floor(rand() * 12));

  const ops: (() => Step)[] = [
    () => ({ op: 'mkdir', path: path(), recursive: rand() < 0.3 }),
    () => ({ op: 'write', path: path(), data: data() }),
    () => ({ op: 'write', path: path(), data: data() }),
    () => ({ op: 'read', path: path() }),
    () => ({ op: 'readdir', path: rand() < 0.2 ? '/' : path() }),
    () => ({ op: 'stat', path: path() }),
    () => ({ op: 'lstat', path: path() }),
    // rmSync goes through std::filesystem, whose '..' handling isn't POSIX; keep '..' out of removals.
    () => ({ op: 'rmdir', path: path(false) }),
    () => ({ op: 'rmTree', path: path(false) }),
    // rename of a '.'/'..' component is EBUSY on Linux, EINVAL on macOS.
    () => ({ op: 'rename', from: path(isLinux), to: path(isLinux) }),
    () => ({ op: 'rename', from: path(isLinux), to: path(isLinux) }),
    () => ({ op: 'symlink', target: rand() < 0.5 ? path(false) : pick(names), path: path() }),
    () => ({ op: 'readlink', path: path() }),
    // macOS realpath(3) resolves '/file/..' to '/' (Linux: ENOTDIR).
    () => ({ op: 'realpath', path: path(isLinux) }),
    () => ({ op: 'truncate', path: path(), length: Math.floor(rand() * 8) }),
    () => {
      const flags = pick(['w', 'a', 'r+', 'wx']);
      // pwrite on an O_APPEND fd appends on Linux but honors the offset on macOS.
      const position = flags === 'a' && !isLinux ? undefined : Math.floor(rand() * 6);
      return {
        op: 'fdWrite',
        path: path(),
        flags,
        data: data(),
        ...(position === undefined ? {} : { position }),
      };
    },
    () => ({
      op: 'fdRead',
      path: path(),
      length: 1 + Math.floor(rand() * 8),
      position: Math.floor(rand() * 6),
    }),
    // macOS differs from Linux for these (unlink on a directory, link following symlinks).
    ...(isLinux
      ? [
          (): Step => ({ op: 'unlink', path: path() }),
          (): Step => ({ op: 'link', existing: path(), path: path() }),
          // macOS copyfile(3) reports ENOTSUP and different precedence for bad sources.
          (): Step => ({ op: 'copyFile', src: path(), dest: path(), exclusive: rand() < 0.3 }),
        ]
      : []),
  ];
  return () => pick(ops)();
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const seeds = ONLY_SEED ? [Number(ONLY_SEED)] : Array.from({ length: SEEDS }, (_, i) => i + 1);

/**
 * macOS checks rename's source before the target's parent, and types before the ancestor
 * checks; Linux, the reference, does the opposite. When both fail nothing changed, so
 * only the errno differs.
 */
function macRenameErrno(step: Step, actual: Outcome, expected: Outcome): boolean {
  return !isLinux && step.op === 'rename' && 'error' in actual && 'error' in expected;
}

describe('fs random-op differential: MemoryVfs vs node:fs', () => {
  it.each(seeds)('seed %i', (seed) => {
    const root = mkdtempSync(join(tmpdir(), 'clientvm-fsrand-'));
    chmodSync(root, 0o755); // mkdtemp creates 0700; the VFS root is 0755
    roots.push(root);
    const reference = nodeTarget(root);
    const subject = vfsTarget(new MemoryVfs());
    const next = generator(seed);
    const history: Step[] = [];
    for (let i = 0; i < STEPS; i++) {
      const step = next();
      history.push(step);
      const expected = outcome(reference, step);
      const actual = outcome(subject, step);
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) &&
        !macRenameErrno(step, actual, expected)
      ) {
        expect(
          actual,
          `seed ${seed}, step ${i}: ${JSON.stringify(step)}\nhistory:\n${history.map((s) => JSON.stringify(s)).join('\n')}`,
        ).toEqual(expected);
      }
    }
  });
});
