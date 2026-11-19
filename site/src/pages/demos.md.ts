// SPDX-License-Identifier: Apache-2.0
// The demos gallery as markdown, for agents: /demos.md.
import { galleryMarkdown } from '../lib/demo-pages.ts';

export function GET(): Response {
  return new Response(galleryMarkdown(), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
