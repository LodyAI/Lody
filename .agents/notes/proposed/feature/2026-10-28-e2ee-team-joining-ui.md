# Team invitation and admission surfaces

Status: proposed
Translation: current

[中文](2026-10-28-e2ee-team-joining-ui.zh.md)

## Abstract

Personal-device pairing and ordinary organization membership do not provide a complete encrypted-team joining flow. The approved MVP has email invitations with automatic admission by a qualified online administrator device, and shared links with individual explicit approval. These surfaces retain pending progress, distinguish admission from key delivery, and reuse existing seat explanations. An unavailable applicant or optional directory stays separate from other members and ordinary workspaces; installed desktop and live service acceptance remain unverified.

## Decisions and boundaries

- Email invitations and revocable shared links expire after 48 hours. The native host prepares the signed KeyPackage; a link alone grants no membership. All invitations admit Member, and only Owner can promote to Admin. The existing ordinary invitation cap and seat policy remain service-owned.
- The independent invitation pin survives login, desktop deep links, and switching between tokens. Pending native originals are recovered before treating a source as expired. A failed submission, offline device, unknown append, and delayed key delivery expose resumable states rather than replacing the original request.
- Global background admission runs only for encrypted workspaces with projected Owner/Admin membership, then verifies the actual personal-device ledger role. It automatically processes email requests only. Each member failure is isolated, and the native reader is acquired and returned under its original account and owner cookie.
- The encrypted account directory supplies navigation and display labels, never device authorization. Optional directory failure cannot unload healthy ordinary work. Returning to a known ordinary route clears encrypted selection even when the route remounts during an outage; unresolved encrypted targets fail closed.
- The native team runtime and authenticated relay are separate companion changes. This independently based UI PR carries optional protocol declarations so it builds on main; an older host shows an upgrade message. Overlapping declarations should disappear on rebase after the runtime lands. Neither companion is stacked into this branch.
- Settings provides invitations, a per-request approval list, revocation, and Owner promotion. Pending link requests reuse PR20-D's settings attention marker, scoped to the verified manager/account/workspace; a queue failure cannot hide key-update attention. Member removal and rotation belong to a separate workstream.
- Role changes consume #1982's single optional `setMemberRole(workspaceId, membershipId, role)` port; no parallel `promoteMember` port/signing owner remains. On main without that companion the promotion action stays unavailable. The joining DTO lives once at `cloud-api/src/e2ee-members.ts`, with identical declarations in the independently based native companion.
- #1979 owns ledger capability state and snapshot/retained/digest v4. This UI adds no ledger state schema or snapshot version and delegates decoding to core. Merge the shared `memberRole` status field once, preserving #1982's identity fields and the native companion's reader ownership field. This branch is rebased onto main `6a53ad05` containing the protocol, without stacking its branch or issuing another format bump.

## Evidence and limits

Owning tests cover ordinary/encrypted routing, retained progress after a lost response or expired source, explicit link approval, email-only automatic admission, per-member failure isolation, offline recovery, optional directory errors, reader cleanup and the existing seat explanation. Real Storybook components supply narrow and desktop-width screenshots, including dark waiting and the expanded device-public-key details. Preview data is synthetic.

This is a draft implementation of the owner-approved direction. It does not prove real email delivery, Stripe charging, installed desktop deep links, native keychain behavior, two-account end-to-end joining, or cross-platform behavior. Browser preview is not installed-device acceptance. No saved ledger or ciphertext format is changed.
