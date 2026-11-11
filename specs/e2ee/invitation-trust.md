# Where invitation trust comes from: server-delivered versus self-delivered

Status: draft
Translation: current

[中文](invitation-trust.zh.md)

## Scenario

An administrator invites a colleague to an encrypted workspace. The invitee needs to know which workspace they are joining: the workspace ID, its genesis, and the public key of an endorsing device. The administrator needs to know that the device being admitted is the invitee's. [Snapshot-first workspace invitations](snapshot-join.md) requires this information to arrive over an independent channel.

Email invitations do not meet that requirement. The server sends the email, assembles the genesis and endorser key in the link, and knows the invitation token. A dishonest server can do two things at once:

- Send the invitee an email pointing at a workspace the server forged. The invitee believes they joined the team; what they write is encrypted to the server.
- Use the real invitation's token to submit its own key first, have an administrator device admit it automatically, and read the real workspace.

Together, the server can relay content in the middle unnoticed. The invitation signature checked before automatic admission does not prevent this: at that point the invitee has no trusted key with which to verify a signature.

A link the administrator copies and sends does not have the first problem: it is generated on the administrator's device, and the genesis and endorser key never pass through the server. But the server still knows the token and can pose as the invitee, so these links currently require manual approval for every request, and the applicant's email and name that the administrator sees also come from the server.

## Decision

**Invitations fall into two classes by delivery channel, with different trust, and the interface says which is which. Only a channel that does not pass through the server can establish trust in both directions at join time.**

### 1. Email invitations: trust equals the server until verified

Email invitations stay, and so does automatic admission (conditions in whitepaper §4). They are a convenience, not independent verification:

- A member who joined by email is marked "unverified" in the member list; the invitee's own workspace shows "not yet verified with a team member".
- The mark restricts nothing. This matches the whitepaper's existing principle: use may begin after normal approval and machine checks, manual verification may come later, and an unverified state must be shown honestly.
- The invitation interface and the whitepaper state that an unverified email invitation is only as secure as the server is honest.

### 2. Self-delivered links: carry a secret the server does not know

When an administrator device generates a link it adds, besides the genesis, endorser key and token, a random 128-bit secret that lives only in the link fragment and is never uploaded.

- The invitee's client computes an authentication code over its own join request with that secret and submits it with the request.
- The administrator device that holds the secret verifies the code before signing the admission. A valid code shows that the request came from someone who received this link and that the device public key in it was not replaced by the server.
- A request that verifies counts as verified; neither side shows the unverified mark.
- A single-recipient link (admitting once) may be admitted automatically after verification, with no further click from the administrator. A shareable multi-recipient link still needs manual approval per person, because more than one person holds it.
- The secret is stored only on the device that generated the link. Other administrator devices cannot verify the code and handle the request as an unverified one with manual approval.

This path's guarantee depends on the administrator sending the link over a channel the server does not control, such as the team's existing chat tool or an in-person scan.

### 3. Verifying afterwards

A member who joined by email, or who was approved by a device without the link secret, can verify once afterwards: the invitee and any already verified member compare the [security code](whitepaper.md). The code binds the genesis, ledger position and permission state digest, so one comparison detects both attacks: a replaced workspace (different genesis) or a replaced invitee device (a different device public key in the state).

- On success, each side's client records locally that it verified at that position and clears the corresponding unverified mark. The record is local state; it is not written to the ledger or uploaded.
- A mismatch must raise an explicit warning, must not pick a side automatically, and tells the user to contact an administrator.

## Guarantees

- When joining through a self-delivered single-recipient link, a dishonest server can neither steer the invitee to another workspace nor have its own device admitted as the invitee, provided it cannot see the link.
- Email invitations and unverified requests always carry a visible unverified state until the user completes one security code comparison.
- Ledger record formats do not change; the link secret and authentication code exist only in the invitation link and in the request's transport data.

## Not guaranteed

- **While unverified.** Before verification, an email invitation does not resist a dishonest server. The mark makes that state visible; it does not stop an attack.
- **The channel itself.** If the administrator sends the link somewhere the server can also read, section 2's guarantee does not hold.
- **Real-world identity.** The authentication code proves the request came from someone holding the link, not who that person is.
- **Administrators with several devices.** The link secret is not synchronised between an administrator's devices; while the generating device is offline, other devices can only approve manually.

## Trade-offs considered

The owner agreed to the following directions in the review conversation on 2026-11-11; this Spec remains a draft until this revision's PR is approved.

1. **Unverified members are not restricted.** Barring them from remote machines, or making them read-only, until verified would turn an email invitation into "join, then do one more step before you can work". Only the state is shown.
2. **The default in the invitation interface is unchanged.** Email and the copied link sit side by side, and the copied link is labelled "no need to trust the server".
3. **A single-recipient link is admitted automatically once it verifies.** The authentication code already proves the request came from the link holder, so automatic admission does not lower security and saves a click.
4. **No pop-up reminders to verify.** The state is shown on the members page and the workspace security page only, to avoid warning fatigue.

## Evidence

- The server sends the email and assembles the genesis: the private backend's invitation email logic (not citable from this repository); on the public side `packages/components/src/lib/e2ee-member-offer.ts` reads those fields from the link fragment.
- Links are generated on the administrator device: `memberInvitationUrl(offer)` in `packages/components/src/components/settings/e2ee-team-settings.tsx`.
- Invitation signature check before automatic admission: `verifyAutomaticMemberAdmission` in `packages/e2ee-client/src/member.ts` ([#2549](https://github.com/LodyAI/Lody/pull/2549), not yet merged).
- Account-wide pairing already uses the same "secret never sent to the server" approach: [whitepaper §3](whitepaper.md).
- The security code interface exists; recording verification by position is not yet wired in: [whitepaper §5.2](whitepaper.md).

These are conclusions from reading code and documents; no tests were run. The exact construction of the authentication code is settled in format review before implementation.
