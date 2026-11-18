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
const PROMPT_TIMEOUT_MS = 15_000;
const RESTART_DELAY_MS = 300;
/**
 * The tail of the shell's output when bash waits for a command:
 * `user@clientvm:~/app$ `, then a `\r` as the line editor puts the cursor back.
 */
const PROMPT = /\$ \r?$/;

export type DemoMode = 'express' | 'vite';

/** The files the editor opens, relative to APP; the first is shown. */
export const EDITABLE: Record<DemoMode, string[]> = {
  express: ['server.js', 'package.json', 'README.md'],
  vite: ['src/App.tsx', 'src/index.css', 'src/main.tsx', 'index.html', 'package.json'],
};

const START: Record<DemoMode, string> = { express: 'npm start', vite: 'npm run dev' };

export interface DemoCallbacks {
  status(text: string): void;
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
  term.write(note(mode === 'vite' ? 'Booting a Vite + React project…' : 'Booting the sandbox…'));
  try {
    let building = false;
    instance = await vm.createInstance({
      ...(mode === 'vite'
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
        : { fs: { from: { home: { user: { app: EXPRESS_APP } } } } }),
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
  await startShell();

  const setup = (async () => {
    await withTimeout(shell.prompt(), PROMPT_TIMEOUT_MS, 'The shell');
    cb.status('installing packages…');
    const opened = new Promise<number>((resolve) => {
      const sub = instance.onPortOpen((p) => {
        sub.dispose();
        resolve(p);
      });
      subs.push(sub);
    });
    shell.run(`npm install --no-audit --no-fund && ${START[mode]}`);
    // The prompt comes back only if npm install or the server stops.
    const stopped = shell.prompt().then(() => {
      throw new Error('the command stopped before the server opened a port');
    });
    const p = await withTimeout(Promise.race([opened, stopped]), SETUP_TIMEOUT_MS, 'Setup');
    cb.status(`instance ${instance.id} · port ${p}`);
  })();

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
      if (alive) shell.run(START.express);
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
