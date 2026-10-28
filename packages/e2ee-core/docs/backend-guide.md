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
key) from the session or from a device access credential bound when the device
was admitted, never from the request body.

**Where signatures are verified.** Signature checks have two tiers. The required
tier is what every host must enforce; the optional tier adds server-side
signature verification with the `@lody/e2ee-core/host` helpers. Lody Cloud
implements only the required tier: it verifies signatures when accepting ledger
records, and for mailbox and staging requests it applies the structural checks
below. Recipients always verify signatures and key commitments themselves, so
skipping the optional tier lets a device misbehave only in its own slots and its
own envelopes, within the per-sender limits.

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
2. At the current view, the sender is an eligible current device (Recovery
   devices may not send), the recipient is a current device and the epoch is
   current. Optional tier: `authenticateEpochEnvelope(view, context, frame)`
   also verifies the envelope signature.
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

**`report(report, publication?)`** — the decoded report names the principal as
recipient at the current view. Optional tier: `authenticateInstallationReport`,
and `checkLocalPublication` for a local publication. The report's revision
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

- **Stage**: the principal must be the record's signing device named by the
  group. Optional tier: verify the principal's signature over
  `epochStagingRequestSigningBytes({ operation: 'stage', workspaceId, group })`,
  where `workspaceId` is your own workspace identifier, and run
  `checkEpochStageRequest({ genesis, principal, group })`. Store the group if
  absent. A retry must match every byte, otherwise refuse. Clients verify a
  staged group with `authenticateEpochStagedGroup` before using it.
- **Read**: return the stored group or nothing. Anyone in the workspace may
  read; groups are ciphertext.
- **Delete**: only the record's signing device (the principal), naming an
  `occupied` epoch and commitment that differs from the group's. Optional tier:
  require the request signature as well.
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

## Machine sharing policy storage (unconnected contract)

The optional `cloud-api` machine-sharing DTOs address one workspace/genesis,
machine and owner membership instance. Control operations require device credentials
and current ledger eligibility. Commits require the machine owner's active personal
device and `admitMachineSharingFrame` before storing an opaque original. This verifies
the exact resource and fixed business signature/AAD domain without decryption; it is
required sharing admission, separate from the optional mailbox signature tier above.

`latestForMember` is a separate account-authenticated query for current workspace
members. It returns only ciphertext and untrusted routing/head metadata. It never
returns permission conclusions, accepts device credentials, or renews execution
freshness. Machines retain their own credential-authenticated `readHead` path.

Atomically insert immutable originals and CAS the full head identity: scope, status,
revision and digest. First signed revision is 1/null parent; subsequent revisions
increment by one and reference the complete original frame's SHA-256 digest. The
maximum frame is 262287 bytes. Retain lightweight request intent digests for exact
retry checks. Exact retries return the original receipt while retained, or a removed
barrier after purge; changed intent under the same requestId fails. Confirmed
conflicts must not auto-rebase.

Sharing withdrawal is a new signed complete policy. Actual machine removal first
marks its head removed, retaining its last committed revision/digest even when
ciphertext is purged. A never-written resource uses removed revision 0/digest null.
Explicit new owner intent CASes that removed head to n+1 with its digest as parent
(0/null to 1/null). Comparing status prevents old pending active-head requests
from reactivating a removed resource. Atomic same-member machine replacement keeps
the policy active and does not run removal cleanup. Retain the removal cutoff and
minimal request receipts even after reactivation; cleanup deletes only ciphertext
at/below that cutoff, never newer commits. Purged version/request reads return a
removed barrier; an exact commit retry of a purged request returns removed and
must never restore its original frame.

A server tombstone is a storage/CAS barrier, not a signed policy or verified client
pin. Missing originals leave a history gap that the core currently rejects; A3 must
provide explicit reviewed gap recovery before claiming execution after such cleanup.
Never silently seed a verified pin from the server tombstone. Latest-head delivery
still supports only bounded freshness. No server or transport is enabled here; see
the [pending Spec increment](../../../specs/e2ee-foundations.md#machine-sharing-policy-pending-approval-increment).
