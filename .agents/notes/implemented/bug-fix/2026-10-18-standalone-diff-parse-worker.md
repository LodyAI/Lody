# Parse standalone diffs in the shared Worker

Status: implemented
Translation: current

[中文版](2026-10-18-standalone-diff-parse-worker.zh.md)

## Abstract

Standalone tool and PR-file diffs previously parsed synchronously below 200,000 combined characters. Text length did not bound comparison complexity: a synthetic 5,000-line replacement below that limit blocked the main thread for approximately 1.74 seconds. Cache misses now use the existing shared parse Worker where available, except for standalone snippets bounded by both characters and lines, which retain immediate availability even while that Worker is busy. Complete unchanged-line context and legacy fallback availability remain intact. Explicit multi-file/chunk-source and large-file paths preserve their existing bounds and failures; very large diff DOM/layout costs remain.

## Decision and behavior

`ui/diff-viewer/diff-viewer.tsx` expands the existing Worker route, retaining its queue, exact-input request identity, parsed cache, stale-result guard, suspended-job reuse and visibility admission. Supplied metadata and cache hits bypass parsing. Standalone snippets with at most 8,192 combined characters and 256 combined lines retain the synchronous path; counting stops as soon as the line budget is exceeded and allocates no line arrays. All other formerly inline inputs use the Worker when available. Explicit multi-file/chunked sources remain Worker-only regardless of size. No new Worker owner, data authority, or message lifecycle is introduced; this pure admission predicate does not change the established shared Worker lifecycle.

```text
visible cache miss
  → bounded tiny standalone snippet: parse inline and render immediately
  → otherwise: existing shared Worker queue
  → compare complete old/new inputs
  → discard obsolete results
  → restore formerly-inline unchanged context
  → cache and render
```

The Worker intentionally strips complete old/new line arrays for bounded multi-file results. Newly offloaded standalone inputs below the previous threshold reconstruct those arrays with Pierre's exported `SPLIT_WITH_NEWLINES`, preserving exact CRLF, empty-file and final-newline behavior and the unchanged context needed by expansion/rendering. Only these formerly inline inputs retain a synchronous availability fallback when Worker creation/execution fails. Missing Worker APIs keep their prior synchronous route. Explicit worker-only, chunked and larger inputs continue to report failures without a potentially unbounded inline retry. Cancelled or superseded effects neither restore context nor execute fallback parsing.

Routing every tiny snippet through the Worker would introduce a new availability dependency: tool and PR-file callers omit `parseCacheKey`, so virtualized remounts cannot reuse the parsed cache and would briefly collapse to the loading state on every mount, potentially waiting behind a large file. A deferred-Worker regression reproduces that failure in the original PR and proves small snippets remain ready across remounts after the correction. A narrow synchronous budget avoids that dependency without content-derived cache keys or another queue. Larger uncached standalone diffs still prepare asynchronously, including on remount; syntax highlighting continues to share the render Worker for every size.

Changing only the default route without restoring complete lines would change standalone context behavior. Returning full files for every Worker result would expand memory/transfer costs for existing large and chunked surfaces. This implementation keeps the legacy distinction at the viewer, leaving the shared client/Worker protocol unchanged. The existing [multi-file decision](2026-10-17-multi-file-diff-opening.md) continues to own viewport/read limits; it is not replaced.

## Correctness and measurement limits

The owning viewer suite covers immediate uncached mount/remount while a Worker request is held, including both inline-budget boundaries; deferred default parsing beyond the line and character budgets; complete normalized-result equality including unchanged CRLF context; cached remount; obsolete-file completion; Worker absence/failure; empty files and final newlines through both routes; supplied metadata; deferred collapsed bodies; visibility suspension; retained unsent comments; exact-input edits; and explicit worker-only failure. Existing client and real Worker-implementation suites cover chunk transport and bounded results. No correctness test uses a wall-clock performance threshold.

The preceding production-browser audit measured 610.5–620.3 ms synchronous parsing for 3,000 replaced lines and 1,743 ms for 5,000 lines / 177,781 combined characters. The existing Worker took 1,673 ms on the latter fixture with a 6.2 ms maximum frame gap; the direct/Worker normalized metadata matched. These isolate parsing, not full viewer paint or packaged Electron performance. Worker failure can still block briefly on the deliberately retained legacy fallback, and huge rendered diffs can still incur DOM/layout cost.

Initial full-viewer validation expanded all 120 CRLF context lines through the UI, including the first and last lines. A complete 5,000-line / 177,781-character replacement rendered the expected final new line; readiness took 2,827.7 ms and its maximum frame gap was 845.7 ms. This exposes the remaining rendering cost rather than repeating the parse-only frame claim. A second production Storybook build compares the original PR revision and bounded-inline correction in the same bundle: with the 5,000-line replacement queued first, the original snippet displays loading until the large file completes; the corrected snippet is already readable while the large file remains preparing. Both render the large file's expected final line. This is one diagnostic pair, not an isolated timing benchmark: validation runs concurrently and the baseline runs first, warming shared Workers. Uncached remount behavior is covered by deterministic deferred-Worker tests rather than a full conversation scroll-engine integration.

The final correction passes all 23 focused viewer/client/Worker tests and root `pnpm check`, including 576 component test files / 5,612 tests, plus root `pnpm format`. The browser fixtures explicitly retain Pierre 1.0.10’s existing custom-element registration, whose package side-effect declaration names source rather than shipped dist. No test-environment workaround changes product source. `pnpm run docs check` reports only six existing links into uninitialized Kimi/Pi submodules.

The [file-surface guide](../../../docs/sessions-file-surfaces.md) and nearest UI rules describe the current route. Implementation and validation are recorded in [PR #1694](https://github.com/LodyAI/Lody/pull/1694). Private traces and transcripts are excluded.
