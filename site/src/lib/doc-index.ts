// SPDX-License-Identifier: Apache-2.0
// The docs collection arranged for the sidebar and the /docs/ index.
import { getCollection } from 'astro:content';
import { GUIDES, titleOf } from './docs.ts';

export interface DocLink {
  slug: string;
  title: string;
  summary: string;
}

export interface DocSection {
  label: string;
  id: string;
  docs: DocLink[];
}

/** The first paragraph after the title, as plain text. */
function summaryOf(markdown: string): string {
  const para =
    markdown
      .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
      .replace(/^#[^\n]*\n/m, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^[#|>`-]/.test(p)) ?? '';
  const text = para
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ');
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}…` : text;
}

export async function docSections(): Promise<DocSection[]> {
  const entries = await getCollection('docs');
  const link = (slug: string): DocLink | undefined => {
    const e = entries.find((x) => x.id === slug);
    if (!e) return undefined;
    const title = titleOf(e.body ?? '', slug).replace(/^ADR \d+:\s*/, '');
    return { slug, title, summary: summaryOf(e.body ?? '') };
  };
  const guides = GUIDES.map((g) => ({
    label: g.label,
    id: g.label.toLowerCase().replace(/\s+/g, '-'),
    docs: g.slugs.map(link).filter((d): d is DocLink => d !== undefined),
  }));
  const decisions = entries
    .map((e) => e.id)
    .filter((id) => id.startsWith('decisions/'))
    .sort()
    .map((slug) => {
      const d = link(slug)!;
      return {
        ...d,
        title: `${slug.slice('decisions/'.length, 'decisions/'.length + 4)} · ${d.title}`,
      };
    });
  return [...guides, { label: 'Design decisions', id: 'decisions', docs: decisions }];
}
