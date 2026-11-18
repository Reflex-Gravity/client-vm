# Quickstart

Add ClientVM to a web app: deploy the sandbox once, boot an instance, run a dev server inside it
and show its preview. Then add a terminal and hand the instance to an agent.

> [!NOTE]
> ClientVM runs in **Chromium-based browsers** (Chrome, Edge, Arc, Brave). To try it without
> setting anything up, open the [live demo](https://clientvm.joeldsouza.me/).

## 1. Deploy the sandbox

Instances run on a static sandbox: the files of `@clientvm/sandbox-host`, served on a wildcard
subdomain of a **separate registrable domain** such as `*.myapp-sandbox.dev`. Each instance and
each preview port gets its own subdomain, so the browser keeps agent code away from your app and
from other instances.

```sh
npm install -D @clientvm/sandbox-host
# deploy node_modules/@clientvm/sandbox-host/dist to *.myapp-sandbox.dev
```

Serve these headers on every response, plus `Service-Worker-Allowed: /` on
`/__clientvm/sw.js`:

```
Document-Isolation-Policy: isolate-and-require-corp
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy: frame-ancestors https://myapp.example
```

Then check the deployment:

```sh
npx clientvm-check-sandbox 'https://{id}.myapp-sandbox.dev' --app https://myapp.example
```

> [!TIP]
> The [hosting guide](hosting.md) explains each requirement and shows a scheme that needs only
> one wildcard certificate.

## 2. Install the runtime

```sh
npm install @clientvm/clientvm
```

Your own app needs **no** special headers: no COOP, no COEP.

## 3. Create a controller and an instance

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });

// Start from your own files…
const instance = await vm.createInstance({
  fs: { from: { home: { user: { app: { 'index.js': "console.log('hi')" } } } } },
  limits: { maxProcesses: 64, maxCpuMs: 30_000 },
});

// …or from a ready Vite 8 + React 19 + TypeScript project with node_modules installed.
const app = await vm.createInstance({ preset: 'vite-react-ts' });
```

- **`preset`** builds the project once, in about 10 s, in a hidden instance. The result is kept in
  your origin's Cache Storage, so every later instance boots from it in about 0.2 s with no
  downloads ([why](decisions/0018-presets-cached-on-host-origin.md)).
- **`limits`** caps what the instance can use. Agent code is treated as hostile, so set them.
- **Persistence:** add `fs: { persist: true }` and a fixed `id` to keep an instance's files
  across reloads.

## 4. Run commands and show the preview

```ts
const { code, stdout } = await instance.exec('node index.js', { cwd: '/home/user/app' });

app.onPortOpen((port, url) => {
  previewIframe.src = url; // https://<id>-p5173.myapp-sandbox.dev/
});
await app.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
```

- `exec` runs a shell command line to completion and returns its exit code and output.
- `spawn` returns a process with streaming `stdout`/`stderr`, `stdin`, `kill()` and `exit`.
- `onPortOpen` fires when a server starts listening. The URL is private to this browser tab.
- `instance.fs` reads and writes the instance's files from your page.

## 5. Add a terminal

`@clientvm/terminal` attaches a real interactive `bash` to any xterm.js-compatible terminal. You
choose the terminal emulator; it is not a dependency.

```ts
import { Terminal } from '@xterm/xterm';
import { attachShell, attachActivityView } from '@clientvm/terminal';

const term = new Terminal();
term.open(element);
await attachShell(term, app, { cwd: '/home/user/app' }); // history, Tab completion, Ctrl+C, job control

// Or a read-only feed of what the agent runs:
attachActivityView(agentTerm, app, { filter: (p) => p.tag?.['source'] === 'agent' });
```

## 6. Hand it to an agent

`@clientvm/agent-api` turns an instance into LLM tool definitions: files, `exec`, background
processes, driving the preview, screenshots, the mailbox and child instances.

```ts
import { createAgentTools } from '@clientvm/agent-api';

const tools = createAgentTools({ instance: app });
// Send tools.definitions as `tools` to the model; run each tool_use block through
// tools.call(block.name, block.input) and return the result as a tool_result.
```

> [!IMPORTANT]
> Keep your model API key on your server. Run the model call there and relay tool calls to the
> page that owns the `ClientVM`. The [agent tool API](agent-api.md) has a complete loop.

## Next steps

- **How it fits together:** [how ClientVM works](architecture.md), with diagrams.
- **Look up an API:** the [API reference](interfaces.md).
- **Check a Node API before relying on it:** the [compatibility matrix](compatibility.md).
- **Run it from a checkout:** the [README](../README.md#try-it-locally) starts a local sandbox
  and an agent playground.
