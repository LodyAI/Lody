# Ledger records and replay

Ledger records, replay, snapshots and admission are pure protocol code exported
through `@lody/e2ee-core/protocol`: synchronous Result functions plus Effect
forms for cooperative verification. `VerifiedLedger` and `LedgerFeed` are the
stateful workflows in this directory; see [workflows](../../../docs/workflows.md).

```text
caller-pinned genesis + expected (head, length) + raw records
  bounded canonical parsing
  predecessor check + [P07](../../../README.md)-a strict signature verification
  Org/member/kind-bound join or possession proof
  permission from preceding state
  private state transition
  expected endpoint check
  opaque verified view
```

`decodeRecord` returns **unverified** inspection data. `hashRecordBytes` and the
three signing-byte helpers compute bytes, never authority. `verifyLedger` audits
from the caller's independently pinned genesis. `extendLedger` accepts only an
actual view returned by this module, clones its private state, and publishes a new
view only after the entire suffix and checkpoint pass. Failure reports the record
position where available and leaves the earlier view unchanged. Inspections are
detached maps of frozen rows with copy-owning P07-a byte wrappers. Reflected
constructors, structural clones and caller-injected verifiers cannot mint views.

The checkpoint is an independently expected **total** record count and head.
It detects missing suffixes as well as chain breaks and unexpected endpoints. A
server's self-reported endpoint is not an independent freshness proof. This module
does not discover the latest global state, bind product workspace IDs, or resolve
forks; callers own those trust and freshness checks. There is no arbitrary-state
starting point in the record/replay entry. The explicit snapshot entry below has
separate qualification and provenance.

