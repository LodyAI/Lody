# Relations bar keeps MCP-created Sessions reachable

Status: implemented
Translation: current

[中文](2026-09-24-session-relations-bar.zh.md)

## Abstract

Sessions and Tabs created through `lody_session_create` were only visible as
in-stream "Session created" cards, which scroll away with the conversation, so
after a few turns the user lost track of what the Session had spawned and where
it came from. A pinned relations bar now sits directly above the composer info
bar: collapsed it is one info-bar-height row summarising the created count and
the opener; expanded it lists the opener, a divider, then every created Session
or Tab with its agent icon, title, and kind. The in-stream relation cards stay as
a record but shrink to one clickable line (label, title, status, arrow), since
the bar is now the persistent index. Verified with a jsdom behavior test and
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
- The bar shows when either direction exists, not only when children exist: a
  created Session with no children of its own still benefits from a persistent
  way back to its opener, and the header summary names both.
- It is a separate pill above the info bar rather than an info-bar item. The
  info bar's cluster/stage model stages exactly one item and has no expanded
  list form; forcing a navigation list into it would break that contract.
- The expanded list grows upward and caps at `max-h-64` with its own scroller,
  so the toggle row never moves under the pointer.
- The created list subscription lives in the `CurrentSessionRelationsBar` leaf:
  created Sessions change status often, and the conversation page must not
  re-render for it.

- `SessionRelationCard` (created-Session progress/completion and the
  "automatically created by" start card) is one `h-8` row button. The action
  label moved into the accessible name `"<action>: <title>"`, so selectors
  match the prefix; a reply preview or error stays inline and truncated.

## Verification and limits

`tests/session-relation-card.test.tsx` renders the connected bar over a real
metadata store and checks inclusion (independent Session + Tab), exclusion
(side chat, archived), the divider, and the exact Tab navigation target.
`Sessions/SessionRelationsBar` stories cover collapsed/expanded states. Not
verified in the packaged app with a live MCP fan-out.
