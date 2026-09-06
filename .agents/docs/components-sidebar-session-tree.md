# Sidebar session rows and the opened-by tree

Scope: `packages/components/src/components` (sidebar renderers, `session-list.tsx`,
`sessions/session-list-rows.ts`, `lib/session-opened-by-tree.ts`) and the mobile chat
lists. Binding rules live in
[that directory's AGENTS.md](../../packages/components/src/components/AGENTS.md) and in
[mobile/AGENTS.md](../../packages/components/src/components/mobile/AGENTS.md); this page
explains why they are shaped that way.

The desktop entry points include `loro-sidebar.tsx`, `loro-app-sidebar.tsx`,
`sidebar-*.tsx`, and the grouped `session-list.tsx`. Local-project sections and
`sidebar-updated-session-list.tsx` (Updated and Pinned) use the same tree, with
`sidebar-navigation-model.ts` keeping keyboard navigation aligned with rendered rows.

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

`sessionListAtom` excludes child Tabs from sidebar rows. The shared
`sidebarCollapsedOpenedBySessionsAtom` holds collapse state, initially expanded.
Navigation connects the tree, each row's "Go to Opener Session" menu entry,
`SessionHeaderMenu.openedByRelations`, and conversation cards for successful create
Operations or the precise opener. Mobile applies the same two-field tree per bucket
without the desktop disclosure.

Lifecycle traversal follows both relationships. Child Tabs share the root's machine
archive/restore/delete command; independently opened descendants enqueue their own.
The archive list preserves opened-by indentation, while child Tabs stay within their
owner's archived-tab UI. These are separate traversal and presentation responsibilities,
not a reason to collapse the two relationships into one.

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

## The leading slot, and why status left it

The opener and unrelated top-level rows keep the exact flat-list alignment; only a child
widens the shared leading slot from 14px to 26px, which produces the 12px title indent
without shifting the row background.

That slot used to hold status as well, with status winning: an active child dropped its
trunk and elbow, and an active opener dropped its disclosure, because a node can show
only one thing at its centre. The cost of that rule was backwards. Working, unread, and
waiting rows are precisely the ones a user is tracking through a tree, and they were the
only rows whose nesting silently disappeared — a group of opened Sessions looked like a
group right up to the moment any of it started running, and then looked like a flat list
with a stray indent.

So status moved to the row's END slot instead, where it replaces the resting metric
cluster (line diff, `Mergeable`, worktree glyph, PR icon, time) for as long as it lasts.
Both halves of that are deliberate. The leading slot now draws the tree unconditionally,
so nesting is a stable fact about the list rather than a function of activity. And the
end slot still shows one thing at a time: a running row reads `[├─ title ......... ◌]`,
with nothing competing for the right edge and more room for the title. Nothing is lost —
the diff, branch, and PR detail were already in the desktop hover info card, which is
where a user goes when they want numbers rather than a glance.

The mobile chat rows still keep status on their leading node; their geometry (48px
indent, a selection checkbox in the same slot, a chevron that has to sit outside the row
button and lift above the edge-back swipe zone) is different enough that the change is a
separate one to make.
