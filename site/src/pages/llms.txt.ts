// SPDX-License-Identifier: Apache-2.0
// /llms.txt: what ClientVM is and where to read more, for agents.
import { DOCS, REPO, SITE, hero } from '../content/landing.ts';

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
    `- [Hosting the sandbox](${DOCS}/hosting.md): domain, headers and deployment checks`,
    `- [Compatibility matrix](${DOCS}/compatibility.md): every supported Node API and its gaps`,
    `- [Agent tool API](${DOCS}/agent-api.md): LLM tool definitions for an instance`,
    `- [Interfaces](${DOCS}/interfaces.md): the public API`,
    `- [Security model](${DOCS}/security.md)`,
    '',
    '## Optional',
    '',
    `- [Architecture](${DOCS}/architecture.md)`,
    `- [Packages](${DOCS}/packages.md)`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
