# Coalesce overlapping local history refreshes

Status: implemented
Translation: pending
PR: [#563](https://github.com/LodyAI/Lody/pull/563)

## Abstract

Opening the same imported conversation in overlapping renderer lifecycles could start the same
local history refresh twice, while the CLI rejected the second request as an error. Local project
history operations now share the result of an equivalent in-flight request and serialize distinct
requests for the same project. The coordinator is process-local, so it does not claim coordination
between separate CLI processes.

## Decision and scope

The CLI service owns coordination because it is the shared boundary for catalog sync, selected
session import, and conflict resolution. A request identity includes the provider, workspace,
machine, local project, operation, root path, and operation target. Import targets are treated as a
set, so equivalent selections in a different order reuse the same result.

Distinct operations and targets retain the existing single-writer behavior by waiting for the
project's current tail instead of surfacing a synthetic “already running” error. The original
operation result or failure still reaches every caller that requested it. A settled operation is
removed before callers continue, and a failed operation does not poison the queue, so a later
refresh can run normally.

This supplements the imported-history guarantees in
[One history writer before windowed readers](../architecture/2026-09-07-single-history-writer.md).
It does not change replay comparison, catalog persistence, conflict resolution policy, or the
cross-process concurrency limit recorded there.

## Evidence and limits

Deterministic service tests use deferred promises to show that equivalent imports execute once and
return the same result, different targets execute in order, and fresh requests run after both
failure and successful completion. CLI typechecking and the focused service suite validate the
process-local contract. The tests do not reproduce renderer remount timing or exercise filesystem
and provider I/O.
