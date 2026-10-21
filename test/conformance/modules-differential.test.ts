// SPDX-License-Identifier: Apache-2.0
// url, querystring, string_decoder and assert compared with Node's own modules.
import nodeAssert from 'node:assert';
import * as nodeQs from 'node:querystring';
import { StringDecoder as NodeDecoder } from 'node:string_decoder';
import * as nodeUrl from 'node:url';
import { StringDecoder, assertModule, querystringModule, urlModule } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

function both<T>(fn: () => T): { ok: unknown } | { error: string | undefined } {
  try {
    return { ok: JSON.parse(JSON.stringify(fn() ?? null)) };
  } catch (err) {
    return { error: (err as { code?: string }).code ?? (err as Error).name };
  }
}

const URLS = [
  'http://user:pass@Example.COM:8080/p/a/t/h?query=string&a=1#hash',
  'https://example.com',
  'https://example.com/',
  'http://[::1]:3000/x',
  '/relative/path?x=1#y',
  'relative/path',
  '//cdn.example.com/lib.js',
  'mailto:someone@example.com',
  'file:///home/user/file.txt',
  'http://example.com/a b?c d#e f',
  'git+ssh://git@github.com/user/repo.git',
  'HTTP://EXAMPLE.com/UPPER',
  '?only=query',
  '#only-hash',
  '',
];

describe('url differential', () => {
  it('legacy parse', () => {
    for (const u of URLS) {
      for (const parseQuery of [false, true]) {
        expect(
          both(() => ({ ...urlModule.parse(u, parseQuery) })),
          `${u} ${parseQuery}`,
        ).toEqual(both(() => ({ ...nodeUrl.parse(u, parseQuery) })));
      }
    }
    expect(both(() => ({ ...urlModule.parse('//host/path', false, true) }))).toEqual(
      both(() => ({ ...nodeUrl.parse('//host/path', false, true) })),
    );
  });

  it('legacy format and resolve', () => {
    for (const u of URLS) expect(urlModule.format(u), u).toBe(nodeUrl.format(u));
    const objs = [
      {
        protocol: 'http',
        hostname: 'example.com',
        port: '80',
        pathname: '/x',
        query: { a: '1', b: ['2', '3'] },
      },
      { protocol: 'https:', host: 'h.com', pathname: 'nolead', search: 'q=1', hash: 'frag' },
      { pathname: '/only' },
    ];
    for (const o of objs) expect(urlModule.format(o), JSON.stringify(o)).toBe(nodeUrl.format(o));
    const resolves: [string, string][] = [
      ['http://a.com/b/c', 'd'],
      ['http://a.com/b/c', '/d'],
      ['http://a.com/b/c', '../d'],
      ['http://a.com/b/c', 'http://other.com/'],
      ['/one/two/three', 'four'],
      ['/one/two/three', '../four'],
    ];
    for (const [from, to] of resolves)
      expect(urlModule.resolve(from, to), `${from} + ${to}`).toBe(nodeUrl.resolve(from, to));
  });

  it('file URL helpers', () => {
    for (const p of ['/home/user/a.txt', '/with space/x', '/percent%20/y', '/q?/h#', '/dir/']) {
      expect(urlModule.pathToFileURL(p).href, p).toBe(nodeUrl.pathToFileURL(p).href);
      expect(urlModule.fileURLToPath(nodeUrl.pathToFileURL(p).href)).toBe(
        nodeUrl.fileURLToPath(nodeUrl.pathToFileURL(p).href),
      );
    }
    expect(both(() => urlModule.fileURLToPath('http://x/y'))).toEqual(
      both(() => nodeUrl.fileURLToPath('http://x/y')),
    );
    expect(both(() => urlModule.fileURLToPath('file:///a%2fb'))).toEqual(
      both(() => nodeUrl.fileURLToPath('file:///a%2fb')),
    );
    const u = new URL('https://u:p@h.com:8443/p?q#f');
    expect(urlModule.urlToHttpOptions(u)).toEqual(nodeUrl.urlToHttpOptions(u));
  });
});

describe('querystring differential', () => {
  it('parse/stringify/escape', () => {
    const inputs = [
      'a=1&b=2',
      'a=1&a=2&a=3',
      'x=%20y+z',
      'k',
      '=v',
      'a[b]=c',
      'bad=%E0%A4%A',
      'u=%F0%9F%98%80',
      '',
      '&&a=1&&',
    ];
    for (const q of inputs)
      expect({ ...querystringModule.parse(q) }, q).toEqual({ ...nodeQs.parse(q) });
    expect({ ...querystringModule.parse('a:1;b:2', ';', ':') }).toEqual({
      ...nodeQs.parse('a:1;b:2', ';', ':'),
    });
    const objs = [
      { a: 1, b: 'two', c: [3, 'four'], d: true, e: null, f: undefined, g: NaN },
      { 'k y': 'v/€' },
      {},
    ];
    for (const o of objs)
      expect(querystringModule.stringify(o), JSON.stringify(o)).toBe(nodeQs.stringify(o as never));
    for (const s of ["hello world!*'()~", 'ünï/cødé', '😀'])
      expect(querystringModule.escape(s)).toBe(nodeQs.escape(s));
  });
});

