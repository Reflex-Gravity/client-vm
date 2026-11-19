// SPDX-License-Identifier: Apache-2.0
// A chat room on Express and ws: the e2e fixture's package.json and lockfile
// (test/fixtures/express-ws), so the install is the tested one, with a chat
// server and page. The page talks to the server over a WebSocket through the
// preview's service worker; bash posts into the same room with curl.
import type { DemoDefinition } from './types.ts';

const fixture = import.meta.glob<string>('../../../test/fixtures/express-ws/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const FIXTURE = '../../../test/fixtures/express-ws/';

const FILES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(fixture).map(([p, text]) => [p.slice(FIXTURE.length), text]),
  ),
  'server.js': `// A chat room: Express serves the page, ws carries the messages.
const http = require('http');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const history = [];

function broadcast(text) {
  history.push(text);
  if (history.length > 50) history.shift();
  for (const client of wss.clients) if (client.readyState === 1) client.send(text);
  console.log('chat: ' + text);
}

wss.on('connection', (ws) => {
  for (const text of history) ws.send(text);
  ws.on('message', (data) => broadcast(String(data)));
});

app.get('/', (req, res) => res.type('html').send(fs.readFileSync('index.html', 'utf8')));
// From bash: curl --data 'hi' localhost:3000/say
app.post('/say', express.text({ type: '*/*' }), (req, res) => {
  broadcast('bash: ' + req.body);
  res.end('sent\\n');
});
app.get('/clients', (req, res) => res.json({ connected: wss.clients.size }));

server.listen(3000, () => console.log('chat on http://localhost:3000'));
`,
  'index.html': `<!doctype html>
<meta charset="utf-8" />
<title>Chat</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  ul { list-style: none; padding: 0; min-height: 10rem; border: 1px solid #ddd; border-radius: 8px; }
  li { padding: 6px 10px; border-bottom: 1px solid #eee; }
  form { display: flex; gap: 8px; }
  input { flex: 1; padding: 8px; }
  #state { color: #888; font-size: 13px; }
</style>
<h1>Chat</h1>
<p id="state">connecting…</p>
<ul id="log"></ul>
<form id="f"><input id="msg" placeholder="Say something" autocomplete="off" /><button>Send</button></form>
<script type="module">
  const log = document.getElementById('log');
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
  ws.onopen = () => (document.getElementById('state').textContent = 'connected over a WebSocket');
  ws.onclose = () => (document.getElementById('state').textContent = 'disconnected');
  ws.onmessage = (e) => {
    const li = document.createElement('li');
    li.textContent = e.data;
    log.append(li);
  };
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('msg');
    if (input.value) ws.send('page: ' + input.value);
    input.value = '';
  };
</script>
`,
};

const demo: DemoDefinition = {
  files: FILES,
  editable: ['server.js', 'index.html', 'package.json'],
  bootNote: 'Booting the sandbox…',
  start: 'npm start',
  serverProcess: /\bserver\.js\b/,
  restartOn: { file: 'server.js', command: 'npm start' },
};
export default demo;
