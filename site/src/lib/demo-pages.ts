// SPDX-License-Identifier: Apache-2.0
// The demos as markdown, for agents: /demos.md lists them and
// /demos/<slug>.md describes one. Built from the same catalog as the pages.
import { DEMOS, type Demo } from '../demos/catalog.ts';
import { REPO, SITE, docUrl } from '../content/landing.ts';

/** The gallery's copy, shared by the page and its markdown. */
export const gallery = {
  title: 'Runs in this tab.',
  lede: 'Every demo below boots a ClientVM instance in your browser: no server, no sign-up, and nothing leaves the device. Each one shows a claim the docs make, working.',
  faq: [
    {
      q: 'Where does a demo run?',
      a: 'In this tab. The page creates an instance on its own sandbox origin, which runs bash, Node.js and npm in Web Workers. The preview is served by a service worker on that origin, so the app you see never leaves the browser.',
    },
    {
      q: 'Which browsers work?',
      a: 'Chromium-based browsers (Chrome, Edge, Brave, Arc) version 137 or later. ClientVM v1 relies on Document-Isolation-Policy, which other engines do not ship yet.',
    },
    {
      q: 'Why is the first run slower?',
      a: 'The first time, npm and any WebAssembly build tools are downloaded and checked, and presets are built once. They are cached in your browser, so later runs start in seconds.',
    },
    {
      q: 'Can I use one as a starting point?',
      a: 'Yes. Each demo links to its files on GitHub, and the code under “How it’s built” is the ClientVM part. Open it in the playground to change it first.',
    },
  ],
};

/** The source link for a demo: a file or a folder in the repository. */
export const sourceUrl = (demo: Demo): string =>
  `${REPO}/${demo.source.endsWith('.ts') ? 'blob' : 'tree'}/main/${demo.source}`;

const chip = (t: Demo['triggers'][number]) =>
  t.command ? `\`${t.command}\`` : `tool call \`${t.tool?.name}\` ${JSON.stringify(t.tool?.input)}`;

export function demoMarkdown(demo: Demo): string {
  return [
    `# ${demo.name}`,
    '',
    `> ${demo.summary}`,
    '',
    `Live: ${SITE}/demos/${demo.slug}/ (Chromium) · Source: ${sourceUrl(demo)}`,
    '',
    ...demo.about.flatMap((p) => [p, '']),
    "## How it's built",
    '',
    '```ts',
    demo.code,
    '```',
    '',
    '## Try',
    '',
    ...demo.triggers.map((t) => `- ${t.label}: ${chip(t)}`),
    '',
    '## Built with',
    '',
    demo.builtWith.join(', '),
    '',
    '## Docs',
    '',
    ...demo.docs.map((d) => `- [${d.label}](${docUrl(d.slug)})`),
    '',
  ].join('\n');
}

export function galleryMarkdown(): string {
  return [
    '# ClientVM demos',
    '',
    `> ${gallery.lede}`,
    '',
    ...DEMOS.map((d) => `- [${d.name}](${SITE}/demos/${d.slug}.md) (${d.category}): ${d.summary}`),
    '',
    '## Questions',
    '',
    ...gallery.faq.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
  ].join('\n');
}
