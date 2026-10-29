# E2EE core as ports, workflows and adapters

Status: implemented
Translation: current
PR: [Browser ledger/original stores #2053](https://github.com/LodyAI/Lody/pull/2053) · [Browser custody/key journals #2060](https://github.com/LodyAI/Lody/pull/2060)

[中文](2026-10-16-e2ee-core-service-architecture.zh.md)

## Abstract

`@lody/e2ee-core` exposed about twenty factory functions that each opened their
own SQLite files, took raw callbacks for remote systems and kept a private
rollback pin. That made the library hard to reuse outside Lody, hard to read,
and impossible to run against another backend or store. The core is now split
into ports (Effect services the application provides), workflows (services the
library implements as Layers on those ports only) and adapters, behind role-based
entries plus an unstable `./internal`. Node SQLite, browser ledger/original
IndexedDB, JS curves and Loro Streams adapters implement separate capabilities;
storage never grants authority. Protocol bytes and workflow guarantees stay with
the existing core. Product composition remains
separate from these storage and crypto adapters.

## Problem

- Each workflow factory (`makeSqliteEpochReceiver`, `makeSqliteKeyDistribution`,
  `makeSqliteEpochRotation`, …) took paths, modes, protectors and remote
  callbacks, opened its own stores and nested other factories. Composition was
  implicit and duplicated; a different backend or store meant forking code.
- Every store embedded its own ledger pin, so rollback protection was copied
  into seven places with slightly different error mapping.
- Twenty-five package subpaths mixed pure protocol, host-only workflows,
  adapters and test helpers; the README described an earlier extraction.
- Error channels were often `unknown`; most functions were `Effect.gen`
  wrappers.

## Decision

1. **Ports** (`./services`): backend (`LedgerLog`, `LedgerFeedSource`,
   `KeyMailbox`, `EpochStagingStore`), platform (`DeviceIdentity`,
   `KeyProtector`, `CandidateProtector`), application (`WorkspaceScope`,
   `LedgerViewSource`, `EpochPublicationSource`) and local storage (one port
   per journal or store). Ports carry typed errors (`BackendError`,
   `LocalStoreError`, …) and JSDoc contracts.
2. **Workflows** (`.`): `VerifiedLedger`, `LedgerFeed`, `LedgerSubmission`,
   `InstalledEpochKeys`, `InstalledEpochHistory`, `KeyReceiver`, `KeyRepair`,
   `KeyDistributor`, `EpochPublisher`, each a `Context.Service` with a `layer`
   that depends only on ports and protocol code. `E2eeWorkflows` composes them.
3. **One rollback guard.** `VerifiedLedger` with a single `LedgerPinStore`
   replaces the per-store pins. Pin-fault coverage moved to one owning suite.
4. **Adapters** implement ports behind separate entries. Store mutations verify
   their own write and captured binding inside the same transaction, so an ignored
   or mismatched write aborts. SQLite remains the reference for all local ports;
   IndexedDB also supplies installation, key and snapshot journals; browser custody is a separate opt-in adapter.
5. **Backend contract** (`./host`): staging DTOs as Effect Schemas, request
   signing bytes and stage-request checks, plus the mailbox rule functions.
   Platform-neutral; `@lody/cloud-api` re-exports the staging contract instead
   of defining it.
6. **Effect practice.** Public methods are `Effect.fn` spans; helpers are
   `Effect.fnUntraced`; functions that only wrapped `Effect.gen` became
   `Effect.fnUntraced`; workflows declare complete failure unions.

## Discoveries and choices

- **Close semantics are per workflow.** Making every workflow wait for
  in-flight calls on Scope close deadlocked existing tests: receive, repair and
  distribution intentionally let in-flight remote work fail at the next guard
  instead of being awaited. Only owners of native protection (installed keys,
  history, publisher) wait. Both behaviors are explicit (`makeAdmissionGate`,
  `makeCloseGuard`).
- **Capture at construction.** The old factories bound borrowed callbacks at
  initialization; a test mutates them afterwards. Workflows now capture ports
  with `own()` so a later mutation cannot swap a capability.
- **Candidate protection stays separate.** The reviewed decision that an
  unpublished rotation key uses a distinct protector from installed keys is
  kept as a separate `CandidateProtector` port, rather than reusing
  `KeyProtector`.
- **Public contract completion.** The documentation check now traverses namespace
  exports and resolved service members, including inherited contracts. The old
  check missed `Bytes` exports and service methods with no JSDoc. A compiler-backed
  fixture checks both rejection and acceptance; documentation quality still needs
  human review. Public ledger/key workflow queries and acknowledgements now have
  named spans too, without adding argument attributes or installing telemetry.
  `LedgerViewSourceError` replaces the view port's `unknown` error channel;
  expected source failures keep the cause and leave the rollback pin unchanged.
  This changes the adapter's compile-time contract, not ledger or wire behavior.
  Submission acknowledgement still copies its argument at invocation, before
  the lazy traced body runs; the real-journal test mutates the caller's argument
  before execution to preserve that ownership guarantee.
- **Delivery refusals propagate.** Only an `unavailable` mailbox leaves a
  delivery `Pending`; a refusal (unauthorized, conflict) fails, matching the old
  distinction between transport loss and host rejection.
- **Unified feed store.** Full-history and snapshot feeds share one
  `LedgerFeedStore` (origin plus suffix records); verification lives in
  `LedgerFeed`. File formats of all stores were re-versioned, since nothing is
  deployed.
- **Alternatives considered.** Keeping the factories and documenting them was
  rejected: it would not make backends or storage replaceable. One entry per
  module was rejected: it hides who each export is for.

## Workspace and recovery (stack layer 3)

- The `E2eeWorkspace` facade no longer receives prebuilt factory objects. A
  `WorkspacePlatform` returns a Layer of ports, and the facade builds
  `E2eeWorkflows` plus `WorkspaceControl` in the workspace Scope. The handle's
  methods are unchanged, so platforms change only how they supply resources.
- `LedgerSync` (application port) replaces the old ledger client plus
  checkpoint callback. The workspace derives `LedgerViewSource` from
  `LedgerSync.refresh`, preserving the old behavior that every workflow read
  refreshes the feed.
- Recovery vault storage is two ports (`RecoveryVaultStore`,
  `RecoveryVaultLocalStore`) with a `RecoveryVaults` workflow. The vault wire
  DTOs move to `./host` as Schemas, and `@lody/cloud-api` re-exports them, as
  with staging.
- Workspace errors use `Schema.TaggedError` with `reason`, like other public
  errors.

## The Lab on the services (stack layer 5)

- The Lab's `WorkspacePlatform` supplies ports like an external integrator.
  Its ledger actor exposes `LedgerSync`, `SubmissionJournal` and `LedgerLog`;
  its HTTP mailbox and staging clients become `KeyMailbox` and
  `EpochStagingStore`. The ledger pin and candidate files are per actor,
  because several actors share one directory, and a shared pin would couple
  their rollback knowledge.
- Single-component fault harnesses use `./internal` testing helpers. These
  open one workflow (receiver, distributor, publisher…) from the real Layers
  with per-store options; there is no second implementation.
- Platform callbacks `documentState` and `recoveryConfiguration` receive the
  workspace's built services, since a platform may need workflows (key reads,
  delivery) while assembling native state or recovery inputs.
