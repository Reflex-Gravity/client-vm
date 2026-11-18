// SPDX-License-Identifier: Apache-2.0
// The docs' diagrams (docs/diagrams/*.svg) at stable URLs, /docs/diagrams/<name>.svg,
// for the pages, the markdown copies and anyone who links to one.
import type { APIRoute, GetStaticPaths } from 'astro';

const files = import.meta.glob<string>('../../../../../docs/diagrams/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(files).map(([path, svg]) => ({
    params: { name: path.slice(path.lastIndexOf('/') + 1) },
    props: { svg },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(props['svg'] as string, {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
  });
