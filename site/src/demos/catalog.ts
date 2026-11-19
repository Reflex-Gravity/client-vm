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
  {
    slug: 'agent-drives-preview',
    name: 'Agent drives the app',
    tag: 'agent tools · preview',
    summary:
      'The tool calls an AI agent makes: read the running app, click and type in it, check its console and edit its files.',
    category: 'Agents',
    builtWith: ['@clientvm/agent-api', 'Node.js 24', 'driveable preview'],
    start: 'Start the app for the agent',
    steps: ['boot', 'start', 'ready'],
    previewHint: 'The app shows here; the agent’s clicks and typing happen in it.',
    triggers: [
      { label: 'read the page', tool: { name: 'preview_snapshot', input: { port: 5050 } } },
      {
        label: 'click “Add item”',
        tool: { name: 'preview_click', input: { port: 5050, text: 'Add item' } },
      },
      {
        label: 'fill the form',
        tool: {
          name: 'preview_type',
          input: { port: 5050, selector: '#name', value: 'Ada', submit: true },
        },
      },
      { label: 'read the console', tool: { name: 'preview_console', input: { port: 5050 } } },
      {
        label: 'edit index.html',
        tool: {
          name: 'edit_file',
          input: {
            path: '/home/user/app/index.html',
            old_string: '<h1>Todo</h1>',
            new_string: '<h1>Edited by the agent</h1>',
          },
        },
      },
      {
        label: 'reload and read',
        tool: { name: 'preview_snapshot', input: { port: 5050, path: '/' } },
      },
    ],
    about: [
      'This is what an AI app builder does between a model’s turns. Each chip is one tool call from @clientvm/agent-api, made here in the browser exactly as it would be for a model’s tool_use block, and the terminal shows the call and the result the model would get back.',
      'The preview is the agent’s own: preview_snapshot reads it as a text outline with element refs, preview_click and preview_type drive it, and preview_console returns what the page logged. edit_file changes the project, and the next load shows the change.',
    ],
    code: `import { createAgentTools } from '@clientvm/agent-api';

const tools = createAgentTools({ instance: app, previewContainer });
// send tools.definitions to the model; for each tool_use block it returns:
const result = await tools.call('preview_click', { port: 5050, text: 'Add item' });`,
    source: 'site/src/demos/agent-drives-preview.ts',
    docs: [
      { label: 'Agent API', slug: 'agent-api' },
      { label: 'Security model', slug: 'security' },
    ],
  },
  {
    slug: 'vite8-tailwind',
    name: 'Tailwind on Vite 8',
    tag: 'Vite 8 · Tailwind 4',
    summary:
      'Vite 8, React 19 and Tailwind CSS 4, with rolldown, lightningcss and Tailwind’s oxide scanner running as WebAssembly.',
    category: 'Frameworks',
    builtWith: ['Vite 8', 'React 19', 'Tailwind CSS 4', 'WebAssembly'],
    start: 'Start Vite 8 with Tailwind',
    steps: BOOT_INSTALL_START,
    previewHint: 'The page shows here once Vite is ready.',
    triggers: [
      {
        label: 'swap the colour',
        command: "sed -i 's/emerald/rose/g' src/App.jsx && grep -c rose src/App.jsx",
      },
      {
        label: 'add a class',
        command: "sed -i 's/rounded-2xl bg-white/rounded-2xl bg-white -rotate-2/' src/App.jsx",
      },
      { label: 'build', command: 'npx vite build' },
      { label: 'list the build', command: 'ls -la dist/assets' },
      { label: 'stand-ins', command: 'ls /usr/local/lib/clientvm/standins' },
    ],
    about: [
      'Vite 8 and Tailwind 4 lean on native binaries: rolldown for bundling, lightningcss for CSS, and Tailwind’s oxide scanner. ClientVM swaps each for its official WebAssembly build of the same version, downloaded and integrity-checked on first use, so the project needs no changes.',
      'The package.json and lockfile are the ones the end-to-end tests install. Edit a class in App.jsx and the scanner finds it; Vite hot-reloads the CSS.',
    ],
    code: `const app = await vm.createInstance({ fs: { from: { home: { user: { app: project } } } } });

app.onPortOpen((port, url) => (preview.src = url));
// native rolldown, lightningcss and oxide are swapped for their WebAssembly builds
await app.exec('npm install && npm run dev', { cwd: '/home/user/app' });`,
    source: 'test/fixtures/vite8-tailwind',
    docs: [
      { label: 'WebAssembly stand-ins', slug: 'decisions/0013-wasm-stand-ins-for-native-packages' },
      { label: 'Compatibility', slug: 'compatibility' },
    ],
  },
  {
    slug: 'websocket-chat',
    name: 'WebSocket chat',
    tag: 'Express · ws',
    summary:
      'A chat room on Express and ws: the page talks to the server over a real WebSocket, and bash posts into the same room.',
    category: 'Servers',
    builtWith: ['Express 4', 'ws 8', 'npm 11'],
    start: 'Start the chat server',
    steps: BOOT_INSTALL_START,
    previewHint: 'The chat page shows here once the server listens.',
    triggers: [
      {
        label: 'say from bash',
        command: "curl -s --data 'hello from bash' localhost:3000/say",
      },
      { label: 'who is connected', command: 'curl -s localhost:3000/clients' },
      { label: 'start server', command: 'npm start' },
    ],
    about: [
      'The server is the unmodified ws package on an Express app. When the page opens a WebSocket to its own origin, the preview’s service worker hands it to the server listening inside the instance; nothing leaves the tab.',
      'Send a message in the page, or post one from bash with curl: every connected page gets it, and the server logs it in the terminal.',
    ],
    code: `const app = await vm.createInstance({ fs: { from: { home: { user: { app: chat } } } } });

app.onPortOpen((port, url) => (preview.src = url));
// the page's WebSocket reaches the ws server through the preview's service worker
await app.exec('npm install && npm start', { cwd: '/home/user/app' });`,
    source: 'site/src/demos/websocket-chat.ts',
    docs: [
      { label: 'Previews', slug: 'decisions/0008-sub-origin-per-port' },
      { label: 'Compatibility', slug: 'compatibility' },
    ],
  },
];

/** Each demo's files, loaded when it starts. */
const DEFINITIONS: Record<string, () => Promise<{ default: DemoDefinition }>> = {
  'todo-vite-react': () => import('./todo-vite-react.ts'),
  express: () => import('./express.ts'),
  shell: () => import('./shell.ts'),
  'agent-drives-preview': () => import('./agent-drives-preview.ts'),
  'vite8-tailwind': () => import('./vite8-tailwind.ts'),
  'websocket-chat': () => import('./websocket-chat.ts'),
};

export const demoOf = (slug: string): Demo | undefined => DEMOS.find((d) => d.slug === slug);

export async function loadDefinition(slug: string): Promise<DemoDefinition> {
  const load = DEFINITIONS[slug];
  if (!load) throw new Error(`no demo named ${slug}`);
  return (await load()).default;
}

/** For tests: every demo has a module. */
export const definitionSlugs = (): string[] => Object.keys(DEFINITIONS);
