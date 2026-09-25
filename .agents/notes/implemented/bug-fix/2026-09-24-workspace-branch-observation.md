# Observe workspace branches independently of GitHub

Status: implemented
Translation: current
PR: [#953](https://github.com/LodyAI/Lody/pull/953)

[中文](2026-09-24-workspace-branch-observation.zh.md)

## Abstract

Local Git conversations could have no branch display because branch synchronization
ran only inside GitHub turn finalization. A workspace branch service now owns Git
observation and owner-session publication, independently of PR processing. Agent
binding, terminal turns, and authorized workspace activation/explicit root refresh use the same
serialized service. Existing last-known-branch semantics remain; continuous idle
HEAD watching is outside this change.

## Decision

The UI already consumes branch metadata for local projects, so adding another UI
Git reader would duplicate state and move machine filesystem knowledge into the
renderer. Merely widening the GitHub condition would leave initial, cancelled, and
idle restored Sessions uncovered. Extract observation from turn post-processing
instead, and inject it into execution plus the workspace activation/explicit refresh boundary.

```text
Execution bind / terminal turn ─┐
Authorized workspace refresh ──┴─> WorkspaceGitService
                                     └─> owner SessionMeta.branchName → existing UI
GitHub PR detection remains a separate optional consumer.
```

The service serializes the Git probe and metadata write per owner, including child
Tabs. Startup and file snapshots do not await the observation. Publication does
not depend on a changed file-index row, so a branch-only refresh is not discarded.
Failures are best effort and never invent a branch or discard restoration identity.
No new wire field, renderer reader, polling loop, or GitHub dependency is introduced.

The earlier [render-cost guidance](../../../docs/sessions-render-cost.md) continues
to govern branch labels. The [contract](../../../../specs/workspace-branch-state.md)
records the observation points and last-known semantics. Unborn branches are valid;
detached HEAD and unreadable/non-Git directories do not replace existing metadata.

## Verification

200 initial tests passed across branch observation, execution, post-processing, Code
Collab, and MessageHandler integration suites. Real temporary Git repositories cover remote-free/unborn branches,
checkout changes, worktrees, and detached HEAD. Deterministic barriers cover
concurrent parent/child observations and nonblocking workspace activation.
Execution tests assert branch state before the prompt, after a local turn, and
after cancellation during finalization. CLI type checking, scoped formatting, and
document checks passed. Scoped type-aware lint reported no errors; the new service
and its tests reported no warnings. The desktop UI was not manually launched.

An idle external checkout with no workspace refresh is not a live update guarantee.
No UI redesign or release is included.

Full repository `pnpm check` and `pnpm format` also passed before PR creation.

## Review refinements

Independent review found no P0/P1 blockers, but identified repeated probes when
execution finalization also refreshed Code Collab, and on ordinary file watcher
events. Narrow the injected observer to branch observation at activation and explicit
root refresh; terminal observation stays with execution. Failure publication no
longer awaits this optional probe. A throwing workdir resolver is caught before
probing and preserves the last branch. Behavioral regressions cover watcher/turn
refresh exclusion, nonblocking failure settlement, and unavailable workdirs.

Post-review validation: 187 targeted regression tests, full `pnpm check`,
`pnpm format`, and `pnpm run docs check` passed.
