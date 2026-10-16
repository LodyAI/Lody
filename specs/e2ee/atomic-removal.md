# Atomic member removal and staged epoch publication

Status: draft
Translation: current

[中文](atomic-removal.zh.md)

## Ledger transition

An active Owner/Admin personal device observing `rotationRequired = true` may
produce tag 7. Tag 8 is `[8, targetMembershipId, nextEpoch, commitment,
previousEpochKey]` in the existing ordinary record, with exact arity and unchanged
`lody-e2ee/sig/v1\0` and `lody-e2ee/rec/v1\0` domains. Only the current Owner's
personal device may produce tag 8; its target must exist and cannot be Owner.
The next epoch is exactly current + 1; overflow and reused commitments fail.
Tag 2 remains unsupported. There is one current prelaunch format, no dual reader.

One tag 8 transition removes the membership and all its personal, machine and
Recovery devices, retains historical authors and retired identities, stores the
new commitment and existing 72-byte history packet, and clears rotationRequired.
The publisher opens the packet and checks the old commitment. Replay verifies
signature, shape and pre-state authority; ciphertext shape cannot prove its key.

## Stage first, commit once

1. Generate the candidate key, original signed record R and its hash h, and signed
   HPKE envelopes for **every** post-transition active device, including Recovery
   and Guest. Persist all originals locally before dispatch. Protect the candidate
   key with the initialized host port.
2. Stage the whole group atomically, addressed by
   `(genesis, nextEpoch, commitment, h, recipient)`. One Convex mutation writes
   all recipient rows or none. Read back the group and compare count and every
   original frame byte. A failed stage/readback never dispatches CAS.
3. Submit the same R through the existing P09 CAS. Streams remains content-blind.
4. On success the ledger is the only activation point. On conflict discard the
   local protected candidate; do not install, re-sign or silently retry another
   candidate. On an unknown outcome reconcile exact original R through P09 and
   retain/reuse the same staged group, including after a process crash.

A staged envelope is inert until a genuine verified ledger includes its tag 7/8
record, exact epoch, commitment and signer. This historical publication proof
remains distinct from ordinary mailbox sender eligibility: later revocation of
that publisher does not strand still-eligible staged recipients. Recipients
verify their current device/key binding and the actual HPKE/commitment before
installation. Later-joined devices use the existing mailbox and repair path.

The storage adapter must authenticate device possession, bind the staging caller
to R's signing device, verify R and every envelope's fixed outer signature/context,
and make the full group immutable at its locator. A retry either matches every
original byte or fails; it never replaces or shrinks a group. Account membership
or an account's management role alone is not device possession. Where cloud
credentials identify only an account, stage/delete requests need a device-signed
proof bound to the operation, workspace and complete group/request fields.

Only R's original signing device may delete its own group, including every page
of a physical cleanup. The Convex mutation checks the original signer and deletes
its rows in the same transaction. Missing groups return success without deletion. Other members and other management devices are denied,
even if they supply a genuine occupied tuple. The server enforces this device
binding; it does not read Streams or accept `occupied` as ledger authority.
The honest client additionally requires a genuine committed *different commitment
at the same epoch* before requesting cleanup. A timeout, age, untrusted host hint or absent record never does. Local
results/originals retain their explicit acknowledgement contract.

## Owners and limits

Core exposes only stage/read/conditional-delete effects. Portable DTOs live in
cloud-api; the private Convex adapter owns cloud persistence, and the Lab's SQLite
adapter uses one native transaction per whole group. Neither storage nor an
account role supplies signed-ledger authority. The client supplies and verifies
its independent genuine view; storage cannot certify global freshness.

A buggy or malicious publishing device can bypass staging and directly CAS a valid
record, or delete its own staged group despite the client cleanup rule.
This is key withholding: the epoch commits but recipients may be stuck without
its key. It is a measured Lab limitation, not prevented by Streams or cross-store
transactions. Staging protects the honest publisher's crash window; it does not
force a malicious publisher to make usable ciphertext or preserve it forever.

## Approval and evidence

The design direction above is supplied by the user; this revised Spec remains
**draft for approval**. It does not enable production, select vault/native custody,
strict B, account recovery or an MLS replacement. See [producer and replay](../../packages/e2ee-core/src/internal/ledger/ADMISSION.md),
[staging port](../../packages/e2ee-core/src/internal/keys/staging.ts),
[rotation workflow](../../packages/e2ee-core/src/internal/keys/publisher.ts) and
[Lab](../../packages/e2ee-lab/README.md).
