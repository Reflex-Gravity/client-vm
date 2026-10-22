// SPDX-License-Identifier: Apache-2.0
// The terminal page, like StackBlitz's: a real interactive shell (`bash -i`
// on a pseudo-terminal, through @clientvm/terminal's attachShell) in one tab,
// and everything the agent's tool calls run (attachActivityView) in another.
// Both are drawn by xterm.js.
import { createAgentTools } from '@clientvm/agent-api';
import { attachActivityView, attachShell } from '@clientvm/terminal';
import { STARTER, vm } from './sandbox.ts';

// The terminal emulator is the host app's choice, not a ClientVM dependency
// (ADR 0016). This page loads pinned xterm.js builds from a CDN; the import
// map in terminal.html pins their hashes, so altered files do not load.
const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs';
const FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs';

interface Disposable {
  dispose(): void;
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
  const [{ Terminal }, { FitAddon }] = (await Promise.all([
    import(/* @vite-ignore */ XTERM),
    import(/* @vite-ignore */ FIT),
  ])) as [{ Terminal: new (opts: object) => XTerm }, { FitAddon: new () => { fit(): void } }];
  const open = (id: string, extra: object = {}) => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      ...extra,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open($(id));
    // Hidden tabs have no size; fit when they are shown.
    new ResizeObserver(() => {
      if ($(id).offsetWidth > 0) fit.fit();
    }).observe($(id));
    return term;
  };
  const shellTerm = open('terminal', { cursorBlink: true });
  const agentTerm = open('agent-terminal', { disableStdin: true });
  shellTerm.write('\x1b[2mBooting a ClientVM instance…\x1b[0m\r\n');

  // Tabs: the user's shell, and what the agent runs.
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-tab]');
  for (const tab of tabs)
    tab.addEventListener('click', () => {
      for (const t of tabs) {
        t.setAttribute('aria-selected', String(t === tab));
        $(t.dataset['tab']!).hidden = t !== tab;
      }
      (tab.dataset['tab'] === 'terminal' ? shellTerm : agentTerm).focus();
    });

  const instance = await vm.createInstance({
    fs: { from: { home: { user: { app: { ...STARTER, ...DEMO_FILES } } } } },
    limits: { maxProcesses: 64, maxCpuMs: 30_000 },
  });
  $('status').textContent = `instance ${instance.id}`;
  instance.onPortOpen((port, url) => {
    $('url').textContent = `port ${port}`;
    $<HTMLIFrameElement>('preview').src = url;
  });

  // A real shell: prompt, history (↑/↓), Tab completion, Ctrl+C, programs that
  // read keys (npm's progress, prompts, Vite's shortcuts). Exits restart it.
  const startShell = async (): Promise<void> => {
    const session = await attachShell(shellTerm, instance, { cwd: APP });
    void session.exit.then(() => {
      shellTerm.write('\x1b[2mStarting a new shell…\x1b[0m\r\n');
      void startShell();
    });
  };
  await startShell();

  // The agent's commands, each with its output and how it ended.
  attachActivityView(agentTerm, instance, {
    filter: (p) => p.tag?.['source'] === 'agent',
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

  shellTerm.focus();
}

main().catch((err: unknown) => {
  $('status').textContent = `failed: ${String(err)}`;
});
