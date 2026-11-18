// SPDX-License-Identifier: Apache-2.0
// Cloudflare Worker for the site's demo sandbox. It serves the static
// @clientvm/sandbox-host build and adds the response headers instance and
// port origins need (docs/hosting.md). It never sets cookies.
import { sandboxResponse } from './sandbox.ts';
import type { SandboxEnv } from './sandbox.ts';

interface Env extends SandboxEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return sandboxResponse(request, env, (r) => env.ASSETS.fetch(r));
  },
};
