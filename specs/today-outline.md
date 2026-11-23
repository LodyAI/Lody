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
- In the Chinese UI the feature is named 每日笔记 ("daily notes"; Obsidian likewise renders its "Today" short name
  as 日记), since 今天 reads oddly as a noun and 日志 suggests logs; the current day's heading stays 今天 and the
  return button 回到今天.
- The "Open Today" shortcut defaults to `⌘⇧D` (`Ctrl+Shift+D` on Windows/Linux; D for Daily, as Roam and Tana
  bind their daily page), the same on desktop and Web, and can be rebound or unbound in Settings → Keyboard
  shortcuts. It acts, and is listed in the shortcuts list and the command palette, only while the experiment is
  on; when pinned it moves the column like the sidebar entry.
  Hovering the sidebar's "New chat", "Today" and "Search" rows reveals their current binding as a pill at the row's
  end (the style of the ⌘1–9 pills shown while ⌘ is held), and holding the modifier shows them too.
- v1 covers desktop and Web; mobile does not show it.
- Today can fill the main area, or be pinned with the pin button at its top as a column right of the left
  sidebar (layout: left sidebar | Today | main area). Pinned state and column width are stored on this device
  only; the width is resizable. The pinned column is a page card like the main area's (the darker
  inset sheet, same radius and rim), anchored to the sidebar with 4px of window ground between it and the main
  card, so the two read as separate pages rather than one fused panel (user decision). With the sidebar hidden the
  pinned column is the window's leftmost surface: the sidebar toggle and Back/Forward move to its toolbar (right of
  the traffic lights) and leave the main page, which no longer clears the traffic lights; its content tightens so the
  content lines up with the leftmost traffic light (x 16–30): bullet dots centre on its right edge (x=30), fold
  toggles centre on its left edge (x=16), the date heading stays aligned with the dots' left edge, and the end
  gutter is 16px (user decision).
- A fold toggle sits flush against its bullet (centres 14px apart) and shows only while its line is hovered, focused
  from the keyboard or being edited; at rest a folded node is marked by its ringed dot. Unpinning keeps the main area's current content and only hides the column.
- Filling the main area, the stream sits in a centred readable column of at most 720px (compare Obsidian's 700px,
  Notion's ~708px and AFFiNE's ~752px of text) that narrows with the window and keeps side gutters; nesting
  indents within it. "Full width" in the More menu spans the whole main area instead, a global preference stored on
  this device rather than per day. A conversation dropped in the gutter beside the column lands in the day at that
  height.
  While pinned, a Today link to this workspace or the sidebar's Today entry only moves the column to that day; the
  main area likewise keeps its content.
- On desktop, a button beside the pin (page or pinned column) opens Today in its own window at the day shown, one
  window per workspace (opening it again raises it); the source window is unchanged. That window shows only the day
  stream, and its pin instead keeps the window above all other windows. Conversations its mentions open, by click
  or Enter, show in the primary window; Convert to task keeps Today in place. The window loads none of the workspace
  shell (sidebar, notifications, badges, command palette) and starts no background conversation prefetch: it
  syncs only the pages, metadata and live status it shows. Turning the experiment off closes it.

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
  source, each member shown with their avatar; with a single member (such as a local OSS workspace) the item is hidden. The more menu also offers
  "Copy link" to a member's page for a day. v1 shows no remote cursors or presence; concurrent edits merge via CRDT.

### Outline editing

- A node's content is plain text (no bold, links or other inline formatting in v1) and can be indented, folded
  and reordered. Shift+Enter inserts a line break inside the node.
- Keys (my call, following Logseq / BlockSuite conventions):
  - Enter splits at the caret; on an empty node that is nested and has no next sibling it outdents, otherwise it
    creates a sibling.
  - Tab indents under the previous sibling (expanding it if folded); Shift+Tab outdents directly, and the
    following siblings become its children (user decision).
  - Backspace at line start merges into the previous visible node, re-parenting children to it.
  - ↑/↓ cross nodes only from the first/last visual line, keep the visual column, and skip folded subtrees;
    moving past a day's first/last node enters the adjacent date.
  - `Mod+Shift+↑/↓` moves a node with its children; `Mod+↑/↓` folds/unfolds; `Esc` enters block selection
    (user decision).
