// SPDX-License-Identifier: Apache-2.0
// The docs collection arranged for the sidebar, the /docs/ index, prev/next
// links, the sitemap and the agent-facing text files. Runs at build time only.
import { execFileSync } from 'node:child_process';
import { getCollection } from 'astro:content';
import { GUIDES, READING_ORDER, titleOf } from './docs.ts';

export interface DocLink {
  slug: string;
  title: string;
  summary: string;
}

export interface DocSection {
  label: string;
  id: string;
  blurb: string;
  docs: DocLink[];
  /** The individual decision records, under "Design decisions". */
  records?: DocLink[];
}

export interface DocPage extends DocLink {
  body: string;
  /** The section it is listed under. */
  section: string;
  /** ISO date of the last commit that touched it, if git knows. */
  modified: string | undefined;
}

/** The first paragraph after the title, as plain text. */
export function summaryOf(markdown: string): string {
  const para =
    markdown
      .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
      .replace(/^#[^\n]*\n/m, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^[#|>!<-]/.test(p) && !/^\[[^\]]+\]\([^)]*\)\s*·/.test(p)) ?? '';
  const text = para
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ');
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}…` : text;
}

const modifiedCache = new Map<string, string | undefined>();
/** When docs/<slug>.md last changed, from git (CI checks out full history). */
function modifiedOf(slug: string): string | undefined {
  if (!modifiedCache.has(slug)) {
    let date: string | undefined;
    try {
      date =
        execFileSync('git', ['log', '-1', '--format=%cI', '--', `../docs/${slug}.md`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
      date = undefined;
    }
    modifiedCache.set(slug, date);
  }
  return modifiedCache.get(slug);
}

const recordTitle = (slug: string, title: string): string =>
  `${slug.slice('decisions/'.length, 'decisions/'.length + 4)} · ${title}`;

/** Every published doc, guides in reading order then decision records. */
export async function docPages(): Promise<DocPage[]> {
  const entries = await getCollection('docs');
  const page = (slug: string, section: string): DocPage | undefined => {
    const e = entries.find((x) => x.id === slug);
    if (!e) return undefined;
    const body = e.body ?? '';
    const title = titleOf(body, slug).replace(/^ADR \d+:\s*/, '');
    return {
      slug,
      title: slug.startsWith('decisions/') ? recordTitle(slug, title) : title,
      summary: summaryOf(body),
      body,
      section,
      modified: modifiedOf(slug),
    };
  };
  const guides = GUIDES.flatMap((g) => g.slugs.map((s) => page(s, g.label)));
  const records = entries
    .map((e) => e.id)
    .filter((id) => id.startsWith('decisions/'))
    .sort()
    .map((s) => page(s, 'Design decisions'));
  return [...guides, ...records].filter((d): d is DocPage => d !== undefined);
}

export async function docSections(): Promise<DocSection[]> {
  const pages = await docPages();
  const link = ({ slug, title, summary }: DocPage): DocLink => ({ slug, title, summary });
  return GUIDES.map((g) => {
    const section: DocSection = {
      label: g.label,
      id: g.label.toLowerCase().replace(/\s+/g, '-'),
      blurb: g.blurb,
      docs: g.slugs
        .map((s) => pages.find((p) => p.slug === s))
        .filter((p): p is DocPage => p !== undefined)
        .map(link),
    };
    if (g.label === 'Design decisions')
      section.records = pages.filter((p) => p.slug.startsWith('decisions/')).map(link);
    return section;
  });
}

/** The guides before and after this one in reading order; records step through records. */
export async function neighbours(
  slug: string,
): Promise<{ prev: DocLink | undefined; next: DocLink | undefined }> {
  const pages = await docPages();
  const order = slug.startsWith('decisions/')
    ? ['decisions', ...pages.filter((p) => p.slug.startsWith('decisions/')).map((p) => p.slug)]
    : READING_ORDER;
  const at = order.indexOf(slug);
  const find = (s: string | undefined) => pages.find((p) => p.slug === s);
  return {
    prev: at > 0 ? find(order[at - 1]) : undefined,
    next: at >= 0 ? find(order[at + 1]) : undefined,
  };
}
