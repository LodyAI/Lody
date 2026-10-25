# Finish Markdown imports before jsdom teardown

Status: implemented
Translation: current
PR: [#1879](https://github.com/LodyAI/Lody/pull/1879)

[中文](2026-10-25-markdown-test-import-drain.zh.md)

## Abstract

CI's third component shard passed all 204 test files but failed on 21 unhandled
rejections from KaTeX Copy-tex accessing `document` after jsdom teardown.
The session-share Markdown suite now waits for pending dynamic imports in its
`afterAll` hook. This keeps the real lazy-loading path while ensuring its browser
initialization finishes inside the test environment's lifetime.

## Scope and verification

The [Markdown suite](../../../../packages/components/tests/session-share-markdown.test.tsx)
mounts the real renderer, whose effect imports the
[browser-only entry](../../../../packages/components/src/components/ai-gui/markdown-math-copy.ts).
Copy-tex registers a document listener during module evaluation, as recorded in
the [math copy decision](../feature/2026-10-16-math-selection-copy.md).
`vi.dynamicImportSettled()` joins that work before the suite releases jsdom;
it does not suppress import errors or replace the extension with a mock.
The three focused Markdown rendering, selection, and sharing suites pass all
93 tests locally. The original CI failure depends on module-loading timing and
did not reproduce in the focused local baseline; CI remains the runner check.
The local full-shard attempt has no unhandled import errors, but fails eight
other files with missing exports from reused dependencies and storage-fixture
errors; it is not a passing full-shard result.
