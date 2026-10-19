# Roost native runtime and shared clients

Status: proposed
Type: architecture
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329), [#1509](https://github.com/LodyAI/Lody/pull/1509)

[中文](2026-10-09-roost-native-runtime.zh.md)

## Abstract

The npm history adapter previously required a separately built Roost executable,
so a public Lody checkout could not build or package the experimental backend.
The CLI now consumes the published Node-API package with its SQLite implementation
running in a Worker. Electron stages that package with one target prebuild; shared
Web and mobile clients retain the existing history RPC interfaces. This change
does not establish browser-local IndexedDB replicas or offline Streams sync.
Normal tail edits reuse signed prefixes within the same Session, and shared
readers avoid rebuilding unchanged business facts during streaming. Complete
history coverage and device-level responsiveness remain validation limits.

## Decision and boundaries

Pin `@loro-dev/roost-node@0.1.2` as a CLI runtime dependency and exempt only that
version and its six exact platform dependencies from the release-age policy.
Keep `@loro-dev/roost@0.1.2` for identity,
application JSON, and `NodeLodyHistory`. Neither Rust source nor a sibling Roost
checkout is needed to install, build, or package Lody.

Use `RoostNativeClient` directly. Preserve the database path, credential-store
seed, admitted owner, bounded queue, shared stream leases, and awaited final close.
Worker initialization failures close the failed client before releasing its lease.
Retire subprocess binary and client-path discovery. Historical owner architecture
is described by the [transition proposal](2026-09-30-roost-transition-delivery-lifecycle.md).

The later [writer identity change](2026-10-11-roost-writer-identity.md) removes the
credential-store prerequisite through application-managed persistence, implemented
separately from this native runtime integration. Independent-replica enrollment and
synchronization remain proposed; previous Nightly keyrings are not migrated.

Externalize the native npm package intact so its client, Worker, and binding
keep their relative paths. Electron stages it in `resources/cli/node_modules`
and copies it into `app.asar.unpacked` before signing. Select exactly one of the
six published macOS, Windows MSVC, or Linux GNU arm64/x64 binaries per artifact.
Unsupported targets fail during packaging. Linux musl is not supported; the
published Linux builds require glibc 2.35 or newer.

Web and iOS reusing shared components never import this Node package. The existing
remote history bridge reads and writes through the owning machine's advertised
`sessionHistory: 2` RPC contract. The machine must be available. Browser Roost
storage is available from the browser package, but this repository does not
compose an IndexedDB replica or authorize a new sync scheduler. Public Web/mobile
application sources are outside this repository's boundary.

The [feature gate](../feature/2026-10-08-roost-history-feature-gate.md) still controls
new-session selection. Loro remains the default; existing backend discriminators,
history, Loro control metadata, and transport authorization remain unchanged.

## Failure diagnostics

The published 0.1.2 host retains Worker `error` events, binding-load exceptions
and fault causes through its public `failure` and `Error.cause` APIs. Lody consumes
that release directly, without a pnpm SDK patch. Request outcome codes and retry
policy remain SDK-owned. The owner correlates initialization,
write, RPC and exit evidence with one diagnostic ID and records CLI, Node,
Electron and compiled desktop provenance through the existing local logger.
Internal callers still receive their original errors; owner-generated RPC errors
send only the safe stage/code/ID string, and the renderer supplies localized context. Raw Worker causes
never enter history or the remote error envelope. This is a repair of lost
evidence; it does not identify the cause of a previously reported Nightly failure
or authorize a fallback, replay, telemetry upload or storage migration.

Client transport failures are a separate boundary. Previously, Machine RPC
synthesized unsuccessful history responses when appending to the machine's
request stream failed, and the remote Roost bridge wrapped every unsuccessful response
as `RoostHistoryError`, including `request_failed`. A synthetic ten-second timeout
through the real Streams Client, JSON/RPC client and renderer bridge reproduces
the Roost storage wording and owner-local-log instruction without an owner
handler or history write. Those messages do not establish a Worker fault or an
owner-generated diagnostic reference. The client now retains typed transport,
remote-handler or protocol provenance, request ID and target machine on its local
history response projection. Append failures and response deadlines produce transport
errors; owner metadata refusals retain their stable code. These fields are not added
to encrypted wire history results, preserving older strict response parsers. The
renderer reserves Roost storage wording and owner-local-log instructions for owner
storage responses. An unconfirmed POST never authorizes automatic history replay.

### History owner readiness

Windows UI and WSL daemon identities are distinct, supported targets. Paired
Nightly logs show first-start `internal_error` ownership rejections followed by
successful owner-side assistant writes for the same sessions; a later request-stream
append timeout targets the WSL machine. These are different failure boundaries.
The RPC server performs its ownership check before the history handler, so a
rejection there bypasses that handler's failure diagnostics. A separate local
wrong-owner probe does not establish that the UI request was misrouted.

The old owner resolver treated an existing metadata record without `machineId`
as foreign. Renderer creation awaits its local metadata write, not arrival at the
target daemon; metadata and RPC travel on independent streams. A deterministic
probe with two real Repos captures the existence-only revision during one complete
metadata upsert, controls its delivery to the owner, and runs the real encrypted
RPC client/server with the production owner resolver. The first request is rejected
with the reported ownership error before the injected history handler can accept
it; delivering the remaining metadata makes a second request succeed. A genuine
foreign owner remains rejected. This establishes a reproducible readiness gap,
not the production delivery order: the logs lack the rejected request's target
and observed metadata owner, and the probe deliberately stages partial delivery.
The repaired resolver observes that session and snapshots it at one SDK boundary,
then waits at most ten seconds for matching session ID, machine ID and persisted
Roost backend. Owner identity alone is insufficient: opening while `historyBackend`
is absent could bind a cold document to the legacy Loro reader. Confirmed foreign,
deleted, invalid and non-Roost identities still fail before storage is opened. A
deadline returns `session_metadata_pending`, explicitly before a history operation
starts. Pending/ready local diagnostics capture observed ownership/backend state
and wait duration; server rejection logs correlate the RPC request ID with this
content-free context. This does not diagnose the independent network timeout.

The readiness kernel is native Effect over the third-party Repo's `observeDocs`:
one scoped subscription per request, no document-body open or shared transport
flush. MessageHandler is its Promise execution entry. Success/rejection/timeout
release the subscription; server stop and MessageHandler cleanup interrupt the
wait. Cancellation does not stop the shared metadata producer, and storage starts
only after the readiness handoff. Existing storage owners retain dispatched writes
with unknown outcomes. This completes the small readiness unit, not the Repo,
document or MessageHandler lifecycle migrations.

Behavioral coverage uses real Repo metadata and cold SQLite-backed history for
absent, existence-only, owner-pending and backend-pending creation. Each accepts
the original first turn once, without Loro history. Foreign/deleted/backend refusals,
TestClock deadlines and cancellation release their observers. Restoring the original
resolver makes all four cold-write regressions fail. Real encrypted RPC tests keep
rejection codes/request correlation and strict success wire results; real Streams
append-timeout and RPC response-deadline tests distinguish transport failures in
both languages without replay.

Extended testing corrected an earlier verification limit: a single refused request
did not prove that refusal survived restart. A packaged Cloud client received
`session_metadata_pending` before any write; metadata was then completed and the
Linux daemon restarted while the original RPC was still valid. The request stream
replayed it and SQLite contained the rejected turn, while the renderer's cached empty
history hid the write. A deterministic encrypted-server regression reproduces this
without networking or sleeps and fails against the previous implementation.

Before returning an owner-readiness refusal, the CLI now commits it to a separate
machine-local SQLite store with FULL synchronization. Replayed requests retain that
original refusal until their original expiry, and a new request ID can retry. A hash
binds the complete request to its workspace/machine/ID; neither history bodies nor
credentials are stored. Identical concurrent requests share one handler; conflicting
ID reuse and unavailable refusal storage fail closed. This kernel uses scoped Effect
SQLite handles executed by MessageHandler callbacks; it has no background tasks or
retained connection. The existing Promise RPC dispatcher remains outside the native
unit. It does not record dispatched outcomes or change their existing recovery policy.
The dispatcher checks expiry and stop again after readiness, before storage handoff;
the regression covers metadata arriving only after the RPC expired.

The expanded native suite checks real MessageHandler cleanup of six pending writes,
isolated cancellation while two first writes succeed, live purge and invalid identity,
and SQLite refusal reopen, expiry, namespace separation, conflicting payloads and
unavailable storage. Encrypted-server tests cover restart replay, concurrent duplicates
and failed lookup/save. Packaged remote testing also staggers three metadata waiters
while a healthy write and ping complete, then appends 32 records across four sessions
and checks content, unique IDs, paging and replacement, with no Loro history.

With the repaired CLI on that Linux daemon, two original unexpired requests were
captured and re-appended unchanged after their metadata-pending/foreign-owner refusals
and after valid metadata arrived. Owner logs confirmed replay with the original codes;
authoritative snapshot reads remained empty. Fresh requests then accepted one turn each,
and another session accepted 16 concurrent turns. Paging and sealed-turn replacement
preserved all identities and content. An independent SQLite backup, inspected through
the native SDK with only the real writer's public owner, matched all 18 accepted turns
and contained neither rejected original turn. Existing activity prevented another live
restart; server recreation and real SQLite close/reopen provide that boundary coverage.

The public CLI build passed at 2 GiB. This Cloud verification bundle reused the public
CLI package-chunk strategy: its original unchunked composition exhausted 2 GiB on both
the previous and repaired source. The local bundle validates the repaired runtime,
not the unchanged Cloud composition's memory limit. No SDK version or runtime patch
was introduced.

A macOS arm64 Cloud Nightly correctness app passed packaging, embedded CLI/native
probes and ad-hoc signature verification, then reused the existing Nightly profile
and authenticated workspace. Its first UI send received an assistant reply and
read back two Roost entries, with no Loro history. Separate cold local history
requests deliberately withheld the machine ID or backend field: the owner logged
pending metadata, the original request stayed pending, and publishing the missing
field accepted that first entry once. Reading each back returned the original turn
and no Loro history; the synthetic fixtures were archived. This validates the
packaged local path, not Windows/WSL delivery order or the independent request-stream
connection timeout.

With Roost enabled, a first UI send to a separate Linux daemon that did not
advertise `sessionHistory` completed with an assistant reply. Persisted metadata
selected `loro`, retained that target machine as owner, and the Loro document
contained both user and assistant turns. No unsupported-target warning appeared.
The setting supplies a preferred backend, which existing creation negotiation
silently downgrades; only an explicitly requested Roost backend rejects an
unsupported target. This exercises remote Loro, not remote Roost or the readiness
repair.

After upgrading that Linux daemon with the same CLI JavaScript as the packaged
app and matching Linux runtime dependencies, its existing identity and login
remained valid and it advertised `sessionHistory: 2`. A new UI conversation's
first send completed with an assistant reply and persisted Roost ownership.
Without injected delay, the owner observed existence-only metadata: two history
requests waited 1,164 ms and 759 ms for matching owner/backend before proceeding.
The production remote history reader returned exactly the user and assistant
turns, with no Loro history and no error toast or manual resend. This validates
the repaired readiness handoff on a real remote Linux daemon; it does not prove
the original Windows/WSL arrival order or resolve the independent connection
timeout.

Verification injects failures into real Node Workers at startup, binding load and
request execution, including an explicit abnormal exit. It checks original causes,
correlated IDs and dispatched/queued outcome semantics. The owning SQLite/RPC suite
checks safe responses and retained Roost history; renderer tests cover local and
remote bridges in English and Chinese. The existing toast Storybook story verifies
the error presentation in both languages and light/dark themes. These injected-fault
checks do not by themselves reproduce the originally reported Nightly failure.

The published 0.1.2 package passes frozen installation, the complete repository
check, the 2 GiB public CLI build and the OSS desktop build. All six actual npm
platform packages stage one matching binding; the host Worker passes signed SQLite
close/reopen under Node 24.14.0 and Electron 44.7.0. Foreign desktop execution and
release signing remain outside this acceptance.

## History mutation and command routing

Status corrections must not reset the active view or recreate a sealed primary.
Mutable state records are anchored to their primary and projected as the same
business turn. Permission responses use the SDK's independent response record;
readers join the outcome onto the corresponding tool without sealing an ongoing
assistant. Ordinary changes refresh affected bodies only.

For general structural copy/import edits, stage a complete history through public SDK
operations in an independent generation. Publish a signed application-owned
activation in the old stream with one native event-cursor CAS. Failed preparation
or a concurrent old-stream write retains the old branch. Never reproduce SDK
envelopes/index formats or rewrite sealed storage. Serial generation resolution
and guarded old handles prevent concurrent readers/writers using a superseded view.
Count/position reads refresh after a lost activation reply; local write barriers
republish that committed projection before RPC binds its durable control revision.
Recovery does not replay an indeterminate action.
Old generations remain archived; reclamation and arbitrary old-adapter downgrade
compatibility are not established by this repair.

ACP output and stable per-item receipts commit together, including chunked batches;
retries find receipts through prior generations. Imports bind their baseline and
source cursor to the same activation; Loro cursor failure is indeterminate and
reopening reads the committed native baseline. Conditional tail rollback retains
later appends and refuses concurrent edits. Fork uses the shared writer's sole
snapshot provenance registry and preflights all collisions before a whole prepend.

Both Cloud one-shot manager entry points inject the same owner RPC composition,
covering session commands, export and MCP history. Native execution remains with
the daemon; only local MCP reuses its manager, whose access gate refuses foreign
machines. RPC directory reads clip to the owner count, batch within the 500-row
limit and restart a moving revision. Fork/Edit & Resend keep their owner sagas;
process-local snapshot/compensation handles are not sent over RPC. New-session
preferences negotiate target capabilities before any durable write.

## Same-conversation performance work

The extended baseline on `d074e53` did not meet the whole long-conversation goal:
latest-window reads were bounded, but the final-user edit copied the retained
prefix and readers rebuilt whole-directory/fact arrays on ordinary text deltas.
A single structural probe measured 7,881 ms for 1,000 rows and 53,823 ms for
6,000 rows (about 3,000 synthetic user/assistant rounds). The repeatable startup
baseline used seven samples and two warm-ups; median Roost latest-40 startup was
69 ms at 6,000 rows versus Loro's 531 ms. Those results did not establish paint,
input latency or complete-history coverage performance.

The normal tail-edit path now calls public SDK fork/restore operations in the
same native stream and view. Retained prefix Turn ids and sealed bytes are reused;
no Lody Session is created or navigated. A sealed application epoch is written
atomically with activation. Native cursor CAS fences eligibility against concurrent
writes and epoch-bound handles prevent late writes into an inactive suffix.
Conditional rollback restores the original head when nothing followed the edit;
later appends retain the whole-generation compensation that preserves their data.
Same-id replacement, arbitrary structural edits and import/copy retain full staging.
Re-appending a removed business identity also stages a generation when its old SDK
binding survives, preserving the shared append contract without reactivating old content.

An exact-cursor local goal projection avoids repeatedly materializing the prefix
for the active-goal guard. It is learned from contiguous tail-first pages or a
complete authoritative read. The writer records its native update receipts and
candidate index events; the projection advances only when observed events are
covered by that evidence. A foreign write, damaged cache, missing coverage or
oversized event range discards reuse and refreshes authoritative state. The index
is optional derived data, not a command receipt or sync authority. Legacy histories
can require one full guard scan before coverage is learned; no migration is forced.

Adjacent reverse pages replace sentinel slots only. State/permission projection
uses eight bounded lanes and directory replies reuse their already-projected page.
Shared directory hooks patch explicit metadata identities; business readers omit
prose summaries while outline readers retain them. Hydrated facts reuse their old
small value only after semantic comparison; evicted edits still discard stale facts
before background derivation. Visible text, goal/permission outcomes, draft focus,
selection and ordering continue to update through their existing contracts.

The trade-offs remain explicit: complete fact/search coverage still reads unseen
history in bounded background chunks, large editable suffixes still cost work,
archived branches have no reclamation, and rollback preserving later appends may
copy a generation. Browser/mobile deployment and device-level frame/latency or
memory acceptance require separate evidence.

## Verification

### Same-conversation performance checkpoint (2026-10-09)

The focused native history suite now passes 27 contracts, plus four RPC/backend
cases in the complete check. Added cases prove retained physical prefix ids,
same-Session reopen, old-handle fencing on both the activating and peer instances,
rollback, re-append of a removed identity, off-window active-goal guards, damaged
cache recovery, foreign writes and lost fork replies. The focused reader/React/
derivation suites pass 52 cases. An additional 6,000-row run of the existing React
streaming contract preserves business facts, draft value, focus and selection,
updates visible text and outline summaries, and observes 25 index visits for the
text delta rather than a whole-directory scan. This is functional evidence, not
a frame-time or input-latency measurement.

After syncing main at `668b0e5`, the bounded projection uses Effect 4.0.2's public
Semaphore API. Frozen installation and the complete `pnpm check` pass: CLI 3641
with four existing skips, shared 1331, shared components 4920 and Electron 214.
`pnpm build` passes. Unmodified local
desktop smoke selected the machine's Chinese language and failed English-only
Settings selectors. An isolated English-profile rerun completed four P0 journeys
before it was stopped when macOS requested Safe Storage keychain authorization;
the complete local desktop smoke is not recorded as passing. Neither run changes
product language behavior or establishes a Roost desktop performance acceptance.

The final production benchmark uses actual published SQLite, fresh backends/views,
warm OS page cache, Apple M4 / macOS arm64 / Node 24.14.0, 4 KiB bodies, one warm-up
and five measured samples. Medians in milliseconds:

| History rows | Roost latest 40 | Loro latest 40 | Roost older 40 | Roost final-user edit | Roost complete directory |
| ------------ | --------------- | -------------- | -------------- | --------------------- | ------------------------ |
| 1,000        | 63.0            | 88.1           | 36.2           | 39.8                  | 910.2                    |
| 6,000        | 68.9            | 550.3          | 44.7           | 60.8                  | 5,721.3                  |
| 10,000       | 58.4            | 820.3          | 42.3           | 56.5                  | 9,374.9                  |

At 6,000 rows (about 3,000 rounds), latest-window P95 is 74.2 ms and edit P95
61.4 ms; at 10,000 rows they are 60.7 ms and 58.7 ms. All 15 measured Roost edits
read one 40-row page and perform no complete-history read. The earlier 53,823 ms
edit is a single baseline probe, not a baseline distribution. Edits are measured
after complete directory coverage has learned the optional goal projection.
Newly authored sessions maintain it incrementally; legacy or invalidated caches
can still require a full authoritative guard scan. Complete background coverage
still takes about 5.7 seconds at 6,000 rows and 9.4 seconds at 10,000 rows.

Reproduce from `apps/cli`:

```sh
BENCH_STRUCTURAL=1 BENCH_SIZES=1000,6000,10000 BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  BENCH_BODY_BYTES=4096 TSX_TSCONFIG_PATH=tsconfig.json \
  node --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-history.mts
```

The benchmark excludes IPC/RPC, React/paint, full facts/search, IndexedDB, real
providers and device memory acceptance. Roost streaming writes include SQLite
durability; this benchmark's Loro control Repo has no disk storage, so its write
timings are not an equivalent durability comparison. Results and validation logs:
`/private/tmp/lody-roost-performance-main-optimized.json`,
`/private/tmp/lody-roost-performance-ui-6000-final.log`,
`/private/tmp/lody-roost-performance-main-check.log` and
`/private/tmp/lody-roost-performance-main-desktop-build.log`.

### Production adapter repair checkpoint (`d074e53`, 2026-10-09)

The final focused suite passes 27 cases: 23 production-history contracts using
actual SessionDocument, LoroRepo and published native SQLite, plus four RPC/backend
cases. Coverage includes seven durable queue failure stages, sealed status
correction, permission followed by sparse tool/text output, held cross-session
Fork captures, opaque stored values, failed private staging, concurrent generation
resolution, stale activation/old handles, per-item receipt retries, conditional
rollback, import cursor failure across reopen, and count/position recovery after
an activation reply is lost. The recovery barrier republishes the committed
projection without replaying the action.

Transport tests enforce the actual RPC range schema and revision restart. A real
owner SQLite composition test exercises the common Cloud factory and owner-failure
propagation. Renderer tests reject explicit unsupported Roost before creation
side effects. The complete `pnpm check` passes: CLI 3604 with four existing skips,
shared 1302, shared components 4892 and Electron 214. Formatting, documentation,
public/platform guards and the rebuilt CLI publication smoke also pass.

The synthetic production benchmark uses 100 and 1000 turns with 4 KiB bodies,
one warm-up and two measured samples. Each Roost open/older read loads one
40-turn page; ten streaming updates use no full history or branch-page reads.
It excludes RPC, renderer paint, IndexedDB, real provider execution and generation
churn. Logs: `/private/tmp/lody-roost-repair-bench.json`,
`/private/tmp/lody-roost-native-contract.log`, `/private/tmp/lody-roost-repair-check.log`
and `/private/tmp/lody-roost-repair-published-bundle.log`.
This repair uses the existing 0.1.1 runtime; no new npm publication is required.

### Published runtime and packaging checkpoint

The user published all six platform packages and the main package at 0.1.1.
The main tarball integrity matches the prepared release; its installed package
contains no binding and resolves only the host platform. Actual published-package
staging passes for all six targets through the installed-host or production public
npm download path. Fixtures cover adjacent/split layouts, exact-version mismatch
and failed-download preservation. Signed host SQLite reopen passes; foreign
binaries are selected on disk locally. The upstream six-platform release
[CI](https://github.com/loro-dev/roost/actions/runs/37877651895) supplies execution
coverage for those targets.

Before this history repair, source `8b1073e0ceef32829b0230ab64801f6a34e36c01`
passed [CI](https://github.com/LodyAI/Lody/actions/runs/37889429418) and
[Desktop E2E](https://github.com/LodyAI/Lody/actions/runs/37889429365).
The normal CLI build passed with a 2 GiB heap; the renderer build used its normal
configuration and contained no native Roost imports. Normal macOS arm64 OSS
0.104.0 directory packaging passed actual CLI boot, native binding and Worker
signed SQLite write/reopen probes. It contained native runtime 0.1.1 and exactly
one 8,021,248-byte host binding, SHA-256
`1d0e23d144491d5e566de679a6a9e2477332027a98e86af74849a4c60a983d93`,
matching the published artifact. This packaging checkpoint predates the adapter
repair; it is not a claim that a new signed application was released.
Logs: `/private/tmp/lody-roost-011-check-merged.log`,
`/private/tmp/lody-roost-011-package.log` and `/private/tmp/lody-roost-011-platforms.log`.

Private Web/mobile builds, remote deployment, browser-local offline replicas,
non-host full desktop packages, release signing/notarization and archived-generation
reclamation remain outside this validation. Test databases are synthetic and
isolated; no user history is used.
