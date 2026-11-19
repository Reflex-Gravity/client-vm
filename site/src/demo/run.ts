// SPDX-License-Identifier: Apache-2.0
// The live demo's runtime half, loaded only when a visitor starts it: one
// ClientVM instance and a real `bash -i` in xterm.js. The setup is typed into
// that shell, as a visitor would type it, so the terminal shows npm install
// and then the server's own output, and Ctrl+C stops it. What it boots and
// types is a demo's definition (../demos/<slug>.ts).
// Patterned on examples/agent-playground/src/terminal.ts.
import { createClientVM } from '@clientvm/clientvm';
import type { Disposable, FileTree, Instance } from '@clientvm/clientvm';
import { attachShell, stripAnsi } from '@clientvm/terminal';
import type { InteractiveTerminalLike } from '@clientvm/terminal';
import type { AgentTools } from '@clientvm/agent-api';
import type { DemoDefinition, SetupStep } from '../demos/catalog.ts';

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
/** The most lines of a tool result the terminal shows. */
const TOOL_LINES = 14;

export interface DemoCallbacks {
  status(text: string): void;
  /** The setup reached this step (the progress strip in components/Demo.astro). */
  step(step: SetupStep): void;
  preview(url: string, port: number): void;
  /** A server stopped listening on `port`. */
  portClosed?(port: number): void;
  /** This browser has no cached copy of the preset yet, so it is built once. */
  firstRun?(): void;
}

interface XTerm extends InteractiveTerminalLike {
  /** xterm.js also takes raw bytes, which it decodes as UTF-8 across writes. */
  write(data: string | Uint8Array): void;
  open(element: HTMLElement): void;
  loadAddon(addon: object): void;
  focus(): void;
  dispose(): void;
}

