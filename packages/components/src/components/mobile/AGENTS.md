# components/mobile — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Mobile-shaped responsive surfaces shared by narrow web and desktop renderer
layouts. The Capacitor application is outside this repository; keep native-only
behavior behind explicit platform capabilities.

## Navigation stack & swipe-back gestures (read before touching gestures)

Two families of swipe-back, split by how the surface animates:

- **Full-screen Vaul `<Drawer direction="right">`** — the session
  (`mobile-workspace-stack.tsx`: SessionDetail layered over the always-mounted
  home/chat landing) and the Files / opened-file / PR / Browser drawers
  (`../sessions/session-detail.tsx`). They keep Vaul's interactive drag but gate
  it to a left-edge zone because vaul@1.1.2 drags a right drawer from any
  pointerdown unless the target has `data-vaul-no-drag`. Use `VaulDrawerBody`
  (`vaul-drawer-edge-back-zone.tsx`), which marks content no-drag and mounts the
  only drag-start zone; this keeps code blocks, wide tables, and the no-drag
  image viewer from fighting dismissal. **Invariant: the zone must never overlap
  a header back button** — pass `topInset` = chrome above the body:
  Files/opened-file/PR/Browser use their mobile drawer header inset, the session
  uses `SESSION_DRAWER_BODY_TOP_INSET`.
  **Browser must be a nested Vaul drawer, not a sibling `createPortal(document.body)`
  panel** — the session is already a body-portal Vaul drawer at `z-50`, so a
  second body-level `fixed z-50` surface lands under the conversation (invisible
  until the session drawer closes and flashes). Managed preview iframes survive
  drawer remount via `managed-preview-frame-cache.ts`. While the session drawer
  is closing, sticky-mount SessionDetail for the exit animation but clear
  nested `urlPr` / `urlBrowser` flags so PR/Browser do not stay open over Home.
  The Files drawer nests the two families: `MobileProjectFileBrowser` mounts its own
  `MobileEdgeBackSwipeZone` (z-60) while inside a folder, so an edge swipe pops one
  directory level and only the root swipe reaches Vaul's z-30 strip and closes the
  drawer. Keep those z values apart if either zone moves.
  Native only; web mounts no zone but content stays no-drag. Session drawer close
  must replace to the remembered `/chat` base; raw `history.back()` can pop
  duplicate session entries left by PR/Browser and leave Vaul half-transformed.

  Body portals inside these drawers can lose touch/scroll because Radix/Vaul's
  modal layer treats them as outside the drawer. Prefer the nearest
  `data-vaul-no-drag` portal target for overlays that must be interactive.
  The session composer's shell AND the `SessionInfoBar` glued above it must stay
  above the edge strip (`z-40` over the strip's `z-30`, via each one's
  `protectFromEdgeBackZone`). The strip is 48px wide and otherwise covers most of
  the leftmost attachment button and the left half of the info bar's leading chip
  (its first chip starts at x=22), leaving them effectively untappable. Keep
  those two protected rather than shrinking the swipe zone; the message body
  still owns the edge-back gesture.
  That `z-40` trick does NOT transfer to anything inside the message list:
  virtua's `VList` sets `contain: strict`, so the list is its own stacking
  context and no row can paint above the strip. A left-edge control in a row can
  only be rescued by insetting it past `EDGE_ZONE_PX`. The assistant turn action
  bar (`data-assistant-turn-actions` in `../ai-gui/view.tsx`) does that with a
  leading turn-duration label reserving
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` (>= `EDGE_ZONE_PX`, pinned by
  `tests/assistant-turn-action-inset.test.ts`); without it the copy button sat
  at x=24..52 with only ~4px tappable. That label is load-bearing layout, not
  decoration — the reserved width must survive an empty/unknown duration, and
  `WorkedGroupHeader` drops its own duration on mobile so the same value is not
  printed twice. Do not put another control ahead of it.
  Full-screen right drawers need `border-l-0!`; plain `border-0` loses to
  Vaul UI's `data-[vaul-drawer-direction=right]:border-l` specificity.

- **CSS-keyframe / framer drill pages** — settings, project, file browser
  (`mobile-drill-page-layout.tsx`). Not Vaul, so no interactive drag: use
  `mobile-edge-back-swipe.tsx`
  (`MobileEdgeBackSwipeZone`), a 48px `@use-gesture` strip that fires `onBack` on
  release, then the page plays its own exit slide. Same back-button invariant:
  mount it inside a body-only `position: relative` region.

## Responsibility split (rest of the directory)

- Screens: `mobile-home-screen.tsx`, `mobile-project-screen.tsx`,
  `mobile-chat-landing-screen.tsx`, `mobile-archive-screen.tsx`.
- Home dock tabs: `mobile-home-screen.tsx` `workspaceTabSpecs` builds
  Inbox / Chat / Tasks / Projects. Inbox only renders when the caller passes
  `showInboxTab` (multi-member workspace AND the developer-mode Inbox beta gate);
  Tasks only renders when the caller
  passes `showTasksTab` (Tasks beta gate — see
  `../tasks/AGENTS.md`); its body is the shared `TasksListBody mobile
