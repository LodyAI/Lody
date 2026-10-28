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
example through the `lody_session_create` MCP tool. Opened Sessions keep their own
workspace and stay first-class rows. Archive follows the opened-by descendants as
well as contained Tabs; restore and deletion still use direct containment only. See
[Session relations](../../specs/session-relations.md). Meanwhile,
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
cross-section, cycling, or deeper-than-one-level opener degrades to a top-level
row — and the preview cap counts top-level rows so a bucket's visible size does not
depend on how deeply it happens to nest.

Workspace mode groups rows by work context, so an opened Session often lives in
another group than its opener: a Role dispatched from a Local Project to another
Machine becomes a plain chat or a GitHub-repository Session. Before the groups build
their trees, `placeWorkspaceSessionsWithOpeners` (`sessions/session-list-rows.ts`)
moves each such row into the group of its topmost rendered ancestor, so the fan-out
stays legible. The row leaves its own group, keeping every Session in exactly one
place for keyboard navigation and counts; it travels with its opener when that group
is folded. Only rendered groups take part, so an opener in a hidden project, the
Pinned section or the archive leaves the row where it was. A Local Project Session
joining a task group becomes a task row, and a local group's hover card names the
moved row's own Machine rather than the project's. Two alternatives were rejected:
making the remote Session a `parentSessionId` child, which would break the child
contract of one shared machine and workspace, and showing the row in both groups,
which would duplicate navigation targets. Updated mode is one list and already nests
across contexts; mobile lists still nest per bucket.

Every list here is sorted by latest activity, so each surface passes `rootRank` and an
opener is ranked by its freshest opened Session. Without that, nesting would bury a
just-updated row under a stale opener and silently break the ordering contract of
Updated mode.

Workspace-mode GitHub groups and local projects share the same five-root preview.
Their Show all state is part of the flattened keyboard-navigation projection, and
folding either group clears that state so reopening starts compact again. Local
project keys are namespaced by machine and project because the same state map also
contains repository full names. See the
[decision note](../notes/implemented/feature/2026-09-17-local-project-session-preview.md).

## Two-line desktop rows

When `Show Branch` is on, GitHub worktree sessions show a second line with branch and relative time. A local-project
session gets that line only when `isWorktree` is true; a GitHub repo association on a direct
local session does not make it a worktree. Direct local rows stay one line even when they carry
repo or PR metadata, while the hover card retains the branch and time details. Chats, mobile
rows and nested children also stay one line. `Show Branch` starts off when no choice has been
saved; a persisted user choice remains in effect. In Workspace mode it controls the combined
branch/time line. See the [default decision](../notes/implemented/feature/2026-10-19-sidebar-branch-details-off-by-default.md).
The loading skeleton keeps its single-line anatomy; the optional meta line appears when the
rows load and the branch preference is on. Two-line local worktree rows use
`sidebarSurface.tall`; the leading and end slots sit in a box one title line high so they stay
on the title line. The first child climbs the opener's metadata line only when that local opener
is a worktree and `Show Branch` is on; Updated-mode openers keep their own two-line geometry.
Work, wait, unread and send status is still the end slot's alone; +/- totals stay in the hover card.

## The leading slot, and why status left it

The opener and unrelated top-level rows keep the exact flat-list alignment; only a child
widens the shared leading slot from 14px to 26px, which produces the 12px title indent
without shifting the row background. The node and its hover menu share a 7px centre:
replacing a disclosure or connector with ⋯ therefore leaves the title in place. The
context-menu expand/collapse action uses the disclosure's callback, so either route
changes the same tree state.

The connector is drawn from the slot, but its length encodes the ROW, and it reads the
row's height instead of assuming one. A row is a 1px border, 3px of padding and one title line
(the subheadline leading: `8px + leading`, 26px at the default size), and the slot is
centered in it, so the trunk reaches `(row - 14px) / 2` above the slot and that plus the
list's 1px `gap-px` below it. One row's trunk then ends where the next one's begins and a
nested group reads as one continuous line. The row height is `--sidebar-row-height`;
unset, it is the app's one-line row, and a list with a different box (the anonymous
share reader's `py-1` around a body line) publishes its own on its row container. A
first child under a two-line Updated-mode opener also climbs the opener's project line
(4px gap plus one footnote line). Every row type draws its title, leading slot and end
slot in `SIDEBAR_ROW_LINE_CLASS` (one subheadline line), never a fixed `h-5`: a fixed
height is how Updated rows stayed 30px after Workspace rows became 28px and the trunk
began to overlap into a darker notch at every row. Row lists also paint-contain every
direct child (`content-visibility: auto`), so a trunk cannot cross the `gap-px` between
rows by overflowing; `SessionOpenedByTreeRow` owns that pixel as padding and returns it
with a negative margin, which keeps the pitch and puts the trunk's last pixel inside the
box that clips it.

Row selection is painted by the TITLE box, not by the row: the trunk and elbow pass
through the gutter of rows they do not belong to, and a tint stretched across that
gutter interrupts the line it crosses. The app's sidebar rows tint the whole row
because their gutter is inside the tinted box already; a reuser that indents the
highlight instead must keep it clear of the 7px connector centre.

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
