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
  `showInboxTab` (multi-member workspaces); Tasks only renders when the caller
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
  per-area `mobile-*-settings.tsx` pages.
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
  `[spinner|accent unread dot|empty] title [Main chip] relative-time`, no
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
  resolves conversation running via ONE derived atom over `sessionLiveStatusAtomFamily`
  (never loop `useAtomValue`) and unread via `lastMessageAt > lastReadAt`.
- Opened files: `mobile-file-viewer-drawer.tsx` is a full-screen right drawer
  layered over the still-mounted conversation. Its header always shows the
  file-type icon and basename; the `…` sheet exposes the complete, wrapping
  path plus tap-to-copy and an explicit copy action. Keep file viewer contents
  mounted across drawer closes so editor/scroll state survives reopening.
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
- Swipe row text: `mobile-swipeable-row.tsx` owns Pin/Archive/Restore/Delete
  visible + aria labels via `chat.mobileHome.swipeActions.*`; avoid hardcoded
  localized overrides in callers.
- Composer run config: BOTH the in-session composer
  (`sessions/session-chat-input-area.tsx`) and the mobile new-chat sheet
  (`chat/chat-landing.tsx` → `mobile-new-chat-sheet.tsx`) share ONE control —
  `mobile-session-run-config.tsx`. It takes `agentSelection` (no SessionMeta
  dependency) plus model/mode/config props, renders the collapsed
  `mobile-run-config-button.tsx` face
  (`[agent icon] model · reasoning · [mode face] · plan/fast`; mode face =
  `permission-mode-face.tsx`, classified by `@lody/shared`
  `classifyPermissionModeFace`), and opens `mobile-run-config-sheet.tsx`
  (Agent/Model/Reasoning/Permission/Plan/Fast rows; Agent/Model/Reasoning/
  Permission use coordinated inline pickers; closing the sheet must not restore
  focus to the composer). New-chat scopes agents via `allowedMachineIds` from
  the selected machine and leaves agent unlocked; in-session locks agent once
  the conversation has turns. `mobile-session-composer-footer.tsx` still
  exports the legacy `MobileModelPickerLabel` helpers for any remaining chip
  faces; `mobile-fast-plan-toggles.tsx` is no longer mounted on new-chat
  (Plan/Fast live inside the run-config sheet).
- `mobile-inline-picker.tsx` dropdown is keyboard-operable (↑/↓/Enter/Esc, desktop
  search autofocus on `pointer: fine`) and **virtualizes lists >40 options** via
  `@tanstack/react-virtual` (scroll-by-index keeps the active row mounted). The
  desktop chat landing layers 2D-spatial keyboard nav on top — see
  [chat-landing-keyboard-nav.md](chat-landing-keyboard-nav.md).

Stories live in `src/stories/Mobile*.stories.tsx`.
