# Daemon catalog readers on the published Promise Repo

Status: implemented
Translation: current
PR: [#1729](https://github.com/LodyAI/Lody/pull/1729)

[中文](2026-10-19-promise-repo-catalog-readers.zh.md)

## Abstract

#1692 called native-wrapper methods absent from the installed `loro-repo@0.23.2`
Promise Repo, breaking CLI compilation. Readers now borrow that same Repo through
public replica and room leases. Daemon reads preserve cold-baseline uncertainty
without request-level catch-up; Role proposals separately require confirmed
synchronization before publishing. This restores intended behavior without a
dependency upgrade or the withdrawn workspace Repo migration. Unabortable SDK
loads may finish after shutdown; late leases are released, while the SDK's
internal-cache limitation remains explicitly unclaimed.

## Compatibility and ownership

The six reproduced `doc.ts` errors involved missing `runLegacy`,
`acquireScopeLegacy`, `.native`, and an unimported `Scope`. #1692's native Repo
tests did not validate the Promise product boundary. This corrects the catalog
implementation/evidence in [the earlier daemon decision](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.md),
retaining its authorization, active Turn and daemon-borrowing contracts. This
supersedes main's interim Promise helper from `de8debe03`; its facade-level
timeout, detach and acquisition coverage is retained against the scoped owner.

Workspace startup starts metadata and workspace readers in the background.
Requests admit one reader per authorized Machine Flock. Same-key requests share
acquisition, capped retry and baseline. The genuine SDK adapter acquires
`acquireFlockDoc` plus `joinFlockDocRoom`; metadata uses `joinMetaRoom`. The explicit
replica lease prevents unload from replacing the object while read; room interest
supplies live updates. No second Repo, storage owner or native wrapper is created.

`WorkspaceCatalogSyncLegacy` is the sole Promise execution entry, consumed by
`LoroDocumentManager`; remove it when that manager adopts native ownership.
Effect owns reader retry, Clock deadlines and Scope finalization. This is a small
lifecycle unit over external SDK I/O, not a migration of the unfinished
workspace/Session consumer graph.

Cloud baseline means the stable `streams` binding completed `waitFor` for
`caught-up`, including metadata hydration. Until then, cached rows remain readable
with syncing/unknown and missing gets are retryable. Local-only composition has
local authority after acquisition. A confirmed baseline remains useful during
detach; reattachment updates the same Repo. Request timeout only stops its Deferred
waiter, never acquisition or the reader lease. Existing manager/Repo transport
recovery handles reconnect; this unit does not loop rejoin on detached bindings.

A transient metadata save failure can leave the room healthy and joined while
`waitFor` returns a tagged error. Filtering that error stranded the initial
baseline until a transport state change. The reader now passes the original SDK
error into capped backoff and retries only the barrier on the same stable binding;
it keeps its room and replica leases. Detached results still wait for a status
event rather than polling. Concurrent requests share recovery, remain unconfirmed
until success, and cannot cancel it. Closing the owner interrupts backoff and
releases readers without treating recovered background errors as cleanup failures.

## Failure and shutdown

The installed SDK releases the room reference when a join rejects. The entry
retries with exponential backoff capped at 30 seconds. Cleanup defects do not
start replacements. The owner retains fiber Exits, uses safe diagnostics, and
delivers cleanup failure at Scope close after interrupting/joining every sibling.
Release attempts both room and replica even if one fails. Manager cleanup records
reader-close failure and continues independent teardown and Repo destruction.

Promise acquisition has no abort API. Closing fences its continuation and releases
late results without waiting forever or claiming raw cancellation. Repo destruction
remains the terminal owner; SDK stale-attachment checks reject delayed connects.
Independent review reproduced an SDK 0.23.2 limit: a storage load completing after
`destroy()` can register a Flock/journal and existence row in the destroyed object's
memory. Tests verify no new room or closed-storage write; they do not claim the
SDK empties these caches again. Never reuse a destroyed Repo. Changing the SDK or
coordinating unrelated workspace replacement is outside this fix.

## Proposal confirmation

Create and update prepare metadata and workspace Role catalogs through strict sync.
Creation then confirms only the authorized target Machine catalog through discovery.
Strict sync checks the report and, for cloud-capable managers, successful Streams
participation plus an unchanged attached transport generation. No-route success
is insufficient. Failure preserves the cause, returns retryable `SYNC_UNAVAILABLE`
and appends no proposal; retrying the same requestId can succeed. Updates preserve
the existing target binding. Local composition retains local authority. Permissions,
current Turn identity, projection redaction and product boundaries stay unchanged.

## Evidence and limits

Tests use real Promise Repos/Flock replicas, in-memory transport boundaries,
explicit completion signals and Effect TestClock. Coverage includes metadata,
workspace and Machine cold reads; later edits; detach/reattach; same-key ownership;
failed/slow acquisition; waiter timeout; close/late results; sibling cleanup after
defects; strict no-route rejection; and create/update failure with no history row
followed by same-id retry. MCP integration uses the real manager and local socket.
Real metadata-save fault injection also covers a joined room recovering without
reattachment, retained data, concurrent waiter expiry, independent Flock reads,
continued failures through the 30-second retry cap and shutdown during backoff.
The recovery regression fails against the previous error-filtering implementation.
No live cloud, device recovery, packaged-app or production acceptance is claimed.

Verification passes `env -u GIT_EXEC_PATH pnpm check`, `pnpm format`, changed-test
typechecking and `pnpm run docs check` with existing documentation warnings.
The suite requires local HTTP/MCP listeners. Removing only the inherited session
Git exec-path is required for the unchanged recursive native SSH fixture; its isolated rerun
passes with the same environment adjustment. No source workaround was added.

The patch targets OSS main, which retains #1692. It neither reverts nor restores
that PR. #1679 idle GC, dependency versions, release changelogs and the private
repository release pointer are unchanged. The PR records the base and final
tested revision.
