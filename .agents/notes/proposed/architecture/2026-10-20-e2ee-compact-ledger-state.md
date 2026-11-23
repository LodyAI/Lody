# Compact ledger authorization state with full device history

Status: proposed
Translation: current

[中文](2026-10-20-e2ee-compact-ledger-state.zh.md)

PRs: this change (stacked on [LodyAI/Lody#1625](https://github.com/LodyAI/Lody/pull/1625)). It refines the [retained verified state](2026-10-19-e2ee-retained-ledger-state.md).

## Abstract

The authorization state that retained state, endorsed snapshots and the comparison digest share stored most facts twice, and it lost history. Used signing keys, encryption keys and membership IDs were separate sets that also repeated every current device and member. Revocation and removal dropped which encryption key and membership each retired device had. So a restored or snapshot-imported view could not attribute content from a retired device, and could not re-export the state it was given. The state now keeps two append-only history tables: every membership ever admitted with its user, and every device ever admitted with its encryption key and membership. It is encoded once, as fixed-width rows. Every source therefore agrees on the state, its digest and the author of every device. A measured ledger shrinks 18% and restores in about 15 ms instead of 24 ms on one host. Original epoch publication records are still not retained.

## Problem

- **Facts stored twice.** The state array had eleven fields. Used signing keys, encryption keys and membership IDs were sorted sets that contained every current device and member again. In the measured ledger below, that and per-item CBOR headers came to 165,581 bytes.
- **History lost on revocation.** `revokeDevice` and `removeMemberAndPublishEpoch` deleted the current rows. Only `contentAuthors` (signing key → user, membership) survived, and `usedEncKeys` was an independent set. With two retired devices, {S1, S2} and {E1, E2} cannot recover which encryption key went with which signing key.
- **Snapshot and retained authors.** Import rebuilt authors only for current devices. So any device retired before the snapshot or the restore point opened as `device-only`, and the state could not be re-exported unchanged. A member removed with all of its devices kept its user ID nowhere after import.

## Decisions

### State model

The current views `members` and `devices` stay current-only, so every existence-based authorization check is unchanged. Added persistent facts:

| Field | Holds | Written by |
|---|---|---|
| `membershipUsers` | every membership ever admitted → user ID | genesis, admit member; never removed |
| `deviceHistory` | every signing key ever admitted → encryption key, membership | genesis, admit member, admit device; never removed |

Revocation and removal change only the current views. Derived indexes are rebuilt or maintained incrementally and never encoded:
- `usedEncKeys` is the encryption keys in `deviceHistory`;
- `usedCommitments` is the commitments in `historyPackets`;
- `memberUsers` holds current members' users, for re-admission checks. It is not the history table.

`usedSigningKeys`, `usedMembershipIds` and `contentAuthors` are removed, because the history tables are those sets.

### Trust decision: endorsed history is accepted (owner decision)

A qualified endorsed snapshot carries the full device history, and importing it builds an author for every device in it, retired ones included. The owner decided this explicitly: a qualified endorser forging historical attribution is outside the threat model.

This does not relax anything else:
- the endorser still needs independent role and position qualification;
- an arbitrary valid signature still makes no trusted view;
- an endorsed view still reports `endorsed-snapshot` and is never upgraded to `full-history`.

`historicalContentIdentity` therefore always returns `kind: 'member'`, and its `device-only` / `missing-history-context` variant is removed.

### Encoding

The envelopes keep their shape; their versions and the digest domain move to 2 (see [Format versions](#format-versions)):

```
retained state   [2, genesis(32), length, head(32), S, verification (0 full-history, 1 endorsed-snapshot)]
snapshot body    [2, genesis, length, head, signer, S]
state digest     sha256("lody-e2ee/snapshot-digest/v2\0" ‖ [2, genesis, length, head, S])
```

`S` is a six-element CBOR array: five byte strings of concatenated fixed-width rows, plus a boolean.

| # | Table, row order | Row |
|---|---|---|
| 0 | memberships, by membership ID | ID (16) · user ID (32) · role (1): 0 removed, 1 owner, 2 admin, 3 member, 4 guest |
| 1 | devices, by signing key | signing key (32) · encryption key (32) · membership index (u32 BE) · status (1): 0 retired, 1 personal, 2 machine, 3 recovery |
| 2 | joins, by device index | device index (u32 BE) · request ID (16) |
| 3 | epoch commitments 0..n | 32 |
| 4 | history packets 1..n | 72 |
| 5 | rotation required | boolean |

The following are not stored, because they derive from the tables:
- the owner (role 1);
- the epoch number (commitment count − 1) and its commitment (the last one);
- used keys, membership IDs and commitments;
- closed joins (device key and request ID);
- every author (the device's membership and that membership's user).

The digest still hashes the retained bytes without their last element, so it needs no second encoding. This requires the digest body and the retained envelope to share one version number.

### Format versions

The compact `S` first shipped under the old version numbers. Version 1 bytes, from either layout, are now rejected:

- The retained envelope and the snapshot body are version 2. The digest domain is `snapshot-digest/v2`, because it hashes different content than v1 did.
- Decoders accept only the current version. Any other version fails with `unknown-version`. Hosts already treat that as "rebuild by full replay", so a stale retained row heals in one replay.
- The `snapshot/v1` and `head-attest/v1` signing domains stay. A version-1 body cannot verify as version 2, because the version is inside the signed body.
- Ledger v1 records and `test/ledger-v1-vector.json` do not change.
- A future change to `S` or to an envelope bumps all three together.

### Restore digest check

`restoreVerifiedState` takes an optional `stateDigest`, which is the value `exportVerifiedState` returned and the host stored with the bytes:

- When it is present, restore first decodes the bytes, then recomputes the digest from them (one SHA-256) and fails with the new code `state-digest-mismatch` on a difference. Decoding first means an old row still reports `unknown-version`, not a digest mismatch.
- When it is absent, restore behaves as before.
- Scope: the check detects corrupted, truncated or swapped rows. It does not stop a writer who can replace both the bytes and the digest. Signatures and curve points are still not rechecked.
- The digest covers position and `S`, not the final verification byte. Flipping that byte alone is not detected.

### WebAssembly observability

`ed25519WasmActive()` is also exported from `@lody/e2ee-core/protocol`, so hosts that cannot bundle `./cloudflare`, such as Convex, can report whether strict Ed25519 runs in WebAssembly. It only reads state: no backend can be injected, replaced or disabled through it.

Snapshot and retained CBOR now allow one byte string up to their total budget (2 MiB and 16 MiB), because a table is one byte string. Records keep their 256-byte limit. Their array-length limit drops to the record limit of 32, since `S` has six elements.

### Canonical decoding

Any of the following rejects the state:
- the field count, types or row widths are wrong, or the packet count is not the commitment count − 1;
- membership IDs are not strictly ascending, a role is not 0–4, there is not exactly one owner, or two current members share a user;
- signing keys are not strictly ascending, an encryption key repeats, a membership index is out of range, or a status is not 0–3;
- a current device belongs to a removed membership, a membership has no device, or the owner has no current non-machine device;
- join device indices are not strictly ascending, the join count is not the membership count − 1, or two joins name devices of the same membership;
- a commitment repeats;
- the existing bounds against the ledger length fail, including the exact genesis shape at length 1.

Snapshot import curve-checks every signing key. Retained restore skips that check, because the bytes are the caller's own.

### Rebuild per source

| | Full replay | Qualified snapshot import | Retained restore |
|---|---|---|---|
| Persistent facts | written by records | decoded from `S` | decoded from `S` |
| Authors | every device | every device in `S` | every device in `S` |
| `verification` | `full-history` | `endorsed-snapshot` | as exported |
| Verified hashes | all | head only (`historyStart` = length − 1) | head only |
| `epochPublications` | every replayed publication | none | none |

## Acceptance (what "the same" means)

- **Source-independent.** At one position, full replay, qualified snapshot import and retained restore from any source give byte-identical `S`, the same comparison and `ledgerStateDigest` digests, and the same author for every device ever admitted. This still holds after appending the same records.
- **Same-source round trip.** Exporting a restored view reproduces the retained bytes exactly, provenance included. Restoring and then extending matches extending the original. Sources differ only in the final verification byte.
- **Behaviour.** Every next record is accepted or rejected with the same code as on the full replay. This covers a retired signing key, a retired encryption key under a new signing key, a removed membership ID, a membership removed with all its devices, a current user's second membership, a used commitment and revoking a retired device.
- **Intentionally different.** Verified hashes before the restore point are absent, so `hasVerifiedRecordHash` is false for them. `epochPublicationRecord` fails for epochs published before the restore point, so `getCommittedEpochStagingKey` cannot stage keys for those epochs from a restored or imported view. `verification` follows the source.

Tests run a ledger with these events before the first export:
- retired devices;
- a removed member;
- a member removed together with all its devices;
- the same user back under a new membership;
- five epochs.

They also check that swapping two retired devices' encryption keys changes the digest. Two deliberate regressions were caught by the tests: dropping retired rows on decode, and deleting history on revocation.

## Measurements

The ledger has 1,301 records: 150 memberships, 50 of them removed; 301 devices; 1,000 rotations. Keys and signatures are real. Times are single runs on one development host.

| | Before | After |
|---|---|---|
| Retained bytes | 165,581 | 135,293 (−18%) |
| Restore | 24.0 ms | 14.8 ms |

Exact row costs: a member admitted with one device 138 bytes, each further device 69, each rotation 104. Removal and revocation change one byte and never shrink the state. One 900 KiB chunk holds about 6,600 single-device members, or 8,800 rotations; before, the figures were 3,300 and 8,200. The 2 MiB snapshot cap now admits about 15,000 single-device members, up from about 5,000.

Nearly all remaining bytes are random: 64 bytes of keys per device and 72-byte history packets. Compression does not help.

## Alternatives

- **A separate author list for snapshot-imported states** in the retained envelope. Needed only while endorsed history was untrusted; dropped after the owner decision.
- **Truncated hashes for retired encryption keys** (would save about 16 bytes per retired device). A false match only rejects a fresh key, but the table would lose its single row shape.
- **Moving history packets out of `S`.** They are a quarter of the bytes, but snapshots and the digest bind them; that is a protocol change for a separate decision.

## Limits and follow-ups

- No compatibility: no deployed state exists. The previous encoding is not read, and its version 1 is rejected as `unknown-version`.
- Not changed: restored and imported views still cannot stage keys for epochs published before their restore point; reading the original publication from the ledger by position is the candidate fix.
- Not verified: the private backend's chunked store with the new bytes. It treats them as opaque, but it must pick up this core.
