# Sidebar session rows and the opened-by tree

Scope: `packages/components/src/components` (sidebar renderers, `session-list.tsx`,
`sessions/session-list-rows.ts`, `lib/session-opened-by-tree.ts`) and the mobile chat
lists. Binding rules live in
[that directory's AGENTS.md](../../packages/components/src/components/AGENTS.md) and in
[mobile/AGENTS.md](../../packages/components/src/components/mobile/AGENTS.md); this page
explains why they are shaped that way.

## One gesture, every row

Session-mention drag is a product-level gesture, not a feature of one list. A row
renderer that omits it makes the same drag work in some lists and not others, which
users read as a bug rather than as a missing feature. The same applies to Mark as
unread in the shared ⋯ menu. When a row's whole surface is a navigation anchor, the
browser starts its own link drag unless `draggable` sits on the row and the anchor
opts out.

## Two fields, not one

`SessionMeta.openedBySessionId` records the Session that created another one — for
example through the `lody_session_create` MCP tool. It is presentation only: opened
Sessions keep their own workspace and lifecycle and stay first-class rows, while
`parentSessionId` children never reach the sidebar at all, so nothing can nest twice.

`openedByRowSessionId` exists because the precise opener may be a child Tab, which has
no sidebar row of its own. `buildSidebarOpenerRowResolver` walks `parentSessionId` up to
the root row to find something that can be indented under. Collapsing the two fields
into one by rewriting `openedBySessionId` to the root would break "Go to Opener Session"
and the conversation's "Opened by" entry, which must land on the exact Tab that created
the Session.

The resolver needs `allActiveSessions` because that is the only view that still contains
child Tabs; a list that re-derives the set from its own rows cannot resolve openers that
live outside it.

## Nesting inside one rendered list

Nesting is resolved inside a single rendered list, which is what keeps section
boundaries intact: a pinned opener and an unpinned opened Session are in different
arrays, so both stay top-level. The tree never hides a Session — a missing,
cross-section, cross-group, cycling, or deeper-than-one-level opener degrades to a
top-level row — and the preview cap counts top-level rows so a bucket's visible size
does not depend on how deeply it happens to nest.

Every list here is sorted by latest activity, so each surface passes `rootRank` and an
opener is ranked by its freshest opened Session. Without that, nesting would bury a
just-updated row under a stale opener and silently break the ordering contract of
Updated mode.

## The leading slot

The opener and unrelated top-level rows keep the exact flat-list alignment; only a child
widens the shared leading slot from 14px to 26px, which produces the 12px title indent
without shifting the row background. Status outranks the tree because a node can show
only one thing at its centre: an active child drops its trunk and elbow, and an active
opener drops its disclosure. Gating the opener on the whole activity set rather than
`isWorking` alone matters because the disclosure branch replaces the indicator — an
unread opener would otherwise render a chevron and lose its unread dot. The context
menu's expand/collapse item is then the only way to fold a busy opener, so it must stay
wired.
