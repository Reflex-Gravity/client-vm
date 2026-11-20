import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Previews arrive with the sandbox's own Host (<id>-p5173.<sandbox-domain>), which
  // Vite's DNS-rebinding check rejects with a 403 outside localhost. The server is a
  // ClientVM virtual port that only that origin can reach, so the check guards nothing.
  server: { allowedHosts: true },
});
