# File mention search

Both composer file menus use this module. Source loading and draft hydration
remain in the parent mentions directory; menu rendering consumes asynchronous
results through `useMentionFileSearch`.

| File                                     | Responsibility                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| [use-file-search.ts](use-file-search.ts) | React lifecycle, source/query freshness, and loading/error state             |
| [client.ts](client.ts)                   | Worker message contract, latest-query coalescing, cancellation, and disposal |
| [search.worker.ts](search.worker.ts)     | Worker-owned index and cooperative query execution                           |
| [engine.ts](engine.ts)                   | Path normalization, cached scoring metadata, and bounded ranked selection    |

The engine shares the parent's vendored fuzzy scorer. The client imports engine
types only; the hook never executes search on the renderer thread. Binding rules
live in [the parent AGENTS.md](../AGENTS.md).

[Behavior tests](../../../../tests/mention-file-search.test.ts) and the
[production-browser benchmark](../../../../benchmarks/file-search/README.md)
share synthetic paths and a frozen reference under
[`tests/fixtures/file-search/`](../../../../tests/fixtures/file-search/).
