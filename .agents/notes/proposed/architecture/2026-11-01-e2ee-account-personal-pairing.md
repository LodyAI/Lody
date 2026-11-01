# E2EE account-wide personal device pairing

Status: proposed
Translation: current

[中文](2026-11-01-e2ee-account-personal-pairing.zh.md)

## Abstract

Adding a second device for the same account today is a copy-paste exchange per
workspace. The user compares full hex public keys and clicks through four steps, and
nothing refreshes on its own. The owner approved a new direction on 2026-11-01: no
pairing code, automatic progress, a 6-digit short authentication string (SAS), and one
approval that covers every encrypted workspace of the account.

This note proposes the SAS construction and gives its security basis. It also covers
the batch-signing and failure model, and the decisions still open. The protocol
statement lives in the [foundations increment](../../../../specs/e2ee-foundations.md#account-wide-personal-device-pairing-pending-approval-increment)
and awaits owner approval. Nothing is implemented or measured yet.

## Problem

- **Trust anchor.** The [current flow](2026-10-26-e2ee-personal-desktop-join.md) carries the genesis and endorser pins over the
  pairing code. That out-of-band channel is what lets the new device trust its first
  snapshot. Removing the code means the code comparison itself must authenticate:
  - the approving device's key;
  - every workspace's genesis and new-device key pair.

  Otherwise the service could substitute either side.
- **Usability.**
  - One code per workspace.
  - Full-key comparison.
  - Manual "check" steps.
  - The joining device lands on the ledger page and is told "device setup and the ledger
    only".

## Proposed SAS

`requestDigest` is SHA-256 over N's immutable canonical request. That request covers:
the account, request ID, expiry, display name, every `(genesis, signing key, encryption
key, possession proof, credential hash)` row, and the commitment `C`.

1. N creates a fresh 32-byte `nN` and publishes
   `C = SHA-256("lody-e2ee/pairing-commit/v1\0" || nN)` inside the request.
2. An approving device A opens the request and returns a fresh 32-byte `nA`. It signs
   `(requestDigest, nA)` with its personal signing key.
3. N verifies A's signature and reveals `nN`, signed with each workspace's new signing
   key. A checks `nN` against `C`.
4. Both compute HKDF-SHA256 with:
   - IKM `nA || nN`;
   - salt `requestDigest`;
   - info `"lody-e2ee/pairing-sas/v1\0" || A's signing public key`;
   - an 8-byte output.

   They show `uint64 mod 10^6` as six digits. The modulo bias is below 2⁻⁴⁴.
5. A signs admissions only after the user confirms that the codes match. Any later
   change to the request or to A's key changes the code.

**Security basis.** The commitment fixes N's inputs before `nA` exists. `nN` stays secret
until A has committed to `nA`. Neither a substituted N (the service inventing keys) nor a
substituted A can steer the code, so each forged exchange matches with probability 10⁻⁶.
This is the same model as:

- Bluetooth Secure Simple Pairing numeric comparison: six digits, commitment-based,
  10⁻⁶ per attempt.
- ZRTP SAS: about 20 bits behind a hash commitment.
- Matrix SAS verification: a commitment to the ephemeral key before exchange, shown as
  about 40-bit emoji or decimal codes.

Signal safety numbers are 60 digits because they compare static fingerprints with no
commitment. Without commitment, six digits would be ground offline in about 10⁶ tries,
so a short code is only safe with commit-reveal.

Online guessing is bounded because:

- each attempt needs a new request the user sees;
- requests expire;
- a mismatch leads the user to decline;
- the service is expected to rate-limit requests per account.

## Batch signing and failure

Each selected workspace is an independent ledger write:

- A journals the exact `AdmitDevice` original and request ID before the network.
- It retries those bytes and reconciles unknown outcomes from the original.
- It never re-signs.
- A crash resumes the remaining workspaces.

Afterwards each workspace is in one of three states: admitted with key delivered,
admitted awaiting delivery, or not admitted. No workspace can be half admitted, because
the record either commits or does not. Key delivery already retries.

N keeps its per-workspace identities and credentials from before submission.
Deselected, declined and expired workspaces leave N's protected identity unadmitted.
A later request reuses it, and N never generates over it.

## Alternatives

- **Show the code immediately on N, without commit-reveal.** Needs a long code (at
  least about 60 bits, as in Signal) to resist offline grinding, which is bad
  usability.
- **Keep the pairing code and only automate the steps.** Smaller change. It still
  needs one code per workspace and a channel between the devices.
- **One device key shared across workspaces.** Simpler batching, but it changes the
  existing per-genesis custody and credential scoping. Rejected; N keeps per-workspace
  keys, and the SAS covers the whole list.
- **A new account-level ledger operation.** Not needed; the existing personal
  `AdmitDevice` is signed per workspace.

## Open decisions

1. **When the code appears.** Commit-reveal shows it only after an approving device
   opens the request, so not "immediately". The alternative is a longer code shown
   immediately.
2. **Request expiry.** 10 minutes is proposed, plus the per-account rate limit.
3. **Web and mobile.** The approved client custody Spec says that a missing identity
   alone never starts pairing automatically. Desktop goes first; Web and mobile need a
   client custody revision.
4. **Who may approve.** Any active personal device of the same membership (the ledger
   rule), or Owner/Admin only (the current implemented slice).
5. **Location.** The service's IP geolocation, shown as an unauthenticated hint.
6. **Manual pairing.** It stays as the fallback and transition path. When no approved
   device is online, the request waits until it expires; recovery-file restore is
   separate.

## Verification limits

This is a design proposal. The SAS construction has no test vectors yet, and no device,
notification or backend work exists.
