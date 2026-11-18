// SPDX-License-Identifier: Apache-2.0
// Which of the repository's docs/ the site publishes, in what order, and how a
// link inside one of them resolves once it is a page here. Internal plans
// (phase plans, spike notes, open questions) stay on GitHub.

const REPO_BLOB = 'https://github.com/Reflex-Gravity/client-vm/blob/main';

export interface DocGroup {
  label: string;
  /** Slugs: paths under docs/ without `.md`. */
  slugs: string[];
}

/** The guides, in reading order. Design decisions (decisions/*) are added after them. */
export const GUIDES: DocGroup[] = [
  { label: 'Get started', slugs: ['hosting', 'interfaces', 'agent-api'] },
  { label: 'Reference', slugs: ['compatibility', 'packages', 'architecture'] },
  { label: 'Security', slugs: ['security', 'security-review'] },
];

/** The glob the docs collection loads, relative to docs/. */
export const DOC_PATTERNS = [
  ...GUIDES.flatMap((g) => g.slugs.map((s) => `${s}.md`)),
  'decisions/*.md',
];

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

  if (target === 'docs' || target === 'docs/decisions') {
    return `/docs/${target === 'docs' ? '' : '#decisions'}${target === 'docs' ? hash : ''}`;
  }
  if (target.startsWith('docs/') && target.endsWith('.md')) {
    const slug = target.slice('docs/'.length, -'.md'.length);
    if (isPublished(slug))
      return mode === 'md' ? `/docs/${slug}.md${hash}` : `/docs/${slug}/${hash}`;
  }
  return `${REPO_BLOB}/${target}${hash}`;
}
