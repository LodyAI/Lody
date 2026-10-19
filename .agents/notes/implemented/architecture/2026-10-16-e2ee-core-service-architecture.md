# E2EE core as ports, workflows and adapters

Status: implemented
Translation: current

[中文](2026-10-16-e2ee-core-service-architecture.zh.md)

## Abstract

`@lody/e2ee-core` exposed about twenty factory functions that each opened their
own SQLite files, took raw callbacks for remote systems and kept a private
rollback pin. That made the library hard to reuse outside Lody, hard to read,
and impossible to run against another backend or store. The core is now split
into ports (Effect services the application provides), workflows (services the
library implements as Layers on those ports only) and adapters (SQLite and Loro
Streams implementations), behind six role-based entries plus an unstable
`./internal`. Protocol bytes, file formats' guarantees and workflow behavior
are preserved; every existing behavioral test still runs against the real
Layers, and the main remaining limit is that only Node SQLite and Loro Streams
adapters exist.

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
4. **Adapters** (`./adapters/node-sqlite`, `./adapters/loro-streams`). Each
   store mutation verifies its own write and the file's workspace/device
   binding inside its transaction, so a tampered or ignored write rolls back,
   as the old stores did.
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

## Verification

Core: 20 test files (356 tests), including composition and public-docs tests, on real
SQLite, Ed25519, HPKE and child processes. `test/composition.test.ts` delivers a key between two devices
through `E2eeWorkflows`. `test/public-docs.test.ts` requires JSDoc on every
public export, namespace export and service member and that `docs/surface*.md`
match the exports. Contract-completion tests also check typed source failure
without pin advancement and completed query/acknowledgement spans. The follow-up
passed core typecheck, type-aware lint (existing warnings), Effect lint (advisory
warnings) and root format. Full root `check`, public-boundary and docs checks
could not finish cleanly in the isolated worktree: other package dependencies
and ACP submodules are absent. No E2EE documentation errors were reported.

The assembled five-layer stack also passes core typecheck, Lab typecheck, all
401 core tests and all 201 Lab tests. The workspace maps refresh failures into
`LedgerViewSourceError`, and the Lab's relocated component harness preserves the
same port contract. Workspace/recovery service members are covered by the stricter
documentation check. These local synthetic results are not production acceptance.

Limits: Lab and desktop consumers are migrated in the later PRs of the stack;
no IndexedDB or mobile storage adapters exist; production composition is still
not wired. The package is still private at version `0.0.0`; reusable service
boundaries do not mean that a standalone SDK or backend has been published.
