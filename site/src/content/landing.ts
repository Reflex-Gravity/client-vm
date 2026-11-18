// SPDX-License-Identifier: Apache-2.0
// The landing page's copy, in one place. The page (src/pages/index.astro), the
// markdown version for agents (/index.md) and /llms.txt all render from it.

export const REPO = 'https://github.com/Reflex-Gravity/client-vm';
export const DOCS = `${REPO}/blob/main/docs`;
export const SITE = 'https://clientvm.joeldsouza.me';

export const hero = {
  eyebrow: 'open source · apache-2.0 · no server-side compute',
  title: 'Node.js, bash and npm, in a browser tab.',
  lede:
    'ClientVM is a browser runtime for AI-agent app builders. Each agent gets isolated ' +
    'instances with their own filesystem, processes and network, runs real npm install and ' +
    'npm run dev, and previews the app it built without a server.',
  install: 'npm install @clientvm/clientvm @clientvm/terminal',
};

/** What "Copy agent prompt" puts on the clipboard: enough for a coding agent to integrate ClientVM. */
export const agentPrompt = `Integrate ClientVM (${REPO}) into this web app so it can run Node.js 24, bash and npm entirely in the browser.

1. Install @clientvm/clientvm, @clientvm/terminal and @clientvm/agent-api from npm.
2. ClientVM needs a static sandbox deployment of @clientvm/sandbox-host on a wildcard subdomain of a separate registrable domain, served with these headers on every response: Document-Isolation-Policy: isolate-and-require-corp, Cross-Origin-Embedder-Policy: require-corp, Cross-Origin-Resource-Policy: cross-origin, Content-Security-Policy: frame-ancestors <this app's origin>, plus Service-Worker-Allowed: / on /__clientvm/sw.js. Follow ${DOCS}/hosting.md.
3. Create a controller: createClientVM({ sandboxOrigin: (id) => \`https://\${id}.<sandbox-domain>\` }). This app needs no COOP/COEP headers.
4. Create an instance with vm.createInstance({ preset: 'vite-react-ts' }) or from files, run commands with instance.exec / instance.spawn, and show previews from instance.onPortOpen((port, url) => ...) in an iframe.
5. For a terminal, pass an xterm.js Terminal to attachShell(term, instance) from @clientvm/terminal.
6. For LLM tools, createAgentTools({ instance }) from @clientvm/agent-api gives tool definitions and tools.call(name, input).

Limits: Chromium only, no native Node addons, outbound fetch is subject to CORS, no raw TCP. Check ${DOCS}/compatibility.md before relying on a Node API.`;

export interface Feature {
  title: string;
  body: string;
  href: string;
}

export const features: Feature[] = [
  {
    title: 'Real npm and pnpm',
    body: 'The unmodified npm 11 and pnpm 10, fetched and SHA-512-verified on first use. Lockfiles, lifecycle scripts, workspaces.',
    href: `${DOCS}/compatibility.md`,
  },
  {
    title: 'Vite with HMR',
    body: 'Stock Vite 6 and Vite 8 projects. esbuild, rollup, rolldown and lightningcss run as their official WebAssembly builds.',
    href: `${DOCS}/decisions/0013-wasm-stand-ins-for-native-packages.md`,
  },
  {
    title: 'An interactive bash',
    body: 'Pseudo-terminals, signals, Ctrl+C and Ctrl+Z, job control, history and Tab completion. About 60 Linux commands, diffed against bash and GNU tools.',
    href: `${DOCS}/decisions/0017-pty-and-signals.md`,
  },
  {
    title: 'Synchronous syscalls',
    body: 'fs.readFileSync really blocks, on SharedArrayBuffer and Atomics.wait, at about 10 µs per round trip.',
    href: `${DOCS}/spike-results.md`,
  },
  {
    title: 'One origin per instance',
    body: 'Each instance runs on its own subdomain, so the browser keeps agent code away from your app and from other instances.',
    href: `${DOCS}/security.md`,
  },
  {
    title: 'Snapshots and forks',
    body: 'Copy-on-write snapshots, forks into new instances, OPFS persistence, a mailbox and capability-gated networking between instances.',
    href: `${DOCS}/phase4-plan.md`,
  },
  {
    title: 'Tools for agents',
    body: 'Files, exec, background processes, screenshots and a driveable preview, as LLM tool definitions.',
    href: `${DOCS}/agent-api.md`,
  },
  {
    title: 'Static hosting only',
    body: 'The sandbox is a folder of static files behind a wildcard subdomain. Nothing runs on a server.',
    href: `${DOCS}/hosting.md`,
  },
];

export const howItWorks = [
  {
    title: 'Your app stays clean',
    body: 'The controller on your page validates every message. Instance pages get cross-origin isolation from Document-Isolation-Policy, so your app needs no COOP/COEP headers.',
  },
  {
    title: 'A kernel per instance',
    body: 'Each instance is a hidden iframe on its own origin with a kernel worker: an in-memory filesystem, a process table, pseudo-terminals and virtual ports.',
  },
  {
    title: 'Previews through a service worker',
    body: 'A server started inside an instance gets its own origin, <id>-p<port>.<sandbox-domain>. A service worker routes it to the instance. Previews stay private to the tab.',
  },
];

