// SPDX-License-Identifier: Apache-2.0
import type { Instance, Preview } from '@clientvm/clientvm';
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, createAgentTools } from './tools.ts';

const enc = new TextEncoder();

/** Just enough of an Instance for the tools, with an in-memory filesystem. */
function fakeInstance() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/', '/home', '/home/user']);
  const calls: string[] = [];
  const tags: unknown[] = [];
  let mail: ((from: string, msg: unknown) => void) | undefined;
  let portOpen: ((port: number, url: string) => void) | undefined;
  const preview: Partial<Preview> = {
    ready: async () => {},
    snapshot: async () => ({
      url: 'http://x/',
      title: 'T',
      outline: '- button "Go" [ref=e1]',
      truncated: false,
    }),
    click: async (t) => void calls.push(`click ${JSON.stringify(t)}`),
    type: async (t, v) => void calls.push(`type ${JSON.stringify(t)} ${v}`),
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    console: () => [{ seq: 1, level: 'error', text: 'boom', time: 0, url: 'http://x/' }],
    waitFor: async () => false,
    close: () => void calls.push('close preview'),
  };
  const instance = {
    id: 'me',
    name: 'me',
    fs: {
      readFile: async (p: string) => {
        const f = files.get(p);
        if (!f)
          throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
        return f;
      },
      writeFile: async (p: string, d: string | Uint8Array) =>
        void files.set(p, typeof d === 'string' ? enc.encode(d) : d),
      mkdir: async (p: string) => void dirs.add(p),
      readdir: async (p: string) => {
        const names = new Map<string, 'file' | 'dir'>();
        for (const f of files.keys())
          if (f.startsWith(`${p}/`)) {
            const rest = f.slice(p.length + 1);
            names.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file');
          }
        return [...names].map(([name, type]) => ({ name, type }));
      },
      rm: async (p: string) => void files.delete(p),
    },
    exec: async (cmd: string, opts: { tag?: unknown }) => {
      tags.push(opts.tag);
      return cmd === 'false'
        ? { code: 1, stdout: '', stderr: 'nope\n' }
        : { code: 0, stdout: `ran ${cmd}\n`, stderr: '' };
    },
    spawn: async (_cmd: string, _args: string[], opts: { tag?: unknown }) => {
      tags.push(opts.tag);
      let push!: (s: string) => void;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => void (push = (s) => c.enqueue(enc.encode(s))),
      });
      const exit = new Promise<{ code: number }>(() => {});
      setTimeout(() => push('listening on 3000\n'), 10);
      return {
        pid: 7,
        stdout,
        stderr: new ReadableStream(),
        exit,
        kill: (s: string) => void calls.push(`kill ${s}`),
      };
    },
    onPortOpen: (cb: (port: number, url: string) => void) => ((portOpen = cb), { dispose() {} }),
    onPortClose: () => ({ dispose() {} }),
    mailbox: {
      send: async (to: string, msg: unknown) =>
        void calls.push(`send ${to} ${JSON.stringify(msg)}`),
      onMessage: (cb: (from: string, msg: unknown) => void) => ((mail = cb), { dispose() {} }),
    },
    openPreview: async () => preview,
    networkLog: async () => [
      { seq: 3, time: 0, port: 3000, method: 'GET', path: '/', status: 200, durationMs: 1.5 },
    ],
    createChild: async (o: { name?: string }) => ({ id: 'kid1', name: o.name }),
    fork: async () => ({ id: 'kid2' }),
    grant: async (to: string, cap: unknown) =>
      void calls.push(`grant ${to} ${JSON.stringify(cap)}`),
  };
  return {
    instance: instance as unknown as Instance,
    files,
    calls,
    tags,
    deliver: (from: string, msg: unknown) => mail?.(from, msg),
    openPort: (port: number) => portOpen?.(port, `http://me-p${port}.x/`),
  };
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text).join('');

