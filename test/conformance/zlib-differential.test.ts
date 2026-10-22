// SPDX-License-Identifier: Apache-2.0
// node-compat's zlib (pako) against node:zlib: round trips in both directions,
// streams, minizlib's synchronous _processChunk path, errors and crc32.
import { Buffer } from 'node:buffer';
import * as nodeZlib from 'node:zlib';
import {
  StringDecoder,
  bufferModule,
  createZlib,
  eventsModule,
  loadStreamModule,
} from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

const stream = loadStreamModule({
  buffer: bufferModule,
  events: eventsModule,
  string_decoder: { StringDecoder },
  process: {
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
    env: {},
    version: 'v24.11.0',
    versions: {},
    emitWarning() {},
  },
});
const z = createZlib(() => stream as never) as unknown as typeof nodeZlib;

const inputs: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  text: Buffer.from('hello hello hello hello zlib '.repeat(200)),
  random: Uint8Array.from({ length: 100_000 }, (_, i) => (i * 2654435761) >>> 24),
};

const pairs = [
  ['deflateSync', 'inflateSync'],
  ['gzipSync', 'gunzipSync'],
  ['deflateRawSync', 'inflateRawSync'],
  ['gzipSync', 'unzipSync'],
  ['deflateSync', 'unzipSync'],
] as const;

describe('zlib differential vs node:zlib', () => {
  for (const [name, data] of Object.entries(inputs)) {
    for (const [enc, dec] of pairs) {
      it(`${enc} -> ${dec} (${name})`, () => {
        const ours = z[enc](data);
        expect(Buffer.from(nodeZlib[dec](ours))).toEqual(Buffer.from(data));
        const theirs = nodeZlib[enc](data);
        expect(Buffer.from(z[dec](theirs))).toEqual(Buffer.from(data));
      });
    }
  }

  it('levels produce valid streams of decreasing size', () => {
    const data = inputs['text']!;
    const sizes = [0, 1, 9].map((level) => z.deflateSync(data, { level }).length);
    expect(sizes[0]).toBeGreaterThan(sizes[1]!);
    for (const level of [0, 1, 9])
      expect(Buffer.from(nodeZlib.inflateSync(z.deflateSync(data, { level })))).toEqual(
        Buffer.from(data),
      );
  });

  it('streams gzip and gunzip in chunks', async () => {
    const data = inputs['random']!;
    const gz = z.createGzip();
    const parts: Buffer[] = [];
    gz.on('data', (d: Buffer) => parts.push(d));
    const done = new Promise((r) => gz.on('end', r));
    for (let i = 0; i < data.length; i += 7000) gz.write(data.subarray(i, i + 7000));
    gz.end();
    await done;
    const zipped = Buffer.concat(parts);
    expect(Buffer.from(nodeZlib.gunzipSync(zipped))).toEqual(Buffer.from(data));

    const gunzip = z.createGunzip();
    const out: Buffer[] = [];
    gunzip.on('data', (d: Buffer) => out.push(d));
    const ended = new Promise((r) => gunzip.on('end', r));
    const theirs = nodeZlib.gzipSync(data);
    for (let i = 0; i < theirs.length; i += 333) gunzip.write(theirs.subarray(i, i + 333));
    gunzip.end();
    await ended;
    expect(Buffer.concat(out)).toEqual(Buffer.from(data));
  });

  it('supports minizlib-style synchronous _processChunk', () => {
    const gz = z.createGzip() as unknown as {
      _processChunk(c: Uint8Array, flush: number): Buffer;
      _handle: { close(): void };
    };
    expect(typeof gz._handle.close).toBe('function');
    const a = gz._processChunk(inputs['text']!, nodeZlib.constants.Z_NO_FLUSH);
    const b = gz._processChunk(new Uint8Array(0), nodeZlib.constants.Z_FINISH);
    expect(Buffer.from(nodeZlib.gunzipSync(Buffer.concat([a, b])))).toEqual(
      Buffer.from(inputs['text']!),
    );
  });

  it('reports corrupt and truncated input like Node', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return `${(e as { code: string }).code} ${(e as Error).message}`;
      }
    };
    const garbage = Buffer.from('not compressed at all');
    expect(code(() => z.inflateSync(garbage))).toBe(code(() => nodeZlib.inflateSync(garbage)));
    const truncated = nodeZlib.gzipSync(inputs['text']!).subarray(0, 40);
    expect(code(() => z.gunzipSync(truncated))).toBe(code(() => nodeZlib.gunzipSync(truncated)));
  });

  it('crc32 matches', () => {
    expect(z.crc32(inputs['random']!)).toBe(nodeZlib.crc32(inputs['random']!));
    expect(z.crc32('abc', 42)).toBe(nodeZlib.crc32('abc', 42));
  });

  it('callback API', async () => {
    const out = await new Promise<Buffer>((resolve, reject) =>
      z.gzip('cb data', (err, r) => (err ? reject(err) : resolve(r))),
    );
    expect(String(nodeZlib.gunzipSync(out))).toBe('cb data');
  });
});