- `Mod+A` widens step by step (user decision, after Logseq and the Obsidian Outliner plugin): while editing it first
  selects the node's text; once the text is all selected (or empty) it selects the node; each further press selects
  the parent (several selected nodes go to their lowest common ancestor); at the top it selects the whole day and
  then stops. It never selects across days.
- Block selection: Esc, or a drag-selection leaving a node, selects whole nodes; selected nodes can be copied,
  cut, deleted, dragged and indented. Selecting a node includes its whole subtree, and the highlight shows it.
  A selection spanning levels indents and outdents each run of adjacent siblings on its own, as one-by-one
  would; moving up or down applies only to one run of adjacent siblings under one parent, and does nothing
  otherwise. In block selection (also after it emptied the page) `Mod+Z` / `Mod+Shift+Z` undo and redo as
  usual, plus `Ctrl+Y` on Windows/Linux.
- Shift+↑/↓ while editing: away from the first/last line the browser extends the selection by a line inside the
  node; on the first/last line the selection first extends to the node's start/end; once it is already at that
  edge, the next press selects the current node only. Further Shift+↑/↓ extend or shrink from that anchor node,
  keep a block selection when shrinking back to it, flip past it, and never cross days. Esc on a selection made
  this way returns to the original text selection (user decision). On macOS ⌥⇧↑/↓ stay with the system's
  paragraph selection; moving nodes uses `Mod+Shift+↑/↓`. Cut and paste work across dates and across members'
  Today.
- Pasting multi-line text splits lines into sibling nodes, inferring hierarchy from indentation; a code block
  stays one node.
- To-dos (user decision): `Mod+Enter` cycles a node through plain text → to-do → done → plain text; with a block
  selection every selected row advances from its own state, as one undo step. A to-do shows a checkbox between its
  bullet and its text; clicking it swaps to-do and done, and a done node's text is struck through and dimmed. Enter in
  a to-do starts another unchecked to-do, and Enter on an empty to-do turns it back into text. Copies write Markdown
  task markers (`- [ ]`, `- [x]`), and pasting reads them back.
- Selection bar (user decision): once the pointer is released, a block selection shows a small bar floating above
  it (below when its top is scrolled out of view) with the to-do step, Convert to task, Copy and Delete. The bar never
  takes focus, so the selection's keys keep working.
- A bullet shows a halo under the pointer, marking it as a control. A line with no text, no children and no to-do
  state hides its dot until its row is hovered, edited or selected (user decision).
- Fold state is stored in the page document and synced with it, and a page opens with its stored folds; but a
  peer folding or unfolding a node does not change the view of someone already looking at the page until they
  fold or unfold that node themselves (user decision). Folding is not an undo step.
- While an IME composition is active, Enter, Tab, Backspace and the `@` menu do not react.

### Focus view

