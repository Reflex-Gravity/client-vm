// SPDX-License-Identifier: Apache-2.0
// Agent tools driving an app's preview: the page of the e2e fixture
// test/fixtures/drive-app (a counter, a form, console output), served from
// index.html so an agent's edit to it shows on the next load. No install. The
// chips make the tool calls a model would (@clientvm/agent-api).
import type { DemoDefinition } from './types.ts';

const FILES: Record<string, string> = {
  'server.js': `// A dependency-free server. It reads index.html on every request, so an
// edit to it shows on the next page load.
const http = require('http');
const fs = require('fs');

http
  .createServer((req, res) => {
    if (req.url === '/about') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><h1>About</h1><a href="/">Home</a>');
    }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync('index.html', 'utf8'));
  })
  .listen(5050, () => console.log('ready on http://localhost:5050'));
`,
  'index.html': `<!doctype html>
<html><head><title>Drive me</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: rgb(250, 240, 230); }
  form { margin: 1rem 0; display: flex; gap: 8px; align-items: center; }
</style>
</head><body>
  <h1>Todo</h1>
  <p id="status">0 items</p>
  <button id="add">Add item</button>
  <form id="f"><label for="name">Name</label><input id="name" name="name" placeholder="your name"><button type="submit">Save</button></form>
  <ul id="items"></ul>
  <a href="/about">About us</a>
  <script>
    let n = 0;
    document.getElementById('add').addEventListener('click', () => {
      n++;
      document.getElementById('status').textContent = n + ' items';
      const li = document.createElement('li');
      li.textContent = 'item ' + n;
      document.getElementById('items').append(li);
      console.log('added', n);
    });
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      document.getElementById('status').textContent = 'hello ' + document.getElementById('name').value;
      console.warn('submitted');
    });
  </script>
</body></html>
`,
};

const demo: DemoDefinition = {
  files: FILES,
  editable: ['index.html', 'server.js'],
  bootNote: 'Booting the sandbox…',
  start: 'node server.js &',
  install: false,
  background: true,
  serverProcess: /\bserver\.js\b/,
  agentTools: true,
};
export default demo;
