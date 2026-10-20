# Native workspace Repo ownership

Status: proposed
Translation: current
PR: [#1607](https://github.com/LodyAI/Lody/pull/1607)

[中文](2026-10-16-native-workspace-repo.zh.md)

## Abstract

The #1607 consumer implementation and its dependent patches were withdrawn on 2026-10-19. The dependency upgrade remains. The sections below preserve historical implementation and verification, not the current product boundary. See the [rollback decision](../../implemented/simplification/2026-10-19-repo-upgrade-without-consumer-migration.md).

## Historical implementation (withdrawn)

## Responsibilities and behavior

The lockfile retains the older Streams graph still pinned by E2EE packages added
on main: CRDT 0.17.0 uses Client 0.10.0, alongside their Client 0.9.0 reference.
Pruning those records during this upgrade leaves dangling references in GitHub's
automatic PR merge even though the branch installs by itself. Preserve the exact
existing package integrity and snapshots; the workspace catalog still selects
Client 0.12.0 and CRDT 0.19.0. Validate frozen installation on the merged tree,
not only lockfile-only resolution, which does not detect this missing graph.
The failing CI merge reproduces the missing dependency before the repair and
completes an offline frozen install afterwards with lifecycle scripts disabled;
that verifies dependency closure, not native builds or the full test suite.

- Workspace roots own one native Repo over existing SQLite or renderer IndexedDB.
  Consumers borrow Doc, Flock and room leases in child Scopes. Opening absence
  and creating business identity remain distinct; local mode performs no cloud I/O.
- Session readers wait for catalog metadata on that Repo before backend selection.
  Runtime retirement aborts those waits; Session retirement removes reader
  observations before releasing its borrowed Doc, including construction failure.
  Main's incremental-history wakeups coexist with the retryable native teardown.
  Restoration consumes the selected native room's baseline state, not an upload
  receipt. Native observer tests fake deadlines while leaving worker scheduling live.
- Native Streams transports reuse the token service and replica-bound checkpoints.
  Foreground roots explicitly reuse same-store Doc cursors; eager workers own
  isolated replicas and volatile cursors. Peer baseline, server confirmation and
  local durability never substitute for each other.
- CLI directory reads and metadata confirmation compose native Repo operations
  at their existing business entries. Remove the single-consumer directory and
  authority objects, unused query options and compatibility methods. Identity
  normalization, deletion filtering, ordering and fresh server confirmation remain.
- The local v7 client owns workers, deadlines and bounded queues (including an
  estimated 64 MiB retained-string budget). Chunked input must be complete and
  cover the announced frontier. Normal writes do not advance join epoch. The old
  client is test-only, retaining host wire-compatibility coverage, with no product
  export or application import. Native client tests exercise the real v7 host.
- Legacy room projection includes actual routing/attachment: absent routes are
  detached, even when a native detail ref initially says joining. First-sync
  waits survive deliberate absence, and fail on an attached route's actual failure.
  Handles retain the native RoomLease and only the UI status view still consumed.
  Inventory and transport snapshots read native leases; local room records only
  retain borrow owners for purge. Remove unused aggregate/wait-result APIs and
  parallel adapter/status maps. Native sync/reconcile retries failed attaches and
  retains SDK producers, replacing application per-room rejoin jobs. Keeping
  the full old subscription contract would duplicate these owners and statuses.

## Release, recovery and causal handoff

Upstream replica release commits and persists the document and metadata before
unsubscribing. Failure retains a `RepoReleaseFailed.retry` and the accepted I/O;
a second acquire can need that release to succeed before constructing a replica.
SDK close stops network admission and drains accepted work; it is not an implicit
fresh server-upload receipt. An offline connection alone does not establish that
shortcut close must fail.

Legacy Doc/Flock handles keep the existing cached replica hold separate from each
view's borrow. Session, preview and schedule caches, Code Collab file indexes and
shortcut indexes release their borrow before eviction or workspace close. Eviction persists before closing the cached hold:
an ordinary quota failure leaves the original native replica active and borrowable.
Repeated and concurrent reopens reuse that replica while storage is still failing;
the next successful eviction saves it and permits a fresh generation. Genuine
native release failures still require recovery before replacement. Simply ignoring
such failures would not work: the installed SDK marks the last replica retiring
before persisting, and its acquire must finish that release. The extra cached hold
is the Legacy cache's existing ownership, removed by successful eviction or workspace
close, not a new retry loop or a second Repo. Native-only borrowers keep scoped release.
Flock readers use `acquireFlockDocHandleLegacy` so the last view release never
retires the cached replica before a successful save. A failed eviction still rejects
and retains its original error; a later borrower can reuse that active replica.
Code Collab still evicts through `unloadFlockDoc`; private shortcut indexes retain
their cached hold until explicit eviction or Repo close, as on the Promise base.
Eviction warnings contain no raw error/Cause or user payload.
Doc and Flock eviction waiters use the SDK release deadline (30 seconds by default). It
does not cancel or duplicate accepted adapter work. A hung save can outlive that
wait while another view borrows the same replica; later durability and close
still join the original write. CLI reinitialization clears a successfully released
borrow separately from the eviction result, preserving this same availability.

Shutdown closes borrowers before Repo, but one failed store must not skip other
stores, transport teardown, joins or Repo close. Runtime disposal attempts these
independent steps and reports errors afterwards. A later dispose retries retained
owners without reopening admission. RuntimeProvider retains retryable closes per
workspace: a failed close cannot poison another workspace, while reopening the
same storage retries its old owner first. Shortcut roots do the same per database;
runtime/remote/index/store failures do not skip independent cleanup or Repo close.
A disposed shortcut runtime can finish its failed retirement on retry. Session
cleanup keeps actual failed borrow releases retryable. Once its borrow is released,
a failed eviction remains reported but does not fence reinitialization on the
still-active cached Doc. The next successful eviction invalidates its local room. Manager lookups also
rebuild a destroyed Session view retained after failed eviction, rather than
returning its disposed Mirror/SessionData. Cleanup and reinitialization use the
existing per-doc ownership chain; concurrent opens share the existing pending
initialization. Genuine failed borrow release stays on that same wrapper and is
retried before reinitialization. Late joins check the captured handle identity so
an old initialization cannot replace the recovered lifetime's room.
Cache/shortcut acquisition still retries genuinely retiring owners: replacing one
after another failed retry can strand an SDK producer, and native Repo itself may
need to finish that release. This necessary exclusion does not apply to a failed
save that left the cached replica active.
Background stream failures emit a payload-free diagnostic, without an unbounded
Cause history or making a later successful destroy fail. Scope finalizers run once;
the small ownership helper retains native retry owners rather than re-closing a
failed Scope. Private Causes/grants never enter diagnostic logs.

Private shortcut constructor/connect/join finalizers already share the workspace
owner Scope, but SDK retirement failures use `DurableReleaseFailure`, not
`RepoReleaseFailed`. Treating that typed receipt as an unknown Cause permanently
replayed it after the accepted HTTP request finished. The existing Scope recovery
boundary now invokes its actual `retryRelease`, just as it invokes Repo receipts;
success clears the retained failure. Other unknown failures remain visible. This
adds no second SDK owner, replayed finalizer or discarded write, and preserves
the dependency order for producers that still have accepted work.

Borrower Scope failure does not establish that Repo close is independent: private
shortcut SDK producers also live under consumer Scopes and can retain accepted I/O.
Keep the existing dependency order rather than forcing native close past any failure.
Another workspace remains independent, and retry closes the retained owner before
releasing its Repo/storage. No new global gate or background retry loop is added.
The installed SDK exposes no terminal discard/termination API. A permanently failing
or hung raw writer still needs confirmed retirement before a second writer may open
the same storage; bounded lossy termination is not claimed by this repair.

CLI and renderer register the SDK snapshot diagnostic observer at their transport
composition entries. The shared explicit scalar projection preserves snapshot and
request correlation, permission/auth/HEAD/export/encode/PUT stages, encoded body
length, outcomes and monotonic stage/workflow elapsed time. Native Repo error
formatting also preserves `abortKind`, `timeoutKind` and `uploadStage`; it never
forwards private Causes, arbitrary error text, bodies, tokens, headers or sensitive
URLs. Ordinary fetch remains `total-only`: missing transmission substages stay
unknown, and a timeout budget is never presented as elapsed time. Snapshot stages
use debug and failures use warn. Protected-content observers remain composed,
including asynchronous failure isolation; neither logger nor observer failures
change upload, retry, authorization or local-only composition.

Configuration saves remain local-first. The writer records a pending token after
committing an authored Provider row; only a probe for that config waits for the
selected local Machine Flock peer receipt. Routine startup/backstop/forced refresh
has no new data-plane dependency when no write is pending. A confirmed receipt
clears only its captured token, so a concurrent newer write still needs handoff.
Unconfirmed delivery or timeout returns a failure response and keeps the token
for retry. Cancellation/disposal prevents late process launches. Cloud transports
and server authority are outside this local causal handoff.

The compatibility write barrier and attachment cancellation preserve two contracts
that readiness and a completed-handle registry alone cannot provide. After a
baseline, another local edit still needs fresh confirmation: `waitUntilSynced`
uses native captured-version upload ACKs for a server route, and checks the
selected route's protocol receipt for a peer. Missing, offline or unsupported
confirmation fails only that explicit wait. First-sync readiness and local-first
writes gain no new gate. Native Repo owns the bounded upload producer even if a
borrower cancels its wait; cancellation does not retire another borrower's replica.

The transport owner is registered synchronously before adapter construction or
native connect. Remove aborts acquisition and closes that owner Scope; native
finalizers revoke registration and drain accepted connection work. Both before
native registration and before publishing a completed lease, acquisition checks
cancellation. Removal and acquisition cleanup share the existing serialized close,
and delete the registry entry only if it still identifies that owner. A successor
can start after confirmed release. A failed close retains the native retry owner;
the next add for that id retries it, while sibling ids remain usable. Scope is the
lifetime primitive; the registry retains ownership, not another native status.

Local v7 congestion recovery keeps the 1,024-event/default 64 MiB bounds. Overflow
fails only that room's current barriers, including accepted but unconsumed sync
events. Explicit reconnect or a physical online edge interrupts and awaits the
old consumer and its accepted Flock I/O, stops the deadline, then creates a fresh
queue and worker in the same room Scope. It discards incomplete chunks, request
ids and server frontier state before rejoining from the retained replica version.
The CRDT/lease and state references survive; completed catch-up advances the epoch.
An interrupted waiter removes its receipt without retiring the shared replica.
A per-room native semaphore serializes restart with close, so replacement cannot
overtake the previous consumer and close prevents later recovery admission. This
is a local lifecycle boundary, not a workspace readiness or write gate.
Room recovery runs independently: waiting for one accepted import does not delay
another room's catch-up worker.
Physical connection status dispatch also must remain independent of that drain.
Healthy rooms receive status events directly; overflowed members schedule one
recovery fiber per member identity in a transport-scoped FiberMap. Repeated online
edges share the outstanding repair, completed tasks leave the map, and existing
room lifecycle serialization still joins recovery before close. Explicit reconnect
continues to await retirement; a retired transport ignores queued status edges.

## Session repair and remaining failure spread

A room binding's first-sync property starts a wait against current native state
on each read. Initial protocol failure rejects that caller's Promise permanently,
but does not memoize failure for later reads. Once the same binding has a joined,
current baseline, a new wait and RoomSyncTracker recovery succeed. The closed
borrow's signal still cancels waiters; no new deadline, producer, retry loop or
status cache is introduced.

Repo 0.23.0 exposes selected-room sync/reconcile, but no selected-binding reset.
Session history retries therefore use only their existing room's `sync('streams')`,
with the existing Doc-sync deadline (8 seconds by default) and borrower signal.
An offline/unconfirmed result rejects that attempt; it is not success or an
unbounded readiness wait. Native reconciliation can retry a failed attach.
Online sweeps sync/reconcile failed/offline rooms and SDK-proven failed initialization,
collecting independent failures. They leave healthy rooms, presence and ordinary
pending baselines alone. This corrects the earlier claim that
moving N-room resets into the controller put them under backoff: its healthy 30s
sweep bypasses that backoff. A persistent room-level 403 must not reset all members
every period. Only a server transport's own offline/closed/failed status permits
restarting all its members. Correction after reviewing `177e5bcb`: renderer
wake/online/auth triggers pass `resetBackoff: true`, so excluding only periodic
sweeps still reset healthy SDK generations on every forced attempt. Online server
transports now use the same selected-room path regardless of that flag. Native
Streams reset serializes all members and presence under the join/create admission
permit; avoiding it preserves unrelated room availability and admission. Local
peer force reconnect remains unchanged because overflow recovery must drain the
failed queue/worker; its `room.sync` alone cannot rebuild them. No new state,
retry loop, deadline, or recovery owner is introduced.

Correction after reviewing `ebf906f9`: the earlier claim that non-retryable HTTP
errors imply a terminal SDK generation needing transport reset was too broad.
Published CRDT 0.19.0 retries live 4xx with its own capped backoff and default
unlimited attempts. Selected SDK sync retries failed initialization and runs a
fresh catch-up/append barrier. However, failed initialization can leave Repo's
room projection at joining: filtering only failed/offline misses it indefinitely.
The facade now reads the transport's native health for joining rooms. It invokes
selected sync only when initialization is unready, has a non-retryable error or
an expired initial-sync hard deadline, and has no pending accepted SDK I/O. The
default 120s deadline terminates initialization even though `initial_sync_timeout`
is retryable; treating that error as an active retry leaves the room stuck after
service recovery. Other retryable initialization errors retain the SDK retry loop.
A genuine pending/retrying baseline keeps its owner; no second state registry or connection-reset cooldown is added. SDK release
receipts remain separate from HTTP failure classification and retain their existing
retry owner. The absence of a per-binding reset does not prevent these HTTP repairs.

CLI composition has no mutable transport route predicate; lazy acquire reconciles
its target. No CLI reliance on periodic route refresh was found. Renderer route
changes continue to call the explicit `refreshTransportRoutes` entry.

The trigger is the existing controller watchdog or reconnect request. Native Repo
owns selected-room reconcile/sync, its deadlines and accepted work; the facade
passes the caller's cancellation and combines independent failure Causes privately.
There is no owner handoff or new retained job map. A failed repair remains visible
and retryable, without interrupting a different room's repair.

The following design limits remain outside this repair; they are not containment
guarantees or claims of completed terminal shutdown:

| Trigger | Spread and retained owner | Recovery / remaining limit |
| --- | --- | --- |
| Repeated private shortcut `sync()` | Each `connect` adds an SDK lease/finalizer to the room Scope; retention grows with calls until room close | Room disposal releases them. Joining once per room remains follow-up work; there is no independent call-count bound. |
| Borrower Scope close fails | `destroy()` stops before native Repo close; native room/background-stop steps, including autopersist, are not reached | The retained workspace owner retries close; unrelated workspaces remain independent. Background activity persists meanwhile. Bypassing this dependency can strand a private SDK producer with accepted I/O. |
| Persistent IndexedDB quota failure during workspace retirement | RuntimeProvider's same-workspace close gate rejects reopening in this window and can consume a release deadline on each retry | Storage recovery permits retirement. Same-key adoption, bounded terminal shutdown/reporting and a terminal SDK/raw-writer termination contract are not implemented here; this remains a product-level availability limit. |

## Verification and limits

Readiness and Session recovery use real Repo boundaries. A failed attach is
retried on the same binding; native joined/baseline/current and recovered Doc
bytes are observed before the UI tracker reaches synced. The original wait
still rejects with its original error. Real filesystem saves pause and fail
while a manager reopens a Session: same-key concurrent callers join one
initialization, an unrelated Session remains available, and persisted bytes,
Mirror and history writer survive repeated failures and storage recovery. A late
join from the previous handle must release itself without replacing the new room.
The five component suites pass 111 cases. Four CLI suites pass 125 cases, with the
Roost active-goal case timing out; the Session suite also passes all 17 cases
separately. The isolated `fd0f4ee8` snapshot passes that Roost case near its 30s
case deadline, and a final isolated run on this tree also passes within the
unchanged deadline. Earlier parallel and isolated timeouts remain a timing-related
validation limit, not a proven baseline failure or a complete parallel suite pass.
The changed code is outside that fixture's manual handle/control composition.
The CLI controller's 17 cases, including published-SDK recovery, also pass. The original facade fails the same-binding
readiness recovery regression, and both original-manager cases return retired
views; removing only the handle identity check lets an old join replace the new
room in both cases. Original wait/cleanup errors remain observable.
Shared/components types pass in the required root check, which reaches its
ten-minute budget during CLI typechecking (exit 124); standalone CLI types pass.
Changed-file type-aware/Effect checks, formatting, documentation and all eight
boundary/translation guards pass. A complete root test pass is not claimed.

Online server repair at `fd0f4ee8` is exercised through real Repo leases and injected native
transport boundaries: Web and dual visible-wake paths retain healthy generations;
a dual-homed failed room survives three reconnect-loop periods without disturbing
its sibling, then uploads its original Doc bytes after the injected failure clears.
Detached routes stay idle. Offline/closed/failed transport recovery and forced
peer reconnect remain covered, as do accepted reconnect I/O drain and close.
These renderer fixtures model the transport boundary, not the full Streams HTTP
protocol; the existing published-SDK CLI controller cases provide that coverage.
The five affected suites pass 133 cases (32 facade, 64 runtime, 8 reconnect-loop,
12 local v7 and 17 CLI recovery). Visibility tests await completion of the real
cloud reconnect call instead of relying on a fixed number of microtask turns.
The `177e5bcb` comparison retains its original facade and fails all four forced
repair regressions: direct facade force, Web wake, dual wake and persistent dual
room failure; non-forced room repair still passes. The preceding head's GitHub
CI and Desktop E2E pass. Changed-file type-aware and Effect lint, repository format,
documentation and all eight boundary/translation guards pass. A full Effect lint
attempt terminates with SIGTERM; scoped Effect checks pass, so a complete full
static pass is not claimed. Shared/components types pass before the required root
check reaches its ten-minute local budget during Electron web typechecking
(exit 124); the complete root chain is not reported as passing.

Flock reuse is tested at the real IndexedDB batch-save and filesystem save
boundaries. Remote-imported indexes survive repeated release/reacquire during
persistent failure with the same Flock identity and bytes; unrelated Flock/Doc
views still open. Recovery permits eviction and a fresh replica loaded from disk.
A held batch save outlives the eviction deadline without losing ownership; another
view writes to the same Flock and the later save includes those bytes. These tests
exercise the Code Collab and shortcut runtime consumers, not only the facade.
All five affected suites pass (130 cases). Removing only the cached Flock hold
makes both consumer regressions fail with `RepoReleaseFailed`; the shortcut
runtime exposes that failure in its directory error state. The preceding head
`7d35b3ff` passed GitHub CI and Desktop E2E; those results are the baseline, not
acceptance of this Flock change. Shared/components types, changed-file type-aware
lint, full Effect checks, repository formatting, documentation and all eight
boundary/translation guards pass. The
required root check reaches its ten-minute local budget during Electron web
typechecking (exit 124), so a complete root pass is not claimed.

Six real-SDK cases cover bootstrap, live-read, append, persistent bootstrap
403, a held valid initialization and an expired initial-sync hard deadline.
Temporary failures recover to synced and the server imports the authored Doc bytes. Across three persistent-denial watchdog periods, the failed SDK generation
is retried and local bytes remain, while the healthy sibling's status and actual
SDK generation stay unchanged. A held baseline's accepted I/O and generation remain
owned across a watchdog period, then its original generation uploads after release.
The hard-deadline case returns bootstrap 503 until the default 120s deadline,
asserts the settled retryable timeout and absence of pending I/O, then restores the
service and observes the original bytes uploaded without restarting the healthy
sibling. It fails against `84416154` after three watchdog periods.
The bootstrap regression fails against `ebf906f9`
with no authored bytes reaching the server, then passes with the health check.
The initialization-deadline fix at `7d35b3ff` passes the five affected CLI/renderer suites (127 cases),
repository types, full type-aware lint and Effect checks, formatting, documentation
and all eight boundary/translation guards. Script tests pass 58 cases.
SDK backoff uses TestClock; the controller interval uses fake timers. These use
the published SDK and Repo over a synthetic HTTP boundary; the controller's Meta
status is injected and production-service acceptance is not claimed.
The required root check reaches its fifteen-minute budget during full CLI/renderer
tests (exit 124); a complete root pass is not claimed. It observes the previously
reproduced SSH credential fixture failure and UI/Roost timeouts. The three unchanged
UI suites pass all 95 cases when rerun serially. The isolated Roost active-goal
case still times out on this tree; the `84416154` snapshot passes near its existing
30s deadline. That timing failure remains unresolved and is not reported as passing.

At `ebf906f9`, the watchdog regression fails against `c57f9ec8` with the healthy sibling observed
as `offline`; the same real-Repo/controller fixture passes after narrowing the
facade repair. Three fake interval periods keep a persistent permission failure
visible while another offline room repeatedly syncs and writes Doc bytes, and
healthy room status and actual presence publishing remain usable. Connection-level
offline/closed/failed and forced-peer cases still reset and preserve the replica.
The five owning CLI/renderer suites pass 121 cases. Repository types and
type-aware lint, full Effect checks, all eight boundary/translation guards,
formatting and documentation checks pass. This is an injected native transport
boundary, not a live-service permission test.
The root check passes types, lint and Effect, then stops at the unchanged
`effect-lint.test.mjs` nested-process fixture under the sandbox. All 58 script
cases pass outside the sandbox; the full application test stage was not
reached, so no complete root pass was claimed at that revision.

The Session isolation regression fails at `11f89018` with the healthy sibling's
native status observed as `offline`; it passes after the selected-room change.
The real Repo with an injected transport gates connection reset explicitly and
checks imported Doc bytes for both pending Sessions. Joining/offline waits use
fake deadlines, remain retryable after timeout and preserve another borrower.
Cancellation covers both native reconcile and sync. At `c57f9ec8`, the four owning CLI suites
pass 90 cases, including existing SDK checkpoint and dispatch/recovery coverage.
CLI types, changed-file lint, Effect and boundary checks pass at that revision.
That root run reached its local ten-minute budget during component typechecking;
it was not a complete root pass.

At `6c5fca07`, the two supplied deep-review regressions fail while the prior 19 cases
pass. After repair, the expanded suites pass 22 cases. Real SDK HTTP remains held
past its abort and release budgets for both `connect`/sync and `join`; after it
finishes, Scope retirement and the same database reopen succeed. A held real Flock
import overflows Meta while a sibling processes repeated later offline/online
edges; releasing the import recovers the same Meta replica, and disconnect remains
closed despite another queued online edge. These are injected boundaries, not
production-network acceptance.

The `6c5fca07` CI CLI group also exposed three Role-history tests added on main
that still constructed the old Promise Repo for the migrated SessionDocument.
Their fixture now constructs the same WorkspaceRepoLegacy used by the consumer;
proposal persistence, idempotency and ownership assertions remain unchanged.

`11f89018` passes all 1,543 Shared cases, 93 affected renderer cases, four Role
history cases, repository types/static checks, 58 script cases, formatting and
documentation/boundary checks. The local root run was stopped during full CLI and
component tests after types/lint/scripts passed; it is not a full-suite pass.
Final merged-head CI remains required.

The persistent IndexedDB save regression fails on `c2dc8435` and passes with this
repair. It checks repeated/concurrent reopens, original Doc identity/bytes, an
independently writable/persisted sibling, successful later eviction and a fresh
durable generation. A separate real Scope/IndexedDB case protects a failed private
SDK producer's storage, proves another workspace can still persist, and closes both
producer and storage after recovery.
The real renderer preview entry and CLI Session reinitialization also reuse the
original replica while persistence remains unavailable; they do not need recovery
to happen before another view opens.
A fake-clock case holds an actual adapter save beyond the eviction deadline,
reopens the same Doc while that write is still accepted, then finishes and verifies
the bytes on disk. The timeout never becomes a durability acknowledgement.
After integration with main `7246f783`, validation covers 143 affected renderer
cases, 175 CLI cases including daemon/MCP and 48 Shared protocol/shortcut/lock cases.
Before that integration, all 1,521 Shared cases passed. Affected-package types,
changed-file lint, formatting, native boundary and documentation checks pass;
real-process/IPC and Git-based guards run outside the restrictive sandbox.
The complete local root test chain was not rerun to completion; these results do
not replace CI on the final PR merge. RuntimeProvider keeps main's bounded client
log event but records only operation/error type, never the private Repo error.

Real v7 host tests exercise two consecutive overflows at the default event cap,
default byte cap, and an injected small byte cap. Schema-valid bursts, including
real Loro update bytes, fail current waits, preserve independent room sync, then
recover both incoming and outgoing writes on the original Doc/Meta replica. A
separately gated real Meta import proves recovery awaits accepted uninterruptible
I/O before replacing the consumer, while a sibling completes its catch-up epoch.
The owning native suite passes 11 cases.
At this repair, full Shared passes 1,522 cases and four affected renderer suites
pass 89 cases. In a separate worktree at `a2f0911d`, all five added congestion
regressions fail against the previous implementation.
The root run also encountered a timeout in the unchanged SubagentTaskPanel
command-details case; its owning suite passes all 19 cases when rerun alone.
Record that separately from the known SSH credential fixture failure rather
than reporting the root run green.

Real renderer SDK fixtures verify plaintext/protected snapshot success, a held PUT
with 275 ms of injected elapsed time, and a 60 s total upload timeout carried
through native Repo error formatting. Throwing log sinks and async observers cannot
fail the upload or skip the configured observer. CLI SQLite/SDK fixtures verify stage records and correlate encoded byte
length and request id with the actual PUT. Added private fields in diagnostic DTOs
are excluded by projection, as are synthetic private payloads and Causes in real
failure paths. Only SDK-provided transmission evidence is logged.
Removing observer registration and the three error classifications makes the
regression fixtures fail.
At `a2f0911d`, diagnostics validation passed 63 affected component cases and 5 CLI cases, plus
full workspace type/static checks, formatting, docs and boundary guards. Full CLI
has 4,313 passes, one skip and the already reproduced SSH `context_unreadable`
fixture failure; root `pnpm check` therefore remains red and not every package's
full suite completed through that command. The script suite passed all 58 cases.

Regression fixtures exercise the real SDK with an upload POST held after baseline,
and a real Streams transport with an explicit connection suspension. They verify
server-received bytes, removal from native inventory and same-id reconnection.
Additional native boundary cases cover cancellation during construction/connect,
late completion versus a successor, release retry, and unconfirmed peer receipts.
Restoring the `d82fea54` facade makes both real regression fixtures fail. At
`95ee59f7`, the sandboxed root check stopped in a script fixture; the same complete script suite
passes outside the sandbox, as do the affected CLI and full Shared suites.
These are synthetic HTTP fixtures, not production-network acceptance.

Behavioral regressions cover automatic retry after failed cache and shortcut
release, shared replica ownership, original-byte preservation after failed save,
background observer failure followed by successful close, continuation/retry of
workspace cleanup and switching after failure, local-room invalidation after failed Session release, and
dirty-only config handoff with cancellation and disposal. Native v7 host tests,
existing legacy peer compatibility cases and snapshot/Streams suites retain their
separate protocol coverage. Final check results are recorded in the PR.
Real native integration also verifies retry after a failed attach, native-only
room inventory, repeated server confirmation versus local authority, and all four
late-reconnect success/failure and waiter-retry shutdown scenarios. A timed-out
waiter shares the retained native producer; another edge does not duplicate it.
Session retirement during reconnect/readiness also cancels only that borrower's
wait, preserving another holder of the shared room and document.

Head `df7de23d` passed full GitHub CI and Desktop E2E; those results are a
baseline, not verification of this revision. The unchanged SSH credential
fixture's `context_unreadable` reproduces locally both before and after this
simplification, so the full CLI suite is not reported green locally. Real production services,
browser-process crashes and cross-platform acceptance remain outside local tests.
Host local server ownership, SessionDocument wrapper cache, Session/Turn/dispatch,
shortcut grants/publication, RPC and migration target uploads retain their existing
application lifecycles. The PR remains one owner-requested adoption unit; unused
framework surfaces and product duplication were removed rather than adding another
migration or changing the reviewed WorkspaceData proposal.
