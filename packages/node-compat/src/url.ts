// SPDX-License-Identifier: Apache-2.0
import { codeError } from './buffer.ts';
import { querystringModule } from './querystring.ts';

/**
 * `url`: the WHATWG URL classes (the browser's), file-URL helpers, and the
 * legacy `url.parse` / `url.format` / `url.resolve` API that older packages use.
 */

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  if (!(u instanceof URL)) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "path" argument must be of type string or an instance of URL',
    );
  }
  if (u.protocol !== 'file:')
    throw codeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
  if (u.hostname !== '' && u.hostname !== 'localhost') {
    throw codeError(
      TypeError,
      'ERR_INVALID_FILE_URL_HOST',
      'File URL host must be "localhost" or empty on linux',
    );
  }
  const pathname = u.pathname;
  if (/%2f/i.test(pathname)) {
    throw codeError(
      TypeError,
      'ERR_INVALID_FILE_URL_PATH',
      'File URL path must not include encoded / characters',
    );
  }
  return decodeURIComponent(pathname);
}

export function pathToFileURL(path: string, resolve: (p: string) => string = (p) => p): URL {
  let resolved = resolve(path);
  // Keep a trailing slash the caller asked for (path.resolve strips it).
  if (path.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
  const url = new URL('file://');
  // Encode what the URL parser would otherwise interpret, as Node does.
  url.pathname = resolved
    .replace(/%/g, '%25')
    .replace(/\\/g, '%5C')
    .replace(/\n/g, '%0A')
    .replace(/\r/g, '%0D')
    .replace(/\t/g, '%09');
  if (resolved.includes('?')) url.pathname = url.pathname.replace(/\?/g, '%3F');
  if (resolved.includes('#')) url.pathname = url.pathname.replace(/#/g, '%23');
  return url;
}

export function urlToHttpOptions(url: URL) {
  const options: Record<string, unknown> = {
    protocol: url.protocol,
    hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ''}${url.search || ''}`,
    href: url.href,
  };
  if (url.port !== '') options['port'] = Number(url.port);
  if (url.username || url.password) {
    options['auth'] = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  }
  return options;
}

// ---------------------------------------------------------------- legacy API

/** Shape of a legacy Url object; every field is null when absent, as in Node. */
export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: string | Record<string, unknown> | null = null;
  pathname: string | null = null;
  path: string | null = null;
  href: string = '';
}

const SLASHED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:']);
const HOSTLESS_PROTOCOLS = new Set(['javascript:']);
// Characters Node escapes in the path/search/hash of a parsed URL.
const AUTO_ESCAPE: Record<string, string> = {
  '\t': '%09',
  '\n': '%0A',
  '\r': '%0D',
  ' ': '%20',
  '"': '%22',
  "'": '%27',
  '<': '%3C',
  '>': '%3E',
  '\\': '%5C',
  '^': '%5E',
  '`': '%60',
  '{': '%7B',
  '|': '%7C',
  '}': '%7D',
};

function autoEscape(s: string): string {
  let out = '';
  for (const ch of s) out += AUTO_ESCAPE[ch] ?? ch;
  return out;
}

export function urlParse(
  url: string | Url,
  parseQueryString = false,
  slashesDenoteHost = false,
): Url {
  if (url instanceof Url) return url;
  if (typeof url !== 'string') {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `The "url" argument must be of type string. Received ${typeof url}`,
    );
  }
  const result = new Url();
  let rest = url.trim();

  // Fragment and query split off first (a '#' or '?' anywhere ends the path).
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    result.hash = autoEscape(rest.slice(hashIdx));
    rest = rest.slice(0, hashIdx);
  }
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) {
    result.search = autoEscape(rest.slice(qIdx));
    result.query = result.search.slice(1);
    rest = rest.slice(0, qIdx);
  } else if (parseQueryString) {
    result.query = {};
  }
  if (parseQueryString && typeof result.query === 'string') {
    result.query = { ...querystringModule.parse(result.query) };
  } else if (parseQueryString && result.query === null) {
    result.query = {};
  }

  rest = rest.replace(/\\/g, '/');
  const proto = /^([a-z0-9.+-]+:)/i.exec(rest);
  if (proto) {
    result.protocol = proto[1]!.toLowerCase();
    rest = rest.slice(proto[1]!.length);
  }

  // As in Node: '//' after a protocol (or with slashesDenoteHost) starts a host, and
  // protocols outside the slashed set (mailto:, git+ssh:) also get a host parsed.
  const hasSlashes = (slashesDenoteHost || proto !== null) && rest.startsWith('//');
  const hostless = result.protocol !== null && HOSTLESS_PROTOCOLS.has(result.protocol);
  const opaqueWithHost = result.protocol !== null && !SLASHED_PROTOCOLS.has(result.protocol);
  if (!hostless && (hasSlashes || opaqueWithHost)) {
    if (hasSlashes) {
      rest = rest.slice(2);
      result.slashes = true;
    }
    let hostEnd = rest.search(/[/?#]/);
    if (hostEnd === -1) hostEnd = rest.length;
    let hostPart = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);
    const at = hostPart.lastIndexOf('@');
    if (at !== -1) {
      result.auth = decodeURIComponent(hostPart.slice(0, at));
      hostPart = hostPart.slice(at + 1);
    }
    const portMatch = /:([0-9]*)$/.exec(hostPart);
    if (portMatch) {
      if (portMatch[1] !== '') result.port = portMatch[1]!;
      hostPart = hostPart.slice(0, hostPart.length - portMatch[0].length);
    }
    let hostname = hostPart.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    result.hostname = hostname;
    result.host =
      (hostPart.startsWith('[') ? `[${hostname}]` : hostname) +
      (result.port ? `:${result.port}` : '');
  }

  if (rest) result.pathname = autoEscape(rest);
  if (
    result.protocol &&
    SLASHED_PROTOCOLS.has(result.protocol) &&
    result.hostname !== null &&
    !result.pathname
  ) {
    result.pathname = '/';
  }
  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ?? '') + (result.search ?? '');
  }
  result.href = urlFormat(result);
  return result;
}

