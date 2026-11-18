// SPDX-License-Identifier: Apache-2.0
// The live demo's examples: what the picker shows, the setup steps the
// progress strip walks through and the commands the "try" chips type into the
// terminal. Plain data, so the page draws them without loading ClientVM
// (./run.ts boots the examples). The first one is selected to start with.

export type DemoMode = 'todo' | 'express' | 'shell';

export type SetupStep = 'boot' | 'install' | 'start' | 'ready';

export interface Trigger {
  label: string;
  command: string;
}

export interface Example {
  mode: DemoMode;
  name: string;
  /** A few words under the name. */
  tag: string;
  /** The start button's label. */
  start: string;
  steps: SetupStep[];
  triggers: Trigger[];
  /** What the empty preview says while this example runs. */
  previewHint: string;
}

export const EXAMPLES: Example[] = [
  {
    mode: 'todo',
    name: 'Todo app',
    tag: 'Vite + React · HMR',
    start: 'Start the todo app',
    steps: ['boot', 'install', 'start', 'ready'],
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
  },
  {
    mode: 'express',
    name: 'Express server',
    tag: 'npm install · server',
    start: 'Start an Express app',
    steps: ['boot', 'install', 'start', 'ready'],
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
  },
  {
    mode: 'shell',
    name: 'Shell & Node',
    tag: 'bash · instant',
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
  },
];

export const exampleOf = (mode: DemoMode): Example =>
  EXAMPLES.find((e) => e.mode === mode) ?? EXAMPLES[0]!;