- User decision, after Workflowy and Logseq. A day's date heading opens that day alone; clicking a bullet (or `⌥→`)
  zooms into its node, showing only it and its subtree. The top-left of the Today toolbar then shows a breadcrumb,
  "Today › YYYY-MM-DD › ancestors › node", each part a way back; "Today" returns to the stream at the scroll
  position it had (anchored to the top visible row, so peers' edits above do not shift it). Middle ancestors fold
  into "…" past five parts.
- Zoomed in, the node's text is the view's editable title (no bullet) and its children list below from depth 0,
  even if the node is folded. Enter in the title starts a first child; the caret, Mod+A, drags and drops,
  Backspace/Delete merges and the caret after a deletion stay inside the subtree; the node itself is not indented,
  outdented, moved, merged or deleted from its own view, and its direct children do not outdent out of it: Enter on
  its empty last child adds another child instead (as in Logseq), so repeated Enter and Shift+Tab keep every line
  inside the subtree. A node deleted meanwhile shows "This node was deleted." with a way back.
- A zoomed node without children shows a "+" where its first child's bullet would be while the pointer is over the
  surface (always on touch screens); clicking it, or anywhere on the surface's empty area, starts that child with
  the caret in it, as one undo step (user decision, after Logseq's add button).
- Keys: `⌥→` zooms into the edited or selected node and `⌥←` goes up one level (node, parent, day, stream). On
  Windows and Linux they always apply; on the Mac, where `⌥←/→` move by word, they apply in block selection and
  while editing only from the node's end (`⌥→`) or start (`⌥←`). `⌘.`, `⌘,` and `⌘[` keep their app bindings;
  on the full page the browser's Back leaves the focus, since the focus is part of the route (`focus=day|<id>`).
  The pinned column and the Today window keep it in their own state.
- Hovering a row shows a "⋯" button left of its fold toggle (at the row's end when the column sits at the window's
  edge, where there is no margin); it and a right-click on the bullet open the node's menu: Zoom in, the to-do step,
  Convert to task, Copy and Delete. The node shows selected while the menu is open.

### Node drag and drop

- The bullet is the drag handle. Moving more than 5px starts a drag; otherwise it is a click that zooms into the
  node (Focus view).
- There is a single kind of drop target: an insertion line between two visible nodes, with depth chosen by the
  pointer's horizontal position; the node lands at the depth the line shows. A node with children, or folded,
  moves with its whole subtree; dragging a selected node carries every selected block. When the drop would make
  the node a child of a folded node, that node expands after a ~0.5s hover.
- Dragging works only within one day; over another date it shows "Can't move to another date" and the card
  flies back on release. Esc during a drag only cancels the drag.
- Dragging a conversation from any section of the left sidebar between two nodes creates a node holding its
  mention.
  Dropping into a node's text to make an inline reference is not supported.
- Visuals reuse the pinned section's floating card, 5px threshold and ~100ms settle animation, with an insertion
  line instead of opening a gap.

### Conversation mentions (mention blocks)

- A conversation appears as an inline mention block inside a node's text; text can be written before and after
  it. It shows the live title in link color, led by a status icon. In data each mention is one character
  (U+FFFC) of the node text carrying a `mention = {kind: 'session', id}` mark (`expand: none`); there is no longer
  a whole-row session node kind. An unknown `kind` shows as a grey placeholder and is kept as-is when copied.
- Insertion: typing `@` (or full-width `＠`) anywhere opens the conversation menu and inserts the mention in place;
  one undo returns to the `@query` text. Pasting a resolvable same-workspace `lody://session` link (bare or
  Markdown) anywhere converts it to a mention. Dragging a conversation from the sidebar between two nodes creates
  a node holding just that mention.
- Caret: a mention takes one caret position. With the caret right after it, ← first selects the whole mention
  (highlighted); a second ← moves before it; → is symmetric. Backspace after it (Delete before it) first selects,
  the second press deletes; `Alt/⌘+Backspace` deletes at once. Enter on a selected mention opens the conversation,
  like clicking its title (in the main area when pinned, otherwise by navigating). Typing replaces a selected mention.
- Status matches the sidebar exactly by reusing its status grouping and unread, running and approval signals;
  Today derives nothing on its own. Icon priority (static 12px icons, circles except the hand):

  | Conversation status                       | Leading icon                                      |
  | ----------------------------------------- | ------------------------------------------------- |
  | Waiting for approval / question           | Blue raised-hand icon                             |
  | Running                                   | Blue ring, right half filled (static, no motion)  |
  | Later                                     | Blue clock ring + countdown (same blue, baseline) |
  | Done (settled), archived                  | Dimmed grey check ring, same grey as struck title |
  | Unread (not shown for agent-managed ones) | Small solid blue dot; title not bold              |
  | Idle                                      | Blue dashed ring                                  |

- Clicking the status icon opens a status menu that changes the conversation's status (writing the same session
  metadata as the sidebar): Mark as unread / Mark as read (whichever applies), Later (presets and custom, reusing
  the sidebar's), Done, Move to Focus (only when Later or Done).
- When the conversation was deleted or the current user cannot access it, the mention shows "Session deleted / No
  access" without a title; it stays until the user removes it. Removing a mention does not affect the
  conversation.
- In plain text (copy, the Convert to task prompt) each mention is written as
  `[@Title](lody://session/<id>?workspace=<id>)`.

### Member mentions

- The `@` menu also lists workspace members (user decision, after Feishu): tabs "All", "People" and "Sessions";
  "All" shows the first matches of each kind, people first. People show only in a workspace with other members.
- A member mention is the same one-character mention with `kind: 'member'` and the member's userId as `id`. It shows
  as a tinted pill with the member's avatar and current name; clicking it opens that member's Today. A member no
  longer in the workspace shows as "Unknown member". Mentioning someone sends no notification.
- In plain text a member mention is written as `@Name`. Clients that predate member mentions show the
  "Unsupported reference" placeholder and keep the mark.

### Convert to task

- The selection bar has "Convert to task" while one node (with its subtree) is selected, which opens the new-conversation page's own component in a dialog
  without leaving Today, so everything that page supports (project groups, attachments, Agent Roles, …) is
  available:
  - The prompt is pre-filled with the node's text and all its children (including folded ones), joined by
    indentation, and is editable. When the node has parents, the prompt by default nests it under them as one
    indented list (user decision); an "Include parent nodes" checkbox switches between the two forms while the
    prompt is unedited.
  - Machine, project, agent config and other defaults match the new-conversation page (the last choice); nothing
    is inherited from the outline context.
  - The dialog uses its own draft and leaves the page's draft untouched. Enter sends (not during IME composition).
- A selected node shows its subtree as selected too: what Convert to task will take.
- On success, if the node's text is unchanged, the line becomes a line holding only the new conversation's
  mention, its original children kept under it, folded; if the text was edited meanwhile, the mention is inserted
  at the line start without overwriting the edit. On failure the original node is unchanged. When pinned, the new conversation also opens in the main area on the
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
- A failed registration or room join retries with exponential backoff, at most 5 minutes apart, while the page is
  open, so failures do not keep loading the backend. A local edit retries a registration (a local write) at once but
  never cuts a join's backoff short. A room whose subscription exists but whose first sync failed keeps that
  subscription and heals inside the SDK, as session rooms do. Opening a page that holds local content but was never
  registered registers it then, so one failure cannot leave notes local-only.
- Page content: a `LoroTree` holds the outline structure (fractional-index ordering); each node's data holds a
  `LoroText` for its text (conversation mentions are marked characters in it); fold state and the to-do state
  (`todo: 'todo' | 'done'`, absent for plain text) are stored alongside. A client that does not know the to-do key
  ignores it and shows the node as text.
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
- Performance target (user decision): a single day of 30,000 nodes, 7 levels deep and about a million characters
  scrolls and edits without visible stutter. A day of 200 or more visible rows mounts only the rows near the
  viewport, plus the row being edited wherever it is (unmounting it would end its editor and IME composition).
  The page model keeps its snapshot incrementally: typing updates only the edited rows, and a structural change
  rebuilds the visible rows from a JS mirror of the tree without reading every node from the document. The
  `Today/Stress` story holds the benchmark outline.
- The sidebar's pinned-row pointer drag bridge currently delivers only on release; it needs a hover callback to
  draw the insertion line. The change runs through pinned-section dragging and needs regression coverage there.
- Add the deep link `lody://today/<userId>/<date>?workspace=<workspaceId>` and register it in
  [deep links](deep-links.md); its userId accepts normalized `%XX` encoding, a deliberate exception to session links.
- No MCP tools are exposed; agents cannot read or write Today.

## Out of scope

- Inline formatting, images. Hiding or archiving done nodes; completing a parent does not touch its children.
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
- Today window: `apps/electron/src/main/today-windows.ts`, `packages/components/src/routes/$workspaceName/today-window.tsx`
