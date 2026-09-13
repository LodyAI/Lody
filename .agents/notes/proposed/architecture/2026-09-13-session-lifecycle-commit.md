# Commit Session lifecycle operations as one durable fact

Status: proposed
Translation: current

Contract: [Session relations](../../../../specs/session-relations.md)
Execution: [Implementation plan](../../../../plans/001-session-lifecycle-commit.md)

[中文](2026-09-13-session-lifecycle-commit.zh.md)

## Abstract

Archive currently compensates failed metadata writes by restoring a previously read
snapshot, which can overwrite legitimate concurrent writes and can itself leave only
some targets changed. The proposed replacement records each archive or restore as one
immutable operation and derives effective Session lifecycle state through a shared
repository projection. The operation is the unit of conflict resolution, persistence,
and publication; resource cleanup follows the resulting state. Real dependency probes
establish local WASM rollback, but also expose non-atomic repository observation and
per-key conflict resolution. Production persistence and mixed-client migration remain
unverified, so this is a proposal rather than a completed fix for #574.

## Decision and scope

Keep repository-based discovery of the selected Session and direct `parentSessionId`
children, explicit workspace ownership, and post-commit terminal cleanup. Replace
`writeArchiveStateFailureSafe`, ordering-dependent writes, `attemptedTargets`, old-value
compensation, and rollback-error aggregation with a repository lifecycle command.
Archive and restore move together because both write the same authority.

One operation freezes its target ids, desired archived state, stable identity, and
ordering information. Its payload is immutable across retries. The shared resolver
orders whole operations and publishes one effective metadata revision; it never
persists an independently authoritative flag for every target. Independent Tab actions
remain valid and use the same operation model with a singleton target set. Execution
status remains runtime-owned and is never restored from a lifecycle snapshot.

Each target takes the highest ordered operation covering it. Identical frozen root
sets choose one winner together; different sets retain earlier results for targets
absent from the newer operation. This is deterministic operation precedence, not a
promise that all children always have the root's state.

Durable admission includes crash-safe local order allocation and recovery of admitted
but unpublished records before accepting new commands. Publication and recovery allow
duplicate delivery of the same operation or revision; subscribers and resource effects
are idempotent rather than claiming exactly-once notifications. Resource work must also
avoid tearing down a newer runtime generation after restore.

This is a lifecycle-specific protocol, not a generic saga, command queue, or distributed
database transaction framework. A compatible client still authors locally against its
own repository. No daemon proxy author, authenticated cloud requirement, or hosted
implementation is introduced into the public desktop.

## Dependency evidence

Inspection used Lody commit `54623883be77bd17f9dab18ef5a60cc2a9b156ef` and installed
artifacts matching `loro-repo@0.20.0` and `@loro-dev/flock-wasm@0.4.3`. Synthetic Node
probes used in-memory replicas; they did not operate on product Session data.
The [reproducible baseline probe](../../../../plans/support/inspect-lifecycle-boundaries.cjs)
checks rollback and repository publication against those pinned versions.

| Boundary                        | Observed behavior                                                                                        | Consequence                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Metadata storage                | LoroRepo imports WASM Flock and stores fields at `m/docId/field` in one meta Flock.                      | Session documents are not separate metadata transaction stores.                 |
| WASM callback throws            | Staged values disappear; no event or exported change remains. A peer's already imported update survives. | Local rollback can avoid authoring stale compensation.                          |
| Other Flock implementation      | `@loro-dev/flock@4.4.4` retains data after the same throwing callback.                                   | Pin and test the actual adapter, not the `txn` method name.                     |
| Direct raw metadata transaction | Raw values change while primed LoroRepo caches stay old and no repo patch is emitted.                    | Application hooks must not bypass the repository cache/event owner.             |
| Remote repository import        | One raw batch becomes per-document callbacks; a callback can read child archived and root active.        | Atomic publication must include repository and consumer projections.            |
| Concurrent raw transactions     | Independent per-key clocks can converge to a mixed root/child tuple.                                     | A local multi-key transaction is not whole-operation conflict resolution.       |
| Durability                      | `upsertDocMeta` does not await persistence; `persistMetaNow` is separate.                                | Acceptance, local durability, and remote acknowledgement need distinct results. |

The WASM package's shipped comments warn that data does not roll back, contradicting
the tested binary. Treat the observed behavior as version-specific evidence and keep
a dependency characterization gate. Importing into an active WASM transaction can
auto-commit it; transaction callbacks must contain no import or async work.

The frontend explicitly disables metadata auto-debounce in
[`create-workspace-runtime.ts`](../../../../packages/components/src/providers/create-workspace-runtime.ts).
That makes raw `txn` callable there, but does not repair the cache/event bypass.
The repository's existing [dependency patch](../../../../patches/loro-repo.patch)
only changes live-monitor startup, not transaction semantics.

## Alternatives and limits

Reordering compensation cannot determine ownership of current values. A local
operation-id comparison followed by a blind write cannot account for a remote edit
that has not arrived, and conditional per-target rollback still permits partial
completion. Neither alternative supplies the required operation boundary.

A repository-owned multi-key batch is useful infrastructure, but alone does not
preserve a transaction through per-key CRDT conflict resolution. Use native atomic
staging where necessary; do not make a general batch API a prerequisite if writing
one complete lifecycle record supplies the smaller boundary.

A background reconciler can rebuild derived state from durable operations. It cannot
infer whether `root active / child archived` is an intentional Tab action or failed
compensation from those flags alone. Existing worktree GC reconciles disk resources,
not lifecycle metadata, and remains responsible only for root-owned worktrees.

The chosen operation ordering, storage admission before publication, migration
baseline, and old-writer policy are gates before production path replacement in the
plan. Both IndexedDB and SQLite admission/recovery prototypes must pass before that
switch; proving one adapter is insufficient. A daemon
capability cannot fence independently authoring old renderers. The public repository
does not contain all product clients or a workspace-wide writer admission mechanism;
do not claim their migration or silently enable a weaker dual-write mode.

## Relationship to earlier decisions

This proposal retains the containment decision in
[Keep opened Sessions outside opener state cascades](../../implemented/bug-fix/2026-09-10-session-containment-lifecycle.md).
It proposes replacing the compensation decision in
[Make cold-start archive discovery and commit failure-safe](../../implemented/bug-fix/2026-09-13-session-archive-complete-metadata-query.md),
while preserving that change's repository discovery. The older implemented note
records its historical implementation; it is not approval of this replacement.

## Verification and rollout

No production implementation or two-product-client persistence/restart test has been
completed for this proposal. The execution plan requires deterministic regression,
two-repository observation, concurrent operations, durable recovery, and legacy-client
fixtures before activation. Worktree cleanup and terminal disposal are evaluated
against effective committed state and do not make lifecycle commits reversible.

[#658](https://github.com/LodyAI/Lody/pull/658) is the affected implementation, not a
completed replacement PR. [#574](https://github.com/LodyAI/Lody/issues/574) remains open
until the operation contract and migration gates have evidence. Local documentation
checks currently also report pre-existing links into uninitialized ACP submodules;
those findings are separate from implementation verification.
