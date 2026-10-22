// SPDX-License-Identifier: Apache-2.0
// Instance.onProcess, the event stream behind @clientvm/terminal: commands
// started by the host or the agent tools, their output while they run, and
// their exit, replayed to listeners that attach late.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

test('onProcess reports exec and spawn: start, streamed output, exit', async ({ page }) => {
  await openHost(page);
  const id = await host(page, 'createInstance');
  await host(page, 'recordProcesses', id);

  const r = await host(page, 'exec', id, 'echo out; sleep 1; echo err >&2; exit 3', {
    cwd: '/tmp',
    tag: { source: 'user', n: 1 },
  });
  expect(r).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });

  const events = await host(page, 'processEvents', id);
  const strip = (es: typeof events) => es.map(({ at: _, ...e }) => e);
  expect(strip(events)).toMatchObject([
    {
      type: 'spawn',
      process: { argv: ['sh', '-c', 'echo out; sleep 1; echo err >&2; exit 3'], cwd: '/tmp' },
    },
    { type: 'output', fd: 1, text: 'out\n' },
    { type: 'output', fd: 2, text: 'err\n' },
    { type: 'exit', code: 3 },
  ]);
  const [spawn, out, , exit] = events;
  if (spawn?.type !== 'spawn' || exit?.type !== 'exit') throw new Error('unexpected events');
  expect(spawn.process.tag).toEqual({ source: 'user', n: 1 });
  expect(new Set(events.map((e) => ('pid' in e ? e.pid : e.process.pid))).size).toBe(1);
  // Output arrives while the command runs, not when it ends.
  expect(exit.at - out!.at).toBeGreaterThan(800);
  expect(exit.exitedAt - spawn.process.startedAt).toBeGreaterThan(800);

  // A spawned process killed by a signal; and the agent tools tag what they start.
  await host(page, 'spawnAndCollect', id, 'node', ['-e', 'setInterval(() => {}, 1000)'], 300);
  const agent = await host(page, 'agent', id);
  await host(page, 'agentCall', agent, 'exec', { command: 'echo from agent' });
  const later = (await host(page, 'processEvents', id)).slice(events.length);
  expect(later.filter((e) => e.type !== 'output')).toMatchObject([
    { type: 'spawn', process: { argv: ['node', '-e', 'setInterval(() => {}, 1000)'] } },
    { type: 'exit', code: 137, signal: 'SIGKILL' },
    {
      type: 'spawn',
      process: { argv: ['sh', '-c', 'echo from agent'], tag: { source: 'agent', tool: 'exec' } },
    },
    { type: 'exit', code: 0 },
  ]);

  // A listener attached now gets the same history.
  await host(page, 'recordProcesses', id);
  const replay = await host(page, 'processEvents', id);
  expect(strip(replay)).toEqual(strip([...events, ...later]));
});
