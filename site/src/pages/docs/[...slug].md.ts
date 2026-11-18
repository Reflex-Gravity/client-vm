// SPDX-License-Identifier: Apache-2.0
// Each published doc as markdown, for agents: /docs/<slug>.md. Links point at
// the other markdown copies, or at GitHub for files the site doesn't publish.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '../../content/landing.ts';
import { agentMarkdown } from '../../lib/docs.ts';

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { body: entry.body ?? '' } }));
};

export const GET: APIRoute = ({ params, props }) =>
  new Response(agentMarkdown(params['slug'] ?? '', props['body'] as string, SITE), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
