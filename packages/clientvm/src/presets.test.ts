// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  decodeImage,
  encodeImage,
  isPresetName,
  memoryPresetStore,
  presetKey,
} from './presets.ts';
import type { FileTree, PresetName } from './types.ts';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const join8 = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

describe('image framing', () => {
  it('round-trips chunks, including empty ones', () => {
    const image = [bytes(1, 2, 3), bytes(), bytes(4)];
    expect(decodeImage(join8(encodeImage(image)))).toEqual(image);
    expect(decodeImage(join8(encodeImage([])))).toEqual([]);
  });

  it('rejects truncated, padded and malformed input', () => {
    const framed = join8(encodeImage([bytes(1, 2, 3), bytes(4, 5)]));
    for (let n = 0; n < framed.length; n++)
      expect(decodeImage(framed.subarray(0, n))).toBe(undefined);
    expect(decodeImage(join8([framed, bytes(0)]))).toBe(undefined);
    expect(decodeImage(bytes(0xff, 0xff, 0xff, 0xff))).toBe(undefined);
  });
});

describe('memoryPresetStore', () => {
  it('keeps one image per preset, dropping older versions', async () => {
    const store = memoryPresetStore();
    await store.put('vite-react-ts@a.1', [bytes(1)]);
    await store.put('other@a.1', [bytes(2)]);
    await store.put('vite-react-ts@b.1', [bytes(3)]);
    expect(await store.get('vite-react-ts@a.1')).toBe(undefined);
    expect(await store.get('vite-react-ts@b.1')).toEqual([bytes(3)]);
    expect(await store.get('other@a.1')).toEqual([bytes(2)]);
    await store.delete('other@a.1');
    expect(await store.get('other@a.1')).toBe(undefined);
  });
});

describe('presets', () => {
  it('accepts only known names', () => {
    expect(isPresetName('vite-react-ts')).toBe(true);
    for (const name of ['', 'toString', '__proto__', 'vite', 1, null]) {
      expect(isPresetName(name)).toBe(false);
    }
  });

  it('keys images by template version', () => {
    expect(presetKey('vite-react-ts')).toBe(
      `vite-react-ts@${PRESETS['vite-react-ts'].template.version}.1`,
    );
  });

  // The modules are generated; this catches a template edited without
  // rerunning `node scripts/build-presets.mjs`.
  it.each(Object.keys(PRESETS) as PresetName[])('%s matches its template directory', (name) => {
    const dir = new URL(`../presets/${name}/`, import.meta.url).pathname;
    const files = walk(dir).map((file) => [relative(dir, file), readFileSync(file, 'utf8')]);
    const { version, files: tree } = PRESETS[name].template;
    expect(flatten(tree)).toEqual(Object.fromEntries(files));
    expect(version).toBe(presetVersion(files as [string, string][]));
  });

  it('pins every dependency of vite-react-ts in its lockfile', () => {
    const { files } = PRESETS['vite-react-ts'].template;
    const pkg = JSON.parse(files['package.json'] as string) as Record<
      string,
      Record<string, string>
    >;
    const lock = JSON.parse(files['package-lock.json'] as string) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    for (const [dep, version] of Object.entries({
      ...pkg['dependencies'],
      ...pkg['devDependencies'],
    })) {
      expect(version, dep).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${dep}`]?.version, dep).toBe(version);
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path) expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });
});

/** Same scheme as `version` in scripts/build-presets.mjs. */
function presetVersion(files: [string, string][]): string {
  const hash = createHash('sha256');
  for (const [path, text] of files) hash.update(`${path}\0${text}\0`);
  return hash.digest('hex').slice(0, 16);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .filter((entry) => entry.name !== 'node_modules')
    .flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
}

function flatten(tree: FileTree, prefix = ''): Record<string, string | Uint8Array> {
  return Object.fromEntries(
    Object.entries(tree).flatMap(([name, value]) =>
      typeof value === 'string' || value instanceof Uint8Array
        ? [[`${prefix}${name}`, value]]
        : Object.entries(flatten(value, `${prefix}${name}/`)),
    ),
  );
}
