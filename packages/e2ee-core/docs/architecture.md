# Architecture

[中文](architecture.zh.md) · [Reading guide](../README.md)

## Layers

```text
            application (Lody desktop, the Lab, your app)
                │ calls workflows, provides ports
┌───────────────▼───────────────────────────────────────────────┐
│ @lody/e2ee-core            workflows (Context.Service + Layer) │
│   VerifiedLedger  LedgerFeed  LedgerSubmission                 │
│   InstalledEpochKeys  InstalledEpochHistory                    │
│   KeyReceiver  KeyRepair  KeyDistributor  EpochPublisher       │
├───────────────┬───────────────────────────────────────────────┤
│ /protocol     │ /services                                      │
│ pure protocol │ ports: backend, platform, application, storage │
│ (no I/O)      │ (Context.Service tags + typed errors)          │
└───────────────┴───────────────▲───────────────────────────────┘
                                │ implemented by
     /adapters/node-sqlite   /adapters/loro-streams   your own adapters
     /host  (backend contract: rules + wire schemas, for servers)
```

Dependency rules, enforced by imports:

- `internal/foundation`, `internal/crypto`, `internal/ledger` (except the two
  stateful workflows) and `internal/keys/{envelope,history,staging,reports}`
  are the **protocol**: synchronous `Result` functions, plus Effect functions
  only where signing, HPKE or cooperative verification is asynchronous. They
  never import services or adapters.
- **Workflows** (`internal/**` files that define a `Context.Service` with a
  `layer`) depend on protocol code and `services/` tags only, never on an
  adapter, Node API or SQLite.
- **Adapters** implement ports. They may use Node APIs and protocol helpers,
  but never decide authority.
- **`/host`** is platform-neutral. A non-Node backend runtime can import it.

## Code map

```text
src/
  index.ts            "."            workflows, errors, results
  workflows.ts                       E2eeWorkflows composition
  services/           "./services"   ports and port errors
  protocol/           "./protocol"   protocol barrel
  host/               "./host"       backend contract
  adapters/
    node-sqlite/      "./adapters/node-sqlite"
    loro-streams/     "./adapters/loro-streams"
  internal/           "./internal"   unstable re-exports for tests and the Lab
    foundation/       bytes, CBOR, identifiers, signatures, content format
    crypto/           content AEAD, epoch HPKE
    ledger/           records, replay, policy, snapshots, admission, feed pages
                      + VerifiedLedger, LedgerFeed
    keys/             envelope, history, staging, reports, delivery
                      + InstalledEpochKeys, KeyReceiver, KeyRepair,
                        KeyDistributor, EpochPublisher
    submission/       LedgerSubmission
    content/          document keys, sealed documents, Streams content codec
    recovery/         recovery identity, vault-v1, workspace recovery + RecoveryVaults
    workspace/        E2eeWorkspace facade, WorkspaceControl, key round, invitations
    lifecycle.ts      admission gate, close guard, own()
```

## Lifecycle

Workflows are **finite** and **scoped**:

- Nothing runs in the background. The application decides when to call
  `resume`, `flushReports`, `reconcileCurrentEpoch` and the rest (at startup,
  on ledger change, on reconnect). Each call processes one bounded page and
  returns a `next` cursor hint.
- Each workflow Layer lives in the application's `Scope`. When the Scope
  closes, the workflow refuses new calls. Two closing behaviors exist, chosen
  per workflow:
  - **Admission gate** (`InstalledEpochKeys`, `InstalledEpochHistory`,
    `EpochPublisher`): close waits for admitted calls, because they borrow
    native protection that must settle before buffers are wiped and resources
    released.
  - **Close guard** (`KeyReceiver`, `KeyRepair`, `KeyDistributor`): close does
    not wait. In-flight work fails at its next guard, so closing never waits on
    a remote call.
- Each workflow captures its ports once at construction (`own()`), so mutating
  a provided object later cannot swap a capability under in-flight work.
- Native calls are uninterruptible. Interrupting a caller waits until the call
  settles and its plaintext is wiped.
- The library never calls `Effect.run*`. Applications run programs at their
  entry points.

## Trust and durability

- **One rollback guard.** `VerifiedLedger.current()` is the only way a
  workflow obtains ledger state. It rejects views that are not genuine, belong
  to another workspace, do not extend what this process saw, or do not contain
  the durable `LedgerPinStore` checkpoint. A genuine newer view is remembered
  in memory even when persisting the pin fails.
- **Originals before network.** Every durable workflow saves its exact
  original bytes (signed record, envelope, report, repair id) before the first
  network step, and retries those bytes. Nothing is re-signed or re-encrypted
  on retry.
- **Results stay until acknowledged.** Ended tasks remain listed by `results`
  until `acknowledge`. Nothing is consumed implicitly.
