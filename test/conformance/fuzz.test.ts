// SPDX-License-Identifier: Apache-2.0
// Seeded fuzz tests (docs/phase5-plan.md, slice 5b). Every run uses the same
// seeds; set FUZZ_SEED=<n> to explore another one and FUZZ_ITERATIONS to go
// longer. A failure message names its seed so it can be replayed.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import {
  CjsResolver,
  PackageJsonCache,
  createPosixPath,
  readTar,
  writeTar,
} from '@clientvm/node-compat';
import type { ResolverFs } from '@clientvm/node-compat';
import { decode, encode } from '@clientvm/protocol';
import type { Value } from '@clientvm/protocol';
import { describe, expect, it } from 'vitest';

const SEED = Number(process.env['FUZZ_SEED'] ?? 20261021);
const ITERATIONS = Number(process.env['FUZZ_ITERATIONS'] ?? 1);

/** mulberry32 */
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

function tools(seed: number) {
  const r = prng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { r, int, pick };
}

const seeds = Array.from({ length: ITERATIONS }, (_, i) => SEED + i);

describe('protocol codec', () => {
  for (const seed of seeds) {
    it(`random values round-trip; random bytes never crash (seed ${seed})`, () => {
      const { r, int, pick } = tools(seed);
      const value = (depth: number): Value => {
        switch (int(depth > 3 ? 6 : 8)) {
          case 0:
            return null;
          case 1:
            return r() < 0.5;
          case 2:
            return pick([0, -1, 1.5, 2 ** 53 - 1, -(2 ** 31), int(1e9)]);
          case 3:
            return Array.from({ length: int(12) }, () => String.fromCharCode(int(0x2ff))).join('');
          case 4:
            return new Uint8Array(Array.from({ length: int(20) }, () => int(256)));
          case 5:
            return pick(['', 'é', '😀', '\0']);
          case 6:
            return Array.from({ length: int(5) }, () => value(depth + 1));
          default: {
            const o: Record<string, Value> = {};
            for (let i = int(5); i > 0; i--) o[`k${int(100)}`] = value(depth + 1);
            return o;
          }
        }
      };
      for (let i = 0; i < 300; i++) {
        const v = value(0);
        expect(decode(encode(v)), `seed ${seed} #${i}`).toEqual(v);
      }
      for (let i = 0; i < 2000; i++) {
        const bytes = new Uint8Array(Array.from({ length: int(64) }, () => int(256)));
        try {
          decode(bytes);
        } catch (err) {
          expect(err, `seed ${seed} #${i}`).toBeInstanceOf(Error);
        }
      }
    });
  }
});

describe('tar reader', () => {
  for (const seed of seeds) {
    it(`corrupted archives terminate and fail cleanly (seed ${seed})`, () => {
      const { int, pick } = tools(seed);
      const enc = new TextEncoder();
      const good = writeTar([
        { path: 'a/', type: 'dir', mode: 0o755, mtime: 1, linkname: '', data: new Uint8Array() },
        {
          path: 'a/f.txt',
          type: 'file',
          mode: 0o644,
          mtime: 1,
          linkname: '',
          data: enc.encode('hello'.repeat(300)),
        },
        {
          path: `a/${'long-name/'.repeat(15)}x`,
          type: 'file',
          mode: 0o644,
          mtime: 1,
          linkname: '',
          data: enc.encode('x'),
        },
        {
          path: 'a/l',
          type: 'symlink',
          mode: 0o777,
          mtime: 1,
          linkname: 'f.txt',
          data: new Uint8Array(),
        },
      ]);
      for (let i = 0; i < 500; i++) {
        const bytes = good.slice(0, pick([good.length, int(good.length)]));
        for (let m = int(8); m > 0; m--) bytes[int(bytes.length)] = int(256);
        let count = 0;
        try {
          for (const entry of readTar(bytes)) {
            expect(entry.data.length, `seed ${seed} #${i}`).toBeLessThanOrEqual(bytes.length);
            if (++count > 100) throw new Error(`seed ${seed} #${i}: runaway entries`);
          }
        } catch (err) {
          expect(err, `seed ${seed} #${i}`).toBeInstanceOf(Error);
          expect(String(err)).not.toMatch(/runaway/);
        }
      }
    });
  }
});

