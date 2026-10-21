# Golden project fixtures

Template projects that the e2e suite runs inside ClientVM. Each has a `package.json` and a
committed `package-lock.json`; `test/e2e/fixtures.ts` installs it once with the host's `npm ci`
(cached in `node_modules/.cache/clientvm-fixtures`, keyed by the lockfile hash) and loads it into
an instance as a file tree.

| Fixture | Used by | What it covers |
|---|---|---|
| `express-ws` | `test/e2e/http.spec.ts` | Unmodified Express 4 + ws 8: routing, JSON bodies, streaming, redirects, WebSockets from a preview, `http.get`/`fetch` from another process |
