// SPDX-License-Identifier: Apache-2.0
// The live demo's runtime half, loaded only when a visitor starts it: one
// ClientVM instance and a real `bash -i` in xterm.js. The setup is typed into
// that shell, as a visitor would type it, so the terminal shows npm install
// and then the server's own output, and Ctrl+C stops it.
// Patterned on examples/agent-playground/src/terminal.ts.
import { createClientVM } from '@clientvm/clientvm';
import type { Disposable, Instance } from '@clientvm/clientvm';
import { attachShell, stripAnsi } from '@clientvm/terminal';
import type { InteractiveTerminalLike } from '@clientvm/terminal';
import type { DemoMode, SetupStep } from './examples.ts';

// The terminal emulator is the host app's choice (ADR 0016). These pinned
// builds come from a CDN; the import map in the page pins their hashes, so
// altered files do not load.
const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs';
const FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs';
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css';
const XTERM_CSS_SRI = 'sha384-n2n7twoohnW+d3myBKaUgl7DSiwidw6MkQy9oesGzkPpMjejKRR3XlnD+5yCdtBD';

/** Where the sandbox host is served; `{id}` is the instance or port label. */
const SANDBOX = import.meta.env.PUBLIC_SANDBOX ?? 'http://{id}.localhost:4173';
export const APP = '/home/user/app';
/** npm install plus the server's start. */
const SETUP_TIMEOUT_MS = 6 * 60_000;
/** A server started in the background, from its start to listening. */
const SERVER_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 15_000;
const RESTART_DELAY_MS = 300;
/**
 * The tail of the shell's output when bash waits for a command:
 * `user@clientvm:~/app$ `, then a `\r` as the line editor puts the cursor back.
 */
const PROMPT = /\$ \r?$/;

export type { DemoMode } from './examples.ts';

/** The files the editor opens, relative to APP; the first is shown. */
export const EDITABLE: Record<DemoMode, string[]> = {
  todo: ['src/App.tsx', 'todos.json', 'src/index.css', 'vite.config.ts', 'package.json'],
  express: ['server.js', 'package.json', 'README.md'],
  shell: ['README.md', 'serve.js', 'fib.js', 'sales.csv'],
};

/**
 * What setup runs after npm install. The shell example runs nothing. The todo
 * app's dev server runs as a background job, so bash prompts again and the
 * "try" commands can curl it without stopping it; its stdin is /dev/null, so
 * Vite does not read the terminal. Vite clears the screen as it starts, which
 * would wipe npm's output above it.
 */
const START: Record<DemoMode, string | undefined> = {
  todo: 'npm run dev -- --clearScreen false < /dev/null &',
  express: 'npm start',
  shell: undefined,
};
const BACKGROUND: Record<DemoMode, boolean> = { todo: true, express: false, shell: false };
/** How long each typed character of a "try" command waits. */
const TYPE_DELAY_MS = 14;
/** How long a "try" command waits for bash after a Ctrl+C before pressing it again. */
const INTERRUPT_RETRY_MS = 1500;
/** How long a "try" command lets a running command finish before pressing Ctrl+C. */
const SETTLE_MS = 700;
/**
 * On a terminal npm shows only a spinner until it is done; at the http level
 * it logs each registry fetch, so the install's progress shows.
 */
const INSTALL = 'npm install --no-audit --no-fund --loglevel http';

export interface DemoCallbacks {
  status(text: string): void;
  /** The setup reached this step (the progress strip in components/Demo.astro). */
  step(step: SetupStep): void;
  preview(url: string, port: number): void;
}

interface XTerm extends InteractiveTerminalLike {
  /** xterm.js also takes raw bytes, which it decodes as UTF-8 across writes. */
  write(data: string | Uint8Array): void;
  open(element: HTMLElement): void;
  loadAddon(addon: object): void;
  focus(): void;
  dispose(): void;
}

