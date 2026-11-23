# Discover Session operation targets from Repo metadata

Status: implemented
Translation: current

[中文](2026-09-17-session-operation-metadata-snapshots.zh.md)

## Abstract

Session lifecycle operations could miss descendants because the renderer's metadata
projection may lag the Repo even after initial hydration. Archive, restore, and
archived-root deletion now discover targets from one workspace-bound Repo snapshot,
after the selected metadata source is ready. The existing relation rules remain
unchanged, and local desktop operations do not require cloud connectivity. Failed
discovery produces no writes; partial write failures remain visible and are not
rolled back as though runtime or worktree cleanup were reversible.

## Decision and ownership

The [relation Spec](../../../../specs/session-relations.md) owns operation semantics.
The [shared reader](../../../../packages/shared/src/session-operation-targets.ts)
uses one metadata-only `repo.listDoc` call, derives identity from document room ids,
and excludes deletion markers. Root validation and descendant selection use that
same result; neither reads nor falls back to UI atoms.

| Operation                            | Snapshot selection                                            |
| ------------------------------------ | ------------------------------------------------------------- |
| Archive                              | Root and recursive containment/precise opened-by descendants. |
| Restore or archived-root deletion    | Root and direct containment children.                         |
| Exact deletion or ordinary Tab close | No relation discovery or global readiness gate.               |

The [runtime](../../../../packages/components/src/providers/create-workspace-runtime.ts)
rejects reads before its selected metadata source completes initial synchronization
or after disposal. Local desktop uses the local transport; cloud reachability and
UI hydration are not gates. [Session actions](../../../../packages/components/src/hooks/use-session-actions.ts)
check current runtime identity after asynchronous discovery and restore validation,
before writing through the captured writer. Once started, writes retain that runtime
and target set. CLI [commands](../../../../apps/cli/src/commands/session.ts) require
pre-discovery synchronization for all three operations, including workspace
resolution after degraded initialization, and retain post-write sync confirmation.

A snapshot means metadata observed in that Repo after its applicable readiness
boundary. It excludes later creations and disconnected replicas. There is no new
relation index, history hydration, daemon command, or cross-Session transaction.

## Failure and recovery

Failed source readiness, failed queries, and missing or deleted roots reject before
writes or terminal closure. Archive writes remain sequential and idempotent; earlier
writes may survive a later failure. Retrying an archived root rediscovers descendants.
Terminal closure follows each accepted archive write and is best-effort. Deletion
processes direct children before the root so a child failure retains the root.

The [state-driven cleanup decision](2026-09-11-session-worktree-reconciliation.md)
remains authoritative for daemon resource cleanup: restoring metadata cannot recreate
terminated runtimes or undo worktree cleanup. Durable completion after process death
would require a separate operation protocol, outside this discovery fix.

## Evidence and alternatives

[#663](https://github.com/LodyAI/Lody/pull/663) and its
[archive decision](../bug-fix/2026-09-13-session-archive-descendants.md) fixed cold
archive by rejecting an incomplete UI cache, but left restore unguarded.
The [projection owner](../../../../packages/components/src/atoms/doc-meta.ts)
publishes later Repo events in deferred batches, so even a ready cache can lag.
The prior investigation at `e11be6b8` reproduced both misses with synthetic callbacks.

Adding the restore guard or waiting for cache readiness as in
[#577](https://github.com/LodyAI/Lody/pull/577) would retain live projection lag.
The unmerged [#658](https://github.com/LodyAI/Lody/pull/658) supplied the Repo-query
direction, but its containment-only archive rule predates #663 and its compensation
cannot undo resource shutdown. This decision replaces the discovery boundary, not
the [containment rules](../bug-fix/2026-09-10-session-containment-lifecycle.md)
retained for restore and deletion.

## Verification and limits

The owning [action suite](../../../../packages/components/tests/use-session-actions.test.ts)
and [CLI suite](../../../../apps/cli/src/commands/session.test.ts) exercise real Repo
state, stale UI projections, deleted entries, canonical identity, failed reads/sync,
workspace switches, partial writes, retry, and unchanged cascade rules.
The [runtime suite](../../../../packages/components/tests/create-workspace-runtime-meta-recovery.test.ts)
covers cold source readiness, local operation without cloud, and disposal during reads.
Deferred signals control races without sleeps.

The four focused component suites passed 90 tests; the CLI command suite passed 71.
Repository validation passed type checks, lint, formatting, script/workspace tests,
i18n, import guards, and platform/public boundaries. The full shared, component,
CLI, and Electron suites passed 1,237, 3,767, 2,886, and 120 tests respectively;
the CI selection retains seven pre-existing skips in CLI/RPC suites.

Validation used pnpm 10.20.0 in a separate clone at the same revision, with lockfile
dependencies and pinned public ACP submodules. Node 26 required
`NODE_OPTIONS=--no-experimental-webstorage` to avoid its native `localStorage`
interfering with jsdom. The `pnpm check` run then reached Electron and stopped on
its missing binary; after supplying the matching 39.5.1 distribution, Electron and
the remaining check stages passed separately. No product code changed for these
environment accommodations. `pnpm run docs check` passed in the validation clone
with 35 existing warnings and no SHA-protected topics. This nested worktree has no
dependencies or initialized ACP submodules; its document check retains the 28
baseline missing-submodule links.

No live Session, Issue, or PR was changed. The Spec remains draft. #574 and #577
still need their normal merge/closure workflow; this local implementation does not
claim either is already closed.
