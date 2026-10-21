// SPDX-License-Identifier: Apache-2.0
// `stream`: Node's own stream implementation (readable-stream, vendored; ADR
// 0010), evaluated with this process's buffer/events/string_decoder/process so
// streams interoperate with every other builtin.

import { FILES } from './vendor/readable-stream.ts';

export interface StreamDeps {
  buffer: unknown;
  events: unknown;
  string_decoder: unknown;
  process: unknown;
}

type Mod = { exports: unknown };

/** Evaluates the vendored package through a private CommonJS registry. */
export function loadStreamModule(deps: StreamDeps): Record<string, unknown> {
  const cache = new Map<string, Mod>();
  const external: Record<string, unknown> = {
    buffer: deps.buffer,
    events: deps.events,
    string_decoder: deps.string_decoder,
    'string_decoder/': deps.string_decoder,
    process: deps.process,
    'process/': deps.process,
    'abort-controller': {
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      default: globalThis.AbortController,
    },
  };

  const resolve = (from: string, spec: string): string => {
    if (!spec.startsWith('.')) return spec;
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    const base = parts.join('/');
    for (const candidate of [base, `${base}.js`, `${base}/index.js`])
      if (candidate in FILES) return candidate;
    throw new Error(`readable-stream: cannot resolve ${spec} from ${from}`);
  };

  const load = (file: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(external, file)) return external[file];
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const source = FILES[file];
    if (source === undefined) throw new Error(`readable-stream: no module ${file}`);
    const module: Mod = { exports: {} };
    cache.set(file, module);
    const fn = new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      `${source}\n//# sourceURL=node:internal/streams/${file}`,
    ) as (...args: unknown[]) => void;
    fn.call(
      module.exports,
      module.exports,
      (spec: string) => load(resolve(file, spec)),
      module,
      file,
      file.slice(0, file.lastIndexOf('/')),
    );
    return module.exports;
  };

  return load('lib/stream.js') as Record<string, unknown>;
}

/** `stream/consumers`. */
export function createConsumers(Buffer: {
  concat(list: Uint8Array[]): Uint8Array & { toString(enc?: string): string };
}) {
  const collect = async (stream: AsyncIterable<unknown>): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for await (const chunk of stream)
      chunks.push(typeof chunk === 'string' ? encoder.encode(chunk) : (chunk as Uint8Array));
    return chunks;
  };
  return {
    async buffer(stream: AsyncIterable<unknown>) {
      return Buffer.concat(await collect(stream));
    },
    async arrayBuffer(stream: AsyncIterable<unknown>) {
      const b = Buffer.concat(await collect(stream));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async text(stream: AsyncIterable<unknown>) {
      return new TextDecoder().decode(Buffer.concat(await collect(stream)));
    },
    async json(stream: AsyncIterable<unknown>) {
      return JSON.parse(new TextDecoder().decode(Buffer.concat(await collect(stream)))) as unknown;
    },
    async blob(stream: AsyncIterable<unknown>) {
      return new Blob((await collect(stream)) as BlobPart[]);
    },
  };
}
