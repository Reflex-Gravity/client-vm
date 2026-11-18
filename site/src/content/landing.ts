// SPDX-License-Identifier: Apache-2.0
// The landing page's copy, in one place. The page (src/pages/index.astro), the
// markdown version for agents (/index.md) and /llms.txt all render from it.

export const REPO = 'https://github.com/Reflex-Gravity/client-vm';
export const SITE = 'https://clientvm.joeldsouza.me';
/** The docs as they sit in the repository; internal plans are only read there. */
export const REPO_DOCS = `${REPO}/blob/main/docs`;

/** A page of the docs on this site: `doc('hosting')`, `doc('decisions/0003-…', 'why')`. */
export const doc = (slug: string, hash?: string): string =>
  `/docs/${slug}/${hash ? `#${hash}` : ''}`;
/** The same page as an absolute URL, for text read off this site (/index.md, prompts). */
export const docUrl = (slug: string, hash?: string): string => SITE + doc(slug, hash);
/** The page's markdown source, served next to it for agents. */
export const docMd = (slug: string): string => `${SITE}/docs/${slug}.md`;
/** The current release; landing.test.ts checks it against @clientvm/clientvm. */
export const version = '0.2.0';

export const hero = {
  eyebrow: 'no server-side compute · chromium',
  title: 'A dev machine for every AI agent, inside a browser tab.',
  lede:
    'ClientVM runs Node.js 24, a real bash and the unmodified npm in the browser. Each agent ' +
    'gets isolated instances with their own filesystem, processes and network, runs npm ' +
    'install and npm run dev, and previews the app it built. No containers, no servers to pay for.',
  install: 'npm install @clientvm/clientvm @clientvm/terminal',
};

/** The licence pitch, shown in the hero and in its own band near the end. */
export const openSource = {
  badge: 'Free & open source',
  license: 'Apache-2.0',
  title: 'Free to use. Open source.',
  body:
    'ClientVM is Apache-2.0: use it in commercial products, fork it, change it, ship it. ' +
    'The code runs in your users’ browsers, so there are no sandbox servers to run or pay ' +
    'for, only static files to host.',
};

/** A project in the works, teased (not linked) in the banner and the footer. */
export const upcoming = {
  name: 'NovemAI',
  label: 'Coming soon',
};

/** What "Copy agent prompt" puts on the clipboard: enough for a coding agent to integrate ClientVM. */
export const agentPrompt = `Integrate ClientVM (${REPO}) into this web app so it can run Node.js 24, bash and npm entirely in the browser.

1. Install @clientvm/clientvm, @clientvm/terminal and @clientvm/agent-api from npm.
2. ClientVM needs a static sandbox: install @clientvm/sandbox-host as a dev dependency and deploy its dist/ folder on a wildcard subdomain of a separate registrable domain (each instance and each preview port gets its own subdomain, so the browser isolates them from this app). Serve these headers on every response: Document-Isolation-Policy: isolate-and-require-corp, Cross-Origin-Embedder-Policy: require-corp, Cross-Origin-Resource-Policy: cross-origin, Content-Security-Policy: frame-ancestors <this app's origin>, plus Service-Worker-Allowed: / on /__clientvm/sw.js. Check it with npx clientvm-check-sandbox 'https://{id}.<sandbox-domain>' --app <this app's origin>. Follow ${docMd('hosting')}.
3. Create a controller: createClientVM({ sandboxOrigin: (id) => \`https://\${id}.<sandbox-domain>\` }). This app needs no COOP/COEP headers.
4. Create an instance with vm.createInstance({ preset: 'vite-react-ts' }) or from files, run commands with instance.exec / instance.spawn, and show previews from instance.onPortOpen((port, url) => ...) in an iframe.
5. For a terminal, pass an xterm.js Terminal to attachShell(term, instance) from @clientvm/terminal.
6. For LLM tools, createAgentTools({ instance }) from @clientvm/agent-api gives tool definitions and tools.call(name, input).

Limits: Chromium only, no native Node addons, outbound fetch is subject to CORS, no raw TCP. Check ${docMd('compatibility')} before relying on a Node API.`;

export interface Feature {
  title: string;
  body: string;
  href: string;
}