describe('agent tools', () => {
  it('definitions are well-formed and unique', () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of TOOL_DEFINITIONS) {
      expect(d.name).toMatch(/^[a-z_]{1,64}$/);
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.input_schema.type).toBe('object');
      for (const r of d.input_schema.required ?? [])
        expect(d.input_schema.properties).toHaveProperty(r);
    }
  });

  it('files: write, read with paging, edit, list, binary detection', async () => {
    const { instance, files } = fakeInstance();
    const t = createAgentTools({ instance });
    expect(
      textOf(await t.call('write_file', { path: '/home/user/a.txt', content: 'one\ntwo\nthree' })),
    ).toBe('wrote 13 bytes to /home/user/a.txt');
    expect(
      textOf(await t.call('read_file', { path: '/home/user/a.txt', offset: 2, limit: 1 })),
    ).toBe('two');
    expect(
      textOf(
        await t.call('edit_file', { path: '/home/user/a.txt', old_string: 'two', new_string: '2' }),
      ),
    ).toBe('replaced 1 occurrence(s) in /home/user/a.txt');
    expect(new TextDecoder().decode(files.get('/home/user/a.txt'))).toBe('one\n2\nthree');
    const ambiguous = await t.call('edit_file', {
      path: '/home/user/a.txt',
      old_string: 'e',
      new_string: 'E',
    });
    expect(ambiguous.is_error).toBe(true);
    expect(textOf(ambiguous)).toMatch(/occurs 3 times/);
    files.set('/home/user/bin', new Uint8Array([0, 1, 2]));
    expect(textOf(await t.call('read_file', { path: '/home/user/bin' }))).toBe(
      '(binary file, 3 bytes)',
    );
    expect(textOf(await t.call('list_dir', { path: '/home/user' }))).toBe('a.txt\nbin');
    const missing = await t.call('read_file', { path: '/nope' });
    expect(missing).toMatchObject({ is_error: true });
    expect(textOf(missing)).toMatch(/^ENOENT: /);
    expect(textOf(await t.call('read_file', { path: 'relative' }))).toBe('paths must be absolute');
  });

  it('exec, background processes, network log', async () => {
    const { instance, calls, openPort } = fakeInstance();
    const t = createAgentTools({ instance });
    expect(textOf(await t.call('exec', { command: 'ls' }))).toBe(
      'exit code 0\n--- stdout ---\nran ls\n',
    );
    expect(await t.call('exec', { command: 'false' })).toMatchObject({ is_error: true });
    const started = textOf(await t.call('start_process', { command: 'npm run dev' }));
    expect(started).toMatch(/^process 1 running\nlistening on 3000/);
    openPort(3000);
    expect(textOf(await t.call('list_processes', {}))).toBe(
      '1\trunning\tnpm run dev\nport 3000\thttp://me-p3000.x/',
    );
    expect(textOf(await t.call('read_console', { process_id: 1 }))).toContain('listening on 3000');
    expect(textOf(await t.call('read_network_log', {}))).toBe('#3 GET :3000/ → 200 (1.5 ms)');
    t.dispose();
    expect(calls).toContain('kill SIGKILL');
  });

  it('tags the processes a call starts', async () => {
    const { instance, tags } = fakeInstance();
    const t = createAgentTools({ instance });
    await t.call('exec', { command: 'ls' });
    // The tool's own fields win over the caller's.
    await t.call('start_process', { command: 'x' }, { tag: { toolUseId: 'tu_1', tool: 'y' } });
    expect(tags).toEqual([
      { source: 'agent', tool: 'exec' },
      { toolUseId: 'tu_1', source: 'agent', tool: 'start_process' },
    ]);
  });

  it('previews, messages, instances, capabilities', async () => {
    const { instance, calls, deliver, openPort } = fakeInstance();
    const t = createAgentTools({ instance });
    expect(textOf(await t.call('preview_click', { port: 3000, ref: 'e1' }))).toBe(
      'nothing is listening on port 3000',
    );
    openPort(3000);
    expect(textOf(await t.call('preview_snapshot', { port: 3000 }))).toBe(
      'T — http://x/\n- button "Go" [ref=e1]',
    );
    expect(textOf(await t.call('preview_click', { port: 3000, ref: 'e1' }))).toMatch(/^clicked/);
    await t.call('preview_type', { port: 3000, selector: '#q', value: 'hi' });
    expect(calls).toEqual(['click {"ref":"e1"}', 'type {"selector":"#q"} hi']);
    expect(await t.call('preview_click', { port: 3000 })).toMatchObject({ is_error: true });
    expect(await t.call('preview_wait', { port: 3000, text: 'x' })).toMatchObject({
      is_error: true,
    });
    const shot = await t.call('preview_screenshot', { port: 3000 });
    expect(shot.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
    });
    expect(textOf(await t.call('preview_console', { port: 3000 }))).toBe('#1 [error] boom');

    await t.call('send_message', { to: 'peer', message: '{"a":1}' });
    expect(await t.call('send_message', { to: 'peer', message: 'not json' })).toMatchObject({
      is_error: true,
    });
    deliver('peer', { b: 2 });
    expect(textOf(await t.call('read_messages', {}))).toBe('from peer: {"b":2}');
    expect(textOf(await t.call('read_messages', {}))).toBe('(no new messages)');

    const spawned: string[] = [];
    const t2 = createAgentTools({ instance, onSpawn: (c) => spawned.push(c.id) });
    expect(textOf(await t2.call('spawn_instance', { name: 'kid' }))).toBe(
      'created instance kid (id kid1)',
    );
    expect(textOf(await t2.call('spawn_instance', { copy_files: true }))).toBe(
      'created instance kid2 (id kid2)',
    );
    expect(spawned).toEqual(['kid1', 'kid2']);
    await t.call('grant_capability', { to: 'peer', kind: 'net', ports: [3000] });
    await t.call('grant_capability', { to: 'peer', kind: 'mount', path: '/home/user/src' });
    expect(calls.slice(-2)).toEqual([
      'grant peer {"kind":"net","peer":"me","ports":[3000]}',
      'grant peer {"kind":"mount","from":"me","path":"/home/user/src","readOnly":true}',
    ]);
    expect(await t.call('no_such_tool', {})).toMatchObject({ is_error: true });
    expect(await t.call('exec', 'not an object')).toMatchObject({ is_error: true });
  });

  it('truncates long output in the middle', async () => {
    const { instance, files } = fakeInstance();
    files.set('/big', enc.encode(`${'a'.repeat(5000)}${'b'.repeat(5000)}`));
    const t = createAgentTools({ instance, maxOutput: 1000 });
    const out = textOf(await t.call('read_file', { path: '/big' }));
    expect(out.length).toBeLessThan(1100);
    expect(out).toMatch(/^a+\n\n\[… \d+ characters omitted …\]\n\nb+$/);
  });
});
