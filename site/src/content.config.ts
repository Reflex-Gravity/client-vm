// SPDX-License-Identifier: Apache-2.0
// The repository's user-facing docs, published as pages under /docs/
// (src/lib/docs.ts says which). Their markdown stays the source of truth in docs/.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { DOC_PATTERNS } from './lib/docs.ts';

export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: DOC_PATTERNS,
      base: '../docs',
      // Ids are the paths under docs/ without `.md`, exactly as links name them.
      generateId: ({ entry }) => entry.replace(/\.md$/, ''),
    }),
  }),
};
