// SPDX-License-Identifier: Apache-2.0
// Presets: ready-made projects an instance can start from (ADR 0018). The
// controller builds a preset once, in a hidden instance that runs only the
// pinned template and its setup, and keeps the resulting filesystem image in a
// PresetStore on the host page's origin. Agent instances never write to the
// store; they boot from a copy of the image.

import { template as viteReactTs } from './presets/vite-react-ts.ts';
import type { FileTree, PresetName } from './types.ts';

/** A template's files and a hash of them (see scripts/build-presets.mjs). */
export interface PresetTemplate {
  version: string;
  files: FileTree;
}

interface PresetDefinition {
  template: PresetTemplate;
  /** Run once in the builder, in {@link PRESET_DIR}. */
  setup: string;
}

/** Where a preset's project lives in an instance. */
export const PRESET_DIR = '/home/user/app';

/** Bump when a setup command or the image contents change without the template changing. */
const PRESET_FORMAT = 1;

export const PRESETS: Readonly<Record<PresetName, PresetDefinition>> = {
  'vite-react-ts': {
    template: viteReactTs,
    // npm ci installs the pinned lockfile. A throwaway build makes Vite reach
    // for rolldown and lightningcss, so their WebAssembly stand-ins (ADR 0013)
    // are fetched now instead of on the first dev server start. npm's download
    // cache would only double the image.
    setup:
      'npm ci --no-audit --no-fund && npx vite build --logLevel error && rm -rf dist ~/.npm/_cacache',
  },
};

export function isPresetName(name: unknown): name is PresetName {
  return typeof name === 'string' && Object.hasOwn(PRESETS, name);
}

/** The store key of a preset's image: a changed template or setup gets a new key. */
export function presetKey(name: PresetName): string {
  return `${name}@${PRESETS[name].template.version}.${PRESET_FORMAT}`;
}

/**
 * Where built preset images are kept between page loads, shared by every
 * instance the host page creates. Only the controller reads and writes it.
 */
export interface PresetStore {
  get(key: string): Promise<Uint8Array[] | undefined>;
  /** Stores `image` under `key`, replacing images stored for older versions of the preset. */
  put(key: string, image: Uint8Array[]): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A store that lasts as long as the page. */
export function memoryPresetStore(): PresetStore {
  const images = new Map<string, Uint8Array[]>();
  return {
    get: async (key) => images.get(key),
    put: async (key, image) => {
      for (const old of images.keys()) if (sameName(old, key)) images.delete(old);
      images.set(key, image);
    },
    delete: async (key) => {
      images.delete(key);
    },
  };
}

/** A store in the host origin's Cache Storage (the default, where available). */
export function cachePresetStore(cacheName = 'clientvm-presets'): PresetStore {
  // Cache Storage needs an http(s) URL; nothing is ever fetched from it.
  const url = (key: string) => `https://clientvm.invalid/presets/${encodeURIComponent(key)}`;
  const keyOf = (request: Request) =>
    decodeURIComponent(new URL(request.url).pathname.slice('/presets/'.length));
  const open = () => caches.open(cacheName);
  return {
    async get(key) {
      const res = await (await open()).match(url(key));
      if (!res) return undefined;
      const image = decodeImage(new Uint8Array(await res.arrayBuffer()));
      if (!image) await this.delete(key);
      return image;
    },
    async put(key, image) {
      const cache = await open();
      for (const request of await cache.keys()) {
        if (sameName(keyOf(request), key)) await cache.delete(request);
      }
      await cache.put(url(key), new Response(new Blob(encodeImage(image))));
    },
    async delete(key) {
      await (await open()).delete(url(key));
    },
  };
}

export function defaultPresetStore(): PresetStore {
  return typeof caches === 'undefined' ? memoryPresetStore() : cachePresetStore();
}

const sameName = (a: string, b: string) => a.split('@')[0] === b.split('@')[0];

/** Frames image chunks as one blob: chunk count, then each length (u32 LE), then the bytes. */
export function encodeImage(image: Uint8Array[]): Uint8Array<ArrayBuffer>[] {
  const header = new DataView(new ArrayBuffer(4 * (image.length + 1)));
  header.setUint32(0, image.length, true);
  image.forEach((chunk, i) => header.setUint32(4 * (i + 1), chunk.byteLength, true));
  return [new Uint8Array(header.buffer), ...image.map((chunk) => new Uint8Array(chunk))];
}

/** Undoes {@link encodeImage}; `undefined` if `bytes` is not a whole framed image. */
export function decodeImage(bytes: Uint8Array): Uint8Array[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 4) return undefined;
  const count = view.getUint32(0, true);
  let offset = 4 * (count + 1);
  if (offset > bytes.byteLength) return undefined;
  const image: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(4 * (i + 1), true);
    if (offset + length > bytes.byteLength) return undefined;
    image.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return offset === bytes.byteLength ? image : undefined;
}
