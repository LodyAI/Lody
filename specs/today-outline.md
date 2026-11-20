# Today outline notes (experimental)

Status: draft
Translation: current

[中文](today-outline.zh.md)

## Scenario

When users open Lody each day they need a place to jot things down: prompts they plan to send later, memos,
and the conversations they are driving. Today is a minimal outline note, paged by day for each member. A node
can reference a Lody conversation and show its live status, and a node holding a written prompt can be
converted into a task in one step. It mounts as an experimental feature that can be switched on and off at
any time; when off it changes none of the app's existing behavior.

## Behavior

### Switch and entry

- Settings → "Experimental features" has its own "Today" row, stored on this device only. When on, a "Today"
  entry appears in the sidebar's top navigation; when off, the entry, the page and every subscription unmount
  immediately. The switch controls only the UI: data still syncs, exports and migrates.
- v1 covers desktop and Web; mobile does not show it.
- Today can fill the main area, or be pinned with the pin button at its top as a column right of the left
  sidebar (layout: left sidebar | Today | main area). Pinned state and column width are stored on this device
  only; the width is resizable. The pinned column sits directly on the sidebar background, continuous with the
  left sidebar, not as a floating card. Unpinning keeps the main area's current content and only hides the column.

### Page stream and dates

- Each member has one page per day in each workspace. A page's date is the writer's local `YYYY-MM-DD` when the
  page is created; it lives in the docId, so every viewer sees the same paging. "Today" at the top of the stream
  uses the viewer's own local date, including when viewing someone else's Today (the owner's time zone is not
  stored; across time zones this differs by at most one day).
- The stream scrolls vertically: today on top, then earlier non-empty dates downward, each with a date header.
  Today always shows, even when empty. Empty dates are skipped; a registered date whose content was cleared is
  not shown and its document is not deleted.
- Future dates are not part of the stream. The calendar entry jumps to any past or future date (even empty); the
  stream re-anchors with that date on top, followed by earlier non-empty dates. Registered dates carry a mark in
  the calendar (documents are not loaded to decide emptiness). Away from today a "Back to today" button floats.
- A page is created and registered on the first input of that day; viewing alone creates nothing. At midnight a
  new today appears on top and the current scroll position stays put.
- Every date's content is directly editable.
- Your own Today shows by default. The top more menu has "View a member's Today", which switches to any member's
  Today and allows editing; it takes no permanent space. The member list reuses the workspace's existing member
  source; with a single member (such as a local OSS workspace) the item is hidden. The more menu also offers
  "Copy link" to a member's page for a day. v1 shows no remote cursors or presence; concurrent edits merge via CRDT.

### Outline editing

- A node's content is plain text (no bold, links or other inline formatting in v1) and can be indented, folded
  and reordered. Shift+Enter inserts a line break inside the node.
- Keys (my call, following Logseq / BlockSuite conventions):
  - Enter splits at the caret; on an empty node that is nested and has no next sibling it outdents, otherwise it
    creates a sibling.
  - Tab indents under the previous sibling (expanding it if folded); Shift+Tab outdents directly, and the
    following siblings become its children (user decision).
  - Backspace at line start merges into the previous visible node, re-parenting children to it; if the previous
    node is a session node, it is block-selected instead.
  - ↑/↓ cross nodes only from the first/last visual line, keep the visual column, and skip folded subtrees;
    moving past a day's first/last node enters the adjacent date.
  - `Mod+Shift+↑/↓` moves a node with its children; `Mod+↑/↓` folds/unfolds; `Esc` enters block selection
    (user decision).
- Block selection: Esc, or a drag-selection leaving a node, selects whole nodes; Shift+↑/↓ extends; selected
  nodes can be copied, cut, deleted, dragged and indented. Cut and paste work across dates and across members'
  Today.
- Pasting multi-line text splits lines into sibling nodes, inferring hierarchy from indentation; a code block
  stays one node.
- Fold state is stored in the page document (synced with content).
- While an IME composition is active, Enter, Tab, Backspace and the `@` menu do not react.

### Node drag and drop

- The bullet is the drag handle. Moving more than 5px starts a drag; otherwise it is a click that opens the node
  menu.
- There is a single kind of drop target: an insertion line between two visible nodes, with depth chosen by the
  pointer's horizontal position; the node lands at the depth the line shows. A node with children, or folded,
  moves with its whole subtree; dragging a selected node carries every selected block. When the drop would make
  the node a child of a folded node, that node expands after a ~0.5s hover.
- Dragging works only within one day; over another date it shows "Can't move to another date" and the card
  flies back on release. Esc during a drag only cancels the drag.
- Dragging a conversation from any section of the left sidebar between two nodes creates a session node.
  Dropping into a node's text to make an inline reference is not supported.
- Visuals reuse the pinned section's floating card, 5px threshold and ~100ms settle animation, with an insertion
  line instead of opening a gap.

### Session nodes

- A session node references one conversation and shows only its live title and status; it has no editable text.
  Notes go in child nodes.
- Insertion: drag from the sidebar; type `@` (or full-width `＠`) at the start of an empty node to open the
  existing session menu, and choosing one converts the node; or paste a resolvable `lody://session` link into an
  empty node. Inline mentions are not supported. One undo returns to the `@query` text.
