// SPDX-License-Identifier: Apache-2.0
// A Markdown plugin for the docs collection (Astro's Sätteri processor): relative
// links between docs become links between the site's pages, and links to anything
// else in the repository go to GitHub (src/lib/docs.ts).
import { fileURLToPath } from 'node:url';
import { resolveDocLink } from './docs.ts';

interface UrlNode {
  url: string;
}

interface Ctx {
  readonly fileURL: URL | undefined;
  setProperty(node: UrlNode, key: 'url', value: string): void;
}

/** The file's path under docs/, or undefined for markdown outside it. */
export function docPath(fileURL: URL | undefined): string | undefined {
  if (!fileURL) return undefined;
  const path = fileURLToPath(fileURL);
  const at = path.lastIndexOf('/docs/');
  return at >= 0 ? path.slice(at + '/docs/'.length) : undefined;
}

function rewrite(node: UrlNode, ctx: Ctx): void {
  const from = docPath(ctx.fileURL);
  if (from === undefined) return;
  const url = resolveDocLink(from, node.url);
  if (url !== node.url) ctx.setProperty(node, 'url', url);
}

export const docLinks = {
  name: 'clientvm-doc-links',
  link: rewrite,
  definition: rewrite,
};
