# E2EE account-wide personal device pairing

Status: proposed
Translation: current

[中文](2026-11-01-e2ee-account-personal-pairing.zh.md)

## Abstract

Adding a second device for the same account today takes a copy-and-paste exchange in
every workspace, a comparison of full hexadecimal public keys and four manual steps.
On 2026-11-01 the owner approved a different flow:

- no pairing code in advance;
- an approval notification on the user's other devices;
- after "Allow", a 6-digit code on the approving device that the user types on the
  new device;
- one approval for every encrypted workspace of the account.

The code is not compared by eye. A CPace handshake that binds both devices' keys
verifies it, so the service cannot substitute a key and a recorded transcript cannot be
attacked offline; each request allows at most 5 online attempts. The protocol statement
is in the [foundations increment](../../../../specs/e2ee-foundations.md#account-wide-personal-device-pairing-pending-approval-increment)
and still awaits owner approval. Nothing is implemented or measured yet.

## Problem

- **Trust anchor.** The [current flow](2026-10-26-e2ee-personal-desktop-join.md) sends
  the genesis and endorser pins inside the pairing code. That out-of-band channel is
  what lets a new device trust its first snapshot. Without the code, the human step
  itself must authenticate the approving device's key, and every workspace's genesis
  and new-device key pair. Otherwise the service could substitute either side.
- **Usability.** The user has to handle a code per workspace, compare full keys and press
  "check" manually. Meanwhile the new device lands on a ledger page.

## Decision (owner, 2026-11-01)

### Request and approval

- **Who starts a request.** Desktop and mobile request automatically when an encrypted
  workspace opens without an identity. Web asks first ("Request access"), because a
  browser may be public or shared. The approved
  [client custody Spec](../../../../specs/e2ee/client-custody.md) gets a matching
  pending increment.
- **Who approves.** Any active personal device of the same user, whatever the user's
  role. Machines and recovery devices never approve.
- **What the approver sees.** The notification shows the device name, an approximate
  location from the IP address the service sees ("approximate, for reference only")
  and the request time. Requests expire after 10 minutes, are rate-limited per
  account, and can be declined.
- **Fallback.** Manual pairing remains for cases where push is unavailable, or the
  approving device is offline and must pair in person.
- **Scope.** One approval covers every encrypted workspace of the account; the user can
  deselect individual workspaces.

### The CPace handshake

1. When the user chooses "Allow" on approving device A, A draws a fresh uniform 6-digit
   code and a fresh 16-byte session ID. The code appears only on A, which already
   holds N's request. The code must not exist before "Allow", because the handshake
   binds that request and that session.
2. The user types the code on N. N and A run CPace (`draft-irtf-cfrg-cpace`, the
   ristretto255/SHA-512 suite), using the code as the password-related string.
   - The channel identifier is the hash of the account, the digest of N's immutable
     request (every per-workspace genesis, key, possession proof and credential hash)
     and A's signing public key.
   - The associated data names each side's role.
3. Both sides send a key-confirmation MAC over the full transcript. A also signs
   `(requestDigest, sid)` with its device key, so N pins exactly the key that the
   channel identifier bound.
4. A is the authoritative attempt counter. Any run that does not confirm counts,
   including runs the service injects. After 5 failures A discards the code and voids
   the request, and the user starts a new one. A code is single-use and dies with its
   request.

## Security bound of the 6-digit code

The code space is 10⁶, about 20 bits.

- **Online.** CPace guarantees that each active run tests at most one candidate code.
  Five attempts per request bound a forgery to at most 5 × 10⁻⁶ per request. Every
  attempt also requires the user to have pressed "Allow". The 10-minute expiry and the
  per-account rate limit bound repetition.
- **Offline.** A passive or recorded transcript reveals nothing that can be tested
  offline, and the code is never sent to the service.
- **Comparable systems.** Apple's device approval uses 6-digit codes. Magic Wormhole
  pairs short codes with a PAKE (SPAKE2). Bluetooth passkey entry also uses 6 digits,
  but leaks a bit per attempt, which CPace does not.

## Why CPace

- **Against SPAKE2.** Both are balanced PAKEs. In 2020 the CFRG selected CPace as its
  recommended balanced PAKE. CPace needs no fixed setup points: SPAKE2 relies on
  constants M and N whose discrete logarithms must be unknown. CPace is also a single
  round with one hash-to-group map, and it has a UC security proof.
  - It can be built on `@noble/curves` ristretto255, beside the pinned noble Ed25519
    stack.
- **Against OPAQUE.** OPAQUE is an augmented PAKE for a client and a server that stores a
  password file. Here two peer devices share a one-time code. Registration, an OPRF and
  envelopes would add complexity with no benefit.

## Rejected alternatives

- **Commit-reveal plus comparing a SAS on both screens.** The earlier draft of this PR
  proposed it. It depends on the user actually comparing the codes, and comparison is
  easy to click through. Typing a code requires a real transfer from the approving
  device to the new one.
- **A long code of about 60 bits shown immediately**, Signal-style. It resists offline
  grinding without a PAKE, but typing or comparing about 18 digits is error-prone. With
  a PAKE limiting online attempts, it adds nothing.
- **One device key shared across workspaces.** It would change per-genesis custody and
  credential scoping. N keeps per-workspace keys, and the request digest covers all of
  them.
- **A new account-level ledger operation.** Not needed. The existing personal
  `AdmitDevice` is signed per workspace.

## Batch signing and failure

- **Before the network.** A journals each workspace's exact `AdmitDevice` original and
  the request ID.
- **On failure.** A retries the same bytes, reconciles unknown outcomes from the
  original and never re-signs. A crash resumes the remaining workspaces.
- **Per-workspace states.** Each workspace ends up in one of three states: admitted with
  key delivered, admitted and awaiting delivery, or not admitted. A record either
  commits or it does not.
- **No regeneration.** N retains its per-workspace identities from before submission. A
  later request reuses them; N never generates an identity over retained ones.

## Verification limits

- No audited JavaScript CPace package is in use. The implementation would follow the
  draft and must pass its published test vectors.
- No device, notification or backend work exists yet.
