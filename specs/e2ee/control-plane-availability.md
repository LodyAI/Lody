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
- `baseEpoch` is lower than the current epoch and is the latest non-abandoned epoch whose key the signer actually holds; `nextEpoch` is the current epoch plus one. Epochs after `baseEpoch` and before `nextEpoch` are marked **abandoned**.
- `baseKeyPacket` encrypts the `baseEpoch` key under the new epoch key, authenticated against genesis, `nextEpoch` and `baseEpoch`. Its AAD is `lody-e2ee/epoch-abandon-history/v1\0 || genesis32 || u32be(nextEpoch) || u32be(baseEpoch)`. The history key chain therefore connects the new epoch directly back to `baseEpoch`, skipping abandoned epochs.
- Publication follows [stage first, commit once](atomic-removal.md#stage-first-commit-once): persist the candidate key, the original record and the envelopes for all active devices, stage and read them back, and only then commit.
- The record clears the rotation reminder. Commitments must not repeat and the epoch must not overflow.

The ledger cannot verify that nobody holds a given epoch key; the Owner decides. Before submitting, the client shows the evidence it can see: this device still lacks the key after requesting repair, the number of installation reports for that epoch, and the time since it was published. It states the consequence and requires explicit confirmation.

### 2. A quota for self-service records

The host rate-limits each membership instance's self-service records (admitting or revoking its own devices, registering a recovery device), with 10 per hour and 30 per day as initial values. Over the limit it returns a recognisable error and the client shows when to retry. Owner/Admin management records (removal, role changes, rotation, abandoning epochs, capability declarations) do not count. Rate limits depend on time and cannot be expressed as ledger rules, so they are a host responsibility; the host is already trusted for availability.

The client's ledger length budget is computed over the suffix after its verified starting point, not over the total length since genesis. A long-lived workspace does not stop as a whole because of its cumulative record count.

Capability 2 selects option A ([S-04] / [A-05]): each membership instance may have at most 32 active devices and 128 lifetime device admissions, including the founding/joining device and every device kind. Atomic machine replacement consumes a lifetime slot but no additional active slot. Over-limit admission fails with `device-quota-exceeded`; revocation, removal, role and key operations remain available. Guests may admit only personal devices; the existing recovery-device path for restoring a personal device remains. Earlier records replay under their earlier rules. Declaration preserves existing devices, while an already over-limit instance cannot admit more. Rejoining requires a new membership instance and fresh identity/device keys.

Revoked devices are retained. These limits bound one membership instance's device growth, not workspace-wide lifetime capacity. Repeated re-admissions, multiple members and epoch/history growth still require host capacity management. Current snapshots encode devices as fixed-width byte tables: a table is not limited to 4096 CBOR container elements. The total snapshot budget remains 2 MiB; another protocol's 4096-element limit is not a snapshot device limit.

The host uses rolling one-hour/24-hour windows, initially 10/30. After validating candidate permissions, signature and parent, it durably reserves quota before dispatching CAS. Unknown outcomes retain the reservation, while retries of the exact original are charged once. All devices of a membership instance share the quota, which survives host restart. The reference host returns HTTP 429 with `self-service-rate-limited` and an absolute millisecond `retryAt`.

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

This revision selects the following options. This task relays another agent's conclusion and provides no link to human approval of this revision, so approval status remains draft; implementation and approval are recorded separately.

1. **The old-epoch write window is not extended while an epoch is stranded.** Extending it would avoid an outage while the Owner is offline, but if the withheld rotation was meant to follow a member removal, the removed member could read that much more new content. It stays at 15 minutes.
2. **Admins can still rotate.** Restricting rotation to the Owner would remove the stranded-epoch case at its source, but then nobody could rotate after a removal while the Owner is offline. Admin rotation stays, with the abandon operation as the backstop.
3. **The initial quota is 10 per hour and 30 per day.** A web client that clears site data must pair again, creating a new device each time; the values are host configuration, adjustable from real usage, and not ledger rules.
4. **No bridging of abandoned epochs in the first version.** Letting a device that holds an abandoned key connect it back into the history chain later would add another record type and verification path.

## Implementation and limits

```text
Owner holds baseEpoch key
  → generate nextEpoch key and history link
  → persist candidate/original/all active-device envelopes
  → stage and compare exact readback
  → commit tag 11
  → new history chain returns to baseEpoch, skipping abandoned epochs
```

`EpochPublisher.publishAbandoning(baseEpoch)`, workspace and personal-device session `abandonEpoch` share the existing candidate journal, staging and exact-original retries. Callers own the evidence display and explicit confirmation described above; this revision adds no product action button. Snapshot, retained-state and digest formats advance together to current-only v5 with a fixed-width abandonment-link table. Old caches rebuild from original v1 history; ledger-v1 bytes stay unchanged.

The public reference host implements durable rate limits. This repository does not contain the private Cloud ledger API, so this revision cannot establish Cloud enforcement or deployment. Client quota messaging also depends on that backend error contract.

## Evidence

- Operations, authority and device limits: `packages/e2ee-core/src/internal/ledger/{records,policy,replay}.ts`.
- Staged publication and history packets: `packages/e2ee-core/src/internal/keys/{publisher,history,staging}.ts`.
- Canonical X25519 and low-order checks: `packages/e2ee-core/src/internal/foundation/bytes.ts`.
- Suffix budgets: `packages/e2ee-core/src/internal/ledger/ledger-feed.ts`; the personal-device client retains a 16384-record suffix budget.
- Durable rate limiting and HTTP errors: `packages/e2ee-lab/src/platform/{control-gateway,host}.ts`.
- Executable evidence: core `test/ledger/{replay,retained-feed}.test.ts`, `test/keys/epoch-rotation.test.ts`, and Lab `test/gateway.test.ts`.

An explicit pre-CAS self-service quota refusal must not occupy the governance slot. Only a newly created original with no possible prior/concurrent dispatch may be released; uncertain originals remain for reconciliation and a later refusal cannot override an earlier unknown result. Writable-epoch status excludes abandoned epochs, including cached hints, while historical keys remain readable. The host clamps wall-clock rollback to the latest persisted issue time instead of treating a small correction as a storage or permission failure.
