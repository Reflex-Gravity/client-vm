// SPDX-License-Identifier: Apache-2.0
// The Express demo: a real npm install of Express, then its server, restarted
// when server.js changes (Node has no --watch here).
import type { DemoDefinition } from './types.ts';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'app',
      private: true,
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.21.2' },
    },
    null,
    2,
  ),
  'server.js': `const express = require('express');
const os = require('os');

const app = express();
app.get('/', (req, res) => {
  console.log(\`GET \${req.url}\`);
  res.send(\`<!doctype html>
<body style="font-family: system-ui; max-width: 36rem; margin: 4rem auto; line-height: 1.5">
  <h1>Hello from ClientVM</h1>
  <p>Express \${require('express/package.json').version} on Node \${process.version}
  (\${os.platform()}), running in your browser tab.</p>
  <p>Edit <code>server.js</code> in the editor. The server restarts as you type.</p>
</body>\`);
});
app.listen(3000, () => console.log('listening on http://localhost:3000'));
`,
  'README.md': `# Try

    ls node_modules | wc -l
    node -p "require('express/package.json').version"
    git init && git add . && git commit -qm init && git log --oneline
    npm install ms && node -p "require('ms')('2 days')"
`,
};

const demo: DemoDefinition = {
  files: FILES,
  editable: ['server.js', 'package.json', 'README.md'],
  bootNote: 'Booting the sandbox…',
  start: 'npm start',
  serverProcess: /\bserver\.js\b/,
  restartOn: { file: 'server.js', command: 'npm start' },
};
export default demo;
