# Persistent machine ownership above the composer

Status: proposed
Translation: current

[中文](2026-10-07-composer-machine-owner.zh.md)

## Abstract

Team collaborators cannot reliably identify the execution machine's owner from
an icon or Session ownership. This review patch adds a persistent avatar, owner,
and machine label to the shared composer info bar using existing machine metadata
and workspace members. It stays outside the rotating cluster/stage model and
wraps the remaining controls onto another line on narrow screens. Component tests
cover persistence and fallback labels; synthetic desktop and narrow-screen browser
checks confirm that the identity labels render. Visual approval and live
team-session verification remain pending.

## Decision and limits

Use `sessionMachine.ownerUserId`, never `session.userId`. Reuse `UserAvatar` and the
already-read workspace-member list. Unknown ownership remains explicit; offline
identity remains available without adding a cache. A separate persistent identity
avoids hiding the requested information in a collapsed chip, at the cost of a
second row below 600px. The existing conversation Storybook harness supplies only
synthetic identity data and uses real composer/info-bar components.

The draft [Spec](../../../../specs/composer-machine-owner.md) describes intended
behavior. On 2026-10-10, the existing synthetic desktop and mobile Storybook
fixtures rendered visible owner and machine-name labels in Chromium. No
screenshots were captured. These checks establish component rendering with
fixture data, not live workspace-member resolution or visual approval.
Live team-session verification remains pending.

## Withdrawal

The user requested reverting this feature on 2026-10-11. Its implementation,
identity-specific stories, tests and translations have been removed; the original
info-bar layout is restored. This proposal is no longer active. See the
[revert decision](../../implemented/simplification/2026-10-11-revert-composer-machine-owner.md).
