# Related-Sessions chip keeps MCP-created Sessions reachable

Status: implemented
Translation: current

[中文](2026-09-24-session-relations-chip.zh.md)

## Abstract

Sessions and Tabs created through `lody_session_create` were only visible as
in-stream "Session created" cards, which scroll away with the conversation, so
after a few turns the user lost track of what the Session had spawned and where
it came from. The composer info bar now carries a Related-Sessions chip (icon
plus created count); one click opens a popover above the bar listing the
opener, a divider, then every created Session or Tab with its agent icon, title,
and kind. A first version used a separate pinned bar; it was dropped because it
cost a full extra row of vertical space. The in-stream cards stay as a record
but shrink to one clickable line. Verified with a jsdom behavior test and
Storybook screenshots; not yet exercised in the packaged desktop app.

## Decision

- Source of truth is `SessionMeta.openedBySessionId`. MCP-created Tabs carry
  both `parentSessionId` and `openedBySessionId`, so a new
  `createdSessionsAtomFamily` keeps them (unlike `openedSessionsAtomFamily`,
  which serves the `⋯` menu and drops Tabs). Side chats are excluded because
  they already live in the right panel; archived rows are excluded like every
  other active relation list.
- Kind is `parentSessionId ? Tab : Session`. Tab rows navigate with
  `{ sessionId: root, tabSessionId }` so a Tab in another workspace restores
  precisely.
- The chip is a plain cluster action, like Preview: it never takes the stage,
  because the stage holds exactly one summary item and a navigation list has
  no summary form. `PopoverActionChip` in `info-chip.tsx` is the reusable shape
  (one click toggles a `side="top"` popover with the bar's popover chrome).
  Inside the bar it anchors to the whole pill via `InfoBarSurfaceContext` and
  Radix `virtualRef`, taking the pill's width, so the panel reads as the bar
  growing upward rather than a chip-sized dropdown.
- Rejected: a separate pinned bar above the info bar (the first iteration). It
  was always visible, but it doubled the chrome above the composer.
- The chip shows when either direction exists, not only when children exist: a
  created Session with no children of its own still needs a persistent way back
  to its opener. The count shows only created Sessions.
- Render cost: the page reads only a boolean (`useHasCreatedSessions`, a
  `selectAtom` over the created list) to decide whether to pass the chip, so an
  otherwise empty bar still hides. The chip subscribes to the list itself in the
  leaf; created Sessions change status often and the page must not re-render.
- `SessionRelationCard` (created-Session progress/completion and the
  "automatically created by" start card) is one `h-8` row button. The action
  label moved into the accessible name `"<action>: <title>"`, so selectors
  match the prefix; a reply preview or error stays inline and truncated.

## Verification and limits

`tests/session-relation-card.test.tsx` renders the connected chip over a real
metadata store, opens the popover, and checks inclusion (independent Session +
Tab), exclusion (side chat, archived), the divider, and the exact Tab
navigation target. `Sessions/SessionRelationsChip` stories cover closed/open
states. Not verified in the packaged app with a live MCP fan-out.
