// SPDX-License-Identifier: Apache-2.0
// Checks a sandbox deployment against docs/hosting.md: the headers instance
// origins must send, and what they must never send. Run it against your own
// deployment before going live:
//
//   node scripts/check-sandbox-headers.mjs 'https://{id}.myapp-sandbox.dev' [--app https://myapp.example]
//
// `{id}` is replaced with a random instance id. `*.localhost` hosts resolve to
// 127.0.0.1, so the dev and preview servers can be checked too.
// Exits 1 if a requirement fails; warnings do not fail.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

const [template, ...rest] = process.argv.slice(2);
const appIndex = rest.indexOf('--app');
const app = appIndex >= 0 ? rest[appIndex + 1] : undefined;
if (!template || !template.includes('{id}')) {
  console.error(
    "usage: node scripts/check-sandbox-headers.mjs 'https://{id}.<sandbox-domain>' [--app <app origin>]",
  );
  process.exit(2);
}

const id = `check${Math.random().toString(36).slice(2, 10)}`;
const origin = new URL(template.replace('{id}', id)).origin;
const portOrigin = new URL(template.replace('{id}', `${id}-p3000`)).origin;

/**
 * GET `url`; `*.localhost` resolves to loopback as browsers do: to whatever
 * `localhost` resolves to (127.0.0.1 and/or ::1), since a server bound to
 * `localhost` may listen on only one of them.
 */
function get(url, headers = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        headers,
        lookup: u.hostname.endsWith('.localhost')
          ? (_host, opts, cb) => dns.lookup('localhost', opts, cb)
          : undefined,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const warn = (msg) => console.log(`  warn  ${msg}`);
const ok = (msg) => console.log(`  ok    ${msg}`);

function checkIsolation(name, h) {
  const expect = (header, value) =>
    String(h[header] ?? '').toLowerCase() === value
      ? ok(`${name}: ${header}: ${value}`)
      : fail(`${name}: ${header} must be "${value}" (got ${JSON.stringify(h[header] ?? null)})`);
  expect('document-isolation-policy', 'isolate-and-require-corp');
  expect('cross-origin-embedder-policy', 'require-corp');
  expect('cross-origin-resource-policy', 'cross-origin');
  if (h['set-cookie']) fail(`${name}: sets a cookie; the sandbox domain must never set cookies`);
  else ok(`${name}: no cookies`);
  const csp = String(h['content-security-policy'] ?? '');
  const ancestors = /frame-ancestors\s+([^;]+)/.exec(csp)?.[1]?.trim();
  if (!ancestors) warn(`${name}: no CSP frame-ancestors; any site can embed instance pages`);
  else if (app && !ancestors.split(/\s+/).includes(app))
    fail(`${name}: frame-ancestors (${ancestors}) does not list the app origin ${app}`);
  else ok(`${name}: frame-ancestors ${ancestors}`);
}

console.log(`Checking ${origin} (and port origin ${portOrigin})`);
try {
  const page = await get(
    `${origin}/__clientvm/instance.html?parent=${encodeURIComponent(app ?? 'https://app.invalid')}`,
  );
  if (page.status !== 200) fail(`instance page: HTTP ${page.status}`);
  checkIsolation('instance page', page.headers);

  const sw = await get(`${origin}/__clientvm/sw.js`, { 'service-worker': 'script' });
  if (sw.status !== 200) fail(`service worker: HTTP ${sw.status}`);
  if (sw.headers['service-worker-allowed'] === '/') ok('service worker: Service-Worker-Allowed: /');
  else fail('service worker: Service-Worker-Allowed must be "/"');
  if (/no-cache|no-store|max-age=0/.test(String(sw.headers['cache-control'] ?? '')))
    ok(`service worker: Cache-Control: ${sw.headers['cache-control']}`);
  else warn('service worker: send Cache-Control: no-cache so updates are picked up promptly');
  if (!/javascript/.test(String(sw.headers['content-type'] ?? '')))
    fail(`service worker: Content-Type must be JavaScript (got ${sw.headers['content-type']})`);

  const bridge = await get(`${portOrigin}/__clientvm/port.html`);
  if (bridge.status !== 200) fail(`port origin: HTTP ${bridge.status} (is the wildcard deployed?)`);
  checkIsolation('port origin', bridge.headers);
} catch (err) {
  fail(`request failed: ${err.message}`);
}

console.log(failures ? `\n${failures} requirement(s) failed` : '\nAll requirements met');
process.exit(failures ? 1 : 0);
