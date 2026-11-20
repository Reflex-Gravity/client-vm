// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';

export default defineConfig({
  // Previews arrive on the sandbox's own Host, which Vite's DNS-rebinding check rejects.
  // The dev server is a ClientVM virtual port only that origin can reach.
  server: { allowedHosts: true },
});
