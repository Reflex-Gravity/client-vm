# Agent playground

A minimal host app for ClientVM. It boots one instance with a tiny Node HTTP server, gives you a
command line into it, shows the instance's preview, and lets you call the
[agent tools](../../docs/agent-api.md) by hand: the same calls an LLM makes.

## Run it

The host app and the sandbox are two origins: the app on `localhost:5180`, instances on
`<id>.localhost:4173`.

```sh
pnpm install
pnpm --filter @clientvm/sandbox-host build && pnpm --filter @clientvm/sandbox-host preview  # :4173
pnpm --filter @clientvm/example-agent-playground dev                                         # :5180
```

Open http://localhost:5180 in Chromium. Click **Call** to run the preselected `start_process`
tool (`npm start`); the preview shows the server's page once port 3000 opens. Try commands such as
`ls -la`, `npm install ms`, `git init && git add -A && git commit -m init`. Every command, yours
and the agent tools' (marked 🤖), appears with its live output, exit status and run time, through
[`@clientvm/terminal`](../../packages/terminal/README.md).

Set `VITE_SANDBOX` to point at another sandbox deployment, with `{id}` where the instance id goes,
for example `VITE_SANDBOX=https://{id}.myapp-sandbox.dev`.

## Connect a model

`createAgentTools({ instance })` returns `definitions` (name, description, JSON Schema input) and
`call(name, input)`. Pass the definitions as tools to any tool-use API, run each tool call the
model makes through `call`, and send the result back as a tool result. With the Anthropic SDK:

```ts
const tools = createAgentTools({ instance });
const messages = [{ role: 'user', content: 'Build a todo app with Vite and React.' }];
for (;;) {
  const reply = await anthropic.messages.create({
    model: MODEL, // the model id you use
    max_tokens: 4096,
    tools: tools.definitions,
    messages,
  });
  messages.push({ role: 'assistant', content: reply.content });
  const calls = reply.content.filter((block) => block.type === 'tool_use');
  if (calls.length === 0) break;
  messages.push({
    role: 'user',
    content: await Promise.all(
      calls.map(async (c) => ({ type: 'tool_result', tool_use_id: c.id, ...(await tools.call(c.name, c.input)) })),
    ),
  });
}
```

Keep API keys on your server: proxy model calls rather than calling the model API from the
browser. Treat tool output (file contents, console logs, page text) as untrusted data; it can
contain prompt injections written by the code the agent runs.