embedded` lazy-imported from `../tasks/tasks-workspace.tsx` (`embedded`
  skips safe-area BaseHeader under the home chrome), and the chat/projects
  group stays mounted-but-hidden so pull-to-refresh and scroll position
  survive tab round-trips. Sticky header is one chrome row:
  workspace | search (middle blank) | archive/settings. Search fills the
  gap between avatar and trailing discs at rest; on pull (or ambient
  offline/reconnect/refresh) search does a fast top→bottom fade
  (`HEADER_SEARCH_EXIT_MS` = 150ms) and only then does the
  connection/pull status pill mount — never overlapping. The pill is
  absolutely centered on the h-9 chrome row. The Chat/project list
  filter chip lives on the first group heading's trailing edge
  (`MobileChatList firstGroupTrailing`); the pill bar expands above the
  scroll region.
- Default mobile home tab: owned by `../chat/chat-landing.tsx`
  (`selectedMobileHomeTab` init); `mobile-workspace-stack.tsx` only keeps the
  `/chat` search/base context mounted under session drawers.
- Settings: `mobile-settings-layout.tsx` / `mobile-settings-row.tsx` +
  per-area `mobile-*-settings.tsx` pages. In-card row dividers on `bg-card`
  settings surfaces must use full-strength `border-border` (card outline
  `border-border/60`) — `border-border/40` is invisible on the near-white
  card, leaving rows visually glued together. `MobileSettingsSection` renders
  `title`+`actions` on one header line and `description` full-width below it
  (don't squeeze the description into the title column next to wide actions).
  `workspaceJoinRequestsSlot` already owns its card frame, so wrap it in a
  `MobileSettingsSection noCard` plus the standard `mx-3` card inset; mounting
  the slot raw drops both the section rhythm and the shared horizontal edge.
  Opening the mobile Settings route from workspace home carries the complete
  in-app path in `from`. Nested settings Back returns to the settings list;
  top-level Back restores that validated source path (including the Projects
  Local/GitHub query) and uses context-free Chat only as the direct-entry fallback.
- Sheets (bottom): `mobile-new-chat-sheet.tsx`,
  `mobile-workspace-switcher-sheet.tsx`, `mobile-create/delete-workspace-sheet`,
  `mobile-worktree-config-sheet.tsx`, `mobile-acp-history-sheet.tsx`,
  `mobile-project-skills-sheet.tsx` (read-only project skills list; opens from the
  Skills row in the local + GitHub project Settings tab — sheet not drill page, same
  single-back-affordance reason as the worktree/ACP sheets).
- Session header sheets (replaced the mobile `SessionTabBar` + `…` dropdown; wired
  in `../sessions/session-detail.tsx` `if (isMobile)`): `mobile-session-tab-sheet.tsx`
  (`MobileSessionTabButton` 💬 in the header — accent (`bg-primary`) dot when a
  background tab is unread — opens the tab switcher: grouped cards (bg-card +
  hairline divide-y, matching the menu sheet); Conversations rows read
  `[hand|spinner|accent unread dot|empty] title [Main chip] relative-time`, no
  close/check affordance, order = shared tab order (main first, NOT time);
  a collapsed `Archived (N)` disclosure row lists archived children (tap =
  restore + switch); then a Viewers card of Files/file/diff/PR/browser — `Files`
  leads it unconditionally and opens the session file browser drawer, the mobile
  stand-in for the desktop Files side panel, which the mobile branch never renders) and
  `mobile-session-menu-sheet.tsx` (the `…` button — flat sheet, no submenu overflow:
  machine/branch info + optional Owner row + Find/Fork/Rename/Copy/Archive). The
  Owner row is the mobile face of the desktop `Change owner` submenu (writes
  `SessionMeta.userId`, multi-member workspaces only — see `../sessions/AGENTS.md`);
  it is a DISCLOSURE, not a flat list, so a large team cannot push the actions off
  screen. Both are pure; session-detail
  resolves each conversation's live status via ONE derived atom over
  `sessionLiveStatusAtomFamily` (never loop `useAtomValue`) and unread via
  `lastMessageAt > lastReadAt`. That atom hands over the status TYPE, not just
  presence: `requestPermission` is the warning-tone hand and outranks the
  spinner, as on the project screen and the desktop sidebar. A subagent tab
  waiting on approval is why — the sheet is the only surface that says so while
  another tab is on screen. The header badge deliberately stays two-state: a dot
  can only differ by COLOR, and `--status-warning` resolves to `--primary` in
  VS Code-derived themes, so a warning dot would just be the unread dot.
- Opened files: `mobile-file-viewer-drawer.tsx` is a full-screen right drawer
  layered over the still-mounted conversation. Its header always shows the
  file-type icon and basename; the `…` sheet exposes the complete, wrapping
  path plus tap-to-copy and explicit path/content copy actions (the content
  action is Markdown-only). Keep file viewer contents mounted across drawer
  closes so editor/scroll state survives reopening. Markdown rendered and
  source modes keep native long-press selection; source mode must not expose
  Monaco's desktop context menu.
- Floating frosted session header: session-detail's mobile `BaseHeader` is an
  absolute overlay (`bg-background/55 backdrop-blur-xl`, 3rem + safe-area) —
  content scrolls UNDER it and frosts. Contract: session-detail sets
  `--conversation-top-inset` on the mobile root; the ai-gui `VList` adds it to
  its paddingTop (unset elsewhere → no-op) and mobile viewer-tab wrappers pad by
  it. Header buttons are `glass-icon-button.tsx` (`GlassIconButton`): canvas-drawn
  glass disc (radial edge glow + specular arc, vertically masked so the rim lights
  top/bottom and melts at the sides; colors from computed `color`, redrawn on
  theme flip) — no CSS filters/SVG, story `MobileFrostedHeader.stories.tsx`.
  Press interaction is pure CSS states: hover scale-105; while pressed scale-125
  and the glass canvas + contents cross-fade to a solid `bg-foreground` disc;
  release transitions back automatically.
- Chrome: `mobile-workspace-layout.tsx`, `mobile-workspace-tabbar.tsx`,
  `mobile-sidebar-drawer.tsx` (sidebar swipe-to-open code is retained but
  disabled), `mobile-connection-status.tsx`.
- Lists: `mobile-chat-list.tsx`, `mobile-swipeable-row.tsx` (iOS-Mail-style
  row actions; also `touch-action: pan-y`), `mobile-filter-pill-bar.tsx`,
  `mobile-filter-drawer.tsx`, `mobile-inline-picker.tsx`.
- Group preview cap: under `MobileChatList capGroupPreviews` every bucket
  previews at most `MOBILE_CHAT_PREVIEW_MAX_ROOTS` (5 — the desktop
  `MAX_VISIBLE_SESSIONS`, copied rather than imported so the mobile bundle skips
  `session-list.tsx`) and ends in a `sessions.showAll` / `sessions.showLess`
  toggle. Workspace home passes it, because its buckets compete for the screen;
  the in-project list does NOT — the user drilled in to read exactly that list
  and there is nothing else there for a cap to make room for. It counts
  TOP-LEVEL rows via `countOpenedByTreeRoots`, and `maxRoots` applies AFTER
  `rootRank`, so a preview truncates the pinned-first / latest-activity order
  rather than reshuffling it and never splits an opener from the Sessions it
  opened. The expanded set is per
  bucket id in `MobileChatList`, NEVER the shared
  `sidebarCollapsedOpenedBySessionsAtom` — that atom is opener fold state the
  drawer sidebar must agree on. The cap is SUSPENDED while archived multi-select
  is active: "select all" takes every id in the list, so a capped surface would
  confirm a permanent delete of rows it never showed. The preview state joins the
  `AnimatePresence` key so "Show less" remounts instead of running a 0.4s height
  exit per hidden row, and collapsing `scrollIntoView({ block: 'nearest' })`s the
  toggle from a LAYOUT effect — the rows that vanish are above it. The toggle's
  leading 16px slot stays EMPTY (it only aligns the label to the row-title x):
  that column carries a row's status indicator and an opener's fold chevron, so a
  chevron there would read as one of those.
  The list is deliberately NOT virtualized. `VList` must own the scroll element,
  but the home screen owns it — pull-to-refresh translates that subtree, the
  dock-collapse listener reads it, hidden home tabs stay mounted for scroll
  position — and `contain: strict` would strip the `liftAboveEdgeSwipeZone`
  escape the opener chevron needs. The cap bounds the row count instead.
- Opened-by tree: `MobileChatListCard` runs the shared
  `lib/session-opened-by-tree.ts` model over EACH bucket, so a Session created
  by the `lody_session_create` MCP tool indents under its opener the same way
  the desktop sidebar nests it. Resolving per bucket is what keeps
  Pinned/date/project section boundaries intact; `chat-landing.tsx` fills
  `openedBySessionId` (precise opener) and `openedByRowSessionId` (row to nest
  under, via `buildSidebarOpenerRowResolver`) — two fields, never merged.
  Fold state is the shared `sidebarCollapsedOpenedBySessionsAtom`, so the
  drawer sidebar and the mobile list can never disagree.
  The row's leading slot owns ONE node, same contract as `sidebar-row-shared`:
  fold chevron on an opener, ├/└ on an opened Session, or the status
  indicator — never two. STATUS WINS on both sides: an active opener drops its
  chevron and an active opened Session drops its connectors. Consequence to
  keep in mind: desktop still exposes the fold in the row context menu, but
  mobile has no row context menu, so an ACTIVE opener cannot be folded until it
  goes quiet. That was accepted deliberately; do not "fix" it by drawing both.
  Because the node is the ordinary 16px status slot, a top-level row keeps its
  exact flat geometry (`px-4`, `w-4`). Only an opened Session widens the slot
  to `w-8 justify-start` — the node stays put and the CONTENT indents 16px, so
  the row background never steps.
  The chevron is a SIBLING of the row `<button>` (the row is one big button —
  nesting a control inside it is invalid and unreachable to assistive tech),
  and it needs `MobileSwipeableRow liftAboveEdgeSwipeZone`: the swipe face is a
  `z-10` stacking context, so nothing inside it can clear the drill-page
  `EDGE_ZONE_PX` strip at `zIndex={20}` on its own. Pass that flag ONLY when
  the chevron actually renders — it costs the edge-back swipe on those rows
  (same trade as the composer's `protectFromEdgeBackZone`).
- Swipe row text: `mobile-swipeable-row.tsx` owns Pin/Archive/Restore/Delete
  visible + aria labels via `chat.mobileHome.swipeActions.*`; avoid hardcoded
  localized overrides in callers.
- Composer run config: BOTH the in-session composer
  (`sessions/session-chat-input-area.tsx`) and the mobile new-chat sheet
  (`chat/chat-landing.tsx` → `mobile-new-chat-sheet.tsx`) share ONE control —
  `mobile-session-run-config.tsx`. It takes `agentSelection` (no SessionMeta
  dependency) plus model/mode/config props, renders the collapsed
  `mobile-run-config-button.tsx` face
  (`[agent icon] model · reasoning · [mode face] · plan/thinking/fast`; mode face =
  `permission-mode-face.tsx`, classified by `@lody/shared`
  `classifyPermissionModeFace`), and opens `mobile-run-config-sheet.tsx`
  (Role/Agent/Model/Interaction/Reasoning/Permission/Plan/Thinking/Fast rows plus
  provider-defined select rows; Agent/Model/Interaction/Reasoning/Permission and
  provider-defined selects use coordinated inline pickers; explicit
  permission selectors take precedence over legacy ACP modes; closing the sheet must not restore
  focus to the composer). New-chat scopes agents via `allowedMachineIds` from
  The **Role** row renders whenever the caller passes `agentRoles` — BOTH
  composers do, meaning different things by it (see `sessions/AGENTS.md`) — and
  renders even when there is nothing to list, reading `None`. It sits above
  Agent, since a Role answers every row under it, and is an ordinary inline
  picker: `None` first, then the Roles by emoji + name, an unavailable one
  listed but disabled with its reason, and `New role` last. Mobile has no detail
  pane and no edit: a phone row cannot carry the binding a Role authorizes, so
  that is read on desktop or in Settings. `None` reports `null`, which clears
  the NAME and leaves the configuration as it stands. `None` also carries an
  EMPTY glyph so its label lines up with the emoji-led rows under it; the
  trigger deliberately does not, because it shows one value rather than a
  column.
  New-chat scopes agents via `allowedMachineIds` from
  the selected machine and leaves agent unlocked; in-session locks agent once
  the conversation has turns. `mobile-session-composer-footer.tsx` still
  exports the legacy `MobileModelPickerLabel` helpers for any remaining chip
  faces; `mobile-fast-plan-toggles.tsx` is no longer mounted on new-chat
  (Plan/Fast live inside the run-config sheet).
- `mobile-inline-picker.tsx` dropdown is keyboard-operable (↑/↓/Enter/Esc, desktop
  search autofocus on `pointer: fine`) and **virtualizes lists >40 options** via
  `@tanstack/react-virtual` (scroll-by-index keeps the active row mounted). Its
  search filters FUZZILY and re-ranks through `lib/fuzzy-option-filter.ts`,
  shared with the desktop run-config menu so one query behaves the same on both:
  a substring match cannot find `claude-opus-5` from `op5`, and a provider's
  model list can run to dozens of ids. `shouldOfferOptionSearch` is the single
  threshold for when a row gets a field at all. Its input is `type="text"`, not
  `type="search"` — the search type draws a UA cancel glyph in the browser's own
  accent, which belongs to no theme and is no thumb's target — and the clear
  button beside it is ours.
- Any mobile sheet that can put a FIELD on screen owes the native-keyboard
  contract, `mobile-run-config-sheet.tsx` included (its rows open pickers with
  search fields). Call `useKeyboardAwareSheet()` rather than assembling it: it
  is three parts that only work together (lift, capped scroller, centered
  focus), and sheets carrying two of the three exist and misbehave on iOS. The
  desktop chat landing layers 2D-spatial keyboard nav on top — see
  [chat-landing-keyboard-nav.md](chat-landing-keyboard-nav.md).

Stories live in `src/stories/Mobile*.stories.tsx`.