describe('path (posix and win32) vs node:path', () => {
  const ours = createPosixPath(() => '/base/dir');
  const oursWin = ours.win32 as unknown as typeof win32;
  // Node's posix.resolve uses process.cwd(); compare relative to an absolute base instead.
  for (const seed of seeds) {
    it(`random paths (seed ${seed})`, () => {
      const { int, pick } = tools(seed);
      const parts = [
        'a',
        'b',
        '.',
        '..',
        '',
        'C:',
        'c:',
        '\\',
        '/',
        '//',
        'x.y',
        '.z',
        'İ',
        ' ',
        'CON',
        'con:',
        '?',
        'UNC',
      ];
      const gen = () =>
        Array.from({ length: int(7) }, () => pick(parts)).join(pick(['/', '\\', '']));
      const fails: string[] = [];
      const check = (what: string, a: unknown, b: () => unknown) => {
        let expected: unknown;
        try {
          expected = b();
        } catch (e) {
          expected = `throws ${(e as Error).name}`;
        }
        if (JSON.stringify(a) !== JSON.stringify(expected))
          fails.push(`${what}: ours ${JSON.stringify(a)} node ${JSON.stringify(expected)}`);
      };
      const safe = (f: () => unknown) => {
        try {
          return f();
        } catch (e) {
          return `throws ${(e as Error).name}`;
        }
      };
      for (let i = 0; i < 400; i++) {
        const p = gen();
        const q = gen();
        for (const [name, o, n] of [
          ['posix', ours, posix],
          ['win32', oursWin, win32],
        ] as const) {
          const O = o as unknown as typeof posix;
          check(
            `${name}.normalize(${JSON.stringify(p)})`,
            safe(() => O.normalize(p)),
            () => n.normalize(p),
          );
          check(
            `${name}.join(${JSON.stringify(p)}, ${JSON.stringify(q)})`,
            safe(() => O.join(p, q)),
            () => n.join(p, q),
          );
          check(
            `${name}.dirname(${JSON.stringify(p)})`,
            safe(() => O.dirname(p)),
            () => n.dirname(p),
          );
          check(
            `${name}.basename(${JSON.stringify(p)})`,
            safe(() => O.basename(p)),
            () => n.basename(p),
          );
          check(
            `${name}.extname(${JSON.stringify(p)})`,
            safe(() => O.extname(p)),
            () => n.extname(p),
          );
          check(
            `${name}.parse(${JSON.stringify(p)})`,
            safe(() => O.parse(p)),
            () => n.parse(p),
          );
          check(
            `${name}.isAbsolute(${JSON.stringify(p)})`,
            safe(() => O.isAbsolute(p)),
            () => n.isAbsolute(p),
          );
          const base = name === 'posix' ? '/base/dir' : 'C:\\base\\dir';
          check(
            `${name}.resolve(base, ${JSON.stringify(p)}, ${JSON.stringify(q)})`,
            safe(() => O.resolve(base, p, q)),
            () => n.resolve(base, p, q),
          );
          check(
            `${name}.relative(base/${JSON.stringify(p)}, base/${JSON.stringify(q)})`,
            safe(() => O.relative(O.join(base, p), O.join(base, q))),
            () => n.relative(n.join(base, p), n.join(base, q)),
          );
        }
      }
      expect(fails.slice(0, 15).join('\n'), `seed ${seed}`).toBe('');
    });
  }
});

