import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Previews arrive on the sandbox's own Host, which Vite's DNS-rebinding check rejects.
  // The dev server is a ClientVM virtual port only that origin can reach.
  server: { allowedHosts: true },
});
