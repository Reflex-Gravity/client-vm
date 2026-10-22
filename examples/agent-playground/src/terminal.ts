// SPDX-License-Identifier: Apache-2.0
// The terminal page, like StackBlitz's: real interactive shells (`bash -i` on
// pseudo-terminals, through @clientvm/terminal's attachShell) in tabs (`+`
// opens another), and everything the agent's tool calls run
// (attachActivityView) in another tab. All are drawn by xterm.js, with search;
// scrollback survives a reload, and port URLs in output open the preview.
import { createAgentTools } from '@clientvm/agent-api';
import { attachActivityView, attachShell } from '@clientvm/terminal';
import { STARTER, vm } from './sandbox.ts';

// The terminal emulator is the host app's choice, not a ClientVM dependency
// (ADR 0016). This page loads pinned xterm.js builds from a CDN; the import
// map in terminal.html pins their hashes, so altered files do not load.
const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs';
const FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs';
const SEARCH = 'https://cdn.jsdelivr.net/npm/@xterm/addon-search@0.16.0/lib/addon-search.mjs';
/** sessionStorage: how many shell tabs were open, and each tab's scrollback (`persist`). */
const STORE = 'clientvm-playground:terminal';

interface Disposable {
  dispose(): void;
}

interface SearchAddon {
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
  clearDecorations(): void;
}

