# E2EE account-wide personal device pairing

Status: proposed
Translation: current

[中文](2026-11-01-e2ee-account-personal-pairing.zh.md)

## Abstract

Adding a second device for the same account today takes a copy-and-paste exchange in
every workspace, a comparison of full hexadecimal public keys and four manual steps. On
2026-11-01 the owner chose a scan-or-paste flow, modeled on Signal linked devices and
Keybase kex2.

The new device shows a QR code and a 28-character pairing string that carries a
one-time 128-bit secret. The secret authenticates the device's request with an HMAC and
never reaches the service. The user scans or pastes the string on any of their personal
devices, which verifies the request before showing its details. One approval covers every
encrypted workspace of the account.

The protocol statement is in the [foundations increment](../../../../specs/e2ee-foundations.md#account-wide-personal-device-pairing-owner-approved-2026-11-01)
and was approved by the owner on 2026-11-01. Only the core primitives are implemented.

## Problem

- **Trust anchor.** The [current flow](2026-10-26-e2ee-personal-desktop-join.md) sends
  the genesis and endorser pins over the pairing code. That out-of-band channel is what
  lets the new device trust its first snapshot.
  - Whatever replaces it must still authenticate both the new device's keys to the
    approver and the approver's key to the new device. The relaying service must stay
    unable to substitute either.
- **Usability.** The user has to handle one code per workspace and compare full keys,
  click "check" by hand, and land on a ledger page.

## Decision (owner, 2026-11-01)

### Pairing string

- **Secret.** `S` is 128 bits from the platform's secure random source. It is generated
  by whichever side displays the code: the new device N by default, or the approving
  device A in the reverse direction.
- **Encoding.**
  - A 2-bit version (`00`) followed by `S` gives 130 bits. These are written as 26
    Crockford base32 characters.
  - Two further check characters hold the top 10 bits of
    `SHA-256("lody-e2ee/pair-check/v1\0" || version || S)`.
  - The result is 28 characters, shown as seven groups of four, for example
    `7K2M-9QXD-4HTR-...`.
- **Parsing.**
  - Case, spaces and dashes are ignored, and `O` is read as `0`, `I` and `L` as `1`.
  - A wrong length reads "the code has 28 characters".
  - A checksum mismatch reads "one character looks wrong; check the code". A random
    error slips through with probability 2⁻¹⁰.
  - Both checks happen before any network request.
- **QR.** The QR code contains `lody://pair/<28 characters>`. The plain string is
  accepted everywhere the QR code is.

### Derived values

Each value is HKDF-SHA256 over `S` with salt `"lody-e2ee/pair/v1\0"` and its own label:

- `lookupId`: 16 bytes, label `"lookup"`. This is the only value the service sees. It
  indexes the request under the authenticated account.
- `requestKey`: label `"request-mac"`. `requestTag` is
  `HMAC-SHA256(requestKey, canonical request)`. The canonical request covers:
  - the account, `lookupId`, direction, display name and expiry;
  - every per-workspace `(genesis, signing key, encryption key, possession proof,
    credential hash)` row.
- `approvalKey`: label `"approval-mac"`. `approvalTag` is
  `HMAC-SHA256(approvalKey, requestDigest || A's signing key || per-workspace
  (genesis, admission record hash, invitation digest))`.

### Flow

1. N submits the request with `requestTag`.
2. A obtains `S` by scan or paste and derives `lookupId`. It then fetches the request and
   verifies `requestTag` before showing anything.
3. After approval, A publishes `approvalTag` beside the signed admissions and snapshot
   invitations.
4. N verifies `approvalTag` and only then pins genesis and A's endorsement key.

## Security argument

- **Substitution.** To change any key, row, name or expiry, the service must forge an
  HMAC under a key derived from a 128-bit secret it never sees. A forged approval toward
  N meets the same bound. Its success probability is about 2⁻¹²⁸.
  - Distinct HKDF labels separate the request tag from the approval tag. A tag for one
    purpose therefore cannot be reflected as the other.
- **Offline attack.** `lookupId` is an HKDF output, so it reveals nothing usable about
  `S`. Brute-forcing a 128-bit secret is infeasible, so there is no online-attempt budget
  to manage.
- **Replay and expiry are client-enforced.** The service's view of the request state is
  not trusted. A malicious service could return an old request whose MAC is valid and
  claim it is still pending.
  - The request's original expiry, at most 10 minutes, is covered by `requestTag`. A
    checks it before signing, and N checks it before accepting an approval.
  - Both persist the terminal states they know (approved, declined, expired) and every
    used `S`. A restart or retry can neither extend nor revive a request, and N destroys
    its `S` after use.
  - N accepts an approval only for the digest of its own current request. An old
    `approvalTag` is bound to an old digest and is rejected.
  - **Remaining limit.** If another approver already declined or consumed the request and
    the service hides it, the MACs cannot reveal that. Global one-time use holds only
    within local state plus the 10-minute expiry, and a leaked `S` is useful only inside
    that window. No further mechanism is added.
- **Social engineering ("ghost pairing").** An attacker who knows the account password
  can create a genuine request on their own device and persuade the user to scan or paste
  its code on the user's device. Every MAC then verifies and the service need not
  misbehave. Whoever holds `S` cannot distinguish that device from the user's own.
  - Before signing, the approver shows a fixed warning: scan or paste only a code showing
    on your own other device, never one someone sent you, and approval grants the
    selected workspaces and all their history.
  - The confirmation names the target device and lists the workspaces to join, each
    deselectable. It labels the device name "provided by the requesting device" and the
    location "approximate, estimated by the server".
  - After approval, every approved device and the account email receive a "new device
    added" notice with a revoke link.
  - These measures reduce the risk and expose it after the fact, as Signal's
    linked-device warning does; they do not prevent it.
- **Account binding.** The service returns a request only to the same authenticated
  account. This is defense in depth; integrity never relies on it.
- **Exposure.** `S` is a short-lived bearer secret. Someone who sees it and also controls
  the relay could substitute keys within the 10-minute window. A bystander without the
  service cannot read or alter another account's request.
  - Mitigations: the code is shown only on the requesting screen, it is single-use, it
    expires, and Lody clears it from its own copy buffer best-effort after pasting.
- **Lineage.** Signal's linked-device QR code carries the new device's key directly; that
  is too long to paste, and Lody covers many workspaces. Keybase kex2 authenticates its
  channel with a shared secret phrase. This design follows kex2's shared-secret MAC in a
  shorter form.

## Other decisions (unchanged)

- **Starting a request.** Desktop and mobile start automatically. Web starts only after
  "Request access", because browsers are often public or shared; the
  [client custody Spec](../../../../specs/e2ee/client-custody.md) carries a matching
  pending increment.
- **Approvers.** Any active personal device of the same user may approve. Machines and
  recovery devices may not.
- **Location.** The approximate location is estimated from the IP address and labeled
  "approximate, for reference only".
- **Manual pairing** uses the same string.
- **Scope.** One approval covers all the account's encrypted workspaces, with
  deselection.

## Rejected alternatives

- **CPace with a 6-digit code typed on the new device.** No audited JavaScript CPace
  implementation exists, and it adds a protocol that needs its own vetting.
- **Comparing a short authentication string on both screens**, with commit-reveal. This
  needs an additional security argument and extra interaction, and comparison is easy to
  click through.
- **Typing a short authentication string.** A short code needs a PAKE or a commitment
  protocol to be safe, plus extra interaction.
- **Putting full public keys in the QR code**, as Signal does. Too long to paste, and Lody
  needs one key set per workspace.
- **One device key across workspaces, or a new account-level ledger operation.** Both
  change per-genesis custody or the ledger without need.

## Batch signing and failure

- **Journaling.** A journals each workspace's exact `AdmitDevice` original and the
  request ID before any network step.
- **Retries.** A retries those exact bytes and reconciles unknown outcomes from the
  original. It never re-signs, and a crash resumes the remaining workspaces.
- **Per-workspace state.** Each workspace is either admitted with its key delivered,
  admitted and awaiting delivery, or not admitted.
- **New-device identities.** N keeps its per-workspace identities from before submission.
  A later request reuses them, and N never generates an identity over them.

## Relay contract

The public relay DTOs are in [`packages/cloud-api`](../../../../packages/cloud-api/src/e2ee-account-pairing.ts)
under `e2eeAccountPairing`: submit, pending, read by lookup ID, decline, publish and claim.
- **Authoritative bytes.** Clients trust only the canonical request and approval bytes and
  their tags. Status, device name, expiry, location and the workspace routing list are
  advisory copies for routing, rate limiting and notifications.
- **Several approvers.** A claim returns every published approval, because each approver
  covers only the workspaces it can sign for.
- **Admissions.** These go through the existing ledger append path. Each invitation row
  carries the approver's device access for its workspace.

## Verification limits

- The string format, key derivation, canonical request and approval bytes and both tags
  are pinned by `packages/e2ee-core/test/pairing-vector.json`. An independent
  standard-library Python generator (`test/generate-pairing-vector.py`) produces it.
- The relay backend is a private default-off draft. Notifications, location and the
  device wiring below are not done.

## Desktop host

[`e2ee-account-pairing.mts`](../../../../apps/electron/src/main/services/e2ee-account-pairing.mts)
implements both sides in Electron main. It is not yet connected to IPC or to the
per-workspace ledger hosts, which arrive as injected ports.
- **Secret.** `S` stays in memory and never touches disk. A restart ends that request
  locally, and the device starts a new one with the same retained identities.
- **Terminal states.** Approved, declined, expired and cancelled are recorded per lookup
  ID in local SQLite. The first state wins and is never revived, whatever the relay
  reports.
- **Approver.** The approver authenticates the request with its tag and checks the expiry
  against its own clock. It checks both again immediately before each signature.
  - Each workspace's exact signed admission is journaled before any network step and
    retried as-is, including after a restart.
  - The journal is keyed by workspace and the new device's signing key, not by request. If
    a request expires after admission but before delivery, the next request from the same
    retained identity reuses that original, so a workspace is never signed twice.
  - Pairing operations run one at a time, which keeps check, sign and journal atomic.
  - The secret and derived keys are wiped on every exit, including failure and
    interruption.
  - An approval is published only after this device has verified its own approval tag.
    Its `approverSigningPublicKey` is the signer of the first row, sorted by genesis; each
    row's record hash binds that workspace's actual signer.
- **New device.** It installs an invitation only after the approval tag verifies, the
  approval binds its own request digest, its own expiry still holds and the invitation
  digest matches. Anything else from the relay is ignored.
- **Decoding.** Relayed bytes are decoded by core's strict `decodePairingRequest` and
  `decodePairingApproval`, which accept only canonical encodings.
