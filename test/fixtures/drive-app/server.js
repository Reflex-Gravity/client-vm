// SPDX-License-Identifier: Apache-2.0
// A dependency-free app for driving previews: a counter, a form, a second
// page, console output and an uncaught error.
const http = require('http');

const page = (title, body) => `<!doctype html>
<html><head><title>${title}</title>
<style>body { font-family: sans-serif; background: rgb(250, 240, 230); } .hidden { display: none; }</style>
</head><body>${body}</body></html>`;

const home = page(
  'Drive me',
  `<h1>Todo</h1>
  <p id="status">0 items</p>
  <button id="add">Add item</button>
  <form id="f"><label for="name">Name</label><input id="name" name="name" placeholder="your name"><button type="submit">Save</button></form>
  <ul id="items"></ul>
  <p class="hidden">secret text</p>
  <a href="/about">About us</a>
  <script>
    let n = 0;
    document.getElementById('add').addEventListener('click', () => {
      n++;
      document.getElementById('status').textContent = n + ' items';
      const li = document.createElement('li');
      li.textContent = 'item ' + n;
      document.getElementById('items').append(li);
      console.log('added', n, { n });
    });
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      document.getElementById('status').textContent = 'hello ' + document.getElementById('name').value;
      console.warn('submitted');
    });
    setTimeout(() => { throw new Error('boom after load'); }, 10);
  </script>`,
);

http
  .createServer((req, res) => {
    if (req.url === '/about') {
      res.setHeader('content-type', 'text/html');
      res.end(
        page(
          'About',
          '<h1>About</h1><a href="/">Home</a><script>console.info("about page")</script>',
        ),
      );
    } else if (req.url === '/data.json') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(home);
    }
  })
  .listen(5050, () => console.log('ready'));
