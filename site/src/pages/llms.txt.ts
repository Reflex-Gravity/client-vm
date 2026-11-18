// SPDX-License-Identifier: Apache-2.0
// /llms.txt: what ClientVM is and where to read more, for agents.
import { REPO, SITE, docMd, hero } from '../content/landing.ts';

export function GET(): Response {
  const body = [
    '# ClientVM',
    '',
    `> ${hero.title} ${hero.lede}`,
    '',
    '## Docs',
    '',
    `- [This page as markdown](${SITE}/index.md): features, quickstart, limits, and an integration prompt`,
    `- [README](${REPO}#readme): how it works and how to integrate it`,
    `- [Docs index](${SITE}/docs/): every guide and design decision`,
    `- [Hosting the sandbox](${docMd('hosting')}): domain, headers and deployment checks`,
    `- [Compatibility matrix](${docMd('compatibility')}): every supported Node API and its gaps`,
    `- [Agent tool API](${docMd('agent-api')}): LLM tool definitions for an instance`,
    `- [Interfaces](${docMd('interfaces')}): the public API`,
    `- [Security model](${docMd('security')})`,
    '',
    '## Optional',
    '',
    `- [Architecture](${docMd('architecture')})`,
    `- [Packages](${docMd('packages')})`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
