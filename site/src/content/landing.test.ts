// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { facts, footerColumns, landingMarkdown, nav, version } from './landing.ts';
import { DEMOS } from '../demos/catalog.ts';

describe('landing copy', () => {
  it('names the current release in its beta notice', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../packages/clientvm/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(version).toBe(pkg.version);
  });

  it('counts the Node tests CI runs, from the vendored manifest', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../../test/conformance/node-tests/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as { passing: string[] };
    expect(facts.map((f) => f.value)).toContain(String(manifest.passing.length));
  });

  it('links the demos and the playground from the nav and the footer', () => {
    const navLinks = nav.map((n) => n.href);
    expect(navLinks).toEqual(expect.arrayContaining(['/demos/', '/play/']));
    const footerLinks = footerColumns.flatMap((c) => c.links.map((l) => l.href));
    expect(footerLinks).toEqual(expect.arrayContaining(['/demos/', '/play/', '/llms.txt']));
  });

  it('lists every demo in the markdown version', () => {
    const md = landingMarkdown();
    expect(md).toContain('## Demos');
    for (const d of DEMOS) expect(md).toContain(`/demos/${d.slug}/`);
  });
});
