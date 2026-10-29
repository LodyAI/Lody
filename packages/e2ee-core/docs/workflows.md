# Workflows

[中文](workflows.zh.md) · [Reading guide](../README.md) · [Services](services.md)

How each workflow behaves, in the order an application meets them. Each
section lists the ports it requires; `E2eeWorkflows` wires them all together.

## VerifiedLedger

_Requires `WorkspaceScope`, `LedgerViewSource`, `LedgerPinStore`._

The single rollback and fork guard. `current()` fetches a view and accepts it
only if all of the following hold:

1. It is genuine (built by this library's verifier).
2. It belongs to the workspace.
3. It extends the newest view observed in this process.
4. It contains the durably pinned checkpoint.

It then advances the pin. A view at the same checkpoint performs no write. If
writing the pin fails, the newer view is still remembered in memory, so an
older view stays refused. `ensureCurrent(view)` repeats the in-process check
for a view obtained earlier. Freshness is relative to this device's own
history; global freshness still depends on the log not hiding records.

## LedgerFeed

_Requires `WorkspaceScope`, `LedgerFeedStore`. Options: origin, expected
checkpoint, budget._

The local verified copy of the ledger. The origin is either the genesis record
or an endorsed snapshot whose `trust` is supplied again on every open. Opening
re-verifies every stored byte up to the independently supplied `expected`
checkpoint. `accept(page, checkpoint)` verifies a `LedgerFeedSource` page,
rejecting duplicate, older or rewound pages, and appends it atomically. The
in-memory view changes only after the write commits. Budgets fail closed and
never delete committed history. `LedgerFeed.viewSource` turns the feed into a
`LedgerViewSource`.

## LedgerSubmission

_Requires `WorkspaceScope`, `SubmissionJournal`, `LedgerLog`._

Exactly-once submission of one signed record per workspace:

```text
submit(record):  journal.prepare(original) → appendCas at parent → read back
                 → Committed (these bytes are in the log) | Conflict (another
                   record took the parent) | unconfirmed (retry with resume)
resume():        continue the saved original; never re-sign
acknowledge(r):  release a finished result
```

A record signed by a device that was revoked meanwhile ends as `Conflict`
without re-signing. The journal keeps the newest observed log checkpoint and
refuses a log that rolled back.

## InstalledEpochKeys and InstalledEpochHistory

_Requires `WorkspaceScope`, `DeviceIdentity`, `VerifiedLedger`, `KeyProtector`,
`InstalledKeyStore`._

The only owner of local key material. `saveAndReload(epoch, key)` works in
this order:

1. Check the key against the ledger commitment and seal it with
   `KeyProtector`. The sealed body is
   `purpose ‖ genesis ‖ device ‖ epoch ‖ commitment ‖ key`.
2. Verify the new blob opens.
3. Store it; the first stored blob wins.
4. Succeed only after the _stored_ blob reopens and matches.

An unreadable stored blob may be replaced only by a new blob that already
opened and matched. `read(epoch)` returns a fresh opaque key that the caller
disposes. Both re-check, after every asynchronous step, that this device is
still an active member.

`InstalledEpochHistory.read(epoch)` returns an installed key. Only when the key
is genuinely missing does it validate the whole chain of signed history
packets from the newest installed key, save the recovered older keys and
return the one requested. Corrupt, permission and storage failures are never
"recovered". This restores installed history only; it is not a vault.

## KeyReceiver

_Requires `WorkspaceScope`, `DeviceIdentity`, `VerifiedLedger`,
`InstalledEpochKeys`, `KeyMailbox`, `ReceiveJournal`._

Installs keys this device receives and reports them.

```text
receive(sender, frame)        verify signature, sender eligibility and frame
  → task saved (Install)      original frame persisted before any network step
  → HPKE open + commitment    every pending install repeats these checks
  → InstalledEpochKeys.saveAndReload
  → sign report, queue it (Report)
flushReports()                send queued original reports (Reported)
resume()                      finish interrupted installs after a restart
fetchAndInstall(cursor)       one mailbox page → receive each envelope
receiveStagedGroup(group)     install from a committed rotation's staged group
recordLocalInstallation(rec)  report this device's own publication
results() / acknowledge(id)   ended tasks until acknowledged
```

- A report is a signed claim of installation, not proof of custody.
- `fetchAndInstall` copies and validates the whole page before writing
  anything. Unreadable routing and sender/workspace/epoch/recipient hint mismatches
  are skipped for this fetch, without journaling or rejecting their frame digests;
  they remain retryable after the server returns honest metadata. Later rows still
  run every normal verification. `processed` counts scanned rows, not installed keys.
  An actual install failure returns no `next` cursor.
  `MailboxInstallError` names the failing frame (sender, `frameDigest`) so the
  application can decide on a repair.
- Only a genuine ledger change ends a task as `Obsolete` or `Revoked`.

## KeyRepair

_Requires `WorkspaceScope`, `DeviceIdentity`, `VerifiedLedger`, `KeyMailbox`,
`RepairJournal`._

Asks senders for a fresh envelope when this device cannot install the current
key. `enqueue(id, rejectedDigest?)` durably binds a caller-chosen stable id to
the current epoch and the optional rejected frame before anything is sent.
Reusing the id with different fields fails `replay`. `flush` sends pending
requests (the mailbox deduplicates by id) and finishes them as `Repaired`,
`Obsolete` or `Revoked`. `Repaired` records a successful request, never an
installation.

## KeyDistributor

_Requires the receiver's ports plus `KeyReceiver`, `DeliveryOutbox`,
`DistributionJournal`, `EpochPublicationSource`._

Makes sure every current device can obtain the current key.

```text
reconcileCurrentEpoch()     recipients from the verified ledger (never the server)
                            one task per (recipient, mailbox revision)
resumePendingDeliveries()   outbox original, or encrypt once and save it
                            put + exact read-back → Observed
results() / acknowledge()   finished tasks until acknowledged
```

The first ciphertext per recipient and epoch is kept forever and re-sent on
every retry. A revision only triggers a retry, never a new ciphertext. Recovery
devices receive keys but never send them. `Observed` means the mailbox returned
the exact bytes, not that the recipient installed them. A full journal fails new
tasks with `task-limit`; acknowledging frees capacity without deleting history.

## EpochPublisher

_Requires `WorkspaceScope`, `DeviceIdentity`, `VerifiedLedger`,
`InstalledEpochKeys`, `CandidateProtector`, `EpochStagingStore`,
`LedgerSubmission`, `EpochCandidateStore`._

Rotates the epoch key (`publish`), or removes a member and rotates in one
signed record (`publishRemoving`, owner only).

```text
generate key → seal history packet → sign record → envelope per device
→ save candidate (protected by CandidateProtector) and read it back
→ stage the complete envelope group, read it back exactly
→ LedgerSubmission.submit
→ Committed: install via InstalledEpochKeys | Conflict: discard candidate key
```

`resume` finishes the same candidate after a crash, without signing again. Once the
matching publication original is in `LedgerSubmission`, resume skips staging/readback
and reconciles that exact CAS, even if staging is unavailable. Candidate-only attempts
still stage and compare readback before their first submission. A missing
candidate may reconcile its exact retained submission only after genuine commitment or
conflict proof; it cannot authorize CAS at an unchanged parent. Normal receiver paths
install committed keys independently. Existing installed keys permit terminal acknowledgement
without reopening the candidate blob. Unpublished keys never bypass CandidateProtector.
`cleanupStaged` deletes this device's group once a different commitment
occupies its epoch. `acknowledge` releases the finished result. Only owner or
admin personal devices may rotate. A manager who bypasses staging and appends
directly can withhold the key. That is a known availability limitation, not a
confidentiality break.

Independent MVP member removal uses `WorkspaceControl.execute({ _tag: "RemoveMember", membershipId })` after an authorized `DeclareCapabilities` command for code 1 has committed. It revokes every device, preserves the epoch and advises manual rotation. `EpochPublisher.publishRemoving` retains its separate atomic tag8 contract.

## WorkspaceControl and the key round

`WorkspaceControl` (_requires `DeviceIdentity`, `LedgerSubmission`,
`LedgerSync`_) signs ordinary commands (admit member or device, set role,
revoke, transfer owner) against a freshly refreshed view and submits each once.
A pending or unacknowledged submission blocks new signing. A result is
acknowledged only after the local feed contains the checkpoint it observed.

`runWorkspaceKeyRound(limit, cursors)` (_requires `KeyRepair`, `KeyReceiver`,
`KeyDistributor`_) is one finite maintenance round: flush repairs, resume
installs, fetch one mailbox page, send reports, reconcile and send deliveries,
send reports again, list results. Each queue keeps its own cursor hint.


Receive (including committed staging) and distribution run as separate finite phases.
A failed receive cannot prevent reconciliation/delivery. `WorkspaceKeyRoundFailure`
reports both `receive` and `distribution` Results, a separate post-send report Result,
and retry `cursors`; successful phases advance independently and failed phases keep
their input hints. Successful rounds retain the existing result fields.

Mailbox fetch skips non-current senders without installing or journaling their keys.
A strict signature bound to exact routing plus a genuine historical identity absent
from current membership yields `retiredDigests`; the round queues digest-bound repair.
Unknown senders only set `refreshRequired`, never reject their digest. Hosts must
refresh their verified ledger and retry; the workspace facade already refreshes its
ledger source, and desktop maintenance uses the existing verified history-ingest path
at most once per call. This refresh occurs after independent distribution.

## E2eeWorkspace

The application facade over everything above. A `WorkspacePlatform` supplies,
per workspace, a Layer of ports (`WorkspacePorts`), the native document state
for each resource, and an optional recovery configuration. `E2eeWorkspace.open()`
builds `E2eeWorkflows` and `WorkspaceControl` in the workspace Scope and
returns one handle: ledger commands, rotation and removal, the key round,
documents (`document(resource, model)` returns the Streams binding plus
native state), results and acknowledgements, recovery.

Calls on the handle are serialized where they change state. `close()` stops
platform work, waits active operations, then releases workflows and stores.
`E2eeWorkspace.restoreFromRecovery` runs the recovery device's restore, then
opens the new personal device's workspace with the recovered keys installed.

## Recovery

`RecoveryVaults` (_requires `RecoveryVaultStore`, `RecoveryVaultLocalStore`_)
creates and unlocks vault-v1 vaults: a recovery file kept offline, or a
passkey PRF. `makeWorkspaceRecovery` keeps one workspace's recovery entry
current (setup, test, replace, skip) and performs a restore. A recovery device
admits a new personal device, then that device installs every epoch key. The
scheme is specified in the whitepaper's backup and recovery section and
[recovery vault](../../../specs/e2ee/recovery-vault.md).

## Documents

Document content uses content v0: a signed header, XChaCha20-Poly1305 under a
document key derived from the epoch key, and purpose-bound AAD.

- **Loro / streams-crdt**: `streamsDocumentBinding({ resource, model, writeEpoch })`
  (`@lody/e2ee-core/adapters/loro-streams`) is the payload-protection binding
  for a `@loro-dev/streams-crdt` document. It seals updates (header 3) and
  snapshots (header 4, with the continuation offset inside the signed header),
  and opens what it reads. It takes its signer, ledger view and keys from
  `DeviceIdentity`, `VerifiedLedger` and `InstalledEpochHistory`.
- **Other transports**: `sealDocument`, `openDocument` and
  `authenticateDocument` (`/protocol`) take a document key, a signer and a
  verified-view lookup. A new seal requires current write permission and a verified published epoch
  no later than current, checked before encryption and again after signing.
  Pending manual rotation does not stop retained-key sends. Each
  run encrypts anew, so a retry must resend the returned bytes.
- Reading authenticates the historical author before decrypting. A revoked
  author's old content still opens and is attributed to its original member,
  also after a ledger snapshot, but this grants no current write right. This applies
  to both Streams snapshots and updates: historical ledger admission, signature,
  readable epoch and AEAD remain mandatory; current author validity is not a read gate.

## Delivery (inside the distributor)

`deliverEpochEnvelope` (internal) performs one put and read-back round. Saved
outbox bytes take precedence over preparing new ones. An `unavailable` backend
leaves the delivery `Pending` with the original unchanged; other backend
failures propagate.

### Retained feed origin

A retained origin contains this caller's full exported v2 state and the source
`offset` immediately after it. Restore preserves full-history versus endorsed-snapshot
provenance. Corruption, unknown versions or another genesis return `retained-cache-invalid`:
rebuild that optional cache from independently verified originals. A cache longer than
its pin is also invalid. Equal lengths require equal heads. If the pin is ahead, provide
`LedgerFeedSource`; opening verifies the suffix and proves the hash at the pin before
persisting any catch-up. A missing or conflicting proof is `local-evidence-conflict`,
never permission to reset the pin.

After at least 64 additional records, call `rebase()` with the same `VerifiedLedger`
used by the runtime. It first advances the pin, then CAS-replaces the origin and removes
covered feed rows in one store transaction. Save the returned origin for next open.
Keep original history separately if the UI needs it. An interrupted compaction must
rebuild from originals or read a suffix to prove the existing pin; never lower it.

`InstalledEpochKeys.check(epoch)` verifies a stored key's current eligibility and
commitment, disposing its temporary material instead of returning a secret to a status reader.

## Device credential binding

`deviceCredentialBindingBytes`, `signDeviceCredentialBinding` and
`verifyDeviceCredentialBinding` bind a new device's access-credential hash to an
approver's active pairing session. The bytes are UTF-8
`lody-e2ee/device-credential-binding/v1` followed by a zero byte, then the pinned
genesis (32 bytes), pairing session ID (16), new Ed25519 public key (32), and
SHA-256 of the raw credential (32). The caller supplies the trusted session and
genesis; a valid signature neither admits a device nor replaces possession proof.
Verification uses the existing strict Ed25519 policy. The first creator device
does not need this proof. `test/foundation.test.ts` retains a fixed signing vector
and checks substitution of every context field.

Desktop error classification, independent paging and terminal acknowledgement are described in [key maintenance availability](../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-key-maintenance-availability.md). `MailboxInstallError.cryptographicRejection` marks only a deterministic rejection at envelope verification; local writes, report signing and unknown native errors never authorize rejecting an envelope.
