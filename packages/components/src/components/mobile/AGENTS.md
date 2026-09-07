# components/mobile

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

The Capacitor app is outside this repository; keep native-only behavior behind
explicit platform capabilities. File ownership: [README.md](README.md).
Background: [ui-mobile.md](../../../../../.agents/docs/ui-mobile.md) — read
before touching gestures.

## Swipe-back and drawer layering

- Full-screen Vaul right drawers (see README) must gate Vaul's drag to a
  left-edge zone through `VaulDrawerBody`, which marks content no-drag and
  mounts the only drag-start zone. Drill pages instead mount
  `MobileEdgeBackSwipeZone` in a body-only `position: relative` region.
- Neither zone may overlap a header back button: pass `topInset` = chrome above
  the body (drawer header inset; `SESSION_DRAWER_BODY_TOP_INSET` for the
  session). Zones are native-only; web mounts none, content still no-drag.
- Browser must be a NESTED Vaul drawer, never a sibling
  `createPortal(document.body)` panel; its managed preview iframes survive
  remount through `managed-preview-frame-cache.ts`. While the session drawer
  closes, sticky-mount SessionDetail for the exit animation but clear nested
  `urlPr` / `urlBrowser`, and close by replacing to the remembered `/chat` base
  — never `history.back()`.
- `MobileProjectFileBrowser`'s in-folder zone (z-60) pops one directory level;
  only the root swipe reaches Vaul's z-30 strip. Keep those apart if either
  moves. Interactive overlays inside a drawer use the nearest
  `data-vaul-no-drag` portal target.
