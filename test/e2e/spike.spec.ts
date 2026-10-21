// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { openSandbox, run, writeFile } from './sandbox.ts';

for (const mode of ['waitAsync', 'postMessage'] as const) {
  test.describe(`sync syscalls (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await openSandbox(page);
    });

    test('node -e readdirSync("/") prints the root listing', async ({ page }) => {
      const result = await run(
        page,
        ['node', '-e', "console.log(require('fs').readdirSync('/'))"],
        mode,
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe("[ 'bin', 'dev', 'etc', 'home', 'tmp', 'usr' ]\n");
      expect(result.code).toBe(0);
    });

    test('readFileSync of a missing file throws a Node-shaped ENOENT', async ({ page }) => {
      const script = `
        try { require('fs').readFileSync('/nope.txt'); }
        catch (e) { console.log(e.message, e.code, e.errno, e.syscall, e.path); }
      `;
      const result = await run(page, ['node', '-e', script], mode);
      expect(result.stdout).toBe(
        "ENOENT: no such file or directory, open '/nope.txt' ENOENT -2 open /nope.txt\n",
      );
      expect(result.code).toBe(0);
    });

    test('readFileSync streams a 4 MiB file through the chunked channel intact', async ({
      page,
    }) => {
      // Write and read back inside the process so both request and response chunking are exercised.
      const script = `
        const fs = require('fs');
        const size = 4 * 1024 * 1024;
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
        fs.writeFileSync('/tmp/big.bin', data);
        const back = fs.readFileSync('/tmp/big.bin');
        let ok = back.length === size;
        for (let i = 0; ok && i < size; i++) ok = back[i] === data[i];
        console.log(ok ? 'match' : 'mismatch', back.length);
      `;
      const result = await run(page, ['node', '-e', script], mode);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('match 4194304\n');
    });

    test('files written by the host are visible to processes', async ({ page }) => {
      await writeFile(page, '/home/user/hello.txt', 'hi from host');
      const result = await run(
        page,
        ['node', '-p', "require('fs').readFileSync('hello.txt', 'utf8')"],
        mode,
      );
      expect(result.stdout).toBe('hi from host\n');
    });

    test('uncaught errors exit 1; process.exit sets the code', async ({ page }) => {
      const thrown = await run(page, ['node', '-e', "throw new Error('boom')"], mode);
      expect(thrown.code).toBe(1);
      expect(thrown.stderr).toContain('Error: boom');

      const exited = await run(page, ['node', '-e', 'setTimeout(() => process.exit(3), 5)'], mode);
      expect(exited.code).toBe(3);
    });

    test('unknown commands fail to spawn with ENOENT, like execve', async ({ page }) => {
      await expect(run(page, ['nosuchcmd'], mode)).rejects.toThrow(
        /ENOENT: no such file or directory, spawn nosuchcmd/,
      );
    });
  });
}
