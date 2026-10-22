# Golden project fixtures

Template projects that the e2e suite runs inside ClientVM. Each has a `package.json` and a
committed `package-lock.json`; `test/e2e/fixtures.ts` installs it once with the host's `npm ci` for linux/x64/glibc (the platform ClientVM reports, so optional native packages match an install inside an instance)
(cached in `node_modules/.cache/clientvm-fixtures`, keyed by the lockfile hash) and loads it into
an instance as a file tree.

| Fixture | Used by | What it covers |
|---|---|---|
| `express-ws` | `test/e2e/http.spec.ts` | Unmodified Express 4 + ws 8: routing, JSON bodies, streaming, redirects, WebSockets from a preview, `http.get`/`fetch` from another process |
| `vite-react` | `test/e2e/vite.spec.ts` | A stock Vite 6 + React 18 project (no overrides): dev server with React Fast Refresh over the WebSocket shim, CSS HMR, the error overlay, and `vite build` with esbuild and rollup replaced by their WebAssembly builds (ADR 0013) |
| `vite8-react` | `test/e2e/vite8.spec.ts` | A stock Vite 8 + React 19 project (no overrides): dev server with HMR and CSS updates, and `vite build`, with rolldown and lightningcss replaced by their WebAssembly builds, installed on first use (ADR 0013) |
| `drive-app` | `test/e2e/drive.spec.ts` | A dependency-free node server (no install step) with a counter, a form, a second page and console output, for driving previews |
