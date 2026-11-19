// SPDX-License-Identifier: Apache-2.0
// Every demo's copy, steps and "try" chips, in the order pages list them. Plain
// data, so a page draws them without loading ClientVM; the runner loads a
// demo's files (./<slug>.ts) only when it starts. Each demo here proves a claim
// the landing page makes.
import type { Demo, DemoDefinition } from './types.ts';

export type { Demo, DemoDefinition, SetupStep, Trigger } from './types.ts';

const BOOT_INSTALL_START: Demo['steps'] = ['boot', 'install', 'start', 'ready'];

export const DEMOS: Demo[] = [
  {
    slug: 'todo-vite-react',
    name: 'Todo app',
    tag: 'Vite + React · HMR',
    summary:
      'A React todo app on the Vite dev server, with an API you can curl from bash and code that hot-reloads as you edit it.',
    category: 'Frameworks',
    builtWith: ['Vite 6', 'React', 'TypeScript', 'bash', 'git'],
    start: 'Start the todo app',
    steps: BOOT_INSTALL_START,
    previewHint: 'The todo app shows here once Vite is ready.',
    triggers: [
      { label: 'list todos', command: 'curl -s localhost:5173/api/todos' },
      {
        label: 'add from bash',
        command: `curl -s --json '{"title":"Added from bash"}' localhost:5173/api/todos`,
      },
      { label: 'tick #2', command: 'curl -s -X PATCH localhost:5173/api/todos/2' },
      { label: 'count open', command: `grep -c '"done": false' todos.json` },
      { label: 'type-check', command: 'npx tsc --noEmit -p tsconfig.json && echo types ok' },
      {
        label: 'git commit',
        command: 'git init -q && git add . && git commit -qm "todo app" && git log --oneline',
      },
    ],
    about: [
      'The vite-react-ts preset boots with its node_modules already installed. The demo writes its own files over it: a React app and a small API, written as a Vite dev-server middleware that keeps the todos in todos.json.',
      'The page polls the API, so a todo added with curl from bash, or typed into todos.json in the editor, shows up within a second. Edits to App.tsx or index.css hot-reload without a page reload.',
    ],
    code: `const app = await vm.createInstance({ preset: 'vite-react-ts' });
await app.fs.writeFile('/home/user/app/src/App.tsx', appSource);

app.onPortOpen((port, url) => (preview.src = url));
await app.exec('npm run dev', { cwd: '/home/user/app' });`,
    source: 'site/src/demos/todo-vite-react.ts',
    docs: [
      { label: 'Presets', slug: 'decisions/0018-presets-cached-on-host-origin' },
      { label: 'Compatibility', slug: 'compatibility' },
    ],
  },
  {
    slug: 'express',
    name: 'Express server',
    tag: 'npm install · server',
    summary:
      'A real npm install of Express from the registry, then its server, which restarts as you edit server.js.',
    category: 'Servers',
    builtWith: ['npm 11', 'Express 4', 'Node.js 24'],
    start: 'Start an Express app',
    steps: BOOT_INSTALL_START,
    previewHint: 'The page Express serves shows here once it is listening.',
    triggers: [
      { label: 'count packages', command: 'ls node_modules | wc -l' },
      {
        label: 'express version',
        command: `node -p "'express ' + require('express/package.json').version"`,
      },
      { label: 'add a package', command: `npm install ms && node -p "require('ms')('2 days')"` },
      {
        label: 'git commit',
        command: 'git init -q && git add . && git commit -qm init && git log --oneline',
      },
      { label: 'start server', command: 'npm start' },
    ],
    about: [
      'The instance starts with a package.json and a server.js, nothing else. The unmodified npm that Node 24 bundles installs Express and its dependencies from the registry, into the instance’s own filesystem.',
      'When server.js listens on port 3000, a service worker on the instance’s origin serves the page to the preview. Edit server.js in the editor and the demo restarts the server for you.',
    ],
    code: `const app = await vm.createInstance({
  fs: { from: { home: { user: { app: { 'package.json': pkg, 'server.js': server } } } } },
});

app.onPortOpen((port, url) => (preview.src = url));
await app.exec('npm install && npm start', { cwd: '/home/user/app' });`,
    source: 'site/src/demos/express.ts',
    docs: [
      { label: 'npm in ClientVM', slug: 'decisions/0012-npm-on-first-use' },
      { label: 'Previews', slug: 'decisions/0008-sub-origin-per-port' },
    ],
  },
  {
    slug: 'shell',
    name: 'Shell & Node',
    tag: 'bash · instant',
    summary:
      'An interactive bash with pipes, background jobs and Node.js, and no install step, so it is ready in a second.',
    category: 'Shell & tools',
    builtWith: ['bash', 'coreutils', 'Node.js 24', 'git'],
    start: 'Start a bash shell',
    steps: ['boot', 'ready'],
    previewHint:
      'Nothing is serving yet. Run node serve.js & (or press “serve in background”) to see a page here.',
    triggers: [
      { label: 'versions', command: 'uname -sr && node -v && npm -v' },
      {
        label: 'pipe a CSV',
        command: 'tail -n +2 sales.csv | cut -d, -f2 | sort | uniq -c | sort -rn',
      },
      { label: 'run node', command: 'node fib.js 30' },
      { label: 'serve in background', command: 'node serve.js &' },
      { label: 'curl it', command: 'curl -s localhost:8080/api/summary' },
      { label: 'list jobs', command: 'jobs' },
      { label: 'find & count', command: "find . -name '*.js' | xargs wc -l" },
    ],
    about: [
      'A real interactive bash on a pseudo-terminal: line editing, history, Tab completion, Ctrl+C, and job control with Ctrl+Z, fg and bg. The Linux commands are written in TypeScript and checked against bash and the GNU tools.',
      'Start node serve.js in the background and its page shows in the preview while the prompt stays free for curl.',
    ],
    code: `import { attachShell } from '@clientvm/terminal';

const box = await vm.createInstance({ fs: { from: projectFiles } });
await attachShell(term, box, { cwd: '/home/user/app' });`,
    source: 'site/src/demos/shell.ts',
    docs: [
      { label: 'Terminals and signals', slug: 'decisions/0017-pty-and-signals' },
      { label: 'Shell commands', slug: 'decisions/0011-in-process-shell-commands' },
    ],
  },
];

/** Each demo's files, loaded when it starts. */
const DEFINITIONS: Record<string, () => Promise<{ default: DemoDefinition }>> = {
  'todo-vite-react': () => import('./todo-vite-react.ts'),
  express: () => import('./express.ts'),
  shell: () => import('./shell.ts'),
};

export const demoOf = (slug: string): Demo | undefined => DEMOS.find((d) => d.slug === slug);

export async function loadDefinition(slug: string): Promise<DemoDefinition> {
  const load = DEFINITIONS[slug];
  if (!load) throw new Error(`no demo named ${slug}`);
  return (await load()).default;
}

/** For tests: every demo has a module. */
export const definitionSlugs = (): string[] => Object.keys(DEFINITIONS);
