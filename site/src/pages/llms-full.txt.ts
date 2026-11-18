// SPDX-License-Identifier: Apache-2.0
// /llms-full.txt: every published doc in one markdown file, guides in reading
// order then the decision records, so an agent can load all of it at once.
import { REPO, SITE, hero } from '../content/landing.ts';
import { docPages } from '../lib/doc-index.ts';
import { agentMarkdown } from '../lib/docs.ts';

export async function GET(): Promise<Response> {
  const pages = await docPages();
  const body = [
    '# ClientVM documentation',
    '',
    `> ${hero.title} ${hero.lede}`,
    '',
    `Source: ${REPO}. Each section below is one page of ${SITE}/docs/, also served on its own at the URL given.`,
    '',
    ...pages.flatMap((p) => [
      '---',
      '',
      `<!-- ${SITE}/docs/${p.slug}.md -->`,
      '',
      agentMarkdown(p.slug, p.body, SITE).trim(),
      '',
    ]),
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
