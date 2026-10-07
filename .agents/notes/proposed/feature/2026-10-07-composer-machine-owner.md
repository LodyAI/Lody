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
cover persistence and fallback labels; actual browser screenshots and live
team-session verification are blocked in the current execution environment.

## Decision and limits

Use `sessionMachine.ownerUserId`, never `session.userId`. Reuse `UserAvatar` and the
already-read workspace-member list. Unknown ownership remains explicit; offline
identity remains available without adding a cache. A separate persistent identity
avoids hiding the requested information in a collapsed chip, at the cost of a
second row below 600px. The existing conversation Storybook harness supplies only
synthetic identity data and uses real composer/info-bar components.

The draft [Spec](../../../../specs/composer-machine-owner.md) describes intended
behavior. Review is pending: shell Chromium cannot create its startup socket and
the available browser rejects the local preview address. No screenshots were
produced and no visual fidelity is claimed. This change is being published as a draft PR; visual approval and live
team-session verification remain pending.
