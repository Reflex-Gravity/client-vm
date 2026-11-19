// SPDX-License-Identifier: Apache-2.0
// The shell demo: bash, Node and a few files, with nothing to install.
import type { DemoDefinition } from './types.ts';

/** The shell example's project: no dependencies, so nothing to install. */
const FILES: Record<string, string> = {
  'sales.csv': `date,region,amount
2026-01-04,north,120
2026-01-04,west,85
2026-01-05,north,140
2026-01-05,east,60
2026-01-06,west,95
2026-01-06,north,110
2026-01-07,south,70
2026-01-07,north,130
2026-01-08,west,90
2026-01-08,east,75
2026-01-09,north,150
2026-01-09,south,65
`,
  'fib.js': `// node fib.js 30: a little CPU work, timed with performance.now().
const n = Number(process.argv[2] ?? 25);
const fib = (k) => (k < 2 ? k : fib(k - 1) + fib(k - 2));
const t0 = performance.now();
const value = fib(n);
console.log(\`fib(\${n}) = \${value} in \${(performance.now() - t0).toFixed(1)} ms\`);
`,
  'serve.js': `// node serve.js &: a plain node:http server on port 8080, in the background.
const http = require('node:http');
const fs = require('node:fs');

function summary() {
  const rows = fs.readFileSync('sales.csv', 'utf8').trim().split('\\n').slice(1);
  const byRegion = {};
  for (const row of rows) {
    const [, region, amount] = row.split(',');
    byRegion[region] = (byRegion[region] ?? 0) + Number(amount);
  }
  return byRegion;
}

http
  .createServer((req, res) => {
    if (req.url === '/api/summary') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(summary()) + '\\n');
    }
    const totals = Object.entries(summary()).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...totals.map(([, v]) => v));
    const bars = totals
      .map(([r, v]) => \`<p style="display:flex;gap:12px;align-items:center">
  <span style="width:4rem">\${r}</span>
  <span style="height:14px;width:\${(v / max) * 60}%;background:#7be3b4"></span> \${v}</p>\`)
      .join('');
    res.setHeader('content-type', 'text/html');
    res.end(\`<!doctype html><body style="font-family:system-ui;margin:3rem">
<h1>Sales by region</h1>\${bars}
<p>Edit <code>sales.csv</code> and reload.</p></body>\`);
  })
  .listen(8080, () => console.log('serving on http://localhost:8080'));
`,
  'README.md': `# A bash shell, in your browser tab

Type into the terminal above, or press a "try" button and watch it type for you.
Everything runs in this tab: a real bash, Node.js 24 and npm.

## Look around

    ls -la
    cat sales.csv | head -5
    tail -n +2 sales.csv | cut -d, -f2 | sort | uniq -c | sort -rn

## Run Node.js

    node fib.js 30
    node -e "console.log(require('os').cpus().length, 'cores')"

## Start a server, then talk to it

    node serve.js &                     # the preview shows its page
    curl -s localhost:8080/api/summary
    jobs                                # then: fg, and Ctrl+C to stop it

## Change things

    echo '2026-01-10,east,200' >> sales.csv    # reload the preview
    git init -q && git add . && git commit -qm init && git log --oneline

You can edit any file here in the editor; changes save as you type.
`,
};

/**
 * Shown in the shell example's terminal before the first prompt. Short lines,
 * so a narrow terminal does not break them mid-word.
 */
const SHELL_WELCOME = [
  'Welcome to bash, running in your browser tab.',
  'Type a command, or press a "try" button above.',
  'Start with:  ls  ·  node fib.js 30  ·  node serve.js &',
  'README.md, in the editor below, has more ideas.',
];

const demo: DemoDefinition = {
  files: FILES,
  editable: ['README.md', 'serve.js', 'fib.js', 'sales.csv'],
  bootNote: 'Booting the sandbox…',
  welcome: SHELL_WELCOME,
};
export default demo;
