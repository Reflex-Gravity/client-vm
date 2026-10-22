// SPDX-License-Identifier: Apache-2.0
// curl over the browser's fetch. localhost URLs reach the instance's virtual
// ports; other origins are subject to CORS. Redirects are always followed
// (browsers do not expose 3xx responses), so -L is accepted and implied.

import { virtualUrl } from '@clientvm/node-compat';
import { NO_LISTENER_HEADER } from '@clientvm/protocol';
import type { CommandContext } from '../types.ts';
import { complain, parseOptions, resolvePath, withUsage } from './util.ts';

const encoder = new TextEncoder();

function formatWrite(fmt: string, res: Response, size: number, ms: number): string {
  return fmt
    .replace(/%\{(\w+)\}/g, (all, key: string) => {
      switch (key) {
        case 'http_code':
        case 'response_code':
          return String(res.status).padStart(3, '0');
        case 'content_type':
          return res.headers.get('content-type') ?? '';
        case 'size_download':
          return String(size);
        case 'url_effective':
          return res.url;
        case 'time_total':
          return (ms / 1000).toFixed(6);
        default:
          return all;
      }
    })
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

export async function curl(ctx: CommandContext): Promise<number> {
  return withUsage(
    ctx,
    async () => {
      const o = parseOptions(ctx.argv.slice(1), {
        short: 'sSLfIiOvkGg',
        shortArg: 'XHdoAuwTem',
        long: {
          silent: { name: 's' },
          'show-error': { name: 'S' },
          location: { name: 'L' },
          fail: { name: 'f' },
          'fail-with-body': { name: 'fail-with-body' },
          head: { name: 'I' },
          include: { name: 'i' },
          'remote-name': { name: 'O' },
          verbose: { name: 'v' },
          insecure: { name: 'k' },
          get: { name: 'G' },
          globoff: { name: 'g' },
          compressed: { name: 'compressed' },
          request: { name: 'X', arg: true },
          header: { name: 'H', arg: true },
          data: { name: 'd', arg: true },
          'data-raw': { name: 'data-raw', arg: true },
          'data-binary': { name: 'data-binary', arg: true },
          'data-urlencode': { name: 'data-urlencode', arg: true },
          json: { name: 'json', arg: true },
          output: { name: 'o', arg: true },
          'user-agent': { name: 'A', arg: true },
          user: { name: 'u', arg: true },
          'write-out': { name: 'w', arg: true },
          'upload-file': { name: 'T', arg: true },
          referer: { name: 'e', arg: true },
          'max-time': { name: 'm', arg: true },
          'connect-timeout': { name: 'connect-timeout', arg: true },
          retry: { name: 'retry', arg: true },
        },
      });
      const f = o.flags;
      const silent = f.has('s') && !f.has('S');
      if (o.operands.length === 0) {
        await complain(ctx, 'no URL specified');
        await ctx.stderr.write("curl: try 'curl --help' for more information\n");
        return 2;
      }
      const headers = new Headers();
      for (const h of o.list.filter((l) => l.name === 'H')) {
        const v = String(h.value);
        const colon = v.indexOf(':');
        if (colon > 0) headers.set(v.slice(0, colon).trim(), v.slice(colon + 1).trim());
      }
      const ua = f.get('A');
      if (typeof ua === 'string') headers.set('user-agent', ua);
      const user = f.get('u');
      if (typeof user === 'string') headers.set('authorization', `Basic ${btoa(user)}`);
      const referer = f.get('e');
      if (typeof referer === 'string') headers.set('referer', referer);

      // Request body: -d joins with '&' (reading @file, stripping newlines), --data-binary keeps bytes.
      const readArg = (v: string, raw: boolean): string => {
        if (raw || !v.startsWith('@')) return v;
        const file = v.slice(1);
        const text = new TextDecoder().decode(
          file === '-' ? new Uint8Array() : ctx.fs.readFileSync(resolvePath(ctx.cwd, file)),
        );
        return text;
      };
      const parts: string[] = [];
      for (const l of o.list) {
        const v = String(l.value);
        if (l.name === 'd') parts.push(readArg(v, false).replace(/[\r\n]/g, ''));
        else if (l.name === 'data-raw') parts.push(v);
        else if (l.name === 'data-binary') parts.push(readArg(v, false));
        else if (l.name === 'data-urlencode') {
          const eq = v.indexOf('=');
          parts.push(
            eq < 0
              ? encodeURIComponent(v)
              : `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`,
          );
        } else if (l.name === 'json') {
          parts.push(readArg(v, false));
          if (!headers.has('content-type')) headers.set('content-type', 'application/json');
          if (!headers.has('accept')) headers.set('accept', 'application/json');
        }
      }
      let body: BodyInit | undefined = parts.length > 0 ? parts.join('&') : undefined;
      if (body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded');
      }
      const upload = f.get('T');
      if (typeof upload === 'string') {
        body = ctx.fs.readFileSync(resolvePath(ctx.cwd, upload)) as Uint8Array<ArrayBuffer>;
      }
      let method = typeof f.get('X') === 'string' ? String(f.get('X')) : undefined;
      if (f.has('I')) method ??= 'HEAD';
      if (typeof upload === 'string') method ??= 'PUT';
      let url = o.operands[0]!;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
      if (f.has('G') && body !== undefined) {
        url += (url.includes('?') ? '&' : '?') + String(body);
        body = undefined;
      }
      method ??= body !== undefined ? 'POST' : 'GET';
      const maxTime = Number(f.get('m') ?? 0);
      const signal = maxTime > 0 ? AbortSignal.timeout(maxTime * 1000) : undefined;
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();

      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(virtualUrl(url) ?? url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (!silent) {
          const timedOut = (err as Error).name === 'TimeoutError';
          await ctx.stderr.write(
            timedOut
              ? `curl: (28) Operation timed out after ${maxTime * 1000} milliseconds\n`
              : `curl: (7) Failed to connect to ${host}: the request was blocked or the host is unreachable (browsers enforce CORS)\n`,
          );
        }
        return (err as Error).name === 'TimeoutError' ? 28 : 7;
      }
      if (virtualUrl(url) && res.headers.has(NO_LISTENER_HEADER)) {
        if (!silent) {
          const u = new URL(url);
          await ctx.stderr.write(
            `curl: (7) Failed to connect to ${u.hostname} port ${u.port || 80} after ${Date.now() - started} ms: Couldn't connect to server\n`,
          );
        }
        return 7;
      }
      if (f.has('v')) {
        await ctx.stderr.write(
          `> ${method} ${new URL(url).pathname}${new URL(url).search} HTTP/1.1\n`,
        );
        await ctx.stderr.write(`< HTTP/1.1 ${res.status} ${res.statusText}\n`);
        for (const [k, v] of res.headers) await ctx.stderr.write(`< ${k}: ${v}\n`);
      }
      if (f.has('f') && res.status >= 400) {
        if (!silent) {
          await ctx.stderr.write(`curl: (22) The requested URL returned error: ${res.status}\n`);
        }
        return 22;
      }
      const head = `HTTP/1.1 ${res.status} ${res.statusText}\r\n${[...res.headers]
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')}\r\n`;
      let outPath: string | null = null;
      const output = f.get('o');
      if (typeof output === 'string' && output !== '-') outPath = resolvePath(ctx.cwd, output);
      else if (f.has('O')) {
        const name = new URL(url).pathname.split('/').pop();
        if (!name) {
          await complain(ctx, '(23) Remote file name has no length');
          return 23;
        }
        outPath = resolvePath(ctx.cwd, name);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const emit = async (data: Uint8Array) => {
        size += data.length;
        if (outPath !== null) chunks.push(data);
        else await ctx.stdout.write(data);
      };
      if (f.has('i') || f.has('I')) await emit(encoder.encode(head));
      if (!f.has('I') && res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await emit(value);
        }
      }
      if (outPath !== null) {
        const all = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        ctx.fs.writeFileSync(outPath, all);
      }
      const w = f.get('w');
      if (typeof w === 'string') {
        await ctx.stdout.write(formatWrite(w, res, size, Date.now() - started));
      }
      return f.has('fail-with-body') && res.status >= 400 ? 22 : 0;
    },
    2,
  );
}
