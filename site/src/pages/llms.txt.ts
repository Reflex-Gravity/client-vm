// SPDX-License-Identifier: Apache-2.0
// /llms.txt (https://llmstxt.org): what ClientVM is, the rules an agent should
// know before integrating it, and every doc as markdown, grouped as the sidebar is.
import { REPO, SITE, hero } from '../content/landing.ts';
import { docSections } from '../lib/doc-index.ts';
import { DEMOS } from '../demos/catalog.ts';

export async function GET(): Promise<Response> {
  const sections = await docSections();
  const item = (d: { slug: string; title: string; summary: string }) =>
    `- [${d.title}](${SITE}/docs/${d.slug}.md)${d.summary ? `: ${d.summary}` : ''}`;
  const body = [
    '# ClientVM',
    '',
    `> ${hero.title} ${hero.lede}`,
    '',
    `Every page below is Markdown. All of them in one file: ${SITE}/llms-full.txt. The landing page as Markdown: ${SITE}/index.md. Source: ${REPO}.`,
    '',
    'Before you integrate it:',
    '',
    '- ClientVM runs in Chromium-based browsers only.',
    '- It needs a static sandbox deployment (`@clientvm/sandbox-host`) on a wildcard subdomain of a separate registrable domain, with the headers in the hosting guide. The host app itself needs no COOP/COEP headers.',
    '- Native Node addons do not run (esbuild, rollup, rolldown, lightningcss and Tailwind oxide are swapped for their WebAssembly builds). Outbound `fetch` is subject to CORS; there is no raw TCP.',
    '- Check the compatibility matrix before relying on a Node API.',
    '- Keep model API keys on a server; relay tool calls to the page that owns the ClientVM.',
    '',
    ...sections.flatMap((s) => [`## ${s.label}`, '', ...s.docs.map(item), '']),
    '## Demos',
    '',
    ...DEMOS.map((d) => `- [${d.name}](${SITE}/demos/${d.slug}.md): ${d.summary}`),
    '',
    '## Optional',
    '',
    ...(sections.find((s) => s.records)?.records ?? []).map(item),
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
