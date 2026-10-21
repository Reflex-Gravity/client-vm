// SPDX-License-Identifier: Apache-2.0
// A scripted agent session through @clientvm/agent-api (slice 4e): the same
// tool calls an LLM would make, against real instances.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

test.describe('agent tools', () => {
  test.setTimeout(90_000);

  test('build, run, inspect and drive an app; spawn and message a sub-agent', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      name: 'builder',
      capabilities: [{ kind: 'spawn-instance', limits: { maxProcesses: 8 } }],
    });
    const agent = await host(page, 'agent', id);
    const call = async (tool: string, input: unknown = {}) => {
      const r = await host(page, 'agentCall', agent, tool, input);
      return { ...r, text: r.content.map((c) => c.text ?? '').join('') };
    };

    expect(
      (
        await call('write_file', {
          path: '/home/user/app/server.js',
          content: `const http = require('http');
let clicks = 0;
http.createServer((req, res) => {
  if (req.url === '/api/click') { clicks++; res.end(String(clicks)); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<title>Clicker</title><h1>Clicks: <span id="n">0</span></h1><button onclick="fetch(\\'/api/click\\').then(r => r.text()).then(t => { document.getElementById(\\'n\\').textContent = t; console.log(\\'clicked\\', t); })">Click me</button>');
}).listen(4000, () => console.log('serving on 4000'));
`,
        })
      ).text,
    ).toMatch(/^wrote \d+ bytes/);
    expect(
      (
        await call('edit_file', {
          path: '/home/user/app/server.js',
          old_string: 'Click me',
          new_string: 'Press me',
        })
      ).text,
    ).toBe('replaced 1 occurrence(s) in /home/user/app/server.js');
    expect(
      (
        await call('exec', {
          command: 'node --check server.js && echo syntax ok',
          cwd: '/home/user/app',
        })
      ).text,
    ).toBe('exit code 0\n--- stdout ---\nsyntax ok\n');
    expect(
      (await call('start_process', { command: 'node server.js', cwd: '/home/user/app' })).text,
    ).toContain('serving on 4000');
    await expect.poll(async () => (await call('list_processes')).text).toMatch(/port 4000\t/);

    const snap = await call('preview_snapshot', { port: 4000 });
    expect(snap.text).toContain('- heading[1] "Clicks: 0"');
    const ref = /button "Press me" \[ref=(e\d+)\]/.exec(snap.text)![1];
    await call('preview_click', { port: 4000, ref });
    expect((await call('preview_wait', { port: 4000, text: 'Clicks: 1' })).text).toBe('ok');
    expect((await call('preview_console', { port: 4000 })).text).toBe('#1 [log] clicked 1');
    const shot = await call('preview_screenshot', { port: 4000 });
    expect(shot.content[0]!.type).toBe('image');
    expect(Buffer.from(shot.content[0]!.source!.data, 'base64').subarray(1, 4).toString()).toBe(
      'PNG',
    );
    expect((await call('read_network_log')).text).toMatch(/GET :4000\/api\/click → 200/);

    // A sub-agent in a child instance; the parent lets it message back.
    const spawned = await call('spawn_instance', { name: 'helper' });
    expect(spawned.text).toMatch(/^created instance helper \(id [a-z0-9]+\)$/);
    expect((await call('grant_capability', { to: 'helper', kind: 'channel' })).text).toBe(
      'granted channel to helper',
    );
    const helperId = /\(id ([a-z0-9]+)\)/.exec(spawned.text)![1]!;
    const helper = await host(page, 'agent', helperId);
    const sent = await host(page, 'agentCall', helper, 'send_message', {
      to: 'builder',
      message: '{"status":"done"}',
    });
    expect(sent.is_error).toBeFalsy();
    expect((await call('read_messages')).text).toBe(`from ${helperId}: {"status":"done"}`);
    // The parent did not grant the reverse direction.
    expect((await call('send_message', { to: 'helper', message: '1' })).is_error).toBe(true);

    expect((await call('stop_process', { process_id: 1 })).text).toBe('process 1 stopped');
    expect((await call('read_console', { process_id: 1 })).text).toMatch(/exited with code/);
  });
});