describe('CommonJS resolver vs require.resolve on random package trees', () => {
  for (const seed of seeds) {
    it(`random trees (seed ${seed})`, () => {
      const { int, pick } = tools(seed);
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-fuzz-resolve-')));
      try {
        const files = new Map<string, string>();
        const names = ['a', 'b', '@s/c', 'd'];
        const targets = [
          './index.js',
          './lib/x.js',
          './lib/',
          './missing.js',
          'lib/x.js',
          './x',
          './lib/*.js',
        ];
        const exportsShape = (): unknown => {
          switch (int(6)) {
            case 0:
              return pick(targets);
            case 1:
              return { '.': pick(targets), './sub': pick(targets) };
            case 2:
              return { require: pick(targets), default: pick(targets) };
            case 3:
              return { '.': { node: pick(targets), default: pick(targets) }, './*': pick(targets) };
            case 4:
              return [pick(targets), pick(targets)];
            default:
              return { './lib/*': pick(targets), './feature': null };
          }
        };
        const addPackage = (dir: string, name: string) => {
          const pkg: Record<string, unknown> = { name };
          if (int(2)) pkg['main'] = pick(['lib/x.js', './lib', 'missing.js', 'index', './x.json']);
          if (int(2)) pkg['exports'] = exportsShape();
          files.set(`${dir}/package.json`, JSON.stringify(pkg));
          for (const f of ['index.js', 'lib/x.js', 'lib/index.js', 'x.json', 'lib/y.js']) {
            if (int(3)) files.set(`${dir}/${f}`, f.endsWith('.json') ? '{}' : '');
          }
        };
        for (const name of names) {
          addPackage(`app/node_modules/${name}`, name);
          if (int(2)) addPackage(`app/node_modules/${name}/node_modules/${pick(names)}`, 'nested');
        }
        files.set('app/main.js', '');
        files.set('app/lib/local.js', '');
        for (const [file, content] of files) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), content);
        }
        const requests = ['./lib/local', './lib/local.js', '../app/main', 'nope'];
        for (const name of names) {
          for (const sub of [
            '',
            '/sub',
            '/lib/x',
            '/lib/x.js',
            '/lib',
            '/x.json',
            '/feature',
            '/lib/y',
            '/package.json',
          ])
            requests.push(name + sub);
        }
        const from = join(root, 'app/main.js');
        const script = `
          const r = require('module').createRequire(process.argv[1]);
          const out = JSON.parse(process.argv[2]).map((q) => {
            try { return { ok: r.resolve(q) }; } catch (e) { return { error: e.code }; }
          });
          process.stdout.write(JSON.stringify(out));`;
        const expected = JSON.parse(
          execFileSync(
            process.execPath,
            ['--no-warnings', '-e', script, from, JSON.stringify(requests)],
            {
              encoding: 'utf8',
            },
          ),
        ) as unknown[];
        const fs: ResolverFs = {
          stat: (p) => {
            try {
              return statSync(p).isDirectory() ? 1 : 0;
            } catch {
              return -1;
            }
          },
          readFile: (p) => {
            try {
              return readFileSync(p, 'utf8');
            } catch {
              return null;
            }
          },
          realpath: (p) => realpathSync(p),
        };
        const resolver = new CjsResolver(fs, new PackageJsonCache(fs), {
          extensions: ['.js', '.json', '.node'],
          globalPaths: [],
          isBuiltin: () => false,
        });
        const mismatches: string[] = [];
        requests.forEach((q, i) => {
          let actual: unknown;
          try {
            actual = { ok: resolver.resolve(q, from, dirname(from), [from]) };
          } catch (e) {
            actual = { error: (e as { code?: string }).code };
          }
          if (JSON.stringify(actual) !== JSON.stringify(expected[i])) {
            mismatches.push(
              `${q}: ours ${JSON.stringify(actual).replaceAll(root, '')} node ${JSON.stringify(expected[i]).replaceAll(root, '')}`,
            );
          }
        });
        const tree = [...files.entries()]
          .filter(([f]) => f.endsWith('package.json'))
          .map(([f, c]) => `${f}: ${c}`)
          .join('\n');
        expect(mismatches.join('\n'), `seed ${seed}\n${tree}`).toBe('');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
