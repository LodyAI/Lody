# Folded sidebar groups keep the status of the Sessions they hide

Status: implemented
Translation: current

[中文](2026-09-26-sidebar-folded-group-status.zh.md)

## Abstract

Folding a project, repo, machine or section in the sidebar hid every Session
inside it, including one waiting for permission, so folding was a way to miss
work that needed the user. A folded group now draws one status mark in the
same trailing column as the rows' marks, chosen by the rows' own priority
(waiting > working > unread), and puts the counts behind hover and the screen
reader label. The trade-off is deliberate: a glance answers "does anything in
here need me?", a hover answers "how much?", and expanding answers "which?".
Nothing is drawn for an expanded group, whose rows already speak. Measured
only in jsdom tests and Storybook screenshots, not with users.

## Problem

- Before this change a folded header drew its icon, name and chevron and
  nothing else. `SidebarSectionHeader` still accepted a `count` prop whose
  badge had been removed, and the
  [sidebar group note](2026-09-25-deep-sea-palette-and-sidebar-groups.md) listed
  "an activity dot on collapsed groups" as not done.
- Teammates' machines start folded, so a Session running there was invisible
  by default.
- The conflict is density against load. A header that listed each state (three
  marks, or counts) would restate the rows the user folded away, in a column
  that shows at most one 14px mark per row.

## Decision

- One mark per folded group, drawn by `SidebarGroupActivityMark`
  (`sidebar-row-shared.tsx`). It renders the row's `SessionRowStatusIndicator`,
  so the hand, the working grid and the unread dot are the exact marks a row
  draws. There is no new symbol to learn.
- Priority is the row's priority. `summarizeSidebarGroupActivity` counts each
  Session once, under the mark its row would draw, so the counts add up to the
  rows asking for attention. Working outranks unread, as it does on a row: a
  group with anything running is still busy, and the unread dot returns when
  the work stops.
- The mark sits at the header's trailing edge, which is the rows' status
  column. Screenshots confirm the same 27px inset from the sidebar edge for
  folded headers and for rows. Hover actions (⋯, new chat) fade in to its left,
  so the mark never moves.
- The counts ("1 waiting for approval · 2 working · 3 unread", zero terms
  omitted) have one home per header:
  - A project row appends them to its existing path tooltip and aria-label.
  - A machine header shows them as an "Activity" row in the machine card that
    already owns its hover, led by the same mark.
  - Repo, Chats, GitHub Worktrees, Pinned and Updated headers have no hover
    surface of their own, so the mark carries a tooltip.

  Two hover surfaces on one header would open together, so a header never gets
  a second one.

- The mark stays mounted while the group is folded and runs the row's
  `useWorkingHandOver`. When the last running Session finishes with new output,
  the header plays the same working → unread transition a row plays. When work
  stops with nothing unread, the grid holds for 1.5s, then goes quiet.
- The status covers only what folding hides. A project's pinned Sessions stay
  visible in Pinned, so they are not counted there. A folded GitHub Worktrees
  section counts every repo Session; a folded machine counts all its projects'
  Sessions, with child Tabs rolled up exactly as the rows roll them up.
- Computation runs only for folded groups, over data each list already holds
  (`liveSessionStatuses`, row flags). No new presence subscription is added.

## Alternatives

- **Counts on the header** (a number or pill per state): this repeats the count
  badge that was already removed, and pills read as decoration here. Rejected.
- **One mark per state, side by side**: three marks make the folded header
  noisier than the rows it replaces, and they break the one-mark column.
  Rejected.
- **Bold or tinted label for unread** (the chat-app convention): this adds a
  second channel that disagrees with the rows, and it cannot express running or
  waiting. Rejected.
- **A dot before the name**: the sidebar group note already rejected a leading
  status dot on machines, because it makes a group look like a different kind
  of section. The leading slot also holds the folder icon and avatar. Rejected.
- **Auto-expand a group when something inside needs attention**: this overrides
  the user's choice and shifts the list under the pointer. Rejected.

## Verification and limits

- `tests/sidebar-local-project-row.test.tsx`: a folded project shows the
  highest-priority mark, and its aria-label carries the counts. The mark
  follows live status changes, rests on the unread dot when work finishes, and
  draws nothing for an expanded or quiet project.
- `tests/session-list-pr-badge.test.ts`: a folded repo group shows the grid and
  its counts. When work stops, the grid holds for the hand-over window and then
  clears.
- `tests/sidebar-machine-card.test.tsx`: section headers draw only while
  folded, waiting outranks working, and the machine card lists the counts.
- Storybook: `Components/Sidebar/Folded Group Status` (Folded, Side by side)
  was checked in light and dark themes, with both hover surfaces.
- Not done:
  - A "Show all (N)" row and a folded opener (opened-by disclosure) also hide
    rows. They do not yet carry the status of what they hide.
  - The mobile home screen still shows its own unread-count pill.
