// SPDX-License-Identifier: Apache-2.0
// Stand-ins installed with npm (ADR 0013): retries on transient npm failures,
// and post-install patches, over an in-memory fs and a scripted npm.
import { describe, expect, it } from 'vitest';
import { STANDIN_ROOT, packageStandIn } from './standins.ts';
import type { StandInHost } from './standins.ts';

/** The few fs calls the installer makes, over a map of files. */
class MemFs {
  files = new Map<string, string>();
  dirs = new Set<string>(['/']);
  mkdirSync(p: string) {
    for (let d = p; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') this.dirs.add(d);
  }
  writeFileSync(p: string, data: string) {
    this.mkdirSync(p.slice(0, p.lastIndexOf('/')));
    this.files.set(p, data);
  }
  readFileSync(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return v;
  }
  readdirSync(p: string) {
    const names = new Set<string>();
    for (const k of [...this.files.keys(), ...this.dirs])
      if (k.startsWith(`${p}/`)) names.add(k.slice(p.length + 1).split('/')[0]!);
    return [...names];
  }
  lstatSync(p: string) {
    return { isDirectory: () => this.dirs.has(p) };
  }
  rmSync(p: string) {
    for (const k of [...this.files.keys()])
      if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === p || k.startsWith(`${p}/`)) this.dirs.delete(k);
  }
  renameSync(from: string, to: string) {
    const move = (k: string) => to + k.slice(from.length);
    for (const [k, v] of [...this.files]) {
      if (k === from || k.startsWith(`${from}/`)) {
        this.files.delete(k);
        this.files.set(move(k), v);
      }
    }
    for (const k of [...this.dirs]) {
      if (k === from || k.startsWith(`${from}/`)) {
        this.dirs.delete(k);
        this.dirs.add(move(k));
      }
    }
  }
}

const OWNER = '/app/node_modules/@tailwindcss/oxide';
const NAME = '@tailwindcss/oxide-wasm32-wasi';

function setup(results: { status: number; stderr?: string }[]) {
  const fs = new MemFs();
  fs.writeFileSync(`${OWNER}/package.json`, JSON.stringify({ version: '4.3.3' }));
  const warnings: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const host: StandInHost = {
    pid: 7,
    spawnSync(_file, _args, { cwd }) {
      const r = results[calls++] ?? { status: 1, stderr: 'unexpected call' };
      if (r.status === 0) {
        const pkg = `${cwd}/node_modules/${NAME}`;
        fs.writeFileSync(`${pkg}/package.json`, JSON.stringify({ name: NAME, main: 'x.cjs' }));
        fs.writeFileSync(`${pkg}/tailwindcss-oxide.wasi.cjs`, 'module.exports = {}');
      }
      return { status: r.status, stderr: r.stderr ?? '' };
    },
    warn: (m) => warnings.push(m),
    sleep: (ms) => sleeps.push(ms),
  };
  const resolve = () => packageStandIn(fs as never, NAME, `${OWNER}/index.js`, host);
  return { fs, host, warnings, sleeps, resolve, calls: () => calls };
}

const pkgDir = `${STANDIN_ROOT}/${NAME}@4.3.3/node_modules/${NAME}`;

describe('stand-ins installed with npm', () => {
  it('retries transient npm failures, then installs and patches', () => {
    const t = setup([
      { status: 1, stderr: 'npm error code ECONNRESET\nnpm error network aborted' },
      { status: 1, stderr: 'npm error code E503' },
      { status: 0 },
    ]);
    expect(t.resolve()).toEqual([`${STANDIN_ROOT}/${NAME}@4.3.3/node_modules`]);
    expect(t.calls()).toBe(3);
    expect(t.sleeps).toEqual([1000, 3000]);
    expect(t.warnings.filter((w) => w.includes('retrying'))).toHaveLength(2);
    // oxide's rescan fix (OXIDE_SCANNER) becomes the package's main.
    expect(JSON.parse(t.fs.readFileSync(`${pkgDir}/package.json`)).main).toBe(
      'clientvm-scanner.cjs',
    );
    expect(t.fs.readFileSync(`${pkgDir}/clientvm-scanner.cjs`)).toContain('new binding.Scanner');
    // Installed once: later lookups reuse it without npm.
    expect(t.resolve()).toBeDefined();
    expect(t.calls()).toBe(3);
  });

  it('gives up after three transient failures', () => {
    const fail = { status: 1, stderr: 'npm error code ETIMEDOUT' };
    const t = setup([fail, fail, fail, { status: 0 }]);
    expect(t.resolve()).toBeUndefined();
    expect(t.calls()).toBe(3);
    expect(t.warnings.at(-1)).toMatch(/cannot install .*ETIMEDOUT/);
    expect(t.fs.dirs.has(`${STANDIN_ROOT}/${NAME}@4.3.3.staging-7`)).toBe(false);
  });

  it('does not retry a failure that is not transient', () => {
    const t = setup([{ status: 1, stderr: 'npm error code ETARGET\nnpm error notarget' }]);
    expect(t.resolve()).toBeUndefined();
    expect(t.calls()).toBe(1);
    expect(t.sleeps).toEqual([]);
  });
});