export function urlFormat(obj: string | Url | URL | Partial<Url>, _options?: unknown): string {
  if (typeof obj === 'string') obj = urlParse(obj);
  if (obj instanceof URL) return obj.href;
  if (typeof obj !== 'object' || obj === null) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "urlObject" argument must be one of type object or string',
    );
  }
  const u = obj as Partial<Url>;
  let auth = u.auth ? `${encodeURIComponent(u.auth).replace(/%3A/i, ':')}@` : '';
  let protocol = u.protocol ?? '';
  if (protocol && !protocol.endsWith(':')) protocol += ':';
  let pathname = u.pathname ?? '';
  let hash = u.hash ?? '';
  let search = u.search ?? '';
  let host = '';
  if (u.host) {
    host = auth + u.host;
  } else if (u.hostname) {
    host =
      auth +
      (u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname);
    if (u.port) host += `:${u.port}`;
  }
  if (!search && u.query && typeof u.query === 'object' && Object.keys(u.query).length > 0) {
    search = `?${querystringModule.stringify(u.query as Record<string, unknown>)}`;
  }
  if (search && !search.startsWith('?')) search = `?${search}`;
  if (hash && !hash.startsWith('#')) hash = `#${hash}`;
  if (u.slashes || (protocol && SLASHED_PROTOCOLS.has(protocol))) {
    if (u.slashes || host) {
      if (pathname && !pathname.startsWith('/')) pathname = `/${pathname}`;
      host = `//${host}`;
    }
  }
  pathname = pathname.replace(/[?#]/g, encodeURIComponent);
  search = search.replace('#', '%23');
  auth = '';
  return protocol + host + pathname + search + hash + auth;
}

export function urlResolve(from: string, to: string): string {
  // The WHATWG resolver matches Node's legacy resolve for absolute bases; fall back
  // to path-style joining for relative bases.
  try {
    return new URL(to, new URL(from)).href;
  } catch {
    const base = new URL(from, 'resolve://x/');
    const resolved = new URL(to, base);
    if (resolved.protocol === 'resolve:') {
      const { pathname, search, hash } = resolved;
      return (from.startsWith('/') ? pathname : pathname.slice(1)) + search + hash;
    }
    return resolved.href;
  }
}

export const urlModule = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  Url,
  parse: urlParse,
  format: urlFormat,
  resolve: urlResolve,
  resolveObject: (from: string, to: string) => urlParse(urlResolve(from, to)),
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions,
  domainToASCII: (d: string) => {
    try {
      return new URL(`http://${d}`).hostname;
    } catch {
      return '';
    }
  },
  domainToUnicode: (d: string) => d,
};
