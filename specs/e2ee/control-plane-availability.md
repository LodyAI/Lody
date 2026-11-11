# Control-plane availability: abandoning unusable epochs and ledger write quotas

Status: draft
Translation: current

[中文](control-plane-availability.zh.md)

## Scenario

**A stranded epoch.** An Admin's device publishes a new epoch, but nobody receives the new key: the device has a bug, is lost after publishing, or the Admin deliberately commits the record without sending envelopes. The ledger has advanced to the new epoch while every other device holds only the old key. Once the 15-minute old-epoch write window ends, the whole workspace cannot write. An honest rotation must read the current epoch key to build the history packet, so nobody can rotate again; removing that Admin does not recover it. The [removal contract](atomic-removal.md#owners-and-limits) records publisher key withholding as a known limitation but gives no way out.

**A flooded ledger.** Any member, including a Guest, can admit and revoke their own devices without limit. Continuous appends make an administrator's removal record lose CAS repeatedly; clients cap total ledger length, and once the cap is reached every client refuses to continue.

**A low-order public key blocks rotation.** After a member registers a low-order X25519 encryption public key, rotation fails while sealing an envelope to it and the whole rotation aborts.

What these share: one non-Owner member, using records the ledger accepts, can stop the workspace's control plane.

## Decision

**A non-Owner member cannot unilaterally make a workspace permanently unusable.** The Owner always has a way out that does not depend on the current epoch key; self-service records have a quota; public keys that would break rotation are rejected at admission.

### 1. The Owner abandons unusable epochs

Add capability 2 and operation tag 11 `[11, nextEpoch, commitment, baseEpoch, baseKeyPacket]`:

- Only an active personal device of the Owner may sign it. Admins, machines and recovery devices are rejected.
- `baseEpoch` is lower than the current epoch and is the latest epoch whose key the signer actually holds; `nextEpoch` is the current epoch plus one. Epochs after `baseEpoch` and before `nextEpoch` are marked **abandoned**.
- `baseKeyPacket` encrypts the `baseEpoch` key under the new epoch key, authenticated against genesis, `nextEpoch` and `baseEpoch`. The history key chain therefore connects the new epoch directly back to `baseEpoch`, skipping abandoned epochs.
- Publication follows [stage first, commit once](atomic-removal.md#stage-first-commit-once): persist the candidate key, the original record and the envelopes for all active devices, stage and read them back, and only then commit.
- The record clears the rotation reminder. Commitments must not repeat and the epoch must not overflow.

The ledger cannot verify that nobody holds a given epoch key; the Owner decides. Before submitting, the client shows the evidence it can see: this device still lacks the key after requesting repair, the number of installation reports for that epoch, and the time since it was published. It states the consequence and requires explicit confirmation.

### 2. A quota for self-service records

The host rate-limits each membership instance's self-service records (admitting or revoking its own devices, registering a recovery device), with 10 per hour and 30 per day as initial values. Over the limit it returns a recognisable error and the client shows when to retry. Owner/Admin management records (removal, role changes, rotation, abandoning epochs, capability declarations) do not count. Rate limits depend on time and cannot be expressed as ledger rules, so they are a host responsibility; the host is already trusted for availability.

The client's ledger length budget is computed over the suffix after its verified starting point, not over the total length since genesis. A long-lived workspace does not stop as a whole because of its cumulative record count.

### 3. Reject low-order encryption public keys at admission

Ledger rules reject low-order or non-canonically encoded X25519 public keys when admitting a device or a member. This changes ledger v1 validation rules and must land before v1 is frozen for production.

## Guarantees

- When nobody holds the current epoch key, the Owner restores the ability to rotate with one record. Other members do not rejoin, and history at `baseEpoch` and earlier stays readable to all active devices and to devices that join later.
- Abandoning widens nobody's permissions and withdraws no key. Installed keys are append-only and are not deleted.
- After seeing the record, honest clients stop sealing new content under abandoned epochs.
- Within the quota, a single non-Owner member can grow the ledger by at most 30 records a day and cannot starve an administrator's submission.

## Not guaranteed

- **Content under abandoned epochs.** If some device did receive an abandoned epoch's key and wrote content with it, only devices holding that key can read it; devices that join later and recovery devices cannot. The Owner must see this before confirming.
- **A malicious Owner.** The Owner can abandon a healthy epoch. The Owner can already remove every member; this is outside the threat model.
- **An offline Owner.** After an epoch is stranded and before the Owner acts, writes still stop when the 15-minute window ends.
- **A malicious host.** The host enforces the quota; a host that does not, or that writes junk records itself, falls under the existing trust in the host for availability.

## Trade-offs considered

The owner agreed to the following directions in the review conversation on 2026-11-11; this Spec remains a draft until this revision's PR is approved.

1. **The old-epoch write window is not extended while an epoch is stranded.** Extending it would avoid an outage while the Owner is offline, but if the withheld rotation was meant to follow a member removal, the removed member could read that much more new content. It stays at 15 minutes.
2. **Admins can still rotate.** Restricting rotation to the Owner would remove the stranded-epoch case at its source, but then nobody could rotate after a removal while the Owner is offline. Admin rotation stays, with the abandon operation as the backstop.
3. **The initial quota is 10 per hour and 30 per day.** A web client that clears site data must pair again, creating a new device each time; the values are host configuration, adjustable from real usage, and not ledger rules.
4. **No bridging of abandoned epochs in the first version.** Letting a device that holds an abandoned key connect it back into the history chain later would add another record type and verification path.

## Evidence

- Rotation rules check only epoch plus one and a non-repeating commitment: the `publishEpoch` branch in `packages/e2ee-core/src/internal/ledger/policy.ts`.
- An honest rotation reads the current epoch key first: `packages/e2ee-core/src/internal/keys/publisher.ts`.
- History packet encryption and binding: `packages/e2ee-core/src/internal/keys/history.ts`.
- Unlimited self-service device admission and revocation: the `admitDevice` and `revokeDevice` branches in `policy.ts`.
- Ledger length budget: `packages/e2ee-client/src/ledger.ts` (`maxRecords: 16384`) and `packages/e2ee-core/src/internal/ledger/ledger-feed.ts`.
- X25519 public keys reject only all-zero: `packages/e2ee-core/src/internal/foundation/bytes.ts`.
- Capability declarations and extension rules: [permission ledger §4.5](permission-ledger.zh.md).

These are conclusions from reading code; no tests were run, and whether the host already rate-limits was not verified.