function loadCss(): void {
  if (document.querySelector(`link[href="${XTERM_CSS}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = XTERM_CSS;
  link.integrity = XTERM_CSS_SRI;
  link.crossOrigin = 'anonymous';
  document.head.append(link);
}

/** An xterm.js terminal in `container`, fitted to it as it resizes. */
async function openTerminal(
  container: HTMLElement,
): Promise<{ term: XTerm; resize: ResizeObserver }> {
  loadCss();
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
  return { term, resize };
}

/** Another terminal on a running instance: its own bash, the visitor's alone. */
export interface ExtraTerminal {
  /** Types a command into this terminal and runs it, like RunningDemo.type. */
  type(command: string): Promise<void>;
  focus(): void;
  dispose(): void;
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
  /**
   * Makes one agent tool call, as a model would, and writes the call and its
   * result to the terminal. Only for demos with `agentTools`.
   */
  callTool(name: string, input: Record<string, unknown>): Promise<void>;
  /** Opens another bash on the same instance, in `container`. */
  newTerminal(container: HTMLElement): Promise<ExtraTerminal>;
  focus(): void;
  destroy(): Promise<void>;
}

/** Nests `src/App.jsx`-style paths into the tree a file tree wants. */
function tree(files: Record<string, string>): FileTree {
  const root: FileTree = {};
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const next = dir[part];
      if (typeof next === 'object' && !(next instanceof Uint8Array)) dir = next;
      else dir = dir[part] = {};
    }
    dir[parts.at(-1)!] = text;
  }
  return root;
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
export interface DemoOptions {
  /** Where the agent tools' preview of the app goes (demos with `agentTools`). */
  agentPreview?: HTMLElement;
}

export async function startDemo(
  demo: DemoDefinition,
  container: HTMLElement,
  cb: DemoCallbacks,
  opts: DemoOptions = {},
): Promise<RunningDemo> {
  cb.status('loading the terminal…');
  const { term, resize } = await openTerminal(container);

  let instance: Instance;
  cb.status('booting the sandbox…');
  cb.step('boot');
  term.write(note(demo.bootNote));
  try {
    let building = false;
    instance = await vm.createInstance({
      ...(demo.preset
        ? {
            preset: demo.preset,
            // Only the first visit builds the project, in a hidden builder;
            // later visits boot from this origin's Cache Storage. Its output
            // has no terminal of its own, so bare \n needs a \r here.
            onPresetBuild: (e) => {
              if (e.type === 'spawn') {
                if (!building) {
                  term.write(note('First start in this browser: building the project once'));
                  cb.firstRun?.();
                }
                building = true;
                const cmd = e.process.argv.at(-1) ?? '';
                term.write(`\x1b[2m$ ${stripAnsi(cmd).replace(/[\r\n]/g, ' ')}\x1b[0m\r\n`);
              } else if (e.type === 'output') {
                term.write(new TextDecoder().decode(e.data).replace(/\r?\n/g, '\r\n'));
              }
            },
          }
        : {
            fs: { from: { home: { user: { app: tree(demo.files) } } } },
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
  // A preset boots its own project; the demo's files are written over it.
  if (demo.preset) {
    for (const [file, text] of Object.entries(demo.files)) {
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
      cb.portClosed?.(p);
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
  if (demo.welcome) {
    // Green, not dim: it is the first thing to read.
    term.write(`\r\n${demo.welcome.map((l) => `\x1b[32m${l}\x1b[0m`).join('\r\n')}\r\n\r\n`);
  }
  await startShell();

  const setup = (async () => {
    await withTimeout(shell.prompt(), PROMPT_TIMEOUT_MS, 'The shell');
    const start = demo.start;
    if (start === undefined) {
      cb.step('ready');
      cb.status(`instance ${instance.id} · bash ready`);
      return;
    }
    const background = demo.background ?? false;
    const install = demo.install ?? true;
    if (install) {
      cb.status('installing packages…');
      cb.step('install');
    }
    const opened = new Promise<number>((resolve) => {
      const sub = instance.onPortOpen((p) => {
        sub.dispose();
        resolve(p);
      });
      subs.push(sub);
    });
    // The install is done once npm runs the server's script.
    const starting = instance.onProcess((e) => {
      if (e.type === 'spawn' && demo.serverProcess?.test(e.process.argv.join(' '))) {
        starting.dispose();
        cb.step('start');
        cb.status('starting the server…');
      }
    });
    subs.push(starting);
    if (background) {
      // Install in the foreground, then start the server as a background job.
      if (install) {
        shell.run(INSTALL);
        await withTimeout(shell.prompt(), SETUP_TIMEOUT_MS, 'npm install');
      }
      cb.step('start');
      cb.status('starting the server…');
      shell.run(start);
      const p = await withTimeout(opened, SERVER_TIMEOUT_MS, 'Starting the server');
      cb.step('ready');
      cb.status(`instance ${instance.id} · port ${p}`);
      return;
    }
    shell.run(install ? `${INSTALL} && ${start}` : start);
    // The prompt comes back only if npm install or the server stops.
    const stopped = shell.prompt().then(() => {
      throw new Error('the command stopped before the server opened a port');
    });
    const p = await withTimeout(Promise.race([opened, stopped]), SETUP_TIMEOUT_MS, 'Setup');
    cb.step('ready');
    cb.status(`instance ${instance.id} · port ${p}`);
  })();

  /**
   * A "try" typer for one shell. It serializes commands, so two clicks do not
   * type into each other.
   */
  const typer = (shell: ShellDriver, live: () => boolean) => {
    let typing = Promise.resolve();
    return (command: string): Promise<void> => {
      const next = typing.then(async () => {
        if (!live()) return;
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
            if (prompted || !live()) break;
            if (Date.now() > deadline) throw new Error('the command did not stop');
          }
        }
        shell.visitorTyped = false;
        for (const ch of command) {
          if (!live()) return;
          shell.send(ch);
          await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
        }
        shell.run('');
      });
      typing = next.catch(() => {});
      return next;
    };
  };
  const type = typer(shell, () => alive);

  // Vite reloads edits itself (HMR). Node has no --watch here, so on a change
  // to a demo's `restartOn` file the runner presses Ctrl+C in the terminal and
  // runs the server again.
  const restartOn = demo.restartOn;
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
      if (alive && restartOn) shell.run(restartOn.command);
    } catch {
      // the server did not stop; leave the terminal to the visitor
    } finally {
      restarting = false;
    }
  };
  if (restartOn) {
    subs.push(
      instance.fs.watch(`${APP}/${restartOn.file}`, () => {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => void setup.then(restart, () => {}), RESTART_DELAY_MS);
      }),
    );
  }

  // The agent tools load with the first tool chip.
  let tools: Promise<AgentTools> | undefined;
  const callTool = async (name: string, input: Record<string, unknown>): Promise<void> => {
    tools ??= import('@clientvm/agent-api').then(({ createAgentTools }) =>
      createAgentTools({
        instance,
        ...(opts.agentPreview ? { previewContainer: opts.agentPreview } : {}),
      }),
    );
    const t = await tools;
    if (!alive) return;
    term.write(`\r\n\x1b[36magent ▸ ${name} ${JSON.stringify(input)}\x1b[0m\r\n`);
    const result = await t.call(name, input);
    if (!alive) return;
    for (const block of result.content) {
      const text =
        block.type === 'text'
          ? block.text
          : `[a ${block.source.media_type} image, ${Math.round((block.source.data.length * 3) / 4 / 1024)} KB]`;
      const lines = text.split('\n');
      const shown = lines.slice(0, TOOL_LINES);
      if (lines.length > TOOL_LINES) shown.push(`… ${lines.length - TOOL_LINES} more lines`);
      const color = result.is_error ? '\x1b[31m' : '\x1b[2m';
      term.write(shown.map((l) => `${color}${l}\x1b[0m`).join('\r\n') + '\r\n');
    }
    // The prompt the shell drew before stays above; a fresh line reads better.
    shell.send('\r');
  };

  const extras = new Set<ExtraTerminal>();
  const newTerminal = async (box: HTMLElement): Promise<ExtraTerminal> => {
    const { term: extra, resize: extraResize } = await openTerminal(box);
    const driver = new ShellDriver(extra);
    let open = true;
    const start = async (): Promise<void> => {
      const session = await attachShell(driver.view, instance, { cwd: APP });
      void session.exit.then(() => {
        if (!open || !alive) return;
        extra.write(note('Starting a new shell…'));
        void start();
      });
    };
    await start();
    const handle: ExtraTerminal = {
      type: typer(driver, () => open && alive),
      focus: () => extra.focus(),
      dispose: () => {
        open = false;
        extras.delete(handle);
        extraResize.disconnect();
        extra.dispose();
      },
    };
    extras.add(handle);
    return handle;
  };

  return {
    instance,
    setup,
    type,
    callTool,
    newTerminal,
    focus: () => term.focus(),
    destroy: async () => {
      alive = false;
      clearTimeout(restartTimer);
      if (tools)
        void tools.then(
          (t) => t.dispose(),
          () => {},
        );
      for (const extra of [...extras]) extra.dispose();
      for (const s of subs) s.dispose();
      resize.disconnect();
      await instance.destroy().catch(() => {});
      term.dispose();
    },
  };
}
