# Services: what you implement and what you choose

[中文](services.zh.md) · [Reading guide](../README.md)

The library splits into two kinds of services.

- **Ports** are the `Context.Service` tags in `@lody/e2ee-core/services`.
  The library *requires* them and *you* provide them, either from your own code
  or from a ready-made adapter.
- **Workflows** are the `Context.Service` tags in `@lody/e2ee-core` (for example
  `KeyReceiver`). The library *implements* them as Layers; you call them. Each is
  replaceable in tests, but you should not reimplement one in production: they
  carry the protocol's security checks.

Every value a port returns is **untrusted**. Workflows re-verify all of it
against the signed ledger, so a faulty or malicious port can delay progress or
lose availability. It cannot grant access, inject keys, or roll a device back to
an older ledger.

## Port catalogue

| Port | Kind | You provide it by | Used by |
| --- | --- | --- | --- |
| [`LedgerLog`](#ledgerlog) | Backend | your ledger server, or `streamsLedgerLog` (Loro Streams) | `LedgerSubmission` |
| [`LedgerFeedSource`](#ledgerfeedsource) | Backend | your ledger server, or `streamsLedgerFeedSource` | your sync loop → `LedgerFeed.accept` |
| [`KeyMailbox`](#keymailbox) | Backend | your mailbox server client (HTTP, Convex, …); `referenceKeyMailbox` for tests | `KeyReceiver`, `KeyRepair`, `KeyDistributor` |
| [`EpochStagingStore`](#epochstagingstore) | Backend | your staging server client | `EpochPublisher` |
| [`DeviceIdentity`](#deviceidentity) | Platform | your device key custody (`nativeDeviceSigner` helps) | all key workflows |
| [`KeyProtector`](#keyprotector--candidateprotector) | Platform | OS key protection; `KeyProtector.fromPromises` wraps native calls | `InstalledEpochKeys` |
| [`CandidateProtector`](#keyprotector--candidateprotector) | Platform | protection for unpublished rotation keys | `EpochPublisher` |
| [`RecoveryVaultStore`](#recoveryvaultstore) | Backend | your vault storage client | `RecoveryVaults` |
| [`WorkspaceScope`](#workspacescope) | Application | `Layer.succeed(WorkspaceScope, { genesis })` | everything |
| [`LedgerViewSource`](#ledgerviewsource) | Application | `LedgerFeed.viewSource`, or your own verified view | `VerifiedLedger` |
| [`EpochPublicationSource`](#epochpublicationsource) | Application | lookup of the current epoch's publication record | `KeyDistributor` |
| [`LedgerSync`](#ledgersync) | Application | your feed sync (`LedgerFeedSource` pages → `LedgerFeed.accept`, checkpoint chosen independently) | `WorkspaceControl`, `E2eeWorkspace` |
| `RecoveryVaultLocalStore` | Local storage | a local key/value store with compare-and-swap | `RecoveryVaults` |
| `LedgerPinStore` | Local storage | `sqliteLedgerPinStore` | `VerifiedLedger` |
| `LedgerFeedStore` | Local storage | `sqliteLedgerFeedStore` | `LedgerFeed` |
| `InstalledKeyStore` | Local storage | `sqliteInstalledKeyStore` | `InstalledEpochKeys` |
| `ReceiveJournal` | Local storage | `sqliteReceiveJournal` | `KeyReceiver` |
| `RepairJournal` | Local storage | `sqliteRepairJournal` | `KeyRepair` |
| `DistributionJournal` | Local storage | `sqliteDistributionJournal` | `KeyDistributor` |
| `DeliveryOutbox` | Local storage | `sqliteDeliveryOutbox` | `KeyDistributor` |
| `EpochCandidateStore` | Local storage | `sqliteEpochCandidateStore` | `EpochPublisher` |
| `SubmissionJournal` | Local storage | `sqliteSubmissionJournal` | `LedgerSubmission` |

`sqliteLocalStores({ directory, mode })` provides every local storage port at
once, one file per store. Use it unless your platform has no Node SQLite.

## Backend ports

Backend rules (what a *server* must enforce) and wire schemas are in
[backend-guide.md](backend-guide.md) and `@lody/e2ee-core/host`. This section
describes the *client* contract.

### LedgerLog

The append-only log holding the workspace's signed records: the only remote
write the protocol relies on for authority.

- `read(anchor)` returns every record from genesis and the checkpoint the log
  claims. The library re-verifies all of it.
- `appendCas(anchor, expected, record)` appends **only if** the log still ends
  at `expected`. It must never append unconditionally. Appending the same bytes
  twice must be idempotent or rejected.
- Failures are `LedgerLogError`. After any failure the library reads back to
  learn the outcome, so a lost response is safe.

### LedgerFeedSource

Paged reads of the same log for keeping a local feed current:
`readAfter(offset)` returns an untrusted `LedgerReadPage`. Offsets are opaque
tokens; `'-1'` starts at genesis. `LedgerFeed.accept(page, checkpoint)` verifies
each page before anything is stored.

### KeyMailbox

Relays epoch-key envelopes to devices, plus installation reports and repair
requests. The adapter **binds every call to the authenticated device**; request
bodies never choose the sender or recipient.

| Method | Meaning |
| --- | --- |
| `status(slot)` | delivery state (`NeedsEnvelope`, `EnvelopeStored`, …) and repair revision of a slot; a scheduling hint |
| `fetch(epoch, cursor, limit)` | page of envelopes addressed to this device |
| `put(id, frame)` / `read(id)` | store / read back an envelope this device authored |
| `report(report, publication?)` | upload a signed installation report |
| `repair(slot, id, rejected?)` | ask senders for a fresh envelope; optionally reject one frame |

Failures are `BackendError` with `reason` `unavailable` (retry later),
`unauthorized`, `invalid-response` or `conflict`. Only `unavailable` is treated
as transient by delivery; the other reasons are reported as failures.

### EpochStagingStore

Stores the complete envelope group of a rotation **before** the rotation record
is appended, so the new key stays retrievable even if the publisher disappears
right after committing. Groups are immutable at their key, only the record's
signer may stage or delete them, and they are inert until the ledger contains
their exact record.

### RecoveryVaultStore

Stores encrypted recovery vaults: immutable entries plus an index replaced by
compare-and-swap. It never receives the unlock secret, the vault master key or
a private recovery key. Wire schemas are in `@lody/e2ee-core/host`; see the
[backend guide](backend-guide.md#5-recovery-vault).

## Platform ports

### DeviceIdentity

`{ signer, encryptionKeyPair }` for this device. `signer.sign` must return a
valid Ed25519 signature; the library verifies every signature it receives
before use, so a wrong signer fails instead of producing bad records. Private
keys stay in your custody. `nativeDeviceSigner(publicKey, cryptoKey)` builds a
signer from a WebCrypto Ed25519 key.

### KeyProtector / CandidateProtector

`protect(body)` and `unprotect(blob)` authenticate and encrypt a whole body;
the library binds purpose, workspace, device, epoch and commitment *inside* the
body, so the protector needs no knowledge of the format.

- Calls must not complete before the native work settles. The library wipes
  buffers when a call returns. `KeyProtector.fromPromises(native)` makes each
  Promise call uninterruptible for you.
- `KeyProtector` protects **installed** keys, which the ledger already
  committed. `CandidateProtector` protects **unpublished** rotation keys. They
  are separate on purpose: what may protect a not-yet-published key is a
  separate decision. You may back both with one native mechanism, but say so
  explicitly in your composition.
- A protector can always read what it protects. It is a trust boundary of the
  host platform, not isolation from a compromised host.
- Desktop: `desktopE2eePorts(custody, device)` in
  `apps/electron/src/main/e2ee-custody.mts` provides both protectors and
  `DeviceIdentity` from an OS-wrapped key (Electron `safeStorage`).

## Application ports

### WorkspaceScope

`{ genesis }`: the workspace this composition serves. Every store and workflow
binds itself to it; a store created for another workspace is refused.

### LedgerViewSource

`current()` returns the newest *genuine* ledger view the application holds.
Normally `LedgerFeed.viewSource`. `VerifiedLedger` checks that each view is
library-verified, belongs to the workspace, extends what this device saw
before, and contains the durable pin. Expected feed, storage or transport
failures must be wrapped in
`LedgerViewSourceError({ cause })`; `LedgerFeed.viewSource` does this for you.
`VerifiedLedger` returns `reason: 'source'` without advancing the durable pin.
Defects and interruption remain in Effect's Cause channel; do not convert them
into availability errors or display raw causes to users.

### EpochPublicationSource

`current(view)` returns the original bytes of the record that published the
current epoch (genesis at epoch 0), or `null`. The distributor uses it only to
record this device's own publication, and verifies it first. Typically a
backwards scan of your local feed.

### LedgerSync

`refresh()` selects the target checkpoint independently and reads the local
feed up to it; `current()` returns the stored state. `WorkspaceControl` and
`E2eeWorkspace` use it, and the workspace derives `LedgerViewSource` from it.

## Local storage ports

Every local store has the same shape of contract (the full method list is in
each port's JSDoc):

- Each method is **one atomic step**. A mutation verifies its own write inside
  its transaction and also checks that the file is still bound to this
  workspace and device. Any difference rolls back and fails with `corrupt`.
- Errors are `LocalStoreError` with `reason`: `storage` (I/O; retry may help),
  `corrupt`, `closed` (owner Scope closed), `conflict` (a precondition no
  longer holds), `capacity` (a bounded store is full) or `missing`.
- Stores never decide anything. Rows are re-validated by the workflow that
  reads them, and no stored byte grants authority.
- Journals keep originals and results until the application acknowledges
  them. Nothing is deleted automatically.

To store elsewhere (IndexedDB, a mobile database, …), implement the ports
against that storage with the same atomicity. The SQLite adapters in
`src/adapters/node-sqlite` are the reference.

## Internal pieces you can swap

Some building blocks are not ports, but are designed to be replaced in
specific situations:

| Piece | Swap it when | How |
| --- | --- | --- |
| `LedgerFeed` | you already keep a verified ledger | provide your own `LedgerViewSource` instead of `LedgerFeed.viewSource` |
| `E2eeWorkflows` | you need only some workflows | compose the individual `X.layer`s you need |
| any workflow | unit-testing a consumer | `Layer.succeed(KeyReceiver, KeyReceiver.of({...}))` |
| `referenceKeyMailbox` | tests and the Lab | bind a `makeSqliteKeyMailbox` host to a device in-process |

Everything under `@lody/e2ee-core/internal` (admission gates, sealers, test
helpers) is **internal-only**: unstable, for this repository's tests and the
Lab.

`LedgerFeedStore.rebase` CAS-checks the entire expected tail, replaces the origin
and its count, removes covered records, and writes/read-checks the new tail in
one transaction. A stale tail returns conflict without mutation.