- Composer shell and `SessionInfoBar` stay above the 48px strip (`z-40` over
  `z-30`, via `protectFromEdgeBackZone`); never shrink the zone instead. That
  escape is unavailable inside the message list, so a left-edge control there
  must be inset past `EDGE_ZONE_PX`: the turn action bar reserves
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` (>= `EDGE_ZONE_PX`, pinned by
  `tests/assistant-turn-action-inset.test.ts`) with a duration label nothing may
  precede, whose width survives an unknown duration.
- Full-screen right drawers need `border-l-0!`; plain `border-0` loses to Vaul.

## Home and chat lists

- Inbox renders only on `showInboxTab`, Tasks only on `showTasksTab`
  (`../tasks/AGENTS.md`). Keep the chat/projects group mounted-but-hidden so
  pull-to-refresh and scroll position survive tab round-trips.
  `../chat/chat-landing.tsx` owns the default home tab; the workspace stack only
  keeps `/chat` base context mounted under drawers.
- The sticky home header is ONE chrome row (workspace | search |
  archive/settings): search fades out over `HEADER_SEARCH_EXIT_MS` before the
  connection/pull pill may mount, and the two never overlap. The filter chip
  sits on the first group heading's trailing edge (`firstGroupTrailing`).
- `capGroupPreviews` caps each bucket at `MOBILE_CHAT_PREVIEW_MAX_ROOTS` with a
  showAll/showLess toggle; workspace home passes it, the in-project list does
  not. It counts TOP-LEVEL rows (`countOpenedByTreeRoots`) AFTER `rootRank` and
  never splits an opener from its opened Sessions. Expanded state is per bucket
  id, NEVER `sidebarCollapsedOpenedBySessionsAtom`; SUSPEND the cap during
  archived multi-select. Preview state joins the `AnimatePresence` key,
  collapsing scrolls the toggle in from a LAYOUT effect, and its leading 16px
  slot stays EMPTY.
- The list is deliberately NOT virtualized: the home screen owns the scroll
  element, so never hand it to `VList`.
- `MobileChatListCard` renders the sidebar's opened-by tree
  (`lib/session-opened-by-tree.ts`, the same two unmerged fields and the shared
  `sidebarCollapsedOpenedBySessionsAtom`; `../AGENTS.md`) over EACH bucket. Its
  leading slot owns ONE node — chevron, ├/└, or status indicator, status
  winning; never draw both. A top-level row keeps flat geometry (`px-4`, `w-4`);
  only an opened Session widens the slot (`w-8 justify-start`, CONTENT indented
  16px, background unchanged), and its chevron is a SIBLING of the row
  `<button>` needing `MobileSwipeableRow liftAboveEdgeSwipeZone` — pass that
  flag ONLY when the chevron renders, since it costs the edge-back swipe.
- `mobile-swipeable-row.tsx` owns Pin/Archive/Restore/Delete visible and aria
  labels (`chat.mobileHome.swipeActions.*`); never hardcode localized overrides.

## Session sheets and viewers

- The session header sheets stay pure; `../sessions/session-detail.tsx` resolves
  live status via ONE derived atom over `sessionLiveStatusAtomFamily` (never a
  loop of `useAtomValue`) and unread via `lastMessageAt > lastReadAt`.
- Conversation rows follow the shared tab order (main first, NOT time) with no
  close/check affordance; `requestPermission` is the warning-tone hand
  outranking the spinner; the header tab badge stays two-state; `Files` leads
  the Viewers card unconditionally. The menu sheet stays flat, and its Owner row
  (multi-member only, writes `SessionMeta.userId`) is a DISCLOSURE, not a list.
- The file viewer drawer header shows only the file-type icon and basename; its
  `…` sheet exposes the complete wrapping path plus tap-to-copy and explicit
  path/content copy (content copy Markdown-only). Keep viewer contents mounted
  across drawer closes. Both Markdown modes keep native long-press selection;
  source mode must not expose Monaco's context menu.
- The frosted session header is an absolute overlay: session-detail sets
  `--conversation-top-inset` on the mobile root, the ai-gui `VList` adds it to
  paddingTop, and viewer-tab wrappers pad by it. Header buttons are
  `GlassIconButton` — canvas drawn, no CSS filters or SVG, press interaction
  pure CSS state.

## Run config, pickers, and sheets

- ONE control (`mobile-session-run-config.tsx`) serves both the in-session
  composer and the new-chat sheet: it takes `agentSelection` (no SessionMeta
  dependency) plus model/mode/config props. Explicit permission selectors
  outrank legacy ACP modes, and closing the sheet must not restore focus to the
  composer.
- The Role row renders whenever the caller passes `agentRoles` — both composers
  do (`../sessions/AGENTS.md`) — even with nothing to list, reading `None`. It
  sits above Agent as an inline picker ordered `None`, Roles by emoji + name,
  then `New role`; an unavailable Role is listed but disabled with its reason.
  `None` (EMPTY glyph, unlike the trigger) reports `null`, clearing only the
  NAME. Mobile has no Role detail pane or editing.
- New-chat scopes agents via `allowedMachineIds` from the selected machine and
  leaves agent unlocked; in-session locks agent once the conversation has turns.
  `mobile-fast-plan-toggles.tsx` is not mounted on new-chat.
- `mobile-inline-picker.tsx` stays keyboard-operable (↑/↓/Enter/Esc, desktop
  search autofocus on `pointer: fine`) and virtualizes lists >40 options. Its
  search filters fuzzily through `lib/fuzzy-option-filter.ts`, shared with the
  desktop run-config menu; `shouldOfferOptionSearch` is the single threshold for
  offering a field at all. The input is `type="text"`, never `type="search"`.
- Any mobile sheet that can put a FIELD on screen owes the native-keyboard
  contract, the run-config sheet included: call `useKeyboardAwareSheet()` rather
  than assembling its three parts separately. Desktop landing keyboard nav:
  [chat-landing-keyboard-nav.md](chat-landing-keyboard-nav.md).

## Settings

- In-card row dividers on `bg-card` surfaces must use full-strength
  `border-border` (card outline stays `border-border/60`).
  `MobileSettingsSection` puts `title` + `actions` on one header line and
  `description` full-width below. `workspaceJoinRequestsSlot` owns its own card
  frame: wrap it in `MobileSettingsSection noCard` plus the standard `mx-3`
  inset.
- Opening mobile Settings from workspace home carries the complete in-app path
  in `from`. Nested Back returns to the settings list; top-level Back restores
  that validated source path (including the Projects Local/GitHub query),
  falling back to context-free Chat only on direct entry.