- The Lab projects service errors by `reason` and protocol errors by `code`;
  the staging adapter keeps a backend refusal's reason.

## Browser storage boundary

A per-device database was rejected: replacing a lost identity would also lose its
workspace rollback knowledge and unresolved originals. The IndexedDB adapter keeps
one stable account/workspace/genesis database. Pairing rows add the local device,
installation, session and purpose; replacement retains old exchanges. Its pin
revision token is a local CAS precondition, never an authority or mode cache.

The adapter uses native short callback transactions rather than awaiting crypto
or network inside IDB. Strict durability is a browser hint; `complete`, after
readback and binding checks, is the observable success boundary. Closing fences
new work and drains actual transaction promises; unknown results reconcile from
retained first bytes. No fallback database or implicit reset restores availability.
The host must independently requalify retained ledger state and verify approval,
protect secret pairing material before storage, and handle loss of persistent
protection under the [custody contract](../../../../specs/e2ee/client-custody.md).
The separate stable client layout now retains installation, receive/report, installed/candidate, distribution/outbox/repair and snapshot publication journals. No store performs remote mailbox operations or approval verification.

## Verification

`packages/e2ee-core/test/composition.test.ts` uses real workflow Layers and crypto
for device key delivery. `packages/e2ee-core/test/public-docs.test.ts` checks JSDoc
and entry surfaces. `packages/e2ee-core/test/indexeddb.browser.test.ts` uses real
Chromium/WebKit persistent profiles, process reopen, competing tabs, native abort/
quota/mismatched-write faults and close. It pins exact original retention, atomic
record/cursor rollback and qualified retained-state reopen. These synthetic
browser-engine checks do not establish minimum-OS, real-device or production
acceptance. The package remains private at `0.0.0`; reusable boundaries do not
publish a standalone SDK or enable a product host.

