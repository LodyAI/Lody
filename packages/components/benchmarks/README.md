# Component benchmarks

| Benchmark                                           | Purpose                                     | Run from this directory's parent (`packages/components`) |
| --------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| [Conversation window](conversation-window.bench.ts) | Windowed history costs                      | `pnpm bench:conversation`                                |
| [Composer file search](file-search/README.md)       | Ranking latency and renderer responsiveness | `node benchmarks/file-search/run.mjs 3`                  |
| [Window bootstrap](window-bootstrap/README.md) | Cross-renderer snapshot reuse and cache-miss overhead | `node benchmarks/window-bootstrap/run.mjs 50` |
