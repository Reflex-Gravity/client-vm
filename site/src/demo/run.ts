// SPDX-License-Identifier: Apache-2.0
// The live demo's runtime half, loaded only when a visitor starts it: one
// ClientVM instance, a real `bash -i` in xterm.js, and a setup that installs
// the project's packages and starts its server, streamed live into a SetupLog.
// Patterned on examples/agent-playground/src/terminal.ts.
import { createClientVM } from '@clientvm/clientvm';
import type { Instance } from '@clientvm/clientvm';
import { attachShell } from '@clientvm/terminal';
import type { InteractiveTerminalLike } from '@clientvm/terminal';
import { SetupLog } from './setup-log.ts';

export { SetupLog };

// The terminal emulator is the host app's choice (ADR 0016). These pinned
// builds come from a CDN; the import map in the page pins their hashes, so
// altered files do not load.
const XTERM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs';
const FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs';
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css';
const XTERM_CSS_SRI = 'sha384-n2n7twoohnW+d3myBKaUgl7DSiwidw6MkQy9oesGzkPpMjejKRR3XlnD+5yCdtBD';

/** Where the sandbox host is served; `{id}` is the instance or port label. */
const SANDBOX = import.meta.env.PUBLIC_SANDBOX ?? 'http://{id}.localhost:4173';
const APP = '/home/user/app';
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PORT_TIMEOUT_MS = 90_000;
/** Tags the setup's processes, so the log follows them and nothing the visitor runs. */
const TAG = { source: 'demo-setup' };

export type DemoMode = 'express' | 'vite';
export type Stage = 'sandbox' | 'packages' | 'server';

export interface DemoCallbacks {
  status(text: string): void;
  stage(stage: Stage): void;
  preview(url: string, port: number): void;
}

interface XTerm extends InteractiveTerminalLike {
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
  res.send(\`<!doctype html>
<body style="font-family: system-ui; max-width: 36rem; margin: 4rem auto; line-height: 1.5">
  <h1>Hello from ClientVM</h1>
  <p>Express \${require('express/package.json').version} on Node \${process.version}
  (\${os.platform()}), running in your browser tab.</p>
  <p>Edit <code>server.js</code> in the terminal, then restart it with <code>npm start</code>.</p>
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
  /** Installs packages and starts the server; rejects with what failed. */
  setup: Promise<void>;
  focus(): void;
  destroy(): Promise<void>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

/**
 * Boots the instance (the "sandbox" stage) and attaches a shell, then runs
 * the rest of the setup in `setup`. Rejects only if the sandbox cannot boot.
 */
export async function startDemo(
  mode: DemoMode,
  container: HTMLElement,
  log: SetupLog,
  cb: DemoCallbacks,
): Promise<RunningDemo> {
  loadCss();
  cb.stage('sandbox');
  cb.status('loading the terminal…');
  log.info('Loading the terminal');
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
  log.info(mode === 'vite' ? 'Booting a Vite + React project' : 'Booting the sandbox');
  try {
    let building = false;
    instance = await vm.createInstance({
      ...(mode === 'vite'
        ? {
            preset: 'vite-react-ts' as const,
            // Only the first visit builds the project; later visits boot from
            // this origin's Cache Storage. Builder pids are negated so they
            // never share partial-line state with the instance's processes.
            onPresetBuild: (e) => {
              if (e.type === 'spawn') {
                if (!building) log.info('First start in this browser: building the project once');
                building = true;
                log.spawn(e.process.argv);
              } else if (e.type === 'output') log.output(-e.pid, e.fd, e.data);
              else log.exit(-e.pid, e.code);
            },
          }
        : { fs: { from: { home: { user: { app: EXPRESS_APP } } } } }),
      limits: { maxProcesses: 64, maxCpuMs: 60_000 },
    });
  } catch (err) {
    resize.disconnect();
    term.dispose();
    log.info(`The sandbox could not start: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  log.info(`Sandbox ${instance.id} is up`);
  cb.status(`instance ${instance.id}`);

  // Follow only the processes the setup starts.
  const ours = new Set<number>();
  const processSub = instance.onProcess((e) => {
    if (e.type === 'spawn') {
      if (e.process.tag?.['source'] !== TAG.source) return;
      ours.add(e.process.pid);
      log.spawn(e.process.argv);
    } else if (!ours.has(e.pid)) {
      return;
    } else if (e.type === 'output') {
      log.output(e.pid, e.fd, e.data);
    } else {
      ours.delete(e.pid);
      log.exit(e.pid, e.code);
    }
  });
  instance.onPortOpen((port, url) => cb.preview(url, port));

  // The visitor's shell, usable while the setup runs.
  term.write(
    '\x1b[2mSetting up: npm install, then the server. Progress is on the right.\x1b[0m\r\n',
  );
  let alive = true;
  const startShell = async (): Promise<void> => {
    const session = await attachShell(term, instance, { cwd: APP });
    void session.exit.then(() => {
      if (!alive) return;
      term.write('\x1b[2mStarting a new shell…\x1b[0m\r\n');
      void startShell();
    });
  };
  await startShell();
  term.focus();

  const setup = (async () => {
    cb.stage('packages');
    cb.status('installing packages…');
    log.info(mode === 'vite' ? 'Checking the installed packages' : 'Installing express');
    // --loglevel http prints a line per registry fetch, so progress shows without a TTY.
    const res = await instance.exec('npm install --no-audit --no-fund --loglevel http', {
      cwd: APP,
      timeoutMs: INSTALL_TIMEOUT_MS,
      tag: { ...TAG, step: 'install' },
    });
    if (res.code !== 0) throw new Error(`npm install failed with exit code ${res.code}`);

    cb.stage('server');
    cb.status('starting the server…');
    log.info(mode === 'vite' ? 'Starting the Vite dev server' : 'Starting the Express server');
    const opened = new Promise<number>((resolve) => {
      const sub = instance.onPortOpen((port) => {
        sub.dispose();
        resolve(port);
      });
    });
    const proc = await instance.spawn('npm', mode === 'vite' ? ['run', 'dev'] : ['start'], {
      cwd: APP,
      tag: { ...TAG, step: 'server' },
    });
    // Always drain output: ClientVM buffers unread output. The log reads it
    // through onProcess.
    void proc.stdout.pipeTo(new WritableStream()).catch(() => {});
    void proc.stderr.pipeTo(new WritableStream()).catch(() => {});
    const exited = proc.exit.then(({ code }) => {
      throw new Error(`the server exited with code ${code} before opening a port`);
    });
    const port = await withTimeout(Promise.race([opened, exited]), PORT_TIMEOUT_MS, 'Server start');
    log.info(`Listening on port ${port}`);
    cb.status(`instance ${instance.id} · port ${port}`);
  })();
  setup.catch((err: unknown) => {
    log.info(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    instance,
    setup,
    focus: () => term.focus(),
    destroy: async () => {
      alive = false;
      processSub.dispose();
      resize.disconnect();
      await instance.destroy().catch(() => {});
      term.dispose();
    },
  };
}