## Browser custody rationale

A lifetime tab lock was rejected because idle protected work must not block other
windows. The host instead enters a scope-wide finite Web Lock before identity
allocation, holds it through real local/native settlement, then releases before
network waits. Database/device-specific locks would admit competing installations;
stealing on cancellation would let unfinished native work overlap its successor.
Reentry therefore checks the actual holding fiber, not just inherited Context. A
child must acquire its own lease; counting arbitrary descendant borrows adds
ownership machinery where the finite local sequence needs no parallel writer.

A nonextractable key alone is insufficient: a retained creation intent, key/probe
readback, actual decrypt and transactional write/readback/restore establish usable
persistent protection. Missing marker/key cannot establish first use while any
scoped original, nonce or journal remains; the creation transaction checks all
incarnation partitions. Fallible availability probes precede wrapping intent, so
a transient quota fault before encryption can retry. Once intent commits, native
encryption and ciphertext retention remain uninterruptible: a crash or genuinely
unknown result still cannot safely be retried as a new encryption. Nonce reservation/count precedes native encryption, so an
unknown result cannot trigger a second encryption. Completed originals reconcile
exactly; ambiguous partials stay blocked. The scope-wide installation pointer and
retired archive remain atomic, retaining old journals across desktop-approved
replacement. The first wrapped candidate belongs to the pending request receipt;
that local completion is never desktop approval. Browser-engine tests cover these
boundaries and all fixed purposes, but do not prove minimum-OS hardware or power-loss
acceptance. The approved Spec and ledger v1 remain unchanged.

## Personal-device product composition

[`@lody/e2ee-client`](../../../../packages/e2ee-client/README.md) owns optional
personal pairing/open/key/management/RPC composition outside core. Desktop
consumes its unchanged pairing codecs, fixed full-history verifier and finite
key-maintenance owner; native storage is an adapter, not a second protocol tree.
The portable RPC implementation likewise has one effectful immutable store port
and a thin SQLite compatibility wrapper. No product transport is enabled here.

Receipts cannot authenticate an independently transferred endorser after cold
reopen. The existing device-credential purpose therefore protects a current-only
local CBOR payload `[1, credential32, pinDigest32]`. Its SHA-256 digest covers the
JSON array of domain `lody-e2ee/client-credential-pin/v1\0` (one NUL), account,
workspace, genesis/device hex, installation ID, original genesis record hex,
endorser and membership. Session is excluded so a terminal retry can preserve the
same credential/identity; pending/admitting/unknown attempts cannot change session.
This is local protected payload, not a new wrapping, signature or ledger format.

Full-history proofs may exceed the fixed single-message pairing limit. A separate
bounded immutable paged public evidence port commits every page plus count/size/
digests atomically; no checksum or saved approval label becomes authority. A
replacement carries the first snapshot original rather than recursively embedding
prior approvals. Fresh full signed history requalifies that snapshot's historical
manager, signature and exact state before the existing origin/pin can reopen.
Using a self-signed cache or a fresh per-device feed namespace would hide lost
trust or rollback evidence, so neither is supported.

Ledger owners precede lazy key owners. Independent key/repair failures remain
retryable; a valid retained admitted epoch remains usable when the current key is
absent. Replacement qualifies new approval and pins before draining healthy old
owners, then uses the approved archive/current atomic switch. Scope close fences
and joins operations before key/credential/store release, without deleting any
identity or uncertain original. Secret and RPC plaintext acquisition uses
`acquireRelease`/`acquireUseRelease` through wipe registration: joining native work
alone can still abandon its returned buffer when cancellation reaches the caller.
The operation Scope owns cleanup on success, failure and interruption; close joins
that Scope before releasing custody. This masks only finite local acquisition,
without moving remote policy or network waits into custody ownership.
Browser engines and desktop regressions exercise
these contracts; minimum-OS devices, native plugins and power-loss durability
remain separate acceptance.


