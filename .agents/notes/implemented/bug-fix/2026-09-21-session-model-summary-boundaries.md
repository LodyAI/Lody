# Keep model summaries shallow, repairable, and outside fork compensation

Status: implemented
Translation: current

[中文](2026-09-21-session-model-summary-boundaries.zh.md)

## Abstract

Model summary observation serialized a growing assistant body on each history commit,
remembered publications after other metadata writers overwrote them, and could fail
an already durable fork. The reader now exposes only model scalars and output counts;
publication compares current metadata, and fork projection runs after compensation's
scope ends. This removes body serialization from the projection and permits repair
on the next history event or flush. It does not introduce immediate metadata-change
observation or a new retry scheduler.

## Decision and responsibilities

This corrects the implementation boundaries of the [original summary decision](../feature/2026-09-12-session-model-summary.md)
and preserves its [display semantics](../../../../specs/session-model-summary.md).
The shared `SessionModelSummaryReader` is a separate narrow capability, leaving the
body reader and directory consumers unchanged. It reads container lengths and model
id/name directly, including legacy inline JSON and LoroText model strings, without
traversing provider extensions. A backward scan remains necessary when the tail has
no visible assistant output; this change does not claim constant time in history length.

```text
history event / flush → scalar/count reader → current metadata comparison → patch
fork history + metadata → durable commit → leave compensation scope → summary flush
```

The publisher owns deduplication because it can read the current metadata cache.
A second remembered publication value cannot establish that the current value still
matches. Metadata subscriptions would add lifecycle and feedback-loop concerns;
repair on history change or flush meets the existing retry boundary. Concurrent
publication remains serialized and hidden/deleted rows remain guarded.

A fork projection has its own error boundary after the saga's compensation block.
Synchronous throws and rejected promises only emit a warning; target session,
worktree, and committed receipt state remain intact. The existing fork harness
already supplies `syncModelSummary`; tests inject failures into that method.

## Verification and limits

Regression coverage uses real Loro containers and rejects recursive map/list
serialization while checking projected values. SessionDocument tests overwrite
metadata after publication and verify repair through a history commit and teardown;
unchanged metadata is not rewritten. Fork tests inject both failure forms and check
that the operation remains committed without termination or worktree cleanup.
The targeted summary/fork, shared history, and import-writer suites passed 113 tests;
shared typechecking, changed-file lint, and root `pnpm format` passed. Root
`pnpm check` stops in components typechecking with missing Electron dependencies
and related type errors. CLI typechecking,
import-service test loading, public-boundary checks, and documentation link checks
are blocked by uninitialized ACP submodules in this checkout. No throughput
benchmark or live provider call is claimed.
