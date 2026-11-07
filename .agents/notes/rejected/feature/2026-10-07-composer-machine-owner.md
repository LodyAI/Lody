# Persistent machine ownership above the composer

Status: rejected
Translation: current

[中文](2026-10-07-composer-machine-owner.zh.md)

## Abstract

Rejected on 2026-10-11: the user asked to revert the feature, its implementation
was removed in [#1431](https://github.com/LodyAI/Lody/pull/1431), and a persistent
owner avatar and name made the composer info bar crowded. The proposal aimed to let
team collaborators identify the execution machine's owner by adding a persistent
avatar, owner and machine label to the shared info bar, wrapping the remaining
controls onto a second line on narrow screens. Keep this record to prevent
reintroducing an always-visible owner; ownership now lives in the on-demand
[machine details card](../../implemented/feature/2026-10-11-composer-machine-info-card.md).
Visual approval and live team-session verification never happened.

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

## Why rejected

The user requested reverting this feature on 2026-10-11 because a persistent owner
looked crowded in the composer info bar. Its implementation,
identity-specific stories, tests and translations have been removed; the original
info-bar layout is restored. This proposal is no longer active. See the
[revert decision](../../implemented/simplification/2026-10-11-revert-composer-machine-owner.md).