/** The parts of xterm.js this page uses. */
interface XTerm {
  readonly cols: number;
  readonly rows: number;
  open(element: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): Disposable;
  onResize(cb: (size: { cols: number; rows: number }) => void): Disposable;
  loadAddon(addon: object): void;
  focus(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const HOME = '/home/user';
const APP = `${HOME}/app`;

// Scripts the agent buttons run: progress over time, colours, a failure.
const DEMO_FILES: Record<string, string> = {
  'build.js': `const steps = ['Resolving modules', 'Transforming 42 files', 'Bundling', 'Minifying'];
let i = 0;
const timer = setInterval(() => {
  if (i === steps.length) {
    clearInterval(timer);
    console.log('\\x1b[32m✓ built in 1.6s\\x1b[0m');
    return;
  }
  console.log('\\x1b[36m[' + (i + 1) + '/' + steps.length + ']\\x1b[0m ' + steps[i++] + '…');
}, 400);
`,
  'test.js': `console.log('running 3 tests');
console.log('  \\x1b[32m✓\\x1b[0m adds numbers');
console.log('  \\x1b[32m✓\\x1b[0m renders the header');
console.error('  \\x1b[31m✗ submits the form\\x1b[0m');
console.error('    expected 201, got 500');
process.exit(1);
`,
};

const AGENT_ACTIONS: { label: string; tool: string; input: Record<string, unknown> }[] = [
  { label: 'Build', tool: 'exec', input: { command: 'node build.js', cwd: APP } },
  { label: 'Run tests (fails)', tool: 'exec', input: { command: 'node test.js', cwd: APP } },
  { label: 'Start server', tool: 'start_process', input: { command: 'npm start', cwd: APP } },
  { label: 'npm install ms', tool: 'exec', input: { command: 'npm install ms', cwd: APP } },
];

async function main(): Promise<void> {
  const [{ Terminal }, { FitAddon }, { SearchAddon }] = (await Promise.all([
    import(/* @vite-ignore */ XTERM),
    import(/* @vite-ignore */ FIT),
    import(/* @vite-ignore */ SEARCH),
  ])) as [
    { Terminal: new (opts: object) => XTerm },
    { FitAddon: new () => { fit(): void } },
    { SearchAddon: new () => SearchAddon },
  ];
  const searches = new Map<string, SearchAddon>();
  const previewUrls = new Map<number, string>();
  // Port links in output (attachShell's linkPorts) open in the preview pane.
  const linkHandler = {
    activate: (_event: MouseEvent, uri: string) => {
      if ([...previewUrls.values()].some((u) => uri.startsWith(u)))
        $<HTMLIFrameElement>('preview').src = uri;
      else window.open(uri, '_blank', 'noopener');
    },
  };
  const open = (id: string, extra: object = {}) => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      linkHandler,
      ...extra,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    searches.set(id, search);
    term.open($(id));
    // Hidden tabs have no size; fit when they are shown.
    new ResizeObserver(() => {
      if ($(id).offsetWidth > 0) fit.fit();
    }).observe($(id));
    return term;
  };
  const agentTerm = open('agent-terminal', { disableStdin: true });

  // Tabs: the user's shells, and what the agent runs.
  const terms = new Map<string, XTerm>([['agent-terminal', agentTerm]]);
  let active = 'terminal';
  const select = (id: string) => {
    active = id;
    for (const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      t.setAttribute('aria-selected', String(t.dataset['tab'] === id));
      $(t.dataset['tab']!).hidden = t.dataset['tab'] !== id;
    }
    terms.get(id)?.focus();
  };
  $('tabs').addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
    if (tab) select(tab.dataset['tab']!);
  });

  // Search in the visible terminal.
  $('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const query = $<HTMLInputElement>('search').value;
    const search = searches.get(active);
    if (!search || !query) return;
    const found = e.shiftKey ? search.findPrevious(query) : search.findNext(query);
    $('search-status').textContent = found ? 'found' : 'not found';
  });

  const instance = await vm.createInstance({
    fs: { from: { home: { user: { app: { ...STARTER, ...DEMO_FILES } } } } },
    limits: { maxProcesses: 64, maxCpuMs: 30_000 },
  });
  $('status').textContent = `instance ${instance.id}`;
  instance.onPortOpen((port, url) => {
    previewUrls.set(port, url);
    $('url').textContent = `port ${port}`;
    $<HTMLIFrameElement>('preview').src = url;
  });
  instance.onPortClose((port) => previewUrls.delete(port));

  // A real shell per tab: prompt, history (↑/↓), Tab completion, Ctrl+C,
  // programs that read keys (npm's progress, prompts, Vite's shortcuts).
  // Exits restart it.
  let shells = 0;
  const addShell = async (): Promise<void> => {
    const n = ++shells;
    const id = n === 1 ? 'terminal' : `terminal-${n}`;
    const pane = $('terminals').insertBefore(document.createElement('div'), $('agent-terminal'));
    pane.id = id;
    pane.className = 'term';
    const tab = $('tabs').insertBefore(document.createElement('button'), $('agent-terminal-tab'));
    tab.setAttribute('role', 'tab');
    tab.dataset['tab'] = id;
    tab.textContent = `Terminal ${n}`;
    const term = open(id, { cursorBlink: true });
    terms.set(id, term);
    select(id);
    sessionStorage.setItem(`${STORE}:tabs`, String(shells));
    const start = async (): Promise<void> => {
      const session = await attachShell(term, instance, {
        cwd: APP,
        persist: { key: `${STORE}:shell-${n}` },
      });
      void session.exit.then(() => {
        term.write('\x1b[2mStarting a new shell…\x1b[0m\r\n');
        void start();
      });
    };
    await start();
  };
  $('tabs').querySelector('[data-tab="agent-terminal"]')!.id = 'agent-terminal-tab';
  $('new-tab').addEventListener('click', () => void addShell());
  const restoredTabs = Number(sessionStorage.getItem(`${STORE}:tabs`) ?? '1') || 1;
  for (let i = 0; i < restoredTabs; i++) await addShell();
  select('terminal');

  // The agent's commands, each with its output and how it ended.
  attachActivityView(agentTerm, instance, {
    filter: (p) => p.tag?.['source'] === 'agent',
    persist: { key: `${STORE}:agent` },
  });
  agentTerm.write('\x1b[2mCommands the agent runs appear here.\x1b[0m\r\n');

  // ---------------------------------------------------------- agent actions
  const tools = createAgentTools({ instance });
  let serverProcess: number | undefined;
  const actions = $('actions');
  const call = async (tool: string, input: Record<string, unknown>) => {
    $('agent-result').textContent = `${tool}…`;
    // Show what the agent runs.
    document.querySelector<HTMLButtonElement>('[data-tab="agent-terminal"]')!.click();
    const r = await tools.call(tool, input, { tag: { button: tool } });
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    const started = /^process (\d+)/.exec(text);
    if (tool === 'start_process' && started) serverProcess = Number(started[1]);
    $('agent-result').textContent = `${r.is_error ? 'error · ' : ''}${text.split('\n')[0] ?? ''}`;
  };
  for (const action of AGENT_ACTIONS) {
    const button = actions.appendChild(document.createElement('button'));
    button.textContent = action.label;
    button.addEventListener('click', () => void call(action.tool, action.input));
  }
  const stop = actions.appendChild(document.createElement('button'));
  stop.textContent = 'Stop server';
  stop.addEventListener('click', () => {
    if (serverProcess === undefined) $('agent-result').textContent = 'no server started yet';
    else void call('stop_process', { process_id: serverProcess });
  });

  terms.get('terminal')?.focus();
}

main().catch((err: unknown) => {
  $('status').textContent = `failed: ${String(err)}`;
});
