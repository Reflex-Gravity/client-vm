// SPDX-License-Identifier: Apache-2.0
// A minimal host app for ClientVM: one instance, a command line, the
// instance's first preview, and the agent tools an LLM would call. Wire
// `tools.definitions` and `tools.call` into your model's tool-use loop to
// let it build in the instance (see README.md).
import { createAgentTools } from '@clientvm/agent-api';
import { createClientVM } from '@clientvm/clientvm';

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

  const terminal = $<HTMLPreElement>('terminal');
  const print = (text: string) => {
    terminal.textContent += text;
    terminal.scrollTop = terminal.scrollHeight;
  };
  $<HTMLFormElement>('exec').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $<HTMLInputElement>('cmd');
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    print(`$ ${cmd}\n`);
    void instance
      .exec(cmd, { cwd: '/home/user/app', timeoutMs: 120_000 })
      .then((r) => print(`${r.stdout}${r.stderr}${r.code ? `[exit ${r.code}]\n` : ''}`))
      .catch((err: unknown) => print(`${String(err)}\n`));
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
