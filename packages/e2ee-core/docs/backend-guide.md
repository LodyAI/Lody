# Backend guide

[中文](backend-guide.zh.md) · [Reading guide](../README.md) · [Services](services.md)

You need three remote capabilities. Any stack works (HTTP, Convex, Durable
Objects, a Postgres service, …). The library never trusts these servers with
keys or authority: everything they return is re-verified by clients. The rules
below exist so a server cannot be used to spam, replay or hide delivery state,
and so honest servers behave the same.

| Capability | Client port | Needs a ledger view on the server? | Contract helpers |
| --- | --- | --- | --- |
| Ledger log | `LedgerLog`, `LedgerFeedSource` | no (content-agnostic) | — |
| Key mailbox | `KeyMailbox` | **yes**, to check eligibility | `@lody/e2ee-core/host` |
| Epoch staging | `EpochStagingStore` | no | `@lody/e2ee-core/host` |

`@lody/e2ee-core/host` is platform-neutral (no Node APIs) and runs inside a
backend. A complete runnable reference of the mailbox rules is
`makeSqliteKeyMailbox` in `@lody/e2ee-core/adapters/node-sqlite`
(`src/adapters/node-sqlite/reference-mailbox-host.ts`).

**Authentication.** Every mailbox and staging request is made by an
authenticated device. The server derives the *principal* (the device's signing
key) from the session, never from the request body.

## 1. Ledger log

An append-only sequence of opaque records per workspace. The server needs no
knowledge of the format.

- **Read**: return records in order from genesis, plus a resumable offset.
  Paging is fine.
- **Conditional append**: append one record only if the current tail equals the
  expected position (offset or record count). Never append unconditionally. An
  exact duplicate must be idempotent or refused, never stored twice.
- **Durability**: an acknowledged append must survive restart.

Loro / Durable Streams provides this directly: the adapters in
`@lody/e2ee-core/adapters/loro-streams` use a control stream with offset CAS
and u32be-framed records.

## 2. Key mailbox

The server keeps, per workspace, epoch and recipient: stored envelopes, a
**repair revision**, the installation reports, the rejected frame digests and
the repair request ids. To decide eligibility it needs the workspace's
current verified ledger view, for example by running `LedgerFeed` on the
server.

**`put(id, frame)`** — store an envelope authored by the principal.

1. `envelopeRouting(frame)` must give `sender = principal` and this workspace.
2. `authenticateEpochEnvelope(view, context, frame)` must pass at the current
   view: the sender is an eligible current device (Recovery devices may not
   send) and the recipient is a current device.
3. `id` is the 16-byte delivery id (hex). An existing `(epoch, sender, id)`
   with a different digest is refused (`replay`). The same bytes again are a
   no-op.
4. Keep at most 16 live (non-rejected) envelopes per sender, recipient and
   epoch. Refuse the 17th distinct frame.

**`read(id)`** — return the frame the principal stored under `id` for the
current epoch, or nothing.

**`fetch(epoch, cursor, limit ≤ 100)`** — only for the current epoch, only
envelopes addressed to the principal and not rejected, ordered by
`(sender, digest)`. The cursor is the last `sender:digest`; return `next` only
if more rows exist. The whole page must come from one consistent read.

**`status(slot)`** — `Ineligible` if the recipient is not a current device,
`Obsolete` if the epoch is not current, `InstallationReported` if a report
exists for the current revision, `EnvelopeStored` if a live envelope exists,
otherwise `NeedsEnvelope`; plus the repair revision.

**`report(report, publication?)`** — `authenticateInstallationReport` against
the current view, with the principal as recipient. For a local publication,
`checkLocalPublication` must accept the supplied record. The report's revision
must equal the slot's current revision, and an envelope source must still be
stored and not rejected. Record the revision as reported.

**`repair(slot, id, rejected?)`** — only for the principal's own slot in the
current epoch. Per `id`, idempotent with the same `rejected`, refused
(`replay`) otherwise. A `rejected` digest must name a stored envelope; mark it
rejected (excluded from fetch but kept). Increment the revision and clear its
reported mark.

Map refusals to `BackendError` `unauthorized` or `conflict`. Transient
failures map to `unavailable`.

## 3. Epoch staging

Immutable storage for a rotation's complete envelope group, keyed by
`(genesis, epoch, commitment, recordHash)`. Use the DTOs `EpochStagedGroupDto` /
`EpochStagedGroupKeyDto` and their `decode…`/`encode…` helpers.

- **Stage**: verify the device-possession proof, a signature by the principal
  over `epochStagingRequestSigningBytes({ operation: 'stage', workspaceId, group })`,
  where `workspaceId` is your own workspace identifier. Then
  `checkEpochStageRequest({ genesis, principal, group })` must pass. Store the
  group if absent. A retry must match every byte, otherwise refuse.
- **Read**: return the stored group or nothing. Anyone in the workspace may
  read; groups are ciphertext.
- **Delete**: only the record's signing device, with a signed `delete` request
  naming an `occupied` epoch and commitment that differs from the group's.
  Check ownership and delete atomically. The client has already verified that
  the occupied commitment is genuine.

The staging server never reads or interprets the ledger. A stored group is
inert until the ledger contains its exact record.

## 4. Document content

A sync server that stores document frames should admit only frames a current
writer sealed. It does not decrypt them; readers still verify the AEAD.

- `admitDocument` before storing a sealed frame: the authenticated device has
  current write permission, and the frame's epoch is published and not later
  than the current one. Earlier frames of an active writer stay valid after a
  rotation.
- `admitStreamsUpdateBatch` for a `@loro-dev/streams-crdt` 0.17 batch: framing,
  header 3 and every frame's signature and permission. The batch is accepted or
  rejected as a whole, and the unchanged original bytes are forwarded.
- `admitStreamsSnapshot` for a snapshot (header 4): additionally, a
  `StreamsRecordBoundaryPort` must prove the signed continuation offset is a
  record boundary no later than the head. String ordering is not proof.

A single-host reference of an exactly-once snapshot publication journal is
`makeSqliteSnapshotPublication` in `@lody/e2ee-core/adapters/node-sqlite`.

## 5. Recovery vault

Opaque storage of encrypted vault entries and one index per vault, using the
`RecoveryVault…` DTOs in `@lody/e2ee-core/host`.

- `putImmutable`: store an entry once; a retry must carry identical bytes.
- `readEntry` / `readIndex`: return the stored ciphertext or nothing.
- `compareAndSwapIndex`: replace the index only if it still has the
  `expected` revision and digest (or none), and every `referencedEntryIds`
  exists, in one transaction; return `Committed` or `Conflict`.
- `deleteUnreferenced`: delete an entry only if the index still equals
  `expectedIndex` and does not reference it.

Login controls who may retrieve a vault. The backend never receives the
unlock secret, master key or recovery private key.

## What a server learns

Who talks to whom and when, workspace and device identifiers, epoch numbers,
sizes and timing. It never sees epoch keys, document keys or plaintext, and it
cannot produce a valid record, envelope or report. See the whitepaper's threat
model: [specs/e2ee/whitepaper.md](../../../specs/e2ee/whitepaper.md).

## Testing your backend

Run the library's own workflows against it. Build the client Layers with your
adapters (`E2eeWorkflows` plus your ports) and drive receive, distribute,
repair and publish. The core test suites in `test/keys/` show the
fault cases worth reproducing: lost acknowledgements, retries after restart,
rejected frames and revocation during a request.
