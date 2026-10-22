// SPDX-License-Identifier: Apache-2.0
// Pseudo-terminals, signals and the interactive shell (ADR 0017), driven
// through `Instance.spawn(..., { pty })` as a terminal emulator would.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

/**
 * The output as text: colour and cursor sequences removed, line ends as \n,
 * the carriage returns of prompt redraws dropped, and echoed backspaces applied.
 */
const plain = (s: string) => {
  let text = s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '');
  // eslint-disable-next-line no-control-regex
  for (let prev = ''; prev !== text;) [prev, text] = [text, text.replace(/[^\n\x08]\x08/, '')];
  return text;
};

async function terminal(page: Page, id: string, args = ['-i'], cmd = 'bash', prompt = true) {
  const pid = await host(page, 'openTerminal', id, cmd, args, { cols: 80, rows: 24 });
  let mark = 0;
  const t = {
    pid,
    type: (text: string) => host(page, 'terminalInput', pid, text),
    /** Output since the last `mark()`. */
    since: async () => plain(await host(page, 'terminalOutput', pid, mark)),
    mark: async () => void (mark = (await host(page, 'terminalOutput', pid)).length),
    /** Waits until the output since the mark matches. */
    expect: (re: RegExp, timeout = 10_000) => expect.poll(() => t.since(), { timeout }).toMatch(re),
    /** Types a line and waits for the next prompt. */
    run: async (line: string) => {
      await t.mark();
      await t.type(`${line}\r`);
      await t.expect(/\n[^\n]*\$ $/);
      return t.since();
    },
  };
  if (prompt)
    await expect.poll(async () => plain(await host(page, 'terminalOutput', pid))).toMatch(/\$ $/);
  return t;
}

