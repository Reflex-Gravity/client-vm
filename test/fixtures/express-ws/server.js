// SPDX-License-Identifier: Apache-2.0
// Golden fixture: an Express app plus a ws server sharing one http.Server.
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.set('etag', false);
app.use(express.json());

app.get('/', (req, res) => {
  res.send(
    '<!doctype html><html><head><title>fixture</title></head><body><h1 id="t">Hello from Express</h1></body></html>',
  );
});
app.get('/api/info', (req, res) => {
  res.json({
    method: req.method,
    path: req.path,
    query: req.query,
    host: req.hostname !== undefined,
  });
});
app.post('/api/echo', (req, res) => res.status(201).set('x-echo', 'yes').json({ got: req.body }));
app.get('/stream', (req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  let i = 0;
  const timer = setInterval(() => {
    res.write(`chunk ${i}\n`);
    if (++i === 3) {
      clearInterval(timer);
      res.end('done\n');
    }
  }, 50);
});
app.get('/redirect', (req, res) => res.redirect('/api/info?from=redirect'));
app.use((req, res) => res.status(404).type('text').send(`no route for ${req.path}`));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  ws.send(`welcome ${req.url}`);
  ws.on('message', (data, isBinary) => {
    if (isBinary) ws.send(data, { binary: true });
    else if (String(data) === 'bye') ws.close(4000, 'requested');
    else ws.send(`echo: ${data}`);
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`listening on ${server.address().port}`));
