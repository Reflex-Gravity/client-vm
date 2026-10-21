// SPDX-License-Identifier: Apache-2.0
// The vendored streams, evaluated with node-compat's own Buffer/events/etc.,
// against Node's built-in streams on the same scenarios.
import * as nodeStream from 'node:stream';
import {
  Buffer,
  StringDecoder,
  bufferModule,
  eventsModule,
  loadStreamModule,
} from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

type S = typeof nodeStream;
const ours = loadStreamModule({
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
}) as unknown as S;

async function trace(
  S: S,
  scenario: (S: S, log: (...a: unknown[]) => void) => Promise<void> | void,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const log = (...a: unknown[]) =>
    out.push(a.map((x) => (x instanceof Uint8Array ? `bytes:${new TextDecoder().decode(x)}` : x)));
  try {
    await scenario(S, log);
  } catch (err) {
    out.push(['threw', (err as { code?: string }).code ?? (err as Error).message]);
  }
  return out;
}

const scenarios: Record<string, (S: S, log: (...a: unknown[]) => void) => Promise<void> | void> = {
  async 'readable from iterable, async iteration'(S, log) {
    for await (const chunk of S.Readable.from(['a', 'b', 'c'])) log(chunk);
  },
  async 'pipeline transform to writable'(S, log) {
    const chunks: string[] = [];
    await S.promises.pipeline(
      S.Readable.from(['x', 'y']),
      new S.Transform({
        transform(chunk, _enc, cb) {
          cb(null, String(chunk).toUpperCase());
        },
      }),
      new S.Writable({
        write(chunk, _enc, cb) {
          chunks.push(String(chunk));
          cb();
        },
      }),
    );
    log(chunks.join(''));
  },
  async 'backpressure and drain'(S, log) {
    const w = new S.Writable({
      highWaterMark: 4,
      write(_c, _e, cb) {
        setTimeout(cb, 1);
      },
    });
    log(w.write('12345'), w.writableLength, w.writableNeedDrain);
    await new Promise((r) => w.once('drain', r));
    log('drained', w.writableLength);
  },
  async 'event order on end'(S, log) {
    const r = new S.Readable({
      read() {
        this.push('data');
        this.push(null);
      },
    });
    for (const ev of ['data', 'end', 'close'])
      r.on(ev, (x?: unknown) => log(ev, x instanceof Uint8Array ? 'bytes' : x));
    await new Promise((res) => r.on('close', res));
  },
  async 'errors and destroy'(S, log) {
    const r = new S.Readable({ read() {} });
    r.on('error', (e: Error) => log('error', e.message));
    r.on('close', () => log('close', r.destroyed));
    r.destroy(new Error('boom'));
    await new Promise((res) => setTimeout(res, 5));
    await S.promises.finished(S.Readable.from([]).resume()).then(() => log('finished ok'));
  },
  async 'object mode, setEncoding, passthrough'(S, log) {
    const p = new S.PassThrough();
    p.setEncoding('utf8');
    p.write(Buffer.from('€'.slice(0, 1)));
    p.end();
    p.on('data', (d: unknown) => log(typeof d, d));
    await new Promise((res) => p.on('end', res));
    const o = new S.Readable({ objectMode: true, read() {} });
    o.push({ a: 1 });
    o.push(null);
    for await (const v of o) log(v);
  },
  async 'duplex and pipe'(S, log) {
    const got: string[] = [];
    const d = new S.Duplex({
      read() {},
      write(chunk, _e, cb) {
        this.push(String(chunk) + '!');
        cb();
      },
      final(cb) {
        this.push(null);
        cb();
      },
    });
    d.on('data', (c: unknown) => got.push(String(c)));
    S.Readable.from(['a', 'b']).pipe(d);
    await new Promise((res) => d.on('end', res));
    log(got.join(','));
  },
  async 'iterator helpers'(S, log) {
    log(
      await (
        S.Readable.from([1, 2, 3, 4]) as unknown as {
          filter(f: (x: number) => boolean): {
            map(f: (x: number) => number): { toArray(): Promise<number[]> };
          };
        }
      )
        .filter((x) => x % 2 === 0)
        .map((x) => x * 10)
        .toArray(),
    );
  },
  'module shape'(S, log) {
    log(
      typeof S.Readable,
      typeof S.Writable,
      typeof S.Duplex,
      typeof S.Transform,
      typeof S.PassThrough,
      typeof S.pipeline,
      typeof S.finished,
      typeof S.Stream,
      S.Readable.prototype instanceof S.Stream,
    );
  },
};

describe('stream differential: vendored streams on node-compat vs node:stream', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, async () => {
      expect(await trace(ours, scenario)).toEqual(await trace(nodeStream, scenario));
    });
  }
  it('uses our Buffer for chunks', async () => {
    const chunks: unknown[] = [];
    await ours.promises.pipeline(
      ours.Readable.from(['ab']),
      new ours.Writable({
        write(c, _e, cb) {
          chunks.push(c);
          cb();
        },
      }),
    );
    expect(Buffer.isBuffer(chunks[0])).toBe(true);
  });
});
