# Component benchmarks

| Benchmark                                           | Purpose                                                          | Run from this directory's parent (`packages/components`)                                              |
| --------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Conversation window](conversation-window.bench.ts) | Windowed history costs                                           | `pnpm bench:conversation`                                                                             |
| [Sidebar toggle](sidebar-toggle.bench.tsx)          | Old remount vs retained 180-row toggle (jsdom; not frame timing) | `NODE_ENV=production pnpm exec vitest bench benchmarks/sidebar-toggle.bench.tsx --run --maxWorkers=1` |
| [Composer file search](file-search/README.md)       | Ranking latency and renderer responsiveness                      | `node benchmarks/file-search/run.mjs 3`                                                               |
| [Slash command ranking](slash-search/README.md)     | Synthetic relevance and pure rank latency                        | `node --experimental-strip-types benchmarks/slash-search/eval.mjs`                                     |
| [Window bootstrap](window-bootstrap/README.md)      | Cross-renderer snapshot reuse and cache-miss overhead            | `node benchmarks/window-bootstrap/run.mjs 50`                                                         |