export const features: Feature[] = [
  {
    title: 'Real npm and pnpm',
    body: 'The unmodified npm 11 and pnpm 10, fetched and SHA-512-verified on first use. Lockfiles, lifecycle scripts, workspaces.',
    href: doc('compatibility'),
  },
  {
    title: 'Vite with HMR',
    body: 'Stock Vite 6 and Vite 8 projects. esbuild, rollup, rolldown and lightningcss run as their official WebAssembly builds.',
    href: doc('decisions/0013-wasm-stand-ins-for-native-packages'),
  },
  {
    title: 'An interactive bash',
    body: 'Pseudo-terminals, signals, Ctrl+C and Ctrl+Z, job control, history and Tab completion. About 60 Linux commands, diffed against bash and GNU tools.',
    href: doc('decisions/0017-pty-and-signals'),
  },
  {
    title: 'Synchronous syscalls',
    body: 'fs.readFileSync really blocks, on SharedArrayBuffer and Atomics.wait, at about 10 µs per round trip.',
    href: `${REPO_DOCS}/spike-results.md`,
  },
  {
    title: 'One origin per instance',
    body: 'Each instance runs on its own subdomain, so the browser keeps agent code away from your app and from other instances.',
    href: doc('security'),
  },
  {
    title: 'Snapshots and forks',
    body: 'Copy-on-write snapshots, forks into new instances, OPFS persistence, a mailbox and capability-gated networking between instances.',
    href: doc('interfaces'),
  },
  {
    title: 'Tools for agents',
    body: 'Files, exec, background processes, screenshots and a driveable preview, as LLM tool definitions.',
    href: doc('agent-api'),
  },
  {
    title: 'Static hosting only',
    body: 'The sandbox is a folder of static files behind a wildcard subdomain. Nothing runs on a server.',
    href: doc('hosting'),
  },
];

/** Four steps, in the order they happen; components/HowItWorks.astro animates them. */
export const howItWorks = [
  {
    title: 'Your page asks for a sandbox',
    code: "vm.createInstance({ preset: 'vite-react-ts' })",
    body: 'One call from your app. The controller on your page only passes messages, and checks every one; agent code never runs on your origin.',
  },
  {
    title: 'It boots on its own origin',
    code: 'https://k3x9….sandbox-domain',
    body: 'A hidden iframe on its own subdomain starts a kernel: a filesystem, a process table, terminals and network ports. The browser keeps it walled off from your app and from other sandboxes.',
  },
  {
    title: 'Code runs as on Linux',
    code: 'npm install && npm run dev',
    body: 'bash, node and npm each run in their own Web Worker and talk to the kernel through system calls. fs.readFileSync really blocks, and a system call round trip takes about 10 µs.',
  },
  {
    title: 'The preview comes back',
    code: 'onPortOpen((port, url) => …)',
    body: 'When a server listens on a port, a service worker serves it on its own origin. You show it in an iframe; it never leaves the tab.',
  },
];

/** The browser features each step rests on, for readers who want the detail. */
export const howItWorksTech = [
  { label: 'Document-Isolation-Policy', href: doc('decisions/0005-document-isolation-policy') },
  { label: 'SharedArrayBuffer + Atomics.wait', href: `${REPO_DOCS}/spike-results.md` },
  { label: 'one Web Worker per process', href: doc('architecture') },
  { label: 'service-worker previews', href: doc('decisions/0008-sub-origin-per-port') },
  { label: 'threat model', href: doc('security') },
];

export interface QuickstartTab {
  id: string;
  label: string;
  lang: 'sh' | 'ts';
  code: string;
}

export interface QuickstartStep extends QuickstartTab {
  title: string;
  body: string;
  /** Optional detail behind a disclosure: why the step is the way it is. */
  why?: { summary: string; diagram: string[]; points: string[]; href: string };
}

/** The path from nothing to a running app, in order. Every step is shown at once. */
export const quickstartSteps: QuickstartStep[] = [
  {
    id: 'sandbox',
    label: 'Deploy the sandbox',
    title: 'Deploy the sandbox, once',
    body:
      'A folder of static files, served on every subdomain of a domain of its own. Each instance ' +
      'and each preview gets its own subdomain, so the browser walls agent code off from your ' +
      'app and from every other instance.',
    why: {
      summary: 'Why a wildcard subdomain on a separate domain?',
      diagram: [
        'myapp.example                  your app: the controller, no special headers',
        '└─ k3x9.myapp-sandbox.dev        instance: its own kernel, files, processes',
        '   └─ k3x9-p5173.myapp-sandbox.dev   preview of the dev server on port 5173',
      ],
      points: [
        'The browser isolates origins: storage, service workers and windows. One origin per instance keeps its code out of your app and out of the other instances.',
        'Previews get an origin per port, served by that origin’s service worker, so an app’s pages are isolated too.',
        'Instance ids and ports are made at runtime, so the deployment must answer for any subdomain: a wildcard, not a list.',
        'Under your own domain (sandbox.myapp.com) instance code would be same-site with your app, and could set cookies on .myapp.com. A separate domain keeps it cross-site.',
        'The headers make every instance page cross-origin isolated (Document-Isolation-Policy). That is what lets fs.readFileSync really block, and why your app needs no COOP/COEP.',
      ],
      href: doc('hosting', 'why-subdomains'),
    },
    lang: 'sh',
    code: `# static files, no server code
npm install -D @clientvm/sandbox-host

# deploy node_modules/@clientvm/sandbox-host/dist to *.myapp-sandbox.dev,
# with these headers on every response:
#   Document-Isolation-Policy: isolate-and-require-corp
#   Cross-Origin-Embedder-Policy: require-corp
#   Cross-Origin-Resource-Policy: cross-origin
#   Content-Security-Policy: frame-ancestors https://myapp.example
# (and Service-Worker-Allowed: / on /__clientvm/sw.js)

# then check the deployment
npx clientvm-check-sandbox 'https://{id}.myapp-sandbox.dev' --app https://myapp.example`,
  },
  {
    id: 'install',
    label: 'Install',
    title: 'Install the runtime in your app',
    body: 'The controller that runs on your page. It only passes messages to the sandbox and checks each one.',
    lang: 'sh',
    code: 'npm install @clientvm/clientvm',
  },
  {
    id: 'run',
    label: 'Run an app',
    title: 'Boot an instance and show its preview',
    body: 'Point the controller at the sandbox from step 1, boot a ready project and start its dev server.',
    lang: 'ts',
    code: `import { createClientVM } from '@clientvm/clientvm';

// the sandbox from step 1; {id} becomes each instance's subdomain
const vm = createClientVM({
  sandboxOrigin: (id) => \`https://\${id}.myapp-sandbox.dev\`,
});

// a ready Vite + React + TypeScript project, node_modules included
const app = await vm.createInstance({ preset: 'vite-react-ts' });

// the dev server's port opens on its own origin, private to this tab
const preview = document.querySelector('iframe')!;
app.onPortOpen((port, url) => (preview.src = url));

await app.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });`,
  },
];