- Status matches the sidebar exactly by reusing the sidebar's status grouping and its unread, running and
  approval signals; Today derives nothing on its own:

  | Session status | Node display |
  | --- | --- |
  | Waiting for approval / question | Prominent status dot, highest priority |
  | Running | Spinning status dot |
  | Unread (not shown for agent-managed conversations) | Unread dot |
  | Later | The sidebar's countdown pill |
  | Settled, archived | Check mark + strikethrough + dimmed |

  Settled and related states depend on the sidebar status view (PR #2948) landing. v1 has no `Cmd+Enter` settle.
- Clicking the title opens the conversation (in the main area on the right when pinned, otherwise by
  navigating); clicking the row's blank area or bullet block-selects it. Reaching a session node with the keyboard
  block-selects it; Enter then opens the conversation and Backspace/Delete removes the node. The context menu
  reuses the sidebar's session menu.
- When the conversation was deleted or the current user cannot access it, the node shows "Conversation deleted /
  No access" without a title; the node stays until the user removes it. Removing a session node does not affect
  the conversation.

### Convert to task

- A plain node's menu has "Convert to task", which opens the new-conversation page's own component in a dialog
  without leaving Today, so everything that page supports (project groups, attachments, Agent Roles, …) is
  available:
  - The prompt is pre-filled with the node's text and all its children (including folded ones), joined by
    indentation, and is editable.
  - Machine, project, agent config and other defaults match the new-conversation page (the last choice); nothing
    is inherited from the outline context.
  - The dialog uses its own draft and leaves the page's draft untouched. Enter sends (not during IME composition).
- On success the node turns into a session node in place and its original children stay under it, folded; on
  failure the original node is unchanged. When pinned, the new conversation also opens in the main area on the
  right; otherwise Today stays.
- The new conversation is an ordinary conversation, listed in the sidebar with no extra marking.

## Data ownership

- One LoroDoc per page. Its docId is `today-<userId>-<YYYY-MM-DD>`, mapped to the Loro Stream
  `{workspaceId}:td:{userId}:{date}`. The docId is the loro-repo name (registration, local persistence,
  encryption binding); the Stream id is the network sync address, as with sessions, schedules and other docs.
- The userId inside the docId and the Stream id is always `encodeURIComponent`-encoded: local workspace userIds
  look like `local:…`, and the colon would otherwise break Stream id segmentation. docIds are parsed by taking the
  fixed-length date from the end. Today uses the same userId as `SessionMeta.userId`. The readable userId and
  date in Stream ids are visible to the server by design (content stays encrypted in encrypted workspaces).
- On a page's first write, `repo.upsertDocMeta` registers `{ userId, date }` in the meta flock. A member's dates
  are listed by docId prefix; the meta holds no content or summary.
- Page content: a `LoroTree` holds the outline structure (fractional-index ordering); each node's data holds a
  `LoroText` for its text, a session node stores `sessionId`, and fold state is stored alongside.
- Data is workspace-shared: every member can read and write every member's Today; neither the UI nor the sync
  layer distinguishes the page owner.
- Encrypted workspaces: document rooms are encrypted by docId automatically and the meta flock is protected too,
  so Today needs nothing extra.
- Nothing is written to SessionMeta and no Flock row family is added.

## Implementation constraints

- Each node's editor is Lexical. Only the node being edited mounts one; the rest render as identically styled
  static text, and a click computes the caret position from its coordinates before mounting. Cross-node caret
  movement and drag-selection are intercepted at node boundaries and hand focus over manually.
- A thin, plain-text-only binding between LoroText and Lexical is written in-house: remote changes apply as
  in-place deltas that also transform the caret, and are buffered during composition.
  `@datalayer/lexical-loro` and `@llui/lexical-loro` are not used; they are incompatible with this repository's
  Lexical 0.53.
- One Loro `UndoManager` per page, with Lexical's own history disabled. Split, merge, multi-line paste and
  conversion are each one undo step; undo and redo restore the node and caret. A cut and paste across dates is
  one step on each page, with no linked undo.
- The stream lazy-loads on scroll and releases documents far out of view; a date holding focus, a selection or a
  drag source is never released.
- The sidebar's pinned-row pointer drag bridge currently delivers only on release; it needs a hover callback to
  draw the insertion line. The change runs through pinned-section dragging and needs regression coverage there.
- Add the deep link `lody://today/<userId>/<date>?workspace=<workspaceId>` and register it in
  [deep links](deep-links.md); its userId accepts normalized `%XX` encoding, a deliberate exception to session links.
- No MCP tools are exposed; agents cannot read or write Today.

## Out of scope

- `Cmd+Enter` settle, inline mentions, inline formatting, images.
- Dragging across dates, a "move to date" action.
- Remote cursors and presence, restricting edits to the page owner.
- Agents reading or writing Today, mobile and native clients.

## Open question

- Whether the hosted backend allowlists Stream id segments; if so it must accept the new `td` segment. This
  repository cannot establish it.

## Evidence

- Existing doc prefixes and Stream mapping: `packages/shared/src/index.ts` (`getLoroStreamIdForDocId`),
  `packages/shared/src/schedule-registry.ts`
- Doc metadata registration and reads: `packages/components/src/lib/doc-meta-batch.ts`,
  `packages/shared/src/repo-doc-meta.ts`
- Encrypted room classification: `packages/shared/src/workspace-streams-content.ts`
- Experimental switch: `packages/components/src/components/settings/experimental-features-setting.tsx`
- Session mention source and links: `packages/components/src/components/mentions/mention-session-source.ts`,
  `packages/shared/src/session-link.ts`
- New-conversation defaults and selectors: `packages/components/src/lib/chat-landing-defaults.ts`,
  `packages/components/src/components/chat/chat-landing-selectors.tsx`
- Sidebar drag bridge: `packages/components/src/lib/session-mention-drag.ts`
- Live status: `packages/shared/src/live-activity-summary.ts`; status grouping in PR #2948
