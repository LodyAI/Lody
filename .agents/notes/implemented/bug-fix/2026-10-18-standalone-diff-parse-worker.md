# Parse standalone diffs in the shared Worker

Status: implemented
Translation: current

[中文版](2026-10-18-standalone-diff-parse-worker.zh.md)

## Abstract

Standalone tool and PR-file diffs previously parsed synchronously below 200,000 combined characters. Text length did not bound comparison complexity: a synthetic 5,000-line replacement below that limit blocked the main thread for approximately 1.74 seconds. Cache misses now use the existing shared parse Worker where available, while retaining the complete unchanged-line context and fallback availability previously provided by inline parsing. Existing explicit multi-file/chunk-source and large-file paths remain bounded and preserve their failure behavior. Moving computation does not itself shorten diff preparation or solve very large diff DOM/layout costs.

## Decision and behavior

`ui/diff-viewer/diff-viewer.tsx` expands the existing Worker route, retaining its queue, exact-input request identity, parsed cache, stale-result guard, suspended-job reuse and visibility admission. Supplied metadata and cache hits bypass parsing. No new Worker owner, data authority, or message lifecycle is introduced; React presentation stays ordinary TypeScript rather than migrating the established shared Worker request owner.

```text
visible cache miss
  → existing shared Worker queue
  → compare complete old/new inputs
  → discard obsolete results
  → restore formerly-inline unchanged context
  → cache and render
```

The Worker intentionally strips complete old/new line arrays for bounded multi-file results. Newly offloaded standalone inputs below the previous threshold reconstruct those arrays with Pierre's exported `SPLIT_WITH_NEWLINES`, preserving exact CRLF, empty-file and final-newline behavior and the unchanged context needed by expansion/rendering. Only these formerly inline inputs retain a synchronous availability fallback when Worker creation/execution fails. Missing Worker APIs keep their prior synchronous route. Explicit worker-only, chunked and larger inputs continue to report failures without a potentially unbounded inline retry. Cancelled or superseded effects neither restore context nor execute fallback parsing.

Changing only the default route without restoring complete lines would change standalone context behavior. Returning full files for every Worker result would expand memory/transfer costs for existing large and chunked surfaces. This implementation keeps the legacy distinction at the viewer, leaving the shared client/Worker protocol unchanged. The existing [multi-file decision](2026-10-17-multi-file-diff-opening.md) continues to own viewport/read limits; it is not replaced.

## Correctness and measurement limits

The owning viewer suite covers loading-to-ready through a deferred parse, complete normalized-result equality including unchanged CRLF context, cached remount, obsolete-file completion, Worker absence/failure, supplied metadata, deferred collapsed bodies, visibility suspension, retained unsent comments, exact-input edits and explicit worker-only failure. Existing client and real Worker-implementation suites cover chunk transport and bounded results. No correctness test uses a wall-clock performance threshold.

The preceding production-browser audit measured 610.5–620.3 ms synchronous parsing for 3,000 replaced lines and 1,743 ms for 5,000 lines / 177,781 combined characters. The existing Worker took 1,673 ms on the latter fixture with a 6.2 ms maximum frame gap; the direct/Worker normalized metadata matched. These isolate parsing, not full viewer paint or packaged Electron performance. Worker failure can still block briefly on the deliberately retained legacy fallback, and huge rendered diffs can still incur DOM/layout cost.

The final implementation passed root `pnpm check` (including 576 component test files / 5,609 tests) and root `pnpm format`. An isolated production Storybook fixture using the real viewer verified all 120 CRLF context lines can be expanded, including the first and last lines. A complete 5,000-line / 177,781-character replacement rendered the expected final new line; readiness took 2,827.7 ms and its maximum frame gap was 845.7 ms. This full-viewer result exposes the remaining rendering cost rather than repeating the parse-only frame claim. The fixture explicitly retains Pierre 1.0.10’s existing custom-element registration, whose package side-effect declaration names source rather than shipped dist. No test-environment workaround changes product source. `pnpm run docs check` reports only six existing links into uninitialized Kimi/Pi submodules.

The [file-surface guide](../../../docs/sessions-file-surfaces.md) and nearest UI rules describe the current route. Product regression and root-check results are recorded with the PR. Private traces and transcripts are excluded.
