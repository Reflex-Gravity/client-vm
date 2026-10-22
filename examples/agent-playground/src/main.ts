// SPDX-License-Identifier: Apache-2.0
// A minimal host app for ClientVM: one instance, a command line, the
// commands it runs with their live output, the instance's first preview, and
// the agent tools an LLM would call. Wire `tools.definitions` and
// `tools.call` into your model's tool-use loop to let it build in the
// instance (see README.md).
import { createAgentTools } from '@clientvm/agent-api';
import { createClientVM } from '@clientvm/clientvm';
import { createActivityFeed, formatDuration, stripAnsi } from '@clientvm/terminal';
import type { CommandBlock } from '@clientvm/terminal';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Where the sandbox host (packages/sandbox-host) is served. Each instance gets
// its own subdomain; *.localhost resolves to 127.0.0.1 in Chromium.
const SANDBOX = import.meta.env['VITE_SANDBOX'] ?? 'http://{id}.localhost:4173';

const vm = createClientVM({ sandboxOrigin: (id) => SANDBOX.replace('{id}', id) });

const STARTER = {
  'package.json': JSON.stringify(
    { name: 'app', private: true, scripts: { start: 'node server.js' } },
    null,
    2,
  ),
  'server.js': `const http = require('http');
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Hello from ClientVM</h1><p>Served by ' + process.version + ' at ' + req.url + '</p>');
  })
  .listen(3000, () => console.log('listening on 3000'));
`,
};

async function main(): Promise<void> {
  const instance = await vm.createInstance({
    fs: { from: { home: { user: { app: STARTER } } } },
    limits: { maxProcesses: 64, maxCpuMs: 30_000 },
  });
  $('status').textContent = `instance ${instance.id}`;

  instance.onPortOpen((port, url) => {
    $('url').textContent = `port ${port}`;
    $<HTMLIFrameElement>('preview').src = url;
  });

  // Every command the instance runs (yours and the agent's), with live output.
  // For a full terminal emulator, pass an xterm.js Terminal to
  // attachActivityView instead (packages/terminal/README.md).
  const terminal = $('terminal');
  const feed = createActivityFeed(instance);
  const rendered = new Map<number, { block: CommandBlock; el: HTMLDetailsElement }>();
  const render = (block: CommandBlock, open: boolean): HTMLDetailsElement => {
    const el = document.createElement('details');
    el.open = open;
    el.className = block.status === 'running' ? 'running' : block.code === 0 ? 'ok' : 'failed';
    const head = el.appendChild(document.createElement('summary'));
    head.textContent = `${block.tag?.['source'] === 'agent' ? '🤖 ' : ''}$ ${block.command}`;
    const status = head.appendChild(document.createElement('small'));
    status.textContent =
      block.status === 'running'
        ? ' running…'
        : ` ${block.signal ?? `exit ${block.code}`} · ${formatDuration(block.exitedAt! - block.startedAt)}`;
    if (block.output)
      el.appendChild(document.createElement('pre')).textContent = stripAnsi(block.output);
    return el;
  };
  feed.subscribe(() => {
    const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 20;
    const blocks = feed.getSnapshot();
    const live = new Set(blocks.map((b) => b.pid));
    for (const [pid, { el }] of rendered)
      if (!live.has(pid)) {
        el.remove();
        rendered.delete(pid);
      }
    // Snapshots replace a block when it changes, so a new object means re-render.
    for (const block of blocks) {
      const old = rendered.get(block.pid);
      if (old?.block === block) continue;
      const el = render(block, old?.el.open ?? true);
      if (old) old.el.replaceWith(el);
      else terminal.append(el);
      rendered.set(block.pid, { block, el });
    }
    if (atBottom) terminal.scrollTop = terminal.scrollHeight;
  });
  $<HTMLFormElement>('exec').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLInputElement>('cmd');
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    void instance
      .exec(cmd, { cwd: '/home/user/app', timeoutMs: 120_000, tag: { source: 'user' } })
      .catch((err: unknown) => ($('status').textContent = String(err)));
  });

  // The tools an agent uses; here they are driven by hand.
  const tools = createAgentTools({ instance });
  const select = $<HTMLSelectElement>('tool');
  const input = $<HTMLTextAreaElement>('input');
  for (const def of tools.definitions) select.add(new Option(def.name, def.name));
  const example = (name: string) => {
    const def = tools.definitions.find((d) => d.name === name);
    const props = (def?.input_schema.properties ?? {}) as Record<string, { type?: string }>;
    const sample: Record<string, unknown> = {};
    for (const key of def?.input_schema.required ?? [])
      sample[key] = props[key]?.type === 'integer' ? 0 : '';
    input.value = JSON.stringify(sample, null, 2);
    $('result').textContent = def?.description ?? '';
  };
  select.addEventListener('change', () => example(select.value));
  // A first call to try: start the starter app's server, then watch the preview.
  select.value = 'start_process';
  example('start_process');
  input.value = JSON.stringify({ command: 'npm start', cwd: '/home/user/app' }, null, 2);

  $('call').addEventListener('click', () => {
    let args: unknown;
    try {
      args = JSON.parse(input.value || '{}');
    } catch (err) {
      $('result').textContent = `Invalid JSON: ${String(err)}`;
      return;
    }
    $('result').textContent = '…';
    void tools.call(select.value, args).then((r) => {
      $('result').textContent =
        (r.is_error ? 'ERROR\n' : '') +
        r.content
          .map((c) => (c.type === 'text' ? c.text : `[${c.source.media_type} image]`))
          .join('\n');
    });
  });
}

main().catch((err: unknown) => {
  $('status').textContent = `failed: ${String(err)}`;
});
