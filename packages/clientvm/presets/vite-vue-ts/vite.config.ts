import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Previews arrive on the sandbox's own Host, which Vite's DNS-rebinding check rejects.
  // The dev server is a ClientVM virtual port only that origin can reach.
  server: { allowedHosts: true },
});
