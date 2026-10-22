# Agent tool API

`@clientvm/agent-api` turns one ClientVM instance into a set of tools for an LLM agent. It has
zero runtime dependencies. Each tool definition has the shape LLM tool-use APIs take: `name`,
`description`, and a JSON Schema `input_schema`. Each result is a list of content blocks: `text`,
or a base64 PNG `image` for screenshots.

```ts
import { createClientVM } from '@clientvm/clientvm';
import { createAgentTools } from '@clientvm/agent-api';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.sandbox.example.dev` });
const instance = await vm.createInstance({
  name: 'builder',
  capabilities: [{ kind: 'spawn-instance', limits: { maxProcesses: 16 } }],
});
const tools = createAgentTools({ instance, onSpawn: (child) => startSubAgent(child) });
```

## A tool-use loop (Claude API)

The definitions and results map one-to-one onto the Messages API's `tools` and `tool_result`
blocks:

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // on your server; never ship API keys to the browser
const messages: Anthropic.MessageParam[] = [
  { role: 'user', content: 'Build a todo app with Vite + React and show me it working.' },
];
for (;;) {
  const response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 8192,
    tools: tools.definitions,
    messages,
  });
  messages.push({ role: 'assistant', content: response.content });
  if (response.stop_reason !== 'tool_use') break;
  const results = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    // Runs in the user's browser. The tag lets a terminal view match output to this call.
    const result = await tools.call(block.name, block.input, { tag: { toolUseId: block.id } });
    results.push({ type: 'tool_result', tool_use_id: block.id, ...result });
  }
  messages.push({ role: 'user', content: results });
}
```

In a real app, the model call runs on your server and `tools.call` runs on the page that owns the
`ClientVM`. Relay the tool calls between them.

To show the user what the agent runs, attach `@clientvm/terminal` to the instance
([README](../packages/terminal/README.md)). Processes a tool starts are tagged
`{ source: 'agent', tool, ...tag }`.

## Tools

| Tool | What it does |
|---|---|
| `read_file`, `write_file`, `edit_file`, `list_dir`, `delete_path` | Filesystem access. `edit_file` replaces an exact, unique string. `read_file` pages by lines and truncates long files in the middle |
| `exec` | Runs a shell command to completion: exit code, stdout, stderr. Default timeout 2 minutes |
| `start_process`, `read_console`, `stop_process`, `list_processes` | Background processes (dev servers) with buffered output, plus the open ports and their preview URLs |
| `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_wait`, `preview_screenshot`, `preview_console` | Drive the app's preview: a text outline with `[ref=eN]` element refs, input, waits, a PNG screenshot, and console output and errors |
| `read_network_log` | HTTP requests the instance served |
| `send_message`, `read_messages` | The mailbox. Sending needs a `channel` capability |
| `spawn_instance` | A child instance, empty or a copy of this one's files. Needs `spawn-instance` |
| `grant_capability` | Lets another instance message this one, reach its ports (`http://<name>.internal:<port>/`), or mount one of its directories read-only |

## Safety

- Tools act only through the agent's own `Instance`. What the agent can reach outside the instance
  is exactly its capabilities (docs/phase4-plan.md).
- Tool failures come back as `is_error` results with the error code and message, never as
  exceptions, so the agent can react to them.
- Page content, file contents, and command output are written by code the agent (or a package it
  installed) controls. Treat them as untrusted data. A page can contain text crafted to steer a
  model (prompt injection). Keep host-side authority, such as deploy keys, out of reach of
  tool results.
- `dispose()` stops background processes and closes previews.
