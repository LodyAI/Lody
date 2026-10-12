# Import OSS Loro records into an existing cloud workspace

Status: implemented
Translation: current

[中文](2026-10-12-oss-cloud-record-migration.zh.md)

## Abstract

OSS and cloud installations use disjoint identities and data roots. The cloud CLI
imports a frozen Loro snapshot into an explicitly selected existing workspace,
preserving history and source data while disabling imported execution. Shared index
writes are server-conditional, and durable receipts allow retries after lost responses
without overwriting later user edits. Historical attachments are archived separately
from immutable operations. Roost remains unsupported; no real account was migrated.

## Decisions and ownership

`migrate --from-oss` belongs to public shared CLI source but only cloud composition
registers it. The source reader holds the OSS host lease during read-only SQLite
backup and attachment freezing. The manifest binds deployment, account, workspace,
source path and machine identities. Users choose an existing workspace; no automatic
workspace creation or source deletion occurs.

IDs remain stable and equal titles are harmless. Unrelated IDs and tombstones stop
migration. Full imported authors travel through Streams initial synchronization;
local-update subscriptions alone do not relay imported history. Independent readback
checks complete document version vectors before publishing stopped session metadata.
Schedules are disabled, dispatch pointers and pending execution queues are cleared.

## Concurrency and recovery

Client-side check-then-write cannot protect shared Flock rows. The target uses the
pinned Streams client's `appendCas` with the checked replica's offset. Every attempt
uses an isolated replica; rejected tentative mutations are discarded. A mismatch
re-reads and rechecks rows. Metadata publication uses CAS too. Capability discovery
requires `append-cas` before any upload; there is no unsafe ordinary-append fallback.
A missing index is created atomically with its initial rows and receipts.

Per-row source hashes are committed in the same sub-Flock batch as the row, outside
workspace meta. Recovery recognizes those receipts even after user edits/deletion or
a lost successful response. It skips already applied rows rather than comparing them
to the original snapshot or replaying old values. This also lets partial session
publication finish after users edit imported configuration.

Document streams are created with an ownership receipt in the initial PUT. A lost
response no longer strands an unowned empty stream; retry verifies remote ownership.
An unrelated pre-existing empty stream still fails closed. Prepared bytes and local
receipts remain frozen. Manifest/journal v2 rejects artifacts of the unreleased v1
prototype, which lacked historical attachment coverage and atomic index receipts.

## Historical attachments and cancellation

Attachment discovery inspects immutable operation boundaries, including deleted or
replaced turns and older branches, using a separate checkout replica. Partial Mirror
map construction is coalesced. Scan map-write runs (container transitions/repeated
keys) even when Loro has merged commits; never treat an intermediate descriptor
as a complete file. All recovered descriptors must match immutable blob bytes;
disk contents never choose which historical hash to trust. Current references
are checked independently. Every discovered local blob
must exist and pass its size/hash check before remote writes. Fork storageSessionId
references are preserved even when their original session is deleted.

Current references are rewritten with HistoryWriter. Past operation identities and
contents remain intact; the HEAD document's `ossMigrationAttachments` root stores
source-to-cloud descriptors for all archived files. Resolve an old-frontier file
against this HEAD archive. Merely checking a version vector is not sufficient to
prove attachment preservation.

The command scopes SIGINT/SIGTERM listeners and supplies their abort signal to the
filesystem lock and Effect runtime; lock release follows upload and target cleanup.
Effect owns sequencing, deadlines and interruption. Cancellation propagates into
attachment fetches and Streams requests, and cleanup awaits Promise settlement with
a five-second bound. Network steps have a five-minute deadline. Aborted upload results
cannot publish receipts or prepared documents. Local journals use fsync/atomic rename.

## Boundaries and validation

Publication is not workspace-wide atomic: interruption may expose a verified subset.
A completed journal represents its original snapshot, not later OSS edits. Workspace
MCP/Role settings, transient indexes, code/worktrees and native login state are not
moved. Provider rows include their configured environment. Roost, shallow snapshots,
unknown storage kinds and unsupported image references fail preflight.

Behavioral tests use real Loro/Flock, SQLite and the actual Streams clients against
an in-memory protocol server with deterministic race/response-loss injection. They
cover CAS inserts/deletes and unrelated writes, metadata tombstones, lost creation and
append responses, partial publication followed by edits/deletion, historical-only
fork attachment freezing/resolution, in-place attachment replacement, process signals, cancellation into a real transfer fetch, and a
virtual-clock timeout. Usage: [migration README](../../../../apps/cli/src/lib/oss-migration/README.md).

The 27 focused migration tests pass. The full CLI suite passes 4064 tests (four skipped) when the session-injected
`GIT_EXEC_PATH` is removed from the test environment; that injection caused the
previous unrelated `context_unreadable` fixture failure. The cloud bundle exceeded the mandated 2 GB heap at chunk
rendering, reproduced with the unchanged baseline entry. Documentation checks have
six existing missing Kimi/Pi submodule links. These are not evidence of hosted E2E.

The requested independent review closed the five findings after repeated adversarial probes. Additional probes covered merged commits, repeated replacements, forks/multiple branches, corrupt historical bytes (zero uploads), and real OS SIGINT/SIGTERM cleanup while holding the migration lock. No remaining reproducible P0/P1/P2 was reported in the supported full-Loro scope.
