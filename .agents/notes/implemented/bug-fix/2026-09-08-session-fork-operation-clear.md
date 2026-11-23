# Clear completed Session fork operations without deleting their Loro root

Status: implemented
Translation: current

[中文](./2026-09-08-session-fork-operation-clear.zh.md)

## Abstract

A new-worktree Session fork could prepare its Git worktree and ACP runtime but fail during the final commit with `Map value must be an object`. The failure occurred when `SessionDocument.setForkOperation(undefined)` asked loro-mirror to delete the optional `forkOperation` root map. Loro root containers are permanent, so the Session document now clears that map through the Loro API and commits the change. Schema parsing continues to expose an empty map as an absent operation.

## Decision and scope

Writes and phase transitions continue through loro-mirror. Completion clears the existing root `LoroMap` directly and commits it, preserving the container so a later fork can reuse it. This changes no Session protocol or schema and needs no data migration.

The regression test uses a real Loro document and Mirror. It covers initial creation, the transition to `committing`, successful clearing, and reuse by a later operation.

## Evidence and alternatives

The desktop `LODY-FORK-001` journey reached worktree and ACP creation before the root deletion threw. Replacing the value with `{}` also avoids root deletion, but that value violates the declared operation shape and would rely on disabled update validation. Clearing the underlying map follows Loro's root-container model while keeping reads schema-validated.

The focused Loro regression and Session fork service suites pass. The desktop journey has not been rerun on this branch because its implementation remains on a separate, unmerged E2E branch.

The fix is limited to `forkOperation`. Other optional root-container removals should use the same model when they need a clear operation, but they are outside this defect's observed path.
