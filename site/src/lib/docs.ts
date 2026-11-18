// SPDX-License-Identifier: Apache-2.0
// Which of the repository's docs/ the site publishes, in what order, and how a
// link inside one of them resolves once it is a page here. Internal plans
// (phase plans, spike notes, open questions) stay on GitHub.

const REPO_BLOB = 'https://github.com/Reflex-Gravity/client-vm/blob/main';

export interface DocGroup {
  label: string;
  /** One line for the /docs/ index. */
  blurb: string;
  /** Slugs: paths under docs/ without `.md`. */
  slugs: string[];
}

/**
 * The guides, in reading order, grouped the way most library docs are: start,
 * concepts, guides, reference. The individual decision records (decisions/*)
 * are listed under the last group, after the summary page.
 */
export const GUIDES: DocGroup[] = [
  {
    label: 'Get started',
    blurb: 'What ClientVM is, a first instance, and the sandbox it needs.',
    slugs: ['overview', 'quickstart', 'hosting'],
  },
  {
    label: 'Concepts',
    blurb: 'How the pieces fit together, and what keeps agent code contained.',
    slugs: ['architecture', 'security'],
  },
  {
    label: 'Guides',
    blurb: 'Hand an instance to an LLM agent.',
    slugs: ['agent-api'],
  },
  {
    label: 'Reference',
    blurb: 'The public API, what works in Node, and every package.',
    slugs: ['interfaces', 'compatibility', 'packages', 'security-review'],
  },
  {
    label: 'Design decisions',
    blurb: 'Why ClientVM is built the way it is, summarised on one page.',
    slugs: ['decisions'],
  },
];

/** Every published guide, in reading order (for prev/next links and llms.txt). */
export const READING_ORDER = GUIDES.flatMap((g) => g.slugs);

/** The glob the docs collection loads, relative to docs/. */
export const DOC_PATTERNS = [...READING_ORDER.map((s) => `${s}.md`), 'decisions/*.md'];

/** Diagrams in docs/diagrams/, served by the site at /docs/diagrams/<name>.svg. */
export const DIAGRAM = /^docs\/diagrams\/([a-z0-9-]+\.svg)$/;

export const isPublished = (slug: string): boolean =>
  GUIDES.some((g) => g.slugs.includes(slug)) || /^decisions\/[^/]+$/.test(slug);

/** The first `# heading` of a markdown file. */
export function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+?)\s*$/m.exec(markdown)?.[1] ?? fallback;
}

/** POSIX path normalisation without node:path, so this also runs in the browser bundle. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Where a link in a doc goes on the site.
 *
 * @param from the doc's path under docs/, e.g. `decisions/0003-x.md`
 * @param href the link as written in the markdown
 * @param mode `html` for the rendered page (root-relative `/docs/<slug>/`),
 *   `md` for the markdown served to agents (`/docs/<slug>.md`)
 */
export function resolveDocLink(from: string, href: string, mode: 'html' | 'md' = 'html'): string {
  // External, in-page, root-relative and mailto links are already fine.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/'))
    return href;
  const hashAt = href.indexOf('#');
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  // Resolved against the repository root; docs live under docs/.
  const target = normalize(`docs/${dir}/${path}`);

  if (target === 'docs') return `/docs/${hash}`;
  if (target === 'docs/decisions') return mode === 'md' ? '/docs/decisions.md' : '/docs/decisions/';
  if (DIAGRAM.test(target)) return `/${target}`;
  if (target.startsWith('docs/') && target.endsWith('.md')) {
    const slug = target.slice('docs/'.length, -'.md'.length);
    if (isPublished(slug))
      return mode === 'md' ? `/docs/${slug}.md${hash}` : `/docs/${slug}/${hash}`;
  }
  return `${REPO_BLOB}/${target}${hash}`;
}

/**
 * A doc's markdown as served to agents: links (and images) point at the other
 * markdown copies on `site`, or at GitHub for files the site doesn't publish.
 */
export function agentMarkdown(slug: string, body: string, site: string): string {
  return body.replace(/\]\(([^)\s]+)\)/g, (_, href: string) => {
    const to = resolveDocLink(`${slug}.md`, href, 'md');
    return `](${to.startsWith('/') ? site + to : to})`;
  });
}
