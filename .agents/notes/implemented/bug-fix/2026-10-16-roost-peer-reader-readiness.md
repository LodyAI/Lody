# Roost peer readers wait for identity and observe owner checkpoints

Status: implemented
Translation: current
PR: [#1626](https://github.com/LodyAI/Lody/pull/1626), [#1650](https://github.com/LodyAI/Lody/pull/1650)

[中文](2026-10-16-roost-peer-reader-readiness.zh.md)

## Abstract

A cold viewer could select legacy Loro before a Roost session's metadata arrived,
leaving a permanently empty reader. A correctly selected reader could also stay
stale after the separate control cursor stopped delivering updates. The renderer
now waits for backend identity, follows live owner capabilities, and observes
committed checkpoints through bounded owner requests. Post-merge fixes align local
watch deadlines and shutdown ordering, preserve live display during replacement,
and deliver committed notifications. Tests exercise real Repo, native SQLite,
IndexedDB, ConversationView and encrypted RPC boundaries with synthetic transport;
they do not establish production latency or independent Roost replication.

## Post-merge correction: local watches and live recovery

An October 17 investigation reproduced four integration defects in the code
merged by PR #1626 (`a4de9a264`). They concern the new observation and recovery
paths, independently of the unrelated Inbox host-sampling failures. This follow-up
fixes them without changing the protocol, history storage, or dependency versions.

- **Local watch deadline.** Electron now derives the control timeout from the whole
  validated request. A watch gets its requested wait plus the ordinary ten-second
  read allowance; ordinary reads and existing long-running control requests keep
  their previous budgets. The renderer test uses this production policy, completes
  an idle 15-second watch successfully, then observes the next reply immediately.
  A pending nonzero recovery timer can also be shortened by a fresh hint or wake;
  zero-delay work remains coalesced.
- **Shutdown cancellation.** MessageHandler owns a separate watch cancellation
  controller. MachineRuntime stops admission and cancels parked watches before
  draining the processor; the full handler owner signal remains available to shared
  writes until normal cleanup. Tests cancel a watch while a writer awaits the same
  metadata and prove that writer still commits. A second test runs the real runtime,
  handler, native waiter and ACP buffer across two sessions: shutdown cancels the
  observer synchronously, drains it and persists the other session's buffered output.
  Reopening native history returns that output. No batch, watch or native I/O
  deadline is advanced to make shutdown finish.
- **Live display during replacement.** Unknown checkpoint coverage still stages a
  complete, coherent replacement while retaining the previous durable cache. During
  that replacement, display reads use the owner rather than the old projection and
  hints continue invalidating the view. The first two supersessions retry immediately;
  repeated ones back off from 500 milliseconds to at most ten seconds. New hints
  update the live view without defeating that bounded rebuild backoff. A 120-row
  regression keeps superseding older pages, verifies that the real ConversationView
  receives another streamed chunk while the durable head remains old, then stops
  publication and verifies complete atomic replacement including the early body.
- **Commit precedes notifications.** Once `cache.applyChanges` succeeds, its
  invalidations are delivered even if a newer hint arrived during the transaction.
  The newer revision schedules catch-up rather than discarding the committed result.
  A 600-row fixture exceeds the inline-body budget and injects that hint during the
  IndexedDB transaction. The actual ConversationView updates its hydrated tail at
  the first commit and retains it after the next checkpoint is applied.

The original tests used a watch transport without Electron's deadline, stable
revision replacement pages, and coherent inline streaming replies. Backend waiter
cancellation did not exercise the runtime's outer drain order. The follow-up tests
extend those owning suites and assert visible content, durable state and cancellation
isolation. Transport interleavings and clocks are controlled; IndexedDB uses
`fake-indexeddb`. This is not production latency or incidence measurement.

Native Effect migration remains deferred for this fix. The renderer's transport,
cache and Repo callbacks, and the runtime/MessageHandler drain and SessionManager
cleanup are unfinished Lody Promise orchestration. A small wrapper would not complete
their ownership contract. No new runtime/Legacy facade or migration ledger claim is
introduced. Dedicated watch cancellation ends observations, not shared producer writes;
the processor still awaits their actual settlement before handler teardown.

## Correction from strict review: reset is a coverage verdict

The October 17 review found a P1 recovery defect in the renderer. An explicit
checkpoint reset still fell through to two older optimizations: updating only the
last hint at a consecutive control revision, or treating a latest page as enough
to advance the existing cache. A missing journal interval can coexist with a
consecutive revision after a committed write loses its reply. The counter does
not prove that the last hint covers an older edited message. Advancing the cache
through those shortcuts could retain stale prefix bodies while claiming the
newer revision/checkpoint.

Reset now retains replacement mode across recovery attempts. It bypasses both
shortcuts, stages pages under one checkpoint in the other slot, and publishes
only after complete coverage. Equal revisions require the new checkpoint too;
the readable old head cannot satisfy that completion test. A complete verified
incremental reply can discharge a previous reset when coverage becomes available.
No command is replayed, and ordinary verified deltas keep their bounded read path.

The owning renderer regression edits the first and last bodies of a fully cached
120-row conversation, supplies only a tail hint, and holds the first older-page
reply. It covers equal, consecutive and skipped revisions, proving that the old
snapshot remains readable until both edits publish together. The consecutive
case failed before this fix with the observable unverified-hint path; the prior
test exercised only a skipped revision and missed the defect.

The CLI owner suite additionally joins the real MessageHandler ACP buffer,
Native SQLite, production encrypted RPC client/server and two independently
scoped renderer bridges/IndexedDB replicas. Their control documents stay empty.
Sparse tool start/completion and 31 Unicode text chunks reach both peers, with
exact final content after owner reopen. A committed-but-lost native reply uses
the same automatic drain and completes without duplicate text. Stream delivery
and browser IndexedDB use test implementations; agent events and peripheral host
services are synthetic. No model or real network is called. Native I/O deadlines
are not advanced by the controlled recovery clock.

## Findings and the Loro comparison

The baseline and the first incremental repair sampled metadata once before the
UI acquired control-room synchronization. Missing backend metadata was treated as
legacy Loro, and later catalog patches did not recompose the cached reader.
Machine capability metadata was also sampled once.

Loro's history reader observes the continuously synchronized local document. It
subscribes before taking its initial snapshot; subsequent bodies arrive in that
same document. Roost uses owner RPC and a separate read projection, while the
Loro control document carries only a hint. Premature backend selection and
missing observation recovery therefore have new consequences at the Roost
integration boundary. They are not evidence of preexisting Loro bugs or an
Effect runtime defect.

A controlled experiment held the control cursor unchanged while owner reads
remained available. The first repair stayed stale for a virtual minute; another
cursor notification recovered it. This proves a missing recovery trigger, not
the cause of a production subscription delay. The selected repair exposes the
owner's committed history observation instead of adding periodic body reads.

## Backend and capability readiness

The runtime subscribes to session metadata with Repo's atomic observation and
snapshot before selecting the history backend. Explicit Roost identity requires
its owning machine. A missing backend on a provisional empty control document
remains pending. An empty Loro list left by the previous erroneous reader is not
legacy evidence. Existing nonempty legacy history without a Roost cursor remains
readable offline. A misplaced old Loro entry beside a known Roost cursor does not
establish legacy identity. These checks read container length/path, not a full
control-document JSON serialization.

For an otherwise legacy row, the runtime waits for restoration of the metadata
binding selected for that session's plane. In a dual runtime, local Meta
restoration does not establish a foreign cloud session's identity. Explicit
backend arrival resolves the same pending acquire without reopening the view.
The finite Repo wait uses its own abort signal; success, deletion and runtime
retirement release metadata/status listeners and the convergence waiter.
After restoration, a missing owner or known Roost cursor remains pending until
metadata changes; it does not re-await the completed barrier or select legacy
history. Both initial tombstones and later deletion retire the pending reader.

A Roost reader observes its owner's capability metadata for its lifetime.
Incremental and watch capabilities are evaluated when work starts, and capability
arrival wakes the existing bridge. Missing capabilities retain legacy reads;
release stops their observers. A newly available checkpoint path stops unnecessary
older-page warming while preserving a staged reset's atomic replacement.

## Checkpoint observation

The separately advertised `sessionHistoryWatch: 1` requires
`sessionHistoryIncremental: 1`. Local control uses `watchChanges` on
`session/history-read`; remote RPC uses the independently classifiable
`session/history-watch` method. Its request, result and history error handling
retain owner-session encryption and ownership validation.

The native backend registers a waiter before checking the supplied checkpoint.
A changed checkpoint returns immediately; otherwise publication wakes the waiter.
The read then uses the same durable `readChanges` and coherent-body response as
ordinary recovery. This covers changes between the initial read and watch
admission, missed hints, and reconnects. Cache content, membership and checkpoint
commit atomically before the next observation. An unchanged checkpoint reads no
history bodies, writes no cache replacement and emits no body invalidation.
Successful delta repair also finishes immediately when only the history tail is
cached; it does not follow the repair with another full latest-page read.

Waits last at most 15 seconds, with a 45-second remote response budget. Local
desktop requests include the requested wait plus a ten-second read allowance. Remote
admission is bounded at 128 watches, separate from ordinary read admission.
MessageHandler also bounds parked owner waits at 128 across transports. Waits
park in JavaScript outside the native Worker and writer queue; after waking,
actual reads acquire ordinary RPC permits or the bounded local watch-read pool.
Local watches for the same session use independent lanes, so one idle viewer
cannot serialize another viewer's observation. No new per-view SSE transport is
created: remote requests reuse the workspace Machine RPC transport.

## Lifecycle and recovery

- Trigger: active history observers, owner publication, control hints, live
  capabilities and visibility/connection recovery enter one refresh owner.
- Owner: each session bridge retains one in-flight refresh and its raw reads;
  shared RPC clients retain dispatched requests. Native waiters own no writer slot.
- Cancellation: hidden/offline remote views start no new observations; local IPC
  remains usable offline. Unsubscribe/dispose fences later publication. A dispatched
  viewer request settles or reaches its bounded deadline; server stop and backend
  close abort parked waits. Runtime shutdown cancels its dedicated watch signal
  before processor drain; shared writers retain their normal owner. Retiring a
  metadata waiter releases only its wait.
- Handoff: durable owner journal precedes the checkpoint response, and atomic
  cache publication precedes observing the next checkpoint.
- Recovery: isolated supersessions retry immediately; repeated supersessions and
  actual failures back off. Reset keeps live owner reads and hint invalidations
  available while staging a coherent replacement. Committed intervals always notify
  readers before further catch-up. User commands are never replayed.

Native Effect migration of the renderer orchestration remains deferred: Repo
composition, cache and transport consumers are unfinished Lody Promise boundaries.
The existing native Effect owner-readiness service remains the RPC precondition.
No new Effect runner or dependency version was introduced.

## Verification and limits

The owning runtime suite uses actual Repo subscriptions with separately gated
local/cloud metadata restoration, late Roost identity, an old empty history list,
legacy absence after restoration, and runtime close during a pending acquire.
The renderer suite changes capabilities after opening and updates the visible
body from owner observation while the control cursor remains empty. Native tests
cover publication, admission gaps, deadlines, cancellation, close and subsequent
writer usability. Encrypted RPC tests cover the actual client method and 128
parked watches while ordinary reads, sends and ping complete.

The follow-up root `pnpm check` passes type checks, type-aware lint, Effect lint,
the complete configured package test run and all post-test i18n/boundary guards.
CLI passes 4330 cases with four existing skips, components 5434, shared 1525,
and RPC 139 with three existing integration skips. All 75 native owner contracts
and the 32-case renderer backend suite pass in those full runs. Restoring the old
deadline, renderer recovery or runtime shutdown code causes the four corresponding
regressions to fail on behavioral assertions. Formatting, documentation checks and
`git diff --check` pass.

The two Inbox failures in the earlier full check were reproduced against an
unmodified archive of PR baseline `fb4d565` under a controlled macOS memory-probe
failure. The relevant production files have identical Git blobs in that baseline
and the original Roost head. They are pre-existing warning behavior, not a Roost
regression. The operator success tests now use deterministic process-command
fixtures and retain assertions that uncertain snapshots refuse recovery without
replay. The 63-case owning suite passes. Evidence and the unchanged production
boundary are recorded in the [Inbox note](../architecture/2026-10-12-operation-inbox.md#superseded-operator-recovery).
The full root check passes with those fixtures.

Documentation checks now pass after checking out Kimi `743c6641` and Pi `64482a51`
at the repository's existing gitlink pins, without installing their dependencies
or changing those pins. The six reported paths were valid source links to absent
submodule checkouts. No registered SHA topics exist.

Before the PR's main-branch integration, the product macOS arm64 snapshot compiled
and packaged successfully with native smoke and signature checks. That snapshot's
CLI was byte-identical to the deployed Docker CLI; the strict-review correction
was in the renderer. Immutable build provenance is recorded in the installer
handoff. The merged PR head has not been repackaged, and packaging does not
install a new renderer into a running application.

These are synthetic local regressions. No linked product conversation, private
Web/mobile source, permissions service or live network was accessed. Cached
content cannot supply bodies never synchronized on this device. Independent
execution replicas, existing-data compaction and production deployment remain
separate work. The linked [history-write Spec](../../../../specs/session-history-writes.md)
remains draft; implementation does not approve it.

Related decisions: [incremental recovery](2026-10-16-roost-incremental-history.md),
[write amplification](2026-10-16-roost-storage-write-amplification.md),
[native runtime](../../proposed/architecture/2026-10-09-roost-native-runtime.md),
[creation feature gate](../../proposed/feature/2026-10-08-roost-history-feature-gate.md).
