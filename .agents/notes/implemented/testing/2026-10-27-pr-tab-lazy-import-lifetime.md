# Keep PR-tab browser fixtures alive through lazy imports

Status: implemented
Translation: current
PR: [#1970](https://github.com/LodyAI/Lody/pull/1970)

[中文](2026-10-27-pr-tab-lazy-import-lifetime.zh.md)

## Abstract

PR-tab layout tests mount real Markdown renderers that begin browser-only lazy imports. CI could finish every assertion and destroy the suite's document before KaTeX copy-tex evaluated, producing unhandled rejections. The suite now waits for Vitest's pending dynamic imports in its final hook, preserving the browser fixture through actual module completion. Product loading behavior and rendering assertions remain unchanged.

## Ownership and evidence

`pr-tab-view.test.ts` owns its jsdom document and the imports started by its mounts. Unmounting the React roots does not cancel native module loading, so final teardown waits on `vi.dynamicImportSettled()` rather than sleeping, mocking Markdown, suppressing errors or weakening assertions. This complements the per-file ownership in the [module-graph decision](2026-09-10-components-test-module-graph.md).

The original components CI shard passed 208 files / 1927 assertions but reported three `document is not defined` rejections from `katex/contrib/copy-tex` after this fixture was torn down. The aggregate Tests job only reflected that shard failure; CLI and its Fleet suite had passed. A focused local run did not reproduce the CI timing, so the CI evidence establishes the failure while the owned completion boundary explains the fix. The affected shard and follow-up CI provide verification; this is not a product-rendering or native-keychain acceptance claim.
