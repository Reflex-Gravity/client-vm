// SPDX-License-Identifier: Apache-2.0
// schema.org structured data (JSON-LD) for search engines and agents that read it.
import { REPO, SITE, hero, version } from '../content/landing.ts';

const website = {
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  url: `${SITE}/`,
  name: 'ClientVM',
  description: hero.lede,
  inLanguage: 'en',
};

const software = {
  '@type': ['SoftwareSourceCode', 'SoftwareApplication'],
  '@id': `${SITE}/#software`,
  name: 'ClientVM',
  description: hero.lede,
  url: `${SITE}/`,
  codeRepository: REPO,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  programmingLanguage: 'TypeScript',
  runtimePlatform: 'Chromium',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Any (Chromium-based browser)',
  softwareVersion: version,
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  keywords: [
    'browser runtime',
    'Node.js in the browser',
    'AI agent sandbox',
    'in-browser bash',
    'npm in the browser',
  ].join(', '),
};

/** The landing page: the site and the software. */
export const homeGraph = (): Record<string, unknown>[] => [website, software];

/** A docs page: an article about the software, with its breadcrumb trail. */
export function docGraph(doc: {
  slug: string;
  title: string;
  description: string;
  section: string;
  modified: string | undefined;
}): Record<string, unknown>[] {
  const url = `${SITE}/docs/${doc.slug}/`;
  return [
    website,
    {
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: doc.title,
      description: doc.description,
      url,
      mainEntityOfPage: url,
      inLanguage: 'en',
      articleSection: doc.section,
      ...(doc.modified ? { dateModified: doc.modified } : {}),
      isPartOf: { '@id': `${SITE}/#website` },
      about: { '@id': `${SITE}/#software` },
      encoding: {
        '@type': 'MediaObject',
        encodingFormat: 'text/markdown',
        contentUrl: `${SITE}/docs/${doc.slug}.md`,
      },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'ClientVM', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Docs', item: `${SITE}/docs/` },
        { '@type': 'ListItem', position: 3, name: doc.title, item: url },
      ],
    },
  ];
}