The scoped host constructor remains the actual drain primitive. Product assembly
uses `makeOwnedPersonalDeviceHost(ports)`, which acquires the whole resource-owning
port Layer in a retained Scope independent of its consumer. Host, session and
parent-Scope close share a five-second waiter budget; timeout reports
`PersonalCloseIncomplete` with a narrow recovery owner. Keep that full failure and
its owner, including the physical lock, borrowed buffers and unresolved originals,
until actual settlement or confirmed native termination. A deadline never proves
successful close or permits same-binding runtime handoff.

Only finite ticket creation is serialized. Native drains run outside that critical
section, concurrent callers observe the same ticket, and independent readers remain
usable while another session drains. Replacement drains every matching owned reader before the supplied external
owner drain and atomic identity switch. Parent retirement joins every child ticket
before releasing the complete port Layer; it cannot rely on a second `Scope.close`
to join an already closing child. Late successful settlement permits explicit close
confirmation; a closed handle never revives. Plaintext transfer also tracks whether
the waiting consumer has disappeared, so a worker result cannot lose wipe ownership
before publication or between publication and receipt.

The shared `makePersonalWorkspaceRuntime` consumes that owned constructor and the
existing `E2eeWorkspaceRuntime`/content bridge rather than creating another transport
or mode cache. Application ports pin account/workspace/genesis independently and
provide local originals plus the execution entry. Read-open refuses missing ready
identity; only explicit preparation can create it. Current-key absence does not
block admitted retained epochs, including one that arrives after a no-key lease.
Per-operation core admission still checks the exact device and current ledger.

A compatible optional preallocated-reader contract lets the provider reserve its
own label before cold open. Shutdown can call bounded native close while unwrap
is pending; a late open cannot record identity or publish content. Closing a queued
label does not retire the distinct opener holding custody. Legacy desktop hosts do
not advertise this optional contract. Labels are ephemeral ownership, not persisted
pins or authority. An incomplete renderer/host close retains its owner for retry;
empty failed initializations do not build an ever-growing chain of recovery owners.

Reader lifetime and underlying host lifetime differ: one reader may close while
another remains. Last-reader close fences that session and retains an incomplete
ticket for confirmation; account change or close during initial acquisition retires
the bound assembly. A new account observation cannot revive it. Provider cleanup
starts native fencing alongside independent renderer cleanup, retaining full failures
and the precise account/reader lease. A later acquisition retries unresolved close
before publishing a successor. Serializing a new open behind the entire native
operation, swallowing a close failure, or memoizing a timeout as permanent failure
would respectively hide the close deadline, permit overlap, or block safe reuse.

Device grants remain inside the captured approved session; only dedicated short-lived
content/attachment tokens leave it. Optional RPC/policy factories advertise real
capabilities, not empty successful handlers. A machine-sharing Layer is trusted host
composition and must retain the existing crypto/original/generation/freshness policy;
the bridge supplies fixed services and ownership, not a substitute policy verifier.
Ordinary management uses core original submission/ACK, atomic member removal and
resumed rotation. Relay history pages confirm the one verified feed and local display
rows are checked against its genuine absolute-position hashes.

The shared content bridge fences late grant/RPC/token results even when a distinct
reader keeps the underlying runtime alive. Its epoch tracker wipes plaintext before
rejecting a late closed-reader result. Cancellation checks do not require the native
combined-signal API; a simulated absent API exercises the existing token entry.
These are local ownership/compatibility rules, not new signed bytes or authority.

This is opt-in public assembly, not Web/mobile activation. Browser tests use real
custody, IDB, mailbox crypto, signed RPC and paused native work; policy-Layer tests
establish composition and scope, not a new policy-storage implementation. Renderer
regressions exercise precise leases, incomplete-close retry, ordinary admission and
retained-key wakeup. These checks do not establish mobile-device, native-plugin,
power-loss or native-process termination qualification. [#2075](https://github.com/LodyAI/Lody/issues/2075)
tracks owned close plus bridge adoption; product composition must retain any
unfinished native owner before enabling mobile custody.
