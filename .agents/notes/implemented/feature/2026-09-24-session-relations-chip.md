# Related-Sessions tree keeps MCP-created Sessions reachable

Status: implemented
Translation: current

[中文](2026-09-24-session-relations-chip.zh.md)

## Abstract

Sessions and Tabs created through `lody_session_create` were only visible as
in-stream "Session created" cards, which scroll away with the conversation, so
after a few turns the user lost track of what the Session had spawned and where
it came from. The composer info bar now carries a Related-Sessions chip; one
click opens a panel above the bar with the complete opened-by tree the current
Session belongs to: every ancestor and descendant, one row per Session with its
Tabs as pills, each showing the same live status mark as the sidebar. Earlier
iterations (a pinned bar, then a flat opener/children list) were replaced; the
in-stream cards stay as a record but shrink to one clickable line. Verified with
unit and jsdom tests and Storybook screenshots; not yet exercised in the
packaged desktop app.

## Decision

- Source of truth is `SessionMeta.openedBySessionId`. The pure builder
  `lib/session-relation-tree.ts` walks up from the current row to the topmost
  live opener, then includes every descendant, so the panel is the same tree
  from any member. Tree edges connect rows (root Sessions): a precise opener
  that is a Tab resolves to its root through the sidebar's
  `resolveSidebarOpenerRowId`, but without the sidebar's one-level depth cap.
- A row is a root Session plus its top Tabs rendered as equal pills, matching
  the tab strip the user sees in that Session. Closed Tabs are hidden unless
  current, as in the tab strip (rows opened from a closed Tab still attach to
  its row); side chats and archived Sessions
  are excluded, so an archived opener ends the upward walk. Cycles stop at the
  first repeated row.
- The trailing kind badge (Parent / Session / Tab) was replaced by live status:
  the sidebar's `SessionRowStatusIndicator` (waiting > working > unread), so a
  status reads the same everywhere. The tree shape already says what is a Tab.
- Tab pills navigate with `{ sessionId: root, tabSessionId }`, so a Tab in
  another workspace restores precisely.
- The chip is a plain cluster action, like Preview: it never takes the stage,
  because the stage holds exactly one summary item and a tree has no summary
  form. `PopoverActionChip` in `info-chip.tsx` anchors its popover to the whole
  bar pill via the `@lody/ui` Popover `anchor` that resolves the enclosing
  `[data-info-bar-surface]`, so the panel reads as the bar growing upward. A
  React context carrying the pill ref was tried and removed: it forced a
  Provider around the whole pill for one consumer.
- Rejected: a separate pinned bar above the info bar (first iteration), because
  it doubled the chrome above the composer; and a flat opener + created list
  (second iteration), because it showed only one level in each direction.
- Render cost: the page reads only a boolean (`useHasSessionRelations`, a
  `selectAtom` over the active-Session list) to decide whether to pass the chip,
  so an otherwise empty bar still hides. The chip builds the tree in the leaf;
  related Sessions change status often and the page must not re-render.
- `SessionRelationCard` (created-Session progress/completion and the
  "automatically created by" start card) is one `h-8` row button. The action
  label moved into the accessible name `"<action>: <title>"`, so selectors
  match the prefix; a reply preview or error stays inline and truncated.

## Verification and limits

`tests/session-relation-tree.test.ts` covers the same tree from every member,
Tab openers, archived/side-chat exclusion, the closed-Tab rule, cycles
including a self-opener, and creation-time order from shuffled input.
`tests/session-relation-card.test.tsx` opens the chip inside the real info bar
and checks rows, the current marker, and the exact Tab navigation target.
`Sessions/SessionRelationsChip` stories render the tree with faked live status.
Not verified in the packaged app with a live MCP fan-out. Tab order follows
creation time, not a user's local tab reordering.
