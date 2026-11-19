// SPDX-License-Identifier: Apache-2.0
// /sitemap.xml: the landing page, the demos, the docs index and every doc page, with the
// date each doc last changed in git.
import { SITE } from '../content/landing.ts';
import { docPages } from '../lib/doc-index.ts';
import { DEMOS } from '../demos/catalog.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function GET(): Promise<Response> {
  const pages = await docPages();
  const urls = [
    { loc: `${SITE}/`, priority: '1.0' },
    { loc: `${SITE}/docs/`, priority: '0.9' },
    { loc: `${SITE}/demos/`, priority: '0.8' },
    ...DEMOS.map((d) => ({ loc: `${SITE}/demos/${d.slug}/`, priority: '0.7' })),
    ...pages.map((p) => ({
      loc: `${SITE}/docs/${p.slug}/`,
      lastmod: p.modified,
      priority: p.slug.startsWith('decisions/') ? '0.5' : '0.8',
    })),
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) =>
        `  <url><loc>${esc(u.loc)}</loc>${
          'lastmod' in u && u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''
        }<priority>${u.priority}</priority></url>`,
    ),
    '</urlset>',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