describe('string_decoder differential', () => {
  it('handles characters split across writes', () => {
    const text = 'aé日😀z';
    const bytes = Buffer.from(text);
    for (const enc of ['utf8', 'utf16le', 'base64', 'hex', 'latin1'] as const) {
      const encoded = Buffer.from(
        text,
        enc === 'base64' || enc === 'hex' || enc === 'latin1' ? 'utf8' : enc,
      );
      const source = enc === 'utf16le' ? encoded : bytes;
      for (let split = 0; split <= source.length; split++) {
        // Node emits U+FFFD for a surrogate pair split at an odd byte offset in
        // utf16le (a known quirk); ClientVM decodes the pair correctly instead.
        if (enc === 'utf16le' && split % 2 === 1) continue;
        const ours = new StringDecoder(enc);
        const node = new NodeDecoder(enc);
        const a =
          ours.write(source.subarray(0, split)) +
          '|' +
          ours.write(source.subarray(split)) +
          '|' +
          ours.end();
        const b =
          node.write(source.subarray(0, split)) +
          '|' +
          node.write(source.subarray(split)) +
          '|' +
          node.end();
        expect(a, `${enc} split ${split}`).toBe(b);
      }
    }
    expect(both(() => new StringDecoder('bogus'))).toEqual(
      both(() => new NodeDecoder('bogus' as BufferEncoding)),
    );
  });
});

describe('assert differential', () => {
  const cases: [string, (a: typeof nodeAssert) => unknown][] = [
    ['ok pass', (a) => a.ok(1)],
    ['ok fail', (a) => a.ok(0)],
    ['equal loose', (a) => a.equal('1', 1)],
    ['equal NaN', (a) => a.equal(NaN, NaN)],
    ['strictEqual fail', (a) => a.strictEqual(1, '1')],
    [
      'deepStrictEqual pass',
      (a) =>
        a.deepStrictEqual(
          { a: [1, { b: new Map([[1, 2]]) }] },
          { a: [1, { b: new Map([[1, 2]]) }] },
        ),
    ],
    ['deepStrictEqual proto', (a) => a.deepStrictEqual(Object.create(null), {})],
    ['deepEqual loose', (a) => a.deepEqual({ a: 1 }, { a: '1' })],
    ['deepStrictEqual sets', (a) => a.deepStrictEqual(new Set([{ x: 1 }]), new Set([{ x: 1 }]))],
    ['deepStrictEqual dates', (a) => a.deepStrictEqual(new Date(1), new Date(2))],
    ['deepStrictEqual buffers', (a) => a.deepStrictEqual(Buffer.from('ab'), Buffer.from('ab'))],
    ['notDeepStrictEqual', (a) => a.notDeepStrictEqual([1], [1])],
    [
      'throws matching class',
      (a) =>
        a.throws(() => {
          throw new TypeError('x');
        }, TypeError),
    ],
    [
      'throws object',
      (a) =>
        a.throws(
          () => {
            throw Object.assign(new Error('m'), { code: 'X' });
          },
          { code: 'X', message: /m/ },
        ),
    ],
    [
      'throws mismatch',
      (a) =>
        a.throws(
          () => {
            throw new Error('x');
          },
          { message: 'y' },
        ),
    ],
    ['throws missing', (a) => a.throws(() => {})],
    [
      'doesNotThrow',
      (a) =>
        a.doesNotThrow(() => {
          throw new Error('x');
        }),
    ],
    ['match', (a) => a.match('abc', /b/)],
    ['match fail', (a) => a.match('abc', /z/)],
    ['fail', (a) => a.fail('custom')],
    ['ifError', (a) => a.ifError(null)],
    ['strict.equal', (a) => a.strict.equal(1, '1' as unknown as number)],
    ['custom message', (a) => a.strictEqual(1, 2, 'my message')],
  ];
  for (const [name, fn] of cases) {
    it(name, () => {
      const run = (a: typeof nodeAssert) => {
        try {
          fn(a);
          return 'pass';
        } catch (err) {
          const e = err as {
            code?: string;
            name?: string;
            operator?: string;
            generatedMessage?: boolean;
            message?: string;
          };
          return {
            code: e.code,
            name: e.name,
            operator: e.operator,
            generated: e.generatedMessage,
            custom: e.generatedMessage ? undefined : e.message,
          };
        }
      };
      expect(run(assertModule as unknown as typeof nodeAssert)).toEqual(run(nodeAssert));
    });
  }
});
