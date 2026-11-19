// SPDX-License-Identifier: Apache-2.0
import type { DemoDefinition } from './types.ts';

/**
 * The todo example: the Vite + React preset, with these files written over
 * it. Its API is a dev-server middleware in vite.config.ts that keeps the
 * todos in todos.json; the page polls it, so changes made from bash or in the
 * editor show within a second, and edits to the React code hot-reload.
 */
const FILES: Record<string, string> = {
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
  server: {
    // Previews come from the sandbox's own host, which Vite rejects with a 403 by
    // default. The server is a virtual port only that origin can reach.
    allowedHosts: true,
    watch: { ignored: ['**/todos.json'] },
  },
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

/**
 * The dev server runs as a background job, so bash prompts again and the
 * chips can curl it without stopping it; its stdin is /dev/null, so Vite does
 * not read the terminal. Vite clears the screen as it starts, which would wipe
 * npm's output above it.
 */
const demo: DemoDefinition = {
  preset: 'vite-react-ts',
  files: FILES,
  editable: ['src/App.tsx', 'todos.json', 'src/index.css', 'vite.config.ts', 'package.json'],
  bootNote: 'Booting a Vite + React project…',
  start: 'npm run dev -- --clearScreen false < /dev/null &',
  background: true,
  serverProcess: /\bvite\b/,
};
export default demo;
