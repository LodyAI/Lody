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

Every Scope includes workspace/genesis, machine, owner membership instance and
`generation` (hex32 initial machine-admission signing key of the uninterrupted
replacement chain). A verified initial admission plus exact atomic replacements
qualifies generation through `verifyMachineSharingGeneration`. Pass its opaque
`machineGeneration` to all core policy operations. The original ledger records and
snapshot/retained formats do not change. Unknown checkpoint prefixes need genuine
ledger-history qualification, never a server-chosen root or counter.

Control operations require device credentials/current ledger eligibility. New
commits require the machine owner's active personal device and
`admitMachineSharingFrame`. Recheck current generation and eligibility inside the
same internal mutation as full scope/status/revision/digest CAS, request-intent
deduplication and original/head insertion. Action-level verification alone cannot
fence a removal between verification and commit. Every new generation starts at
revision 1/null parent. Within it, increment by one and reference the complete
original ciphertext's SHA-256 digest; the frame limit remains 262287 bytes.

Removal permanently closes the old generation and captures its cleanup cutoff.
Readmission, even for the same member and machineId, has a new initial key and
resource: require fresh owner intent, private defaults and a new revision-one
chain, without old policy bytes or pins. Old pending requests must conflict with
the current ledger generation; no old head can be reactivated. Atomic same-member
replacement preserves generation/policy. Cleanup and request receipts are scoped
to the old generation, so delayed deletion cannot touch the new one. Exact old
committed retries may return their retained receipt or removed after purge, never
reinsert ciphertext. Keep lightweight original-intent digests to reject altered
requestId reuse. Purged version reads may return null; old readHead retains its
removed high water as storage evidence only, never a client verification pin.

`latestForMember` remains an independent account-authenticated query for current
workspace members, returning ciphertext/untrusted metadata only. It accepts no
device credential and cannot renew execution freshness; machines use their own
credential-authenticated latest-head action.

Local cache age is strictly less than 15 minutes from before latest-read I/O,
intersected with ledger/request deadlines. A server withholding newer versions
can hide unknown withdrawal indefinitely despite those reads. Signatures and
local chains provide no globally-latest proof; trusting complete latest delivery
remains pending owner confirmation. No network or execution integration is enabled
by this contract. See the [pending Spec increment](../../../specs/e2ee-foundations.md#machine-sharing-policy-pending-approval-increment).
