# E2EE account-wide personal device pairing

Status: proposed
Translation: current

[中文](2026-11-01-e2ee-account-personal-pairing.zh.md)

## Abstract

Repeated manual exchanges made second-device access cumbersome. The 128-bit secret-transfer protocol is implemented; the owner now chose automatic requests, a comparison code and one approval for the current workspace. The automatic implementation adds a committed ephemeral channel while retaining the existing admission journals, MACs and custody. Its approximately 20-bit visual comparison has a different security bound from manual secret transfer, so the protocol increment remains draft and native rollout is tracked separately from fixture verification. A 2026-11-12 owner decision adds scan-to-join in the reverse direction: a computer shows the code with the request at once and signs without a further confirmation, at the cost that anyone who sees the shown code can admit a device.

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

## Other decisions (manual flow)

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
- **Member approvers.** A Member cannot sign snapshot invitations. Under the
  [history increment](../../../../specs/e2ee-foundations.md#member-approvers-deliver-history-instead-of-a-snapshot-approved-increment)
  its row carries no invitation and the new device verifies the full history instead.

## Rejected alternatives

- **CPace with a 6-digit code typed on the new device.** No audited JavaScript CPace
  implementation exists, and it adds a protocol that needs its own vetting.
- **Comparing a short authentication string on both screens** was rejected in the original flow: it needs an additional security argument and users may click through comparison. The 2026-11-10 UI decision revisits this trade-off; its security bound differs from manual secret transfer.
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

## Client surface

The host port is the optional `E2eeAccountPairingRuntime` in
[`packages/platform`](../../../../packages/platform/src/e2ee-account-pairing.ts). The pages
are in [`e2ee-account-pairing.tsx`](../../../../packages/components/src/components/pages/e2ee-account-pairing.tsx).
Since the owner decision of 2026-11-04 they are shown by default, with no developer
mode or client switch. The emergency off is the service refusing with
`e2ee_account_pairing_disabled`, which the page explains; a per-device local
preference could not stop the flow fleet-wide, so none is kept.

- **Ownership.** The host owns `S`, every tag check, the lifetime check, terminal records
  and signing. The UI checks a typed code locally only to name a typo before any network
  request, and wipes the decoded bytes at once.
- **Visibility.** A host without the methods shows nothing, and the existing
  per-workspace pairing stays below. The desktop implements the methods over IPC; Portable hosts can approve; native requester assembly now uses verified history. Browser requester assembly stays capability-gated.

## Verification limits

- The string format, key derivation, canonical request and approval bytes and both tags
  are pinned by `packages/e2ee-core/test/pairing-vector.json`. An independent
  standard-library Python generator (`test/generate-pairing-vector.py`) produces it.
- The private account-pairing relay defaults on with an emergency off switch. Suspended-app notifications and location are not established by the automatic increment.
- One end-to-end test runs on real desktop custody, bootstrap, ledger hosts and SQLite,
  with an in-memory relay. No packaged, native or live-backend run exists.

## Desktop host

The shared workflow is [`@lody/e2ee-client/account-pairing`](../../../../packages/e2ee-client/src/account-pairing.ts),
behind an `AccountPairingStore` port.
[`e2ee-account-pairing.mts`](../../../../apps/electron/src/main/services/e2ee-account-pairing.mts)
is the desktop's SQLite store and composition.
[`e2ee-account-pairing-host.mts`](../../../../apps/electron/src/main/services/e2ee-account-pairing-host.mts)
connects it to the per-workspace hosts, and `E2eeIpc` exposes it to the #2196 port.

- **Workspace list.** The renderer passes its encrypted workspace list as routing hints.
  The host verifies every genesis against its own ledger or the request tag.
- **New device.** It proves possession for the membership that verified history assigns
  to the account's crypto user. On accept it finds the admission record by its
  tag-authenticated ledger hash, takes that record's signer as the endorser, and installs
  the invitation through the existing per-workspace join journal.
- **Member approvers.** A Member's invitation port returns `null`, so its row carries
  an all-zero invitation digest (the relay body is a one-byte placeholder). The new
  device then verifies the full signed history from the tag-authenticated genesis,
  finds its admission by the authenticated record hash, takes its signer as endorser
  and installs through the per-workspace history path. Rows with an invitation keep the
  snapshot path. No wire or relay format changes.
- **After install.** The new device opens the workspace, refreshes it and runs one key
  round with its own credential, as the per-workspace claim does. This is best effort:
  opening the workspace later repeats it.
- **Runtime entries.** Every runtime entry the workflow opens is closed again unless a
  window reads that workspace.
- **Unfinished per-workspace pairing.** An unrelated, unfinished per-workspace pairing
  keeps its journal row. That workspace reports `blocked` and the UI names it; finishing
  or cancelling that pairing lets the request continue.
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

## Portable host

[`account-requester.ts`](../../../../packages/e2ee-client/src/account-requester.ts) is the
mobile and Web new-device side, and the personal device host implements it.

- **Fixed offer.** A portable identity's credential packet is bound to an offer, but the
  account flow prepares the identity before any approver is known. Each workspace
  therefore uses one fixed account offer: its genesis record and membership, a
  placeholder endorser (`00…`), and a `pairingSessionId` derived from the workspace ID.
  Every request and reopen finds the same identity and journal, and the local credential
  format is unchanged.
- **Real endorser.** The real endorser is the signer of the admission record whose ledger
  hash the approval tag authenticated. It is stored with the approval original, and
  snapshot verification and the ledger origin use it in place of the placeholder.
- **Protection.** Identity protection stays with each platform's custody: Keychain or
  Keystore on mobile, web-crypto on Web.
- **Known limit.** Portable hosts do not report an unfinished per-workspace join yet, so
  such a workspace is not shown as blocked.

## Automatic current-workspace verification (2026-11-10)

The owner approved the Ryugi flow in session `318781d5`: a phone opens the workspace, displays a code, and continues automatically after one approval on an existing device. Only the current workspace is granted. Later preserves an inbox count and the same request. This is UI approval, not independent cryptographic review; the automatic foundations increment remains draft. The existing manual protocol and per-workspace fallback remain.

The committed P-256 ECDH exchange binds account, workspace, genesis, request ID, name and original expiry. Before seeing the requester public key, the responder commits SHA-256 over this canonical domain-separated context, a random peer ID, its public key and a 256-bit random nonce. Both freeze their peer’s first message. HKDF-SHA256 over the shared key and complete transcript derives separate comparison and 128-bit pairing-secret outputs. The relay transports only public messages. The existing request/approval HMACs still authenticate admissions. The approving device asks the person to type the six-digit code the new device shows and signs only on a local match; it never displays its own code, and its third wrong entry ends the request (owner decision 2026-11-11 after design review `5b3fb2d9`, so a careless click cannot admit an attacker's device). This is approximately 20 bits of comparison, not the manual scheme’s 128-bit out-of-band authentication. Commitment ordering prevents selecting the responder key/nonce after observing the requester key. This is not a PAKE or a completed independent protocol audit.

A responder first reads its verified local personal identity; service metadata and an approved relay status grant nothing. Native preparation and reopen use the fixed account offer, placeholder endorser and workspace-derived session ID. The real signer is retained in the authenticated approval descriptor. Replacing those journal keys after approval loses the original identity on reopen.

The first foreground responder is fixed for an attempt. If it exits, help explicitly cancels and starts a fresh attempt with another device, retaining the device identity. Remount and Later resume within the same application owner; process restart loses the memory-only secret. The coordinator is separate from content readers and never overrides their close method. Expiry, refusal and cancellation dispose ephemeral material. Discovery records retain the hourly rate window, then indexed bounded cleanup removes them; account purge removes them too. Both relay protocols honor the existing emergency switch.

The real coordinator/HMAC workflow tests and native-host fixture cover admission, key installation and offline reopen. UI tests cover automatic advancement and Later/inbox resumption. These do not establish packaged iOS/desktop acceptance, suspended-app push receipt or independent protocol review.

Running desktop apps can show one generic OS notification per locally verified request while backgrounded; only clicking it focuses Lody. Discovery uses a live query subscription, with scoped polling on subscription failure and while waiting for native progress. No new APNs/FCM path wakes a suspended mobile app.

Approvals and their inbox hold [private telemetry surface leases](../../implemented/bug-fix/2026-10-29-workspace-telemetry-privacy.md) even above an ordinary workspace. Disposal occurs once admission is verified; waiting for a delayed content key does not retain the temporary pairing secret.

## Instant QR join (2026-11-12)

The owner asked that a phone join right after scanning, with no further step (session `207baaf6`, 2026-11-12). In the reverse direction the approving device signs every listed workspace as soon as a request under its own displayed code verifies, and names the requested workspaces it cannot approve. A first version revealed the code only on a click, so that a request sent by someone holding the account password could not put the bearer secret on screen. After reviewing that trade-off the owner chose to show it at once: a computer shows the code in the approval window as soon as a request arrives, the console's Add device action shows it immediately, and a phone shows its code only when asked, because a phone usually scans instead. The accepted cost is exposure of the displayed secret: screen sharing or a camera that captures it within ten minutes admits the viewer's device. The window states the split scope: scanning admits the phone to this device's encrypted workspaces, typing the six-digit code approves only the current workspace. Approval stays single-flight per offer and pauses while the window is hidden. The new device keeps the automatic discovery row open until the scanned join reports joined, ends its own scanned request when the join is cancelled or fails, and stops with an explanation when other workspaces joined but the current one cannot be unlocked by the approver. That stop comes from protocol state, not a timer: the request reports per-workspace coverage from verified approvals (`waiting`, `approved`, `omitted`), and an approver publishes only once every workspace it admitted has its invitation, so `omitted` is exact and a slow installation of an approved workspace is never ended. The approving side latches the verified request and resumes the same approval on every tick until it is delivered: `awaiting-delivery` and transient failures keep the code, and only a typed refusal ends it. Automatic-pairing relay calls are bounded, and cancelling settles locally and detaches the request before the relay notice, so an offline relay never blocks a fresh request.

A new computer also shows `lody://auto-pair?id=…&code=…` beside its six-digit comparison code. A phone approving the request scans it instead of typing; a scan for another request sends nothing, and a matching scan submits the code to the same local comparison and attempt counter. The same links opened from a phone's system camera reach the inbox or the join page. Phones and tablets scan; computers show codes, and the role follows the device rather than the window width.

Component tests in `packages/components/tests/e2ee-account-pairing.test.tsx` cover the immediate code in the window and its scope text, the single approval without a click, deferral after a code join, the scanned join that leaves discovery open, cancellation and partial joins, the request-id check, links from the system camera and the desktop/phone layouts. Real-camera decoding on iOS/Android, the native link delivery and packaged-app behavior are unverified.
