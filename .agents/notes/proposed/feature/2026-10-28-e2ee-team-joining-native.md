# Native team membership admission

Status: proposed
Translation: current

[中文](2026-10-28-e2ee-team-joining-native.zh.md)

## Abstract

Personal-device pairing alone cannot admit another account to an encrypted workspace. This change gives the desktop host a separate signed member request, tied to its account crypto identity and independently transferred genesis pin. A current personal Owner/Admin device signs the Member admission; normal mailbox delivery then gives the new device the retained key history. Pending requests, signed attempts and verified history survive restarts; unavailable peers affect the joining member while the existing workspace remains usable.

## Boundaries and decisions

- The optional public port exposes invitation pins, signed requests and progress. Credentials and private keys remain in the account-bound native host. Ordinary/local composition never starts this workflow.
- Email and shared-link requests have distinct sources. Automatic approval is limited to accepted email invitations; link requests require an explicit approval invocation. The authenticated cloud relay reserves account ownership and seats, while the real permission ledger grants membership.
- A joining desktop retains one exact KeyPackage before submitting. An approver retains each exact signed append before network I/O. Unknown outcomes reuse those bytes. Only verified competing ledger bytes permit a new parent; every prior attempt remains retained.
- A replacement invitation first reconciles the old request with the authenticated relay. Only a cancelled, expired unreserved, or rejected request can retire the local pending intent; an admitting/committed request remains recoverable. Installation and cleanup never erase an installed origin.
- Admission starts from the independently saved genesis and fully verifies bounded permission-history pages. No server-only role or unverified snapshot establishes a local identity. The existing mailbox supplies current and retained epoch keys.
- An admitted Member can approve another personal device of the same account. This does not admit another account or a machine/recovery identity; the server separately binds the publisher to that same current membership.
- Owner promotion uses the existing signed role command and retains original attempts before network I/O. Admins cannot promote, and unknown outcomes reconcile before another intent.
- Each asynchronous member operation captures the authenticated account and the actual native owner instance. Background readers carry an ephemeral ownership cookie; delayed cleanup cannot release a replacement namespace, including a reset under the same account.

## Evidence and limits

The owning runtime test uses real crypto, SQLite and synthetic authenticated safeStorage. It checks different accounts, immutable request recovery, modified credential binding rejection, genuine history verification, bidirectional encrypted payloads, an additional personal device, promotion, and offline reopen. Actual IPC boundary tests cover account/namespace replacement and reader ownership; preload tests cover the explicit renderer allowlist. Backend invitation policy and product UI are separately reviewed changes; they do not compile into this public host PR.

No installed desktop, real OS keychain, production relay, email, Stripe, or cross-platform acceptance is claimed. Full history bootstrap is bounded at 256 pages and 32 MiB; a workspace beyond that budget needs a reviewed bootstrap extension. This PR does not change the saved signed-ledger format or implement member removal/rotation UI.