/** Optional extras on top of step 3's `app`. */
export const quickstartAddons: QuickstartTab[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    lang: 'ts',
    code: `// npm install @clientvm/terminal @xterm/xterm
import { Terminal } from '@xterm/xterm'; // or any xterm.js-compatible emulator
import { attachShell } from '@clientvm/terminal';

const term = new Terminal();
term.open(document.querySelector('#terminal')!);

// a real bash: history, Tab completion, Ctrl+C, job control
await attachShell(term, app, { cwd: '/home/user/app' });`,
  },
  {
    id: 'agent',
    label: 'Agent tools',
    lang: 'ts',
    code: `// npm install @clientvm/agent-api
import { createAgentTools } from '@clientvm/agent-api';

const tools = createAgentTools({ instance: app });

// send tools.definitions to the model as \`tools\`; for each tool call
// it makes, run the tool here in the browser and send the result back
for (const block of response.content) {
  if (block.type !== 'tool_use') continue;
  const result = await tools.call(block.name, block.input);
  results.push({ type: 'tool_result', tool_use_id: block.id, ...result });
}`,
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
  { label: 'Compatibility matrix', href: doc('compatibility') },
  { label: 'Security model', href: doc('security') },
  { label: 'Security review', href: doc('security-review') },
];

export const nav = [
  { label: 'Demo', href: '/#demo' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Compatibility', href: doc('compatibility') },
  { label: 'Security', href: doc('security') },
];

/** The markdown version of the page, for agents (/index.md) and /llms.txt. */
export function landingMarkdown(): string {
  // Links on the page are root-relative; off the page they need the site.
  const abs = (href: string) => (href.startsWith('/') ? SITE + href : href);
  const lines = [
    '# ClientVM',
    '',
    `> ${hero.title} ${hero.lede}`,
    '',
    `Free and open source (Apache-2.0) · Source: ${REPO} · Live demo: ${SITE}/#demo`,
    '',
    '## Install',
    '',
    '```sh',
    hero.install,
    '```',
    '',
    '## How it works',
    '',
    ...howItWorks.map((h, i) => `${i + 1}. **${h.title}** (\`${h.code}\`). ${h.body}`),
    '',
    '## Features',
    '',
    ...features.map((f) => `- [${f.title}](${abs(f.href)}): ${f.body}`),
    '',
    '## Quickstart',
    '',
    ...quickstartSteps.flatMap((q, i) => [
      `### ${i + 1}. ${q.title}`,
      '',
      q.body,
      '',
      ...(q.why
        ? [
            `${q.why.summary}`,
            '',
            '```text',
            ...q.why.diagram,
            '```',
            '',
            ...q.why.points.map((p) => `- ${p}`),
            '',
            `More: ${abs(q.why.href)}`,
            '',
          ]
        : []),
      '```' + q.lang,
      q.code,
      '```',
      '',
    ]),
    '### Add-ons',
    '',
    ...quickstartAddons.flatMap((q) => [`#### ${q.label}`, '', '```' + q.lang, q.code, '```', '']),
    '## Limits',
    '',
    ...limits.map((l) => `- **${l.title}.** ${l.body}`),
    '',
    ...limitLinks.map((l) => `- [${l.label}](${abs(l.href)})`),
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
