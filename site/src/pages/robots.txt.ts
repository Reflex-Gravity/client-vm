// SPDX-License-Identifier: Apache-2.0
// /robots.txt: everything is public, search and AI crawlers alike, and the
// sitemap and llms.txt say where to start.
import { SITE } from '../content/landing.ts';

export function GET(): Response {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
    `# For language models: ${SITE}/llms.txt (index) and ${SITE}/llms-full.txt (all docs).`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