const EXPRESS_APP = {
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

/** The shell example's project: no dependencies, so nothing to install. */
const SHELL_APP = {
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

/**
 * The todo example: the Vite + React preset, with these files written over
 * it. Its API is a dev-server middleware in vite.config.ts that keeps the
 * todos in todos.json; the page polls it, so changes made from bash or in the
 * editor show within a second, and edits to the React code hot-reload.
 */
const TODO_FILES: Record<string, string> = {
  'vite.config.ts': `// The todo API, as a Vite dev-server middleware: /api/todos reads and
// writes todos.json. Edit the file, or curl the API from bash.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const DB = 'todos.json';
const load = (): Todo[] => JSON.parse(fs.readFileSync(DB, 'utf8'));
const save = (todos: Todo[]) => fs.writeFileSync(DB, JSON.stringify(todos, null, 2) + '\\n');

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value) + '\\n');
}

function readBody(req: IncomingMessage): Promise<{ title?: string }> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function todosApi(): Plugin {
  return {
    name: 'todos-api',
    configureServer(server) {
      server.middlewares.use('/api/todos', async (req, res) => {
        let todos: Todo[];
        try {
          todos = load();
        } catch (err) {
          return send(res, 500, { error: 'todos.json: ' + (err as Error).message });
        }
        if (req.method === 'GET') return send(res, 200, todos);

        if (req.method === 'POST') {
          const { title } = await readBody(req);
          if (!title) return send(res, 400, { error: 'a title is required' });
          const todo = { id: Math.max(0, ...todos.map((t) => t.id)) + 1, title, done: false };
          save([...todos, todo]);
          console.log('+ ' + todo.title);
          return send(res, 201, todo);
        }

        const todo = todos.find((t) => t.id === Number(req.url?.slice(1)));
        if (!todo) return send(res, 404, { error: 'no such todo' });
        if (req.method === 'PATCH') {
          todo.done = !todo.done;
          save(todos);
          console.log((todo.done ? '✓ ' : '○ ') + todo.title);
          return send(res, 200, todo);
        }
        if (req.method === 'DELETE') {
          save(todos.filter((t) => t !== todo));
          console.log('- ' + todo.title);
          return send(res, 200, todo);
        }
        send(res, 405, { error: 'method not allowed' });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), todosApi()],
  // todos.json is data, not source: writing it should not reload the page.
  server: { watch: { ignored: ['**/todos.json'] } },
});
`,
  // vite.config.ts uses Node's types, which the preset does not install, so
  // the type-check covers the app's own code.
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`,
  'todos.json':
    JSON.stringify(
      [
        { id: 1, title: 'Boot Node.js in a browser tab', done: true },
        { id: 2, title: 'Tick this off in the preview', done: false },
        { id: 3, title: 'Add one from bash with curl', done: false },
      ],
      null,
      2,
    ) + '\n',
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Todos</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'src/App.tsx': `import { useEffect, useState, type FormEvent } from 'react';

interface Todo {
  id: number;
  title: string;
  done: boolean;
}
type Filter = 'all' | 'active' | 'done';

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data as T;
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const refresh = () =>
    api<Todo[]>('GET', '/api/todos').then(
      (next) => {
        setTodos(next);
        setError('');
      },
      (err: Error) => setError(err.message),
    );

  // Polls, so todos added from bash or edited in todos.json show up here.
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setTitle('');
    await api('POST', '/api/todos', { title: title.trim() });
    void refresh();
  };
  // Both update the list at once, then save and re-read it from the API.
  const toggle = (todo: Todo) => {
    setTodos((all) => all.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)));
    void api('PATCH', \`/api/todos/\${todo.id}\`).then(refresh);
  };
  const remove = (todo: Todo) => {
    setTodos((all) => all.filter((t) => t.id !== todo.id));
    void api('DELETE', \`/api/todos/\${todo.id}\`).then(refresh);
  };

  const shown = todos.filter((t) => filter === 'all' || (filter === 'done') === t.done);
  const left = todos.filter((t) => !t.done).length;

  return (
    <main className="card">
      <header>
        <h1>Todos</h1>
        <span className="live">● live</span>
      </header>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
        />
        <button>Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul>
        {shown.map((todo) => (
          <li key={todo.id} className={todo.done ? 'done' : ''}>
            <input type="checkbox" checked={todo.done} onChange={() => toggle(todo)} />
            <span>{todo.title}</span>
            <button className="del" title="Delete" onClick={() => remove(todo)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <footer>
        <span>
          {left} {left === 1 ? 'item' : 'items'} left
        </span>
        <nav>
          {(['all', 'active', 'done'] as const).map((f) => (
            <button key={f} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </nav>
      </footer>
    </main>
  );
}
`,
  'src/index.css': `/* Try changing --accent: Vite hot-reloads it as you type. */
:root {
  --accent: #10b981;
  --ink: #18181b;
  --muted: #71717a;
  --line: #e4e4e7;
  font-family: system-ui, sans-serif;
  color: var(--ink);
  background: #f4f4f5;
}
body {
  margin: 0;
  padding: 48px 20px;
}
.card {
  max-width: 440px;
  margin: 0 auto;
  padding: 24px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 12px 40px -16px #0003;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
h1 {
  margin: 0 0 16px;
  font-size: 28px;
  letter-spacing: -0.02em;
}
.live {
  color: var(--accent);
  font-size: 12px;
}
form {
  display: flex;
  gap: 8px;
}
form input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
}
form input:focus {
  outline: 2px solid var(--accent);
  border-color: transparent;
}
button {
  font: inherit;
  cursor: pointer;
}
form button {
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
ul {
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--line);
}
li span {
  flex: 1;
}
li.done span {
  color: var(--muted);
  text-decoration: line-through;
}
li input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}
.del {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 20px;
  opacity: 0;
}
li:hover .del {
  opacity: 1;
}
footer {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
  color: var(--muted);
  font-size: 13px;
}
footer nav {
  display: flex;
  gap: 4px;
}
footer button {
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-transform: capitalize;
}
footer button.on {
  border-color: var(--line);
  color: var(--ink);
}
.error {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 13px;
}
`,
};

function loadCss(): void {
  if (document.querySelector(`link[href="${XTERM_CSS}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = XTERM_CSS;
  link.integrity = XTERM_CSS_SRI;
  link.crossOrigin = 'anonymous';
  document.head.append(link);
}

const vm = createClientVM({ sandboxOrigin: (id) => SANDBOX.replace('{id}', id) });

export interface RunningDemo {
  instance: Instance;
  /** Resolves once the server listens; rejects with what failed. */
  setup: Promise<void>;
  /**
   * Types a command into the terminal and runs it, as a visitor would. A
   * server in the foreground, or a half-typed line, gets a Ctrl+C first.
   */
  type(command: string): Promise<void>;
  focus(): void;
  destroy(): Promise<void>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

/** A dim line, for what the demo itself says. */
const note = (text: string) => `\x1b[2m${text}\x1b[0m\r\n`;

/**
 * Stands between xterm.js and the shell: passes keys and output through,
 * and lets the demo type commands and see when bash prompts again.
 */
class ShellDriver {
  private tail = '';
  private keys = new Set<(data: string) => void>();
  private waiters: (() => void)[] = [];
  /** bash is waiting for a command. */
  atPrompt = false;
  /** The visitor typed since the demo last ran a command. */
  visitorTyped = false;
  readonly view: InteractiveTerminalLike;

  constructor(term: XTerm) {
    const keys = this.keys;
    this.view = {
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      write: (data) => {
        term.write(data);
        this.tail = (this.tail + stripAnsi(data)).slice(-120);
        if (PROMPT.test(this.tail)) this.prompted();
      },
      onData: (listener) => {
        const sub = term.onData((data) => {
          this.visitorTyped = true;
          listener(data);
        });
        keys.add(listener);
        return {
          dispose: () => {
            sub.dispose();
            keys.delete(listener);
          },
        };
      },
      ...(term.onResize ? { onResize: term.onResize.bind(term) } : {}),
    };
  }

  private prompted(): void {
    this.atPrompt = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves when bash next shows its prompt (now, if it already is). */
  prompt(): Promise<void> {
    if (this.atPrompt) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Sends keys to the shell as if typed. */
  send(data: string): void {
    this.atPrompt = false;
    this.tail = '';
    for (const k of this.keys) k(data);
  }

  run(command: string): void {
    this.visitorTyped = false;
    this.send(`${command}\r`);
  }
}

/**
 * Boots the instance and attaches a shell, then types the setup into it in
 * `setup`. Rejects only if the sandbox cannot boot.
 */
export async function startDemo(
  mode: DemoMode,
  container: HTMLElement,
  cb: DemoCallbacks,
): Promise<RunningDemo> {
  loadCss();
  cb.status('loading the terminal…');
  const [{ Terminal }, { FitAddon }] = (await Promise.all([
    import(/* @vite-ignore */ XTERM),
    import(/* @vite-ignore */ FIT),
  ])) as [{ Terminal: new (opts: object) => XTerm }, { FitAddon: new () => { fit(): void } }];

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
    fontSize: 13,
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { background: '#07090b', foreground: '#e7e9ec', cursor: '#7be3b4' },
    linkHandler: {
      activate: (_e: MouseEvent, uri: string) => window.open(uri, '_blank', 'noopener'),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  const resize = new ResizeObserver(() => {
    if (container.offsetWidth > 0) fit.fit();
  });
  resize.observe(container);
  fit.fit();

  let instance: Instance;
  cb.status('booting the sandbox…');
  cb.step('boot');
  term.write(note(mode === 'todo' ? 'Booting a Vite + React project…' : 'Booting the sandbox…'));
  try {
    let building = false;
    instance = await vm.createInstance({
      ...(mode === 'todo'
        ? {
            preset: 'vite-react-ts' as const,
            // Only the first visit builds the project, in a hidden builder;
            // later visits boot from this origin's Cache Storage. Its output
            // has no terminal of its own, so bare \n needs a \r here.
            onPresetBuild: (e) => {
              if (e.type === 'spawn') {
                if (!building)
                  term.write(note('First start in this browser: building the project once'));
                building = true;
                const cmd = e.process.argv.at(-1) ?? '';
                term.write(`\x1b[2m$ ${stripAnsi(cmd).replace(/[\r\n]/g, ' ')}\x1b[0m\r\n`);
              } else if (e.type === 'output') {
                term.write(new TextDecoder().decode(e.data).replace(/\r?\n/g, '\r\n'));
              }
            },
          }
        : {
            fs: {
              from: { home: { user: { app: mode === 'shell' ? SHELL_APP : EXPRESS_APP } } },
            },
          }),
      limits: { maxProcesses: 64, maxCpuMs: 60_000 },
    });
  } catch (err) {
    term.write(
      note(`The sandbox could not start: ${err instanceof Error ? err.message : String(err)}`),
    );
    resize.disconnect();
    throw err;
  }
  cb.status(`instance ${instance.id}`);
  // The todo app is the Vite + React preset with its own files written over it.
  if (mode === 'todo') {
    for (const [file, text] of Object.entries(TODO_FILES)) {
      await instance.fs.writeFile(`${APP}/${file}`, text);
    }
  }

  let port: number | undefined;
  const subs: Disposable[] = [
    instance.onPortOpen((p, url) => {
      port = p;
      cb.preview(url, p);
    }),
    instance.onPortClose((p) => {
      if (p === port) port = undefined;
    }),
  ];

  // The visitor's shell, which the setup is typed into.
  const shell = new ShellDriver(term);
  let alive = true;
  const startShell = async (): Promise<void> => {
    const session = await attachShell(shell.view, instance, { cwd: APP });
    void session.exit.then(() => {
      if (!alive) return;
      term.write(note('Starting a new shell…'));
      void startShell();
    });
  };
  if (mode === 'shell') {
    // Green, not dim: it is the first thing to read.
    term.write(`\r\n${SHELL_WELCOME.map((l) => `\x1b[32m${l}\x1b[0m`).join('\r\n')}\r\n\r\n`);
  }
  await startShell();

  const setup = (async () => {
    await withTimeout(shell.prompt(), PROMPT_TIMEOUT_MS, 'The shell');
    const start = START[mode];
    if (start === undefined) {
      cb.step('ready');
      cb.status(`instance ${instance.id} · bash ready`);
      return;
    }
    const background = BACKGROUND[mode];
    cb.status('installing packages…');
    cb.step('install');
    const opened = new Promise<number>((resolve) => {
      const sub = instance.onPortOpen((p) => {
        sub.dispose();
        resolve(p);
      });
      subs.push(sub);
    });
    // The install is done once npm runs the server's script.
    const starting = instance.onProcess((e) => {
      if (e.type === 'spawn' && /\b(vite|server\.js)\b/.test(e.process.argv.join(' '))) {
        starting.dispose();
        cb.step('start');
        cb.status('starting the server…');
      }
    });
    subs.push(starting);
    if (background) {
      // Install in the foreground, then start the server as a background job.
      shell.run(INSTALL);
      await withTimeout(shell.prompt(), SETUP_TIMEOUT_MS, 'npm install');
      cb.step('start');
      cb.status('starting the server…');
      shell.run(start);
      const p = await withTimeout(opened, SERVER_TIMEOUT_MS, 'Starting the server');
      cb.step('ready');
      cb.status(`instance ${instance.id} · port ${p}`);
      return;
    }
    shell.run(`${INSTALL} && ${start}`);
    // The prompt comes back only if npm install or the server stops.
    const stopped = shell.prompt().then(() => {
      throw new Error('the command stopped before the server opened a port');
    });
    const p = await withTimeout(Promise.race([opened, stopped]), SETUP_TIMEOUT_MS, 'Setup');
    cb.step('ready');
    cb.status(`instance ${instance.id} · port ${p}`);
  })();

  /** Serializes "try" commands, so two clicks do not type into each other. */
  let typing = Promise.resolve();
  const type = (command: string): Promise<void> => {
    const next = typing.then(async () => {
      if (!alive) return;
      // A short command (the last chip's, say) may be about to finish.
      if (!shell.atPrompt) {
        await Promise.race([shell.prompt(), new Promise((r) => setTimeout(r, SETTLE_MS))]);
      }
      if (!shell.atPrompt || shell.visitorTyped) {
        // ^C stops a foreground server, or clears a half-typed line. A command
        // that is still starting can miss it, so it is pressed again until
        // bash prompts.
        const deadline = Date.now() + PROMPT_TIMEOUT_MS;
        for (;;) {
          shell.send('\x03');
          const prompted = await Promise.race([
            shell.prompt().then(() => true),
            new Promise<false>((r) => setTimeout(() => r(false), INTERRUPT_RETRY_MS)),
          ]);
          if (prompted || !alive) break;
          if (Date.now() > deadline) throw new Error('the command did not stop');
        }
      }
      shell.visitorTyped = false;
      for (const ch of command) {
        if (!alive) return;
        shell.send(ch);
        await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
      }
      shell.run('');
    });
    typing = next.catch(() => {});
    return next;
  };

  // Vite reloads edits itself (HMR). Node has no --watch here, so on a change
  // to server.js the demo presses Ctrl+C in the terminal and runs the server again.
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restarting = false;
  const restart = async () => {
    if (restarting || !alive) return;
    restarting = true;
    try {
      if (!shell.atPrompt && port !== undefined) {
        shell.send('\x03');
        await withTimeout(shell.prompt(), PROMPT_TIMEOUT_MS, 'Stopping the server');
      } else if (!shell.atPrompt || shell.visitorTyped) {
        return; // the visitor is running or typing something else
      }
      if (alive) shell.run('npm start');
    } catch {
      // the server did not stop; leave the terminal to the visitor
    } finally {
      restarting = false;
    }
  };
  if (mode === 'express') {
    subs.push(
      instance.fs.watch(`${APP}/server.js`, () => {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => void setup.then(restart, () => {}), RESTART_DELAY_MS);
      }),
    );
  }

  return {
    instance,
    setup,
    type,
    focus: () => term.focus(),
    destroy: async () => {
      alive = false;
      clearTimeout(restartTimer);
      for (const s of subs) s.dispose();
      resize.disconnect();
      await instance.destroy().catch(() => {});
      term.dispose();
    },
  };
}