export interface QuickstartTab {
  id: string;
  label: string;
  lang: 'sh' | 'ts';
  code: string;
}

export const quickstart: QuickstartTab[] = [
  {
    id: 'install',
    label: 'Install',
    lang: 'sh',
    code: `# the runtime, and a terminal for it
npm install @clientvm/clientvm @clientvm/terminal

# tools for your agent (optional)
npm install @clientvm/agent-api`,
  },
  {
    id: 'instance',
    label: 'Run something',
    lang: 'ts',
    code: `import { createClientVM } from '@clientvm/clientvm';

// one instance per subdomain of your sandbox domain
const vm = createClientVM({ sandboxOrigin: (id) => \`https://\${id}.myapp-sandbox.dev\` });

// a ready Vite + React + TypeScript project, node_modules included
const app = await vm.createInstance({ preset: 'vite-react-ts' });

app.onPortOpen((port, url) => (preview.src = url)); // private to this tab
await app.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });`,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    lang: 'ts',
    code: `import { Terminal } from '@xterm/xterm'; // bring your own emulator
import { attachShell } from '@clientvm/terminal';

const term = new Terminal();
term.open(element);

// history, Tab completion, Ctrl+C, job control
await attachShell(term, app, { cwd: '/home/user/app' });`,
  },
  {
    id: 'agent',
    label: 'Agent tools',
    lang: 'ts',
    code: `import { createAgentTools } from '@clientvm/agent-api';

const tools = createAgentTools({ instance: app });

// send tools.definitions to the model as \`tools\`,
// then run each tool_use block in the browser:
const result = await tools.call(block.name, block.input);`,
  },
  {
    id: 'host',
    label: 'Host the sandbox',
    lang: 'sh',
    code: `# static files, no server code
pnpm --filter @clientvm/sandbox-host build   # → packages/sandbox-host/dist

# serve them on *.myapp-sandbox.dev with the isolation headers, then check:
node scripts/check-sandbox-headers.mjs 'https://{id}.myapp-sandbox.dev' \\
  --app https://myapp.example`,
  },
];

export const limits = [
  {
    title: 'Chromium only',
    body: 'v1 relies on Document-Isolation-Policy, OPFS and Atomics.waitAsync. Firefox and Safari are not supported yet.',
  },
  {
    title: 'No native addons',
    body: 'node-gyp builds, sharp and prisma engines do not run. A few build tools are swapped for their WebAssembly builds; anything else fails with ERR_DLOPEN_FAILED.',
  },
  {
    title: 'The network is the browser’s',
    body: 'Outbound fetch is subject to CORS, and there is no raw TCP or UDP. git remotes need a CORS proxy.',
  },
  {
    title: 'JavaScript only',
    body: 'Node.js 24 and a TypeScript shell. No Python, no Go, no x86 emulation.',
  },
  {
    title: 'Pre-1.0',
    body: 'The sandbox boundary has not had an independent security review yet. Every Node API we support is listed, with its gaps, in the compatibility matrix.',
  },
];

export const limitLinks = [
  { label: 'Compatibility matrix', href: `${DOCS}/compatibility.md` },
  { label: 'Security model', href: `${DOCS}/security.md` },
  { label: 'Security review', href: `${DOCS}/security-review.md` },
];

export const nav = [
  { label: 'Demo', href: '#demo' },
  { label: 'Docs', href: `${REPO}#readme` },
  { label: 'Compatibility', href: `${DOCS}/compatibility.md` },
  { label: 'Security', href: `${DOCS}/security.md` },
];

/** The markdown version of the page, for agents (/index.md) and /llms.txt. */
export function landingMarkdown(): string {
  const lines = [
    '# ClientVM',
    '',
    `> ${hero.title} ${hero.lede}`,
    '',
    `Source: ${REPO} · License: Apache-2.0 · Live demo: ${SITE}/#demo`,
    '',
    '## Install',
    '',
    '```sh',
    hero.install,
    '```',
    '',
    '## How it works',
    '',
    ...howItWorks.map((h) => `- **${h.title}.** ${h.body}`),
    '',
    '## Features',
    '',
    ...features.map((f) => `- [${f.title}](${f.href}): ${f.body}`),
    '',
    '## Quickstart',
    '',
    ...quickstart.flatMap((q) => [`### ${q.label}`, '', '```' + q.lang, q.code, '```', '']),
    '## Limits',
    '',
    ...limits.map((l) => `- **${l.title}.** ${l.body}`),
    '',
    ...limitLinks.map((l) => `- [${l.label}](${l.href})`),
    '',
    '## Integration prompt for coding agents',
    '',
    '```text',
    agentPrompt,
    '```',
    '',
  ];
  return lines.join('\n');
}