test.describe('pseudo-terminals', () => {
  test.setTimeout(60_000);

  test('bash -i: prompt, a terminal for programs, $?, exit status', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const t = await terminal(page, id);
    expect(await t.run('echo hello $((6*7))')).toContain('\nhello 42\n');
    expect(
      await t.run(
        `node -e "const tty=require('tty');console.log(process.stdout.isTTY, process.stdout.columns, process.stdout.rows, tty.isatty(0), process.env.TERM, process.stdout.getColorDepth())"`,
      ),
    ).toContain('\ntrue 80 24 true xterm-256color 8\n');
    // Inside a pipe, stdout is not the terminal.
    expect(await t.run(`node -e "console.log(process.stdout.isTTY === true)" | cat`)).toContain(
      '\nfalse\n',
    );
    expect(await t.run('false; echo status=$?')).toContain('status=1');
    await t.type('exit 3\r');
    await expect.poll(() => host(page, 'terminalExit', t.pid)).toEqual({ code: 3 });
  });

  test('Ctrl+C: stops in-process commands and programs; a handled SIGINT continues the line', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const t = await terminal(page, id);
    for (const cmd of ['sleep 30; echo not reached', 'node -e "setInterval(() => {}, 1000)"']) {
      await t.mark();
      await t.type(`${cmd}\r`);
      await page.waitForTimeout(500);
      const started = Date.now();
      await t.type('\x03');
      await t.expect(/\^C\n[^\n]*\$ $/);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await t.since()).not.toMatch(/^not reached$/m);
      expect(await t.run('echo s=$?')).toContain('s=130');
    }
    await t.mark();
    await t.type(
      `node -e "process.on('SIGINT', () => { console.log('caught'); process.exit(7) }); setInterval(() => {}, 1000)"; echo after=$?\r`,
    );
    await page.waitForTimeout(800);
    await t.type('\x03');
    await t.expect(/caught\nafter=7\n[^\n]*\$ $/);
  });

  test('stdin: cooked lines, Ctrl+D, raw keys, readline editing, resize', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/keys.js',
      `const rl = require('readline');
rl.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.on('SIGWINCH', () => console.log('winch', process.stdout.columns, process.stdout.rows));
process.stdin.on('keypress', (s, k) => {
  console.log('key', k.name, k.ctrl);
  if (k.name === 'q') process.exit(0);
});
console.log('ready', process.stdin.isRaw);`,
    );
    await host(
      page,
      'writeFile',
      id,
      '/home/user/ask.js',
      `const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
rl.question('name? ', (a) => { console.log('hi ' + a); rl.close(); });`,
    );
    const t = await terminal(page, id);

    await t.mark();
    await t.type('cat\r');
    await page.waitForTimeout(300);
    await t.type('one\x7fe line\r');
    await t.expect(/one line\none line\n$/);
    await t.type('\x04');
    await t.expect(/\$ $/);

    await t.mark();
    await t.type('node keys.js\r');
    await t.expect(/ready true\n/);
    await t.type('a');
    await t.type('\x1b[A');
    await t.type('\x03');
    await t.expect(/key a false\nkey up false\nkey c true\n/);
    await host(page, 'terminalResize', t.pid, 100, 30);
    await t.expect(/winch 100 30\n/);
    await t.type('q');
    await t.expect(/\$ $/);
    // The terminal is cooked again for the shell, which saw the resize too.
    expect(await t.run('echo $COLUMNS x $LINES')).toContain('\n100 x 30\n');

    await t.mark();
    await t.type('node ask.js\r');
    await t.expect(/name\? $/);
    await t.type('Adx\x7fa\x1b[D\x1b[Dl\r');
    await t.expect(/hi Alda\n[^\n]*\$ $/);
  });

  test('line editing: history, completion, continuation lines, background jobs', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    await host(page, 'writeFile', id, '/home/user/project-notes.txt', 'notes\n');
    const t = await terminal(page, id);

    await t.run('echo first');
    await t.mark();
    // Up recalls "echo first"; five Lefts put the cursor before "first".
    await t.type('\x1b[A\x1b[D\x1b[D\x1b[D\x1b[D\x1b[DX \r');
    await t.expect(/\nX first\n/);

    await t.mark();
    await t.type('cat proj\t');
    await t.expect(/cat project-notes\.txt $/);
    await t.type('\r');
    await t.expect(/\nnotes\n/);

    await t.mark();
    await t.type('for i in 1 2; do\r');
    await t.expect(/> $/);
    await t.type('echo n$i; done\r');
    await t.expect(/\nn1\nn2\n[^\n]*\$ $/);

    // A background job: Ctrl+C at the prompt leaves it alone; it is announced when done.
    await t.mark();
    await t.type('node -e "setTimeout(() => {}, 1500)" &\r');
    await t.expect(/\[1\] \d+\n[^\n]*\$ $/);
    await t.type('sleep 5\r');
    await page.waitForTimeout(300);
    await t.type('\x03');
    await t.expect(/\^C\n/);
    await page.waitForTimeout(1500);
    await t.mark();
    await t.type('\r');
    await t.expect(/\[1\]\+ {2}Done {20}node -e "setTimeout\(\(\) => \{\}, 1500\)"\n/);
  });

  test('job control: Ctrl+Z stops a program, jobs lists it, bg and fg continue it', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/tick.js',
      `let n = 0; setInterval(() => console.log('tick', ++n), 150);
process.stdin.on('data', (d) => console.log('read', JSON.stringify(String(d))));`,
    );
    const t = await terminal(page, id);
    await t.mark();
    await t.type('node tick.js\r');
    await t.expect(/tick 2\n/);

    // Ctrl+Z: the program stops and the prompt comes back, with $? = 148.
    await t.mark();
    await t.type('\x1a');
    await t.expect(/\^Z\n\[1\]\+ {2}Stopped {20}node tick\.js\n[^\n]*\$ $/);
    // Stopped means stopped: no ticks while at the prompt, and typed lines are the shell's.
    const quiet = await t.run('echo status=$?');
    expect(quiet).toContain('status=148');
    await page.waitForTimeout(500);
    expect(await t.since()).not.toContain('tick');
    expect(await t.run('jobs')).toMatch(/\[1\]\+ {2}Stopped {20}node tick\.js\n/);

    // bg: it runs again in the background, without the terminal's input.
    await t.mark();
    await t.type('bg\r');
    await t.expect(/\[1\]\+ node tick\.js &\n/);
    await t.expect(/tick \d+\n/);
    expect(await t.run('jobs')).toMatch(/\[1\]\+ {2}Running {17}node tick\.js &\n/);

    // fg: back in the foreground, where it reads the terminal and Ctrl+C ends it.
    await t.mark();
    await t.type('fg %1\r');
    await t.expect(/node tick\.js\n/);
    await t.type('hello\r');
    await t.expect(/read "hello\\n"\n/);
    await t.type('\x03');
    await t.expect(/\^C\n[^\n]*\$ $/);
    expect(await t.run('jobs; echo end')).toMatch(/\nend\n/);
    expect(await t.since()).not.toContain('Stopped');
  });

  test('history builtin: numbered list, a count, -c, and ~/.bash_history', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const t = await terminal(page, id);
    await t.run('echo one');
    await t.run(' echo hidden');
    await t.run('echo two');
    expect(await t.run('history')).toMatch(
      /\n {4}1 {2}echo one\n {4}2 {2}echo two\n {4}3 {2}history\n[^\n]*\$ $/,
    );
    expect(await t.run('history 2')).toMatch(/\n {4}3 {2}history\n {4}4 {2}history 2\n/);
    expect(await host(page, 'readFile', id, '/home/user/.bash_history')).toBe(
      'echo one\necho two\nhistory\nhistory 2\n',
    );
    await t.run('history -c');
    expect(await t.run('history')).toMatch(/\n {4}1 {2}history\n[^\n]*\$ $/);
    expect(await host(page, 'readFile', id, '/home/user/.bash_history')).toBe('history\n');
  });

  test('signals reach handlers: kill(), trap, and the exit status of a default action', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    // Through the public API, without a terminal.
    const server = await host(
      page,
      'startServer',
      id,
      'node',
      [
        '-e',
        `process.on('SIGTERM', () => { console.log('cleaning up'); server.close(() => process.exit(0)) });
const server = require('http').createServer((q, r) => r.end('ok')).listen(3100);`,
      ],
      {},
      3100,
    );
    await host(page, 'kill', id, server.pid);
    expect(await host(page, 'output', server.pid)).toContain('cleaning up');

    // A shell's trap runs when the signal arrives, and the script goes on.
    const t = await terminal(
      page,
      id,
      ['-c', `trap 'echo trapped INT' INT; sleep 2; echo done`],
      'sh',
      false,
    );
    await page.waitForTimeout(500);
    await t.type('\x03');
    await expect
      .poll(() => host(page, 'terminalExit', t.pid), { timeout: 10_000 })
      .toEqual({
        code: 0,
      });
    expect(plain(await host(page, 'terminalOutput', t.pid))).toMatch(/\^C\ntrapped INT\ndone\n/);

    // Without a handler, the default action ends the process with 128 + n.
    const u = await terminal(page, id, ['-e', 'setInterval(() => {}, 1000)'], 'node', false);
    await page.waitForTimeout(500);
    await host(page, 'terminalKill', u.pid, 'SIGUSR1');
    await expect
      .poll(() => host(page, 'terminalExit', u.pid))
      .toEqual({ code: 138, signal: 'SIGUSR1' });
  });
});