`exportVerifiedState` and `restoreVerifiedState` let a party resume from **its
own** earlier verified view. Export returns the canonical state bytes (the
comparison-note state plus the view's verification origin), position and the
comparison-note `stateDigest`. Restore decodes: it checks structure and the
caller's stored genesis/length/head, but neither signatures nor curve points,
because the bytes come from the caller's own storage. When the caller also passes
the stored `stateDigest`, restore recomputes it from the bytes (one SHA-256, no
second encoding) after they decode and fails with `state-digest-mismatch` on a
difference; this catches corrupted or mismatched rows, not a writer who can
replace both. The digest covers position and state but not the trailing
verification byte. The restored view
extends exactly like the exported one; the next record must name its head. It
keeps every device's historical author but reports original epoch publication
records as unavailable. Never restore another party's bytes;
that is what endorsed snapshots are for. Retained bytes are current-format only
(envelope version 4); any other version fails with `unknown-version`, and the
caller rebuilds them by one full replay.

Preserved candidate v1 arrays/domains: genesis, admit Member, set role, admit own
device, revoke own device, transfer Owner, publish epoch. Owner/Admin personal
devices may invite and rotate; only Owner personal devices change roles or transfer
Owner. Recovery devices only admit their own personal devices. Revocation affects
only its target, records never create an approval ancestry tree, and Owner retains
a personal/recovery path. Retired signing/encryption keys, member IDs, closed join
requests and epoch commitments remain replay facts. Legacy tag 2 removal is rejected:
independent removal uses capability-gated tag 10, while [P12](../../../README.md) retains the tag8 transition.
Tag 9 declares capabilities: Owner/Admin personal devices list strictly ascending
nonzero u32 codes, monotonically. Capability 1 enables tag10 `[10, membershipId]`: Owner may remove any non-Owner; Admin may remove only Member/Guest. Removal drops all current devices, retains retired identities and authors, preserves the epoch and sets advisory rotationRequired. Unknown genuine declarations end verification with `upgrade-required`. Declared capabilities are monotonic and preserved by snapshot/retained state v4. The v1 arrays and domains above become permanent at the
first production creation; see the
[frozen vector](../../../test/ledger-v1-vector.json) and
[format compatibility](../../../../../specs/e2ee-foundations.md#format-compatibility).

Join `expiresAt` remains a signed nullable field; pure historical replay does not
consult a current wall clock. Online request expiry/admission belongs to a future
host boundary. A valid 72-byte epoch history packet remains opaque; this module
verifies its signed publication and order, not its decryption or key commitment
preimage. `epochHistoryPacket(view, epoch)` returns that signed fact with an owned
packet copy; epoch zero uses an empty previous-key packet. Unknown/future epochs
fail rather than fabricate a key. Decryption belongs to the key workflow.

The explicit snapshot entry's `historicalContentIdentity(view, device)` is the
single historical-author query. Every source keeps every device ever admitted,
so it returns the admission-bound user/member identity even after revocation,
also from an endorsed snapshot or retained state. Unknown/fake views fail.
`contentPermissions(view, device)` separates current host write admission from
honest new-content sealing: active non-Guest personal/machine devices may write,
Recovery never writes. Pending manual rotation is advisory: administrators should
update keys without blocking active writers or new seals.
Permission is relative to the caller-selected verified endpoint; freshness and
scope binding remain caller obligations. Every query requires the module-created
view, not an inspection object. Snapshot endorsement/import uses the separate entry below; delivery is a key workflow. Product integration remains separate.

[Extraction and reproduced defects](../../../../../.agents/notes/implemented/architecture/2026-10-11-e2ee-ledger-records.md)
and [source fingerprints](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-core/src/ledger/provenance.json). Run package `typecheck` and `test`;
`test/ledger/replay.test.ts` signs fixed synthetic seeds with native Node Ed25519,
independent of the production verifier, and exercises the public ledger subentry.

[Historical-author trust decisions](../../../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#trust-and-authority).

`requireLedgerContinuation(previous, next)` verifies that two real full views share
this exact authenticated prefix using private hashes. It rejects rollback, alternate
forks and fabricated views; it does not discover globally latest state. `VerifiedLedger` uses this relation as its rollback guard.

## Ordinary-record signing

`prepareLedgerRecord` prepares canonical ordinary body CBOR against a
real verified view before any signing. Permission and nested possession proofs use
the same replay checks. `signLedgerRecord` borrows a DeviceSigner and verifies
its output through fixed signature verification and complete ledger extension.
Only registered proposals are accepted; signing bytes and caller inputs are copies.

Execute signing once, then persist and submit the returned original bytes through
`LedgerSubmission`. Re-running signing requests a new signature; the
proposal is not a durable command. The parent is fixed, and a competing suffix
requires CAS conflict handling, never automatic re-signing or rebasing. This entry
does not create genesis, discover freshness, generate/store private keys, or own
transport. Legacy tag2 remains rejected; use RemoveMember/tag10 after DeclareCapabilities([1]).

[Signing durability decisions](../../../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#durability-and-lifecycle)
and [source/destination fingerprints](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-core/src/ledger/signing-provenance.json).

## Authenticated permission snapshots

The snapshot functions use snapshot body version 4
(the compact state; any other version is `unknown-version`) and the snapshot/v1,
head-attest/v1 and snapshot-digest/v4 domains. Caller-pinned
external qualification must include genesis, exact head/count, endorser key,
membership, Owner/Admin role and personal kind. Missing role facts never default
from signed self-claims or journal data. These are externally confirmed facts; the
library checks consistency, not their acquisition or global freshness. An optional
complete-state digest pin supplements, never replaces, that role qualification.

`snapshotTrustFromView` instead derives same-position qualification from a genuine
view into a private token. The snapshot must exactly match its actual complete
state; cloned tokens fail. This path returns that prior view and preserves its audit
provenance. `authenticateLedgerSnapshotEvidence` is the fallback when only identity/
position pins exist: its result is signature evidence with role claims, not a view.

External bootstrap views expose verification=`endorsed-snapshot` and historyStart.
They carry a genuine starting head and verified later hashes using an explicit
offset, without invented pre-snapshot history. `extendLedger` checks every suffix
record and its previous hash/count. Continuation cannot skip an unknown prefix.
Full audit remains `verifyLedger`; signatures/endorsement are not that audit.

`historicalContentIdentity` answers from the device and membership history that
full replay, snapshot import and retained restore all carry; an unknown device fails.

`signLedgerSnapshot` borrows DeviceSigner, signs/verifies the canonical body and
head attestation, then checks a real continuation and current management eligibility.
Its producer metadata must not be copied into receiver trust automatically.

`compareNotes` returns raw same/conflict/lag results without independent confirmation.
`confirmIndependentComparison` requires a caller-obtained exact tuple from manual
or authenticated-channel confirmation, including actual peer identity. Key lists
and relabeled server notes are insufficient. This confirmation grants no permissions
and upgrades no audit provenance. No new comparison wire/signature domain is added.

[Snapshot trust decisions](../../../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.md#trust-and-authority)
· [Snapshot fingerprints](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-core/src/ledger/snapshot-provenance.json).

## Admission consent and ordinary intent

[Admission](ADMISSION.md) (`admission.ts`) adds fixed-verified borrowed signing of joining consent/device possession proofs, genuine-view ordinary command preparation and v1 genesis production from an already retained initial epoch key. Account identity, expiry enforcement, durable key custody, publication and atomic-removal/rotation orchestration use the explicit local candidate owner, not the ordinary command union.

## Local feed

`LedgerFeed` keeps the original v1 frames, the opaque source offset and the
verified view in a `LedgerFeedStore`, starting from the genesis record or an
independently qualified snapshot. It rejects repeated records and rollback
pages, requires a separately trusted endpoint on every open and re-verifies all
stored records then. SQL rows never select ledger authority; local OS or
database tampering is outside the whitepaper's threat model. Behavior:
[workflows](../../../docs/workflows.md#ledgerfeed).

## Atomic removal

Current tag8 is `[8, membershipId, nextEpoch, commitment, previousEpochKey]`.
It removes a non-Owner member and all its current devices while installing the
next commitment/history packet in one transition. Only the pre-state Owner's
personal device may sign it. Current snapshot v4 contains the resulting
members/devices, epoch, history packets and used identities; the same-point state
digest is identical after full replay or independently qualified snapshot replay.
Historical authors are retained when their history is available. No second snapshot
format, old-tag2 reader or dual emission is added. Independent tag10 removal is the MVP action; later tag7 publication is optional manual work.