- **Hints are not authority.** Mailbox statuses, revisions, cursors and server
  lists only schedule work. Only a genuine ledger change ends a task as
  `Obsolete` or `Revoked`.
- **Local tampering** (editing the SQLite files, OS compromise) is outside the
  threat model. Stores verify their own writes and bindings to catch bugs and
  partial failures, not a hostile OS.

## Effect conventions

- **Services**: `Context.Service` classes. Workflows expose `static layer`.
  Ports are plain tags plus JSDoc contracts.
- **Errors**: workflow errors generally use `Schema.TaggedError` with a `reason`
  literal
  (`ReceiveError`, `LocalStoreError`, …). Protocol errors from older modules
  (`LedgerError`, `ContentError`, `ValidationError`, `LedgerFeedError`,
  `EpochStagingError`, `EpochKeyError`) keep `Data.TaggedError` with `code`,
  because their codes are part of tested protocol behavior. Each workflow
  declares its complete failure union (`ReceiveFailure`,
  `DistributionFailure`, `EpochPublishFailure`, `SubmissionFailure`). No
  core ledger/key workflow method returns `unknown` errors. Application view
  sources use `LedgerViewSourceError`; protocol failures retain their typed unions.
- **Functions**: public ledger/key workflow methods (including queries and
  acknowledgements) are `Effect.fn('@lody/e2ee-core/<Service>.<method>')`,
  so they appear as spans when the application installs a tracer. Port adapters
  may choose their own tracing boundaries. The library installs no exporter
  and adds no key, plaintext or argument attributes to spans. Internal
  helpers and protocol functions use `Effect.fnUntraced`. Pure checks return
  `Result` and are lifted with `Effect.fromResult`. A function that only wraps
  `Effect.gen` is written as `Effect.fnUntraced` instead.
- **Resources**: `Effect.acquireUseRelease` for every epoch key copy
  (`disposeEpochKey`) and plaintext buffer (`fill(0)`).

## Rationale

Decisions behind this structure: the owning note
[2026-10-16 e2ee-core service architecture](../../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md).
Earlier protocol and durability decisions:
[current decisions](../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md).

## Browser curves and ownership

The opt-in browser adapter supplies independent JS Ed25519/X25519 capabilities
without changing ledger v1 or the epoch HPKE suite/domain/AAD. Ed25519 uses the
already pinned noble backend. HPKE uses the upstream pinned JS X25519 KEM;
sealing does not require native X25519, while native recipient keys retain their
existing path. Without WASM, only explicit native Ed25519 non-support (or absent
SubtleCrypto) selects the fixed strict JS verifier; a false signature or other
backend failure never selects another acceptance rule.

Raw private fields from the upstream JS key object must not escape behind the
`CryptoKeyPair` type. Core keeps that object in a private WeakMap and exposes
frozen metadata handles. A borrowed HPKE lease keeps the owner's secret alive
through actual crypto settlement, including interruption. Close fences new leases
and signing before waiting for the bounded set of admitted operations, then wipes
both secrets. Cloned, mixed and closed handles fail; native keys remain native.
These handles do not provide native non-extractability or protection against trusted
application code. The platform still owns persistent KEK protection and admission.

The `@hpke/common@1.10.1` patch removes only Node <=18 dynamic builtin loading
from both distributions. All supported Node versions provide global WebCrypto;
missing browser WebCrypto fails instead of importing Node. Algorithms are unchanged.
`test:browser-crypto` builds for Safari 16.4 with no external imports and executes
in Chromium/WebKit with native curves and WASM disabled. Its separate CI job
installs both engines; normal unit tests need no browser. This is desktop engine
compatibility evidence, not minimum-OS real-device or custody acceptance.

## IndexedDB ownership

The opt-in IDB adapter owns one scoped connection and short native transactions,
not a second verification cache. The account/workspace/genesis database survives
identity replacement; local pairing slots add the device/installation binding.
Retained origins are opaque until the existing ledger workflow qualifies them.
Strict durability is requested, while completion is the observable commit boundary.
Close fences new calls before draining the actual transaction promises, and late
open callbacks cannot revive a closed owner. No transaction waits on crypto or
network. The [service guide](services.md#browser-ledger-and-original-stores)
explains routing, CAS and original retention; the owning architecture note records
the rejected per-device database reset.

## Browser persistent protection

The optional browser-custody Layer provides a scope-wide finite writer, persistent
nonextractable AES-GCM protection and read-only identity originals. The host enters
exclusion before allocation and releases it before network waits; closing drains
actual admitted calls, including native work that outlives cancellation. Short IDB
callbacks retain intent/nonce before crypto and exact ciphertext after it. Two
stable database layouts separate ledger/originals from installation, KEK metadata,
key and snapshot journals without erasing either on replacement. These are local
concurrency/recovery evidence, never another ledger or approval cache.
See [custody and installation](services.md#browser-custody-and-installation).
