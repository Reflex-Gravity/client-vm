// SPDX-License-Identifier: Apache-2.0
import type { Disposable, Instance, Process, ProcessTag, Signal } from '@clientvm/clientvm';
import { createSanitizer } from './sanitize.ts';
import type { TerminalLike } from './view.ts';

/**
 * A terminal emulator that takes keyboard input and has a size. An xterm.js
 * `Terminal` fits as is.
 */
export interface InteractiveTerminalLike extends TerminalLike {
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): Disposable;
  onResize?(listener: (size: { cols: number; rows: number }) => void): Disposable;
}

export interface AttachShellOptions {
  /** The program to run (default `bash`, with `-i`). */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Labels the process for `Instance.onProcess` listeners (default `{ source: 'terminal' }`). */
  tag?: ProcessTag;
  /** Written when the program exits (default: a dim `[process exited with code N]` line). */
  exitMessage?: (exit: { code: number; signal?: Signal }) => string;
}

export interface ShellSession extends Disposable {
  readonly process: Process;
  readonly exit: Promise<{ code: number; signal?: Signal }>;
}

/**
 * Runs an interactive shell on a pseudo-terminal (ADR 0017) and connects it
 * to `term`: keys go to the shell, its output is drawn, and resizes reach it
 * as SIGWINCH. Escape sequences that could reach outside the terminal
 * (clipboard writes, hyperlinks) are removed from the output.
 * `dispose()` disconnects and hangs up the shell (SIGHUP).
 */
export async function attachShell(
  term: InteractiveTerminalLike,
  instance: Pick<Instance, 'spawn'>,
  opts: AttachShellOptions = {},
): Promise<ShellSession> {
  const command = opts.command ?? 'bash';
  const args = opts.args ?? (opts.command === undefined ? ['-i'] : []);
  const proc = await instance.spawn(command, args, {
    pty: { cols: term.cols, rows: term.rows },
    tag: opts.tag ?? { source: 'terminal' },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const stdin = proc.stdin.getWriter();
  const encoder = new TextEncoder();
  const sanitize = createSanitizer();
  let attached = true;

  const pumping = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      if (!attached) continue;
      const text = sanitize(decoder.decode(chunk, { stream: true }));
      if (text) term.write(text);
    }
  })();
  // stderr is empty on a terminal (its output is the terminal's); drain it anyway.
  void proc.stderr.pipeTo(new WritableStream()).catch(() => {});

  const subs: Disposable[] = [
    term.onData((data) => {
      if (attached) void stdin.write(encoder.encode(data)).catch(() => {});
    }),
  ];
  if (term.onResize)
    subs.push(
      term.onResize(({ cols, rows }) => {
        if (attached) proc.resize(cols, rows);
      }),
    );

  const exit = proc.exit.then(async (e) => {
    await pumping.catch(() => {});
    if (attached) {
      const message =
        opts.exitMessage?.(e) ??
        `\r\n\x1b[2m[process exited with ${e.signal ?? `code ${e.code}`}]\x1b[0m\r\n`;
      if (message) term.write(message);
    }
    for (const s of subs) s.dispose();
    return e;
  });

  return {
    process: proc,
    exit,
    dispose() {
      if (!attached) return;
      attached = false;
      for (const s of subs) s.dispose();
      proc.kill('SIGHUP');
    },
  };
}
