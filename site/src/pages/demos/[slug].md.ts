// SPDX-License-Identifier: Apache-2.0
// Each demo as markdown, for agents: /demos/<slug>.md.
import type { APIRoute, GetStaticPaths } from 'astro';
import { DEMOS, type Demo } from '../../demos/catalog.ts';
import { demoMarkdown } from '../../lib/demo-pages.ts';

export const getStaticPaths: GetStaticPaths = () =>
  DEMOS.map((demo) => ({ params: { slug: demo.slug }, props: { demo } }));

export const GET: APIRoute = ({ props }) =>
  new Response(demoMarkdown(props['demo'] as Demo), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
