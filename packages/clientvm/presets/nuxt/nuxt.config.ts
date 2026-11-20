// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  css: ['~/assets/main.css'],
  // Devtools and telemetry are off: they are untested in the in-browser runtime.
  devtools: { enabled: false },
  telemetry: false,
  vite: {
    // Previews arrive on the sandbox's own Host, which Vite's DNS-rebinding check rejects.
    // The dev server is a ClientVM virtual port only that origin can reach.
    server: { allowedHosts: true },
  },
});
