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
- Member role changes use companion #1982's `setMemberRole` and management journal. The joining runtime has no separate promotion command, port or journal.
- Each asynchronous member operation captures the authenticated account and the actual native owner instance. Background readers carry an ephemeral ownership cookie; delayed cleanup cannot release a replacement namespace, including a reset under the same account.

## Evidence and limits

The owning runtime test uses real crypto, SQLite and synthetic authenticated safeStorage. It checks different accounts, immutable request recovery, modified credential binding rejection, genuine history verification, bidirectional encrypted payloads, an additional personal device, and offline reopen. Actual IPC boundary tests cover account/namespace replacement and reader ownership; preload tests cover the explicit renderer allowlist. Backend invitation policy and product UI are separately reviewed changes; they do not compile into this public host PR.

No installed desktop, real OS keychain, production relay, email, Stripe, or cross-platform acceptance is claimed. Full history bootstrap is bounded at 256 pages and 32 MiB; a workspace beyond that budget needs a reviewed bootstrap extension. This PR does not change the saved signed-ledger format or implement member removal/rotation UI.

## Removal and rejoin composition

This branch merges current main, including [member controls and local removal #1982](https://github.com/LodyAI/Lody/pull/1982). Its single `setMemberRole` port, native signing implementation and management journal supply Owner promotion. Joining adds no parallel role command, ledger state field or snapshot version; #1979 owns capability state and snapshot/retained/digest v4.

Authenticated removal still compares the originating account, workspace, genesis, signing key and credential, drains the native owner, then erases that incarnation. Cleanup now includes `member_joins` and `personal_join_histories`; otherwise installed origins would block or contaminate a new invitation. Credential-authenticated invitation calls use the existing shared removal classifier and terminal cleanup. A late old-credential response fails the identity comparison and cannot erase its replacement.

`acceptMemberJoin`, `acceptPersonalHistory` and `acceptPersonalJoin` share the marker completion rule: first verify the signed admission/history and its binding to the retained device, then clear a same-genesis removed marker only for a different signing key. Preparation and failed installation retain the marker. After cleanup, a fresh invitation generates a fresh device and credential; retries of the same unresolved request retain their exact originals.

The renderer continues using #1982's single local-data locator: account + workspace + genesis + signing key, with window-specific content namespaces. Successful joining enters the ordinary encrypted runtime admission path, which persists the new locator before opening content. It cannot select the old workspace-only cache or resurrect a removed instance.

Three real crypto/SQLite regressions cover removal followed by a new invitation through each installation entry, distinct membership/key/credential, failed install marker retention, Owner promotion, late old-credential protection, key delivery and offline reopen. The real IPC suite covers terminal cleanup from invitation-management endpoints; the renderer regression verifies that a replacement key selects and retains the replacement local instance. These are automated composition evidence, not installed-device or live-service acceptance.

## Protocol ownership

Public invitation DTOs have one declaration path, `packages/cloud-api/src/e2ee-members.ts`; platform and UI consume those types. The optional `E2eeWorkspaceRuntime` retains the merged signing-key/membership/role fields and `setMemberRole`, plus this PR's ephemeral reader ownership cookie. The native companion can be merged first; product invitation/settings surfaces are supplied by #1986. Neither independent branch stacks the other, and no temporary core overlay remains.

## Key delivery after admission

An approval used to return only after a complete `refresh()`, including a key round of up to four passes. On the packaged B④ run the relay had committed the admission while the approving desktop waited another 30 s. The admin card stayed disabled with no progress shown, and the email worker's call stayed in flight. `approveMemberJoin` now ingests the ledger once (`installKeys: false`), reads the relay result and returns `admitted` with `keyDelivery: 'pending'`. Delivery cannot undo admission. The joining device already gates "ready" on its own installed current key, so it never shows a joined workspace it cannot open.

Delivery belongs to the main-process `E2eeIpc` service, not to a renderer request. Each account/workspace has one in-flight round under a main-owned host reader, so closing every window does not stop it. The host keeps its own key-round single-flight and lock rules, and distribution still targets only verified ledger members. A failure records a public `e2ee_*` code (never key bytes, tokens or causes) and keeps `pairingFailure`. It then waits out a backoff that starts at 10 s, doubles per failure and is capped at 5 min. The next due `memberJoinRequests` or `memberKeyDeliveries` call retries it; the email worker and team settings poll these every 10 s. There is no separate timer or loop. An explicit retry skips the backoff. Member removal and device revocation are terminal and are not retried. Team settings show "Joined · sending key" until delivery succeeds and a retry action on failure. The join page adds that an administrator desktop must be online.

Blast radius: the trigger is a slow or failing relay, mailbox or staging request during a key round. It reaches only the delivery state of the members that round covers. Approval, the request list and other workspaces continue. Recovery is owned by the service instance for the app's lifetime, and retained records are capped at 32 per account/workspace. Quit, sign-out and account changes close the owner. A round in flight then fails `closed` or `account_mismatch`, and the record is not shown to another account. State is in memory only. After a restart, unfinished distribution is rediscovered by the core journals on the next full key round on this device, not by this record. That gap existed before this change.
