// SPDX-License-Identifier: Apache-2.0
// What both playground pages share: where the sandbox is served, and the
// starter app each instance boots with.
import { createClientVM } from '@clientvm/clientvm';

// Where the sandbox host (packages/sandbox-host) is served. Each instance gets
// its own subdomain; *.localhost resolves to 127.0.0.1 in Chromium.
const SANDBOX = import.meta.env['VITE_SANDBOX'] ?? 'http://{id}.localhost:4173';

export const vm = createClientVM({ sandboxOrigin: (id) => SANDBOX.replace('{id}', id) });

export const STARTER = {
  'package.json': JSON.stringify(
    { name: 'app', private: true, scripts: { start: 'node server.js' } },
    null,
    2,
  ),
  'server.js': `const http = require('http');
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Hello from ClientVM</h1><p>Served by ' + process.version + ' at ' + req.url + '</p>');
  })
  .listen(3000, () => console.log('listening on 3000'));
`,
};
