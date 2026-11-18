// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isPublished, resolveDocLink, titleOf } from './docs.ts';

const GH = 'https://github.com/Reflex-Gravity/client-vm/blob/main';

describe('resolveDocLink', () => {
  it('links published docs to their pages, keeping the anchor', () => {
    expect(resolveDocLink('hosting.md', 'security.md')).toBe('/docs/security/');
    expect(resolveDocLink('hosting.md', 'security.md#threats')).toBe('/docs/security/#threats');
    expect(resolveDocLink('hosting.md', './decisions/0008-sub-origin-per-port.md')).toBe(
      '/docs/decisions/0008-sub-origin-per-port/',
    );
  });

  it('resolves links from inside decisions/', () => {
    expect(resolveDocLink('decisions/0003-a.md', '0005-b.md')).toBe('/docs/decisions/0005-b/');
    expect(resolveDocLink('decisions/0003-a.md', '../hosting.md#why')).toBe('/docs/hosting/#why');
  });

  it('sends unpublished docs and other repository files to GitHub', () => {
    expect(resolveDocLink('architecture.md', 'phase4-plan.md')).toBe(`${GH}/docs/phase4-plan.md`);
    expect(resolveDocLink('architecture.md', '../CLAUDE.md#4-architecture')).toBe(
      `${GH}/CLAUDE.md#4-architecture`,
    );
    expect(resolveDocLink('decisions/0016-x.md', '../../packages/terminal/')).toBe(
      `${GH}/packages/terminal`,
    );
  });

  it('maps the decisions directory to the summary page', () => {
    expect(resolveDocLink('architecture.md', 'decisions/')).toBe('/docs/decisions/');
    expect(resolveDocLink('architecture.md', 'decisions/', 'md')).toBe('/docs/decisions.md');
    expect(resolveDocLink('architecture.md', 'decisions.md')).toBe('/docs/decisions/');
  });

  it('serves diagrams from the site', () => {
    expect(resolveDocLink('overview.md', 'diagrams/overview.svg')).toBe(
      '/docs/diagrams/overview.svg',
    );
    expect(resolveDocLink('decisions/0003-a.md', '../diagrams/hosting.svg', 'md')).toBe(
      '/docs/diagrams/hosting.svg',
    );
  });

  it('leaves external, in-page and root-relative links alone', () => {
    for (const href of ['https://publicsuffix.org/', '#shell', '/index.md', 'mailto:x@y.z']) {
      expect(resolveDocLink('hosting.md', href)).toBe(href);
    }
  });

  it('points the markdown copy at markdown', () => {
    expect(resolveDocLink('hosting.md', 'security.md#a', 'md')).toBe('/docs/security.md#a');
  });
});

describe('isPublished and titleOf', () => {
  it('publishes the guides and every decision, not the internal plans', () => {
    expect(isPublished('hosting')).toBe(true);
    expect(isPublished('overview')).toBe(true);
    expect(isPublished('decisions')).toBe(true);
    expect(isPublished('decisions/0001-node-24-target')).toBe(true);
    expect(isPublished('phase5-plan')).toBe(false);
    expect(isPublished('spike-results')).toBe(false);
  });

  it('reads the first heading', () => {
    expect(titleOf('intro\n\n# Hosting the sandbox\n\n## Sub', 'x')).toBe('Hosting the sandbox');
    expect(titleOf('no heading', 'fallback')).toBe('fallback');
  });
});
