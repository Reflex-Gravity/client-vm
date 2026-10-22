// SPDX-License-Identifier: Apache-2.0
// Interactive sessions diffed against real bash in a real pseudo-terminal
// (ADR 0017). The same keystrokes go to `bash -i` on the host (through
// pty-session.py) and to ClientVM's `bash -i` on its pty. Both outputs are
// drawn by a headless terminal emulator (@xterm/headless), and the screens
// are compared: readline and ClientVM's line editor emit different cursor
// sequences for the same picture. CLIENTVM_REF_BASH picks the reference bash
// (default `bash` on PATH; CI's is bash 5).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import headless from '@xterm/headless';
import { host, openHost } from './sandbox.ts';

const { Terminal } = headless;
const COLS = 80;
const ROWS = 40;
const REF = process.env['CLIENTVM_REF_BASH'] ?? 'bash';
const QUIET_MS = 300;
const MAX_WAIT_MS = 5000;

/** Steps after the setup line; each is typed once the output has settled. */
const SESSIONS: Record<string, string[]> = {
  'echo and exit status': ['echo hello\r', 'false\r', 'echo status=$?\r'],
  'history recall with arrow keys': ['echo one\r', 'echo two\r', '\x1b[A\x1b[A\r'],
  'cursor movement and insertion': ['echo helo', '\x1b[D', 'l', '\r'],
  'Ctrl+A, Ctrl+E, Ctrl+W and Ctrl+U': [
    'ho there\x01ec\x05 x\r',
    'echo abc def\x17ghi\r',
    'junk\x15echo cleared\r',
  ],
  'Ctrl+C at the prompt': ['echo partial\x03', 'echo next\r'],
  'continuation lines': ['for i in 1 2; do\r', 'echo n$i; done\r'],
  'Tab completion of a file': ['touch zz-unique-file.txt\r', 'ls zz-u\t', '\r'],
  'Ctrl+C stops a program': ['sleep 5\r', '\x03', 'echo after=$?\r'],
  // An external program: ClientVM runs `sleep` inside the shell, where Ctrl+Z cannot stop it.
  'job control: Ctrl+Z, jobs, fg': [
    'node -e "setTimeout(() => {}, 5000)"\r',
    '\x1a',
    'jobs\r',
    'fg\r',
    '\x03',
    'echo after=$?\r',
  ],
};

const SETUP = "PS1='$ '; PS2='> '; echo ==start==\r";

/** The screen below the last `==start==` line, without trailing blank lines. */
async function screen(raw: Uint8Array | string): Promise<string> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(raw, resolve));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  const rest = lines.slice(lines.lastIndexOf('==start==') + 1);
  while (rest.length > 0 && rest.at(-1) === '') rest.pop();
  term.dispose();
  return rest.join('\n');
}

function referenceAvailable(): boolean {
  return spawnSync(REF, ['-c', 'true']).status === 0 && spawnSync('python3', ['-V']).status === 0;
}

test.describe('interactive sessions match real bash', () => {
  test.skip(!referenceAvailable(), `needs ${REF} and python3 on the host`);
  test.setTimeout(60_000);

  for (const [name, steps] of Object.entries(SESSIONS)) {
    test(name, async ({ page }) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-pty-')));
      let expected: string;
      try {
        const out = execFileSync(
          'python3',
          [new URL('./pty-session.py', import.meta.url).pathname],
          {
            input: JSON.stringify({
              shell: REF,
              args: ['--norc', '--noprofile', '-i'],
              cwd: dir,
              env: {
                HOME: dir,
                PATH: process.env['PATH'],
                TERM: 'xterm-256color',
                LANG: 'C.UTF-8',
              },
              cols: COLS,
              rows: ROWS,
              steps: [SETUP, ...steps],
            }),
            encoding: 'utf8',
            timeout: 60_000,
          },
        );
        expected = await screen(Buffer.from(out, 'base64'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      await openHost(page);
      const id = await host(page, 'createInstance');
      const pid = await host(page, 'openTerminal', id, 'bash', ['-i'], {
        cols: COLS,
        rows: ROWS,
        cwd: '/home/user',
      });
      const output = () => host(page, 'terminalOutput', pid);
      /** Waits until the output has been unchanged for QUIET_MS (or MAX_WAIT_MS passes). */
      const settle = async () => {
        const start = Date.now();
        let last = await output();
        let since = Date.now();
        while (Date.now() - since < QUIET_MS && Date.now() - start < MAX_WAIT_MS) {
          await page.waitForTimeout(50);
          const now = await output();
          if (now !== last) {
            last = now;
            since = Date.now();
          }
        }
      };
      await settle();
      for (const step of [SETUP, ...steps]) {
        await host(page, 'terminalInput', pid, step);
        await settle();
      }
      const actual = await screen(await output());
      expect(actual).toBe(expected);
    });
  }
});
