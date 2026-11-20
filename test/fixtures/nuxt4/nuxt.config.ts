// SPDX-License-Identifier: Apache-2.0
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: false },
  telemetry: false,
  vite: { server: { allowedHosts: true } },
});
