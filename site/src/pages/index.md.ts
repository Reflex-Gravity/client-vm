// SPDX-License-Identifier: Apache-2.0
// /index.md: the landing page as markdown, for agents.
import { landingMarkdown } from '../content/landing.ts';

export function GET(): Response {
  return new Response(landingMarkdown(), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
