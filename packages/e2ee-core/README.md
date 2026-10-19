# @lody/e2ee-core — reading guide

[中文导读](README.zh.md)

End-to-end encryption for collaborative documents synced over an untrusted
backend. A **signed membership ledger** decides who belongs to a workspace and
which **epoch key** is current. Devices deliver that key to each other through
an untrusted mailbox. Documents are sealed with keys derived from it. The
backend stores ciphertext and relays messages, but cannot read content, forge
membership or roll a device back.

The library is not tied to Lody or to Convex. Every remote system, platform
capability and local store is a service you provide, so it fits any app that
syncs through Loro / Durable Streams or a comparable append-only log.

## Availability

The service architecture is reusable, but this is currently a private workspace
package (`private: true`, version `0.0.0`), not a published SDK. Production E2EE
composition is not enabled. Node SQLite and Loro Streams adapters are provided;
other runtimes need their own storage and platform adapters. Backend ports and
`/host` define what another backend must implement; they do not deploy a server.

## Start here

| You want to… | Read |
| --- | --- |
| understand the protocol and its guarantees | [whitepaper](../../specs/e2ee/whitepaper.md) ([中文](../../specs/e2ee/whitepaper.zh.md)) |
| integrate E2EE into an app | [services](docs/services.md) → [workflows](docs/workflows.md) (start from `E2eeWorkspace`) → [surface](docs/surface.md) |
| implement a backend (mailbox, staging, ledger log) | [backend guide](docs/backend-guide.md) and `@lody/e2ee-core/host` |
| implement key custody on a platform | [`DeviceIdentity`, `KeyProtector`, `CandidateProtector`](docs/services.md#platform-ports) |
| store state somewhere other than SQLite | [local storage ports](docs/services.md#local-storage-ports) |
| review or change this package | [architecture](docs/architecture.md), then [AGENTS.md](AGENTS.md) |
| see everything working with real faults | the E2EE Lab, `packages/e2ee-lab` (later in this PR stack) |

## Entries

| Import | Contents | Stability |
| --- | --- | --- |
| `@lody/e2ee-core` | workflows (`KeyReceiver`, `EpochPublisher`, …), their errors and results, `E2eeWorkflows` | public |
| `@lody/e2ee-core/services` | ports to implement or provide, port errors | public |
| `@lody/e2ee-core/protocol` | the pure protocol: bytes, CBOR, ledger verification, envelopes, content format | public |
| `@lody/e2ee-core/host` | what a backend must enforce, staging wire schemas (no Node APIs) | public |
| `@lody/e2ee-core/adapters/node-sqlite` | SQLite implementation of every local store, reference mailbox backend | public |
| `@lody/e2ee-core/adapters/loro-streams` | `LedgerLog` / `LedgerFeedSource` over a Loro / Durable Streams control stream | public |
| `@lody/e2ee-core/internal` | internals for this repository's tests and the Lab | **unstable** |

## A composition in one screen

```ts
import { Effect, Layer } from 'effect';
import { E2eeWorkflows, KeyReceiver, LedgerFeed } from '@lody/e2ee-core';
import { DeviceIdentity, KeyProtector, CandidateProtector, WorkspaceScope } from '@lody/e2ee-core/services';
import { sqliteLocalStores } from '@lody/e2ee-core/adapters/node-sqlite';
import { streamsLedgerLog } from '@lody/e2ee-core/adapters/loro-streams';

const app = E2eeWorkflows.pipe(
  Layer.provideMerge(LedgerFeed.viewSource),
  Layer.provideMerge(LedgerFeed.layer({ origin: { kind: 'genesis', record }, expected, budget })),
  Layer.provideMerge(
    Layer.mergeAll(
      sqliteLocalStores({ directory, mode: 'create-or-open' }),
      streamsLedgerLog({ stream, checkpoint, budget }),
      myKeyMailbox,        // your KeyMailbox adapter
      myStagingStore,      // your EpochStagingStore adapter
      myPublicationSource, // EpochPublicationSource
      KeyProtector.layerFromPromises(nativeInstalledKeyProtection),
      CandidateProtector.layerFromPromises(nativeCandidateProtection),
    )
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(WorkspaceScope, { genesis }),
      Layer.succeed(DeviceIdentity, { signer, encryptionKeyPair }),
    )
  )
);

// Finite steps; the application decides when to run them.
const onStartup = Effect.gen(function* () {
  const receiver = yield* KeyReceiver;
  yield* receiver.resume();
  yield* receiver.fetchAndInstall();
  yield* receiver.flushReports();
});
```

## Code map

```text
src/
  index.ts, workflows.ts   "."        workflows and composition
  services/                "/services" ports
  protocol/                "/protocol" pure protocol barrel
  host/                    "/host"     backend contract
  adapters/node-sqlite/    SQLite stores, reference mailbox backend
  adapters/loro-streams/   Streams ledger log and feed source
  internal/                implementation: foundation, crypto, ledger, keys, submission
test/                      behavior suites (real SQLite, real crypto, child processes)
scripts/check-public-docs.ts  JSDoc and surface documentation check
docs/                      architecture, services, workflows, surface, backend guide
```

Module notes for protocol internals: [ledger](src/internal/ledger/README.md),
[keys](src/internal/keys/README.md),
[Streams adapter](src/adapters/loro-streams/README.md),
[documents](src/internal/content/README.md).

## Documents to read

- **Protocol**: [whitepaper](../../specs/e2ee/whitepaper.md), the
  [E2EE spec index](../../specs/e2ee/README.md),
  [foundations spec](../../specs/e2ee-foundations.md),
  [atomic removal](../../specs/e2ee/atomic-removal.md),
  [publisher key recoverability](../../specs/e2ee/publisher-key-recoverability.md).
- **Decisions**: [current decisions](../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md),
  [open contracts](../../.agents/notes/proposed/architecture/2026-10-15-e2ee-open-contracts.md),
  [service architecture](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.md).
- **This package**: [architecture](docs/architecture.md),
  [services](docs/services.md), [workflows](docs/workflows.md),
  [surface](docs/surface.md), [backend guide](docs/backend-guide.md).

## Questions

**Do I need Convex or Lody Cloud?** No. You need a ledger log with conditional
append (Loro / Durable Streams works out of the box), a key mailbox and a
staging store. Implement them on any stack: [backend guide](docs/backend-guide.md).

**What can the server see?** Metadata only: identifiers, epochs, sizes and
timing. Never keys or plaintext. See the whitepaper's threat model.

**How does a new device get the key?** It is admitted by a signed ledger
record. Existing devices see it in the ledger and `KeyDistributor` sends it an
envelope through the mailbox. The new device runs `KeyReceiver.fetchAndInstall`.

**How do I encrypt a document?** For Loro over Streams, use
`streamsDocumentBinding` as the document's payload protection. Otherwise use
`sealDocument` / `openDocument`. See [workflows](docs/workflows.md#documents).

**How do I rotate the key or remove a member?** `EpochPublisher.publish()` /
`publishRemoving(membershipId)`. Removal and rotation are one signed record, so
there is no window where a removed member can read new content.

**What if a device crashes mid-operation?** Every workflow saves its exact
originals before any network step. Call `resume` / `flush…` after restart; the
same bytes are retried and nothing is re-signed.

**How is rollback prevented?** `VerifiedLedger` pins the newest verified
checkpoint durably and refuses any view that does not contain it.

**Where are keys stored?** Only `InstalledEpochKeys` touches key material.
Blobs are protected by your `KeyProtector` and stored by `InstalledKeyStore`;
callers receive opaque keys they must dispose.

**What if all devices are lost?** A recovery device whose keys live in an
encrypted vault (recovery file or passkey) admits a new personal device:
`E2eeWorkspace.restoreFromRecovery`. See [workflows](docs/workflows.md#recovery).

**Is there a background loop?** No. Every operation is a finite page that
returns a `next` hint; the application schedules calls.

**What errors can a call return?** Method signatures name their typed errors;
JSDoc explains the behavior and ownership contract. Each workflow exports its
full union (`ReceiveFailure`, …). Branch on the documented tag, `reason` or
protocol `code`. Some errors retain an opaque adapter `cause` for local
diagnostics; never display or export it raw.

**How do I test my integration?** Use the SQLite adapters, the reference
mailbox (`makeSqliteKeyMailbox` + `referenceKeyMailbox`) and the suites in
`test/` as examples. The Lab reproduces protocol attacks end to end.

## Checks

```sh
pnpm --filter @lody/e2ee-core typecheck
pnpm --filter @lody/e2ee-core test        # includes the public-docs test
pnpm --filter @lody/e2ee-core check:docs  # exports, namespaces and service members
```

Tests use fixed synthetic vectors, real SQLite, real Ed25519/HPKE and child
processes; the `test/generate-*.py` scripts regenerate vectors (optional).

[Non-gating benchmarks](bench/README.md) emit environment-qualified JSON.
