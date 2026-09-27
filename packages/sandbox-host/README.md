# @clientvm/sandbox-host

The static sandbox page plus kernel and process worker entries. It must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

- `pnpm dev`: development server with isolation headers.
- `pnpm build && pnpm preview`: production bundle (used by Playwright).
