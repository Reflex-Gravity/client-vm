// SPDX-License-Identifier: Apache-2.0
// An HTML (hast) plugin for the docs collection:
// - GitHub's alert blockquotes (`> [!NOTE]`, TIP, IMPORTANT, WARNING, CAUTION),
//   which GitHub renders as callouts, become <aside class="callout"> here too;
// - diagrams get their intrinsic size, so pages don't shift as they load.
import { readFileSync } from 'node:fs';

interface Text {
  type: 'text';
  value: string;
}
interface Element {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
}
type Node = Text | Element | { type: string; children?: Node[] };

interface Ctx {
  setProperty(node: Element, key: string, value: unknown): void;
}

export const ALERTS = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
} as const;

const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

const isElement = (n: Node | undefined): n is Element => n?.type === 'element';

/** The callout for an alert blockquote, or undefined for an ordinary quote. */
export function calloutOf(quote: Element): Element | undefined {
  const children = structuredClone(quote.children);
  const first = children.find(isElement);
  if (!first || first.tagName !== 'p') return undefined;
  const text = first.children[0];
  if (!text || text.type !== 'text') return undefined;
  const match = MARKER.exec((text as Text).value);
  if (!match) return undefined;
  const kind = match[1] as keyof typeof ALERTS;
  (text as Text).value = (text as Text).value.slice(match[0].length);
  // A marker on its own line leaves a leading line break; drop it.
  if ((text as Text).value === '' && first.children[1]?.type === 'element') {
    const br = first.children[1] as Element;
    if (br.tagName === 'br') first.children.splice(0, 2);
  }
  if (first.children.length === 0) children.splice(children.indexOf(first), 1);
  return {
    type: 'element',
    tagName: 'aside',
    properties: { className: ['callout', `callout-${kind.toLowerCase()}`] },
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: { className: ['callout-title'] },
        children: [{ type: 'text', value: ALERTS[kind] }],
      },
      ...children,
    ],
  };
}

const sizes = new Map<string, { width: number; height: number } | undefined>();
/** A diagram's viewBox size, read from docs/diagrams/ (the site builds from site/). */
function diagramSize(src: string): { width: number; height: number } | undefined {
  const name = /^\/docs\/diagrams\/([a-z0-9-]+\.svg)$/.exec(src)?.[1];
  if (!name) return undefined;
  if (!sizes.has(name)) {
    try {
      const svg = readFileSync(
        new URL(`../docs/diagrams/${name}`, `file://${process.cwd()}/`),
        'utf8',
      );
      const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      sizes.set(name, vb ? { width: Number(vb[1]), height: Number(vb[2]) } : undefined);
    } catch {
      sizes.set(name, undefined);
    }
  }
  return sizes.get(name);
}

export const docHtml = {
  name: 'clientvm-doc-html',
  element: {
    filter: ['blockquote', 'img'],
    visit(node: Element, ctx: Ctx): Element | void {
      if (node.tagName === 'blockquote') return calloutOf(node);
      const size = diagramSize(String(node.properties['src'] ?? ''));
      if (!size) return;
      ctx.setProperty(node, 'width', size.width);
      ctx.setProperty(node, 'height', size.height);
      ctx.setProperty(node, 'decoding', 'async');
      ctx.setProperty(node, 'className', ['diagram']);
    },
  },
};
