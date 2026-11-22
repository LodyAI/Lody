# components/mobile

Responsive mobile surfaces shared by narrow web and the desktop renderer. Binding
rules live in [AGENTS.md](AGENTS.md); background and reasoning live in
[ui-mobile.md](../../../../../.agents/docs/ui-mobile.md). This file is the
directory index. Stories: `src/stories/Mobile*.stories.tsx`.

## Screens and chrome

- `mobile-app-icon-settings.tsx` — host-provided icon previews and native selection
  below Font size in both narrow and wide Appearance settings (including iPad).
  The optional `__LODY_APP_ICON__` bridge owns the catalog and
  installed state; shared UI contains no native artwork or Capacitor dependency.
  See [app icon contract](../../../../../specs/app-icon-selection.md).

- `mobile-home-screen.tsx` — workspace home. `workspaceTabSpecs` builds the
  Inbox / Chat / Projects dock tabs. The header's connection/pull pill is
  absolutely centred on the h-9 chrome row, and the pill bar expands above the
  scroll region. Its Add project and private-resource Help sheets opt into
  [DrawerContent](../../ui/drawer.tsx)'s `bottomPadding="safeArea"`; the sheet owns
  that local bottom clearance.
- `mobile-project-screen.tsx`, `mobile-chat-landing-screen.tsx`,
  `mobile-archive-screen.tsx` — the other top-level screens.
- `mobile-workspace-layout.tsx`, [`mobile-workspace-tabbar.tsx`](../../../../../specs/mobile-workspace-dock.md),
  `mobile-workspace-stack.tsx` (SessionDetail layered over the always-mounted
  home/chat landing), `mobile-sidebar-drawer.tsx` (swipe-to-open code retained but
  disabled), `mobile-connection-status.tsx`.
- `mobile-drill-page-layout.tsx` — CSS-keyframe drill pages (settings, project,
  file browser). `mobile-edge-back-swipe.tsx` and `vaul-drawer-edge-back-zone.tsx`
  own the two swipe-back zones.

## Lists and rows

- `mobile-chat-list.tsx` (`MobileChatList`, `MobileChatListCard`),
  `mobile-swipeable-row.tsx` (iOS-Mail-style row actions; `touch-action: pan-y`),
  `mobile-later-sheet.tsx` (Later picker and section-name sheet),
  `mobile-filter-pill-bar.tsx`, `mobile-filter-drawer.tsx`.
- `MOBILE_CHAT_PREVIEW_MAX_ROOTS` is 5 — the desktop `MAX_VISIBLE_SESSIONS`,
  copied rather than imported so the mobile bundle skips `session-list.tsx`.

### Status grouping

The home list's Status grouping (`specs/sidebar-status-view.md#phones`) and the
Pinned area of every grouping render the shared `buildStatusViewLayout` from
`@lody/shared`; nothing here sorts or classifies those rows.

- `mobile-status-view.ts` maps list rows onto the shared layout input. A row's
  `readOnly` (the session-management guard's predicate) and a read-only member
  (`useStatusViewWritable`) both mean `canManage: false`, so status actions,
  swipes and drags are not offered where they would be refused. Pinning stays
  available through the preference path, except in an encrypted workspace
  without the write role, where no pin can be sealed either (`canPrefer: false`).
- A row nested under its opener carries its own id (`data-status-row-id`) and
  its opener's (`data-status-root-id`). Its menu and swipes act on it alone
  (the Spec's opened-by rule); it has no order of its own, so it does not drag
  and drops land relative to its opener.
- `use-mobile-status-list.tsx` owns the surface state the shared contract leaves
  to each surface: the clock (re-render at `nextChangeAt`, each minute while
  Later countdowns show, and on foreground), the order frozen while a row is
  lifted, the dropped order held until the moved row's placement reads back or
  its write fails, and the row, section-picker, section-header, Later and
  section-name sheets, and the confirmation before a section is deleted. The
  clock timer is capped at 2^31-1 ms: a longer delay fires at once in browsers.
  Section menus show only in the Status grouping, where pins can be placed.
  Writes go through the injected `MobileStatusCommands`
  (`runStatusViewCommand` plus `use-mobile-status-actions.ts`, which asks the
  shared sub-conversation question and offers Undo after Later and Settle).
- `use-status-list-drag.ts`: holding a row still for 450 ms lifts it; releasing
  opens the action menu, moving drags it. Movement before the lift is a scroll
  or a swipe; a second finger cancels the gesture, and a context-menu request
  (right click, TalkBack, a menu key) opens the action menu. The drop slot follows
  the finger; over a list that takes no drops it is cleared, and only in the
  auto-scroll zones (which clear the floating tab bar) does it survive the
  finger passing over padding. Pull-to-refresh stands down for a touch a lifted
  row claimed. While a row is lifted, a non-passive `touchmove` listener on the
  list surface stops the WebView scrolling; the list scrolls itself at its
  edges. That listener must be registered at mount: one added at the lift is
  too late, because the browser commits to a pan at `touchstart` and cancels
  the pointer. Haptics use `navigator.vibrate` where the WebView has it
  (Android); the Capacitor shell has no haptics bridge, so iOS is silent.
  Chrome also refuses `vibrate` until the page has had a tap (user activation),
  so the lift and slot feedback stay silent on a freshly loaded page whose
  first gesture is a long press.
- `MobileStatusSwipeRow`: a leading swipe pins or unpins; a trailing swipe gives
  Settle and Later on Focus and Later rows, Archive on Settled and pinned rows.
- On a fold, one list instance portals its first bucket into the upper panel
  (`splitTargets`), so both panels share one layout, one drag and one planner
  input.

## Sheets and session surfaces

- `mobile-new-chat-sheet.tsx` hosts the new-chat page: the session-style
  composer stays at the bottom, with machine and project in that order above it.
  Local Git worktree and branch share a row; GitHub exposes its branch. Local
  checked-out and worktree refs both display decoded branch labels with localized
  local/remote suffixes; launch keeps the exact selector. Run
  configuration opens the same Sheet as an ongoing conversation. The
  selection group shares the composer column and sits above it. Its page, frosted header,
  back button and composer column reuse the session equivalents. The page lifts above the
  native keyboard through the same composer shell (keyboard margin, safe-area inset and
  transition) used by ongoing sessions. First send retains this page until navigation
  reaches the session, then waits for its presentation acknowledgement before
  dismissing new chat. Pending sends preserve the focused textarea, blocking edits
  without disabling it. The destination claims an existing new-chat focus in its
  layout effect before source removal; native iOS also checks the keyboard-height
  signal so manual dismissal is respected. Accepted sends dismiss the keyboard
  after the message surface paints; rejection or resumed editing keeps it open.
  Keyboard inset and safe-area padding share a transition. Entry/completion never
  open a keyboard.
  Entrance suppression persists through delayed portal mounts
  and same-entry URL replacements; later visits and Back retain their animation.
  The page itself pushes in from the right (`.mobile-drill-in`) and Back slides it
  out before closing; the host hiding it after first-send presentation removes it
  without a slide. In the native app a rightward drag starting within
  `EDGE_ZONE_PX` of the left edge moves the page with the finger over the mounted
  screen beneath, then commits or snaps back. The drag is bound on the page rather
  than an overlay strip, so no tap target is covered, and drags starting in the
  composer shell stay with the composer. The existing
  project and agent selection handlers retain draft and scope semantics. The
  project list mixes all sources using the desktop recency/name/id comparator,
  with a pinned “No project selected” option. Groups and local folders use type icons;
  GitHub rows and the selected value share the desktop owner avatar, falling back to
  the GitHub icon while loading or on failure. GitHub rows omit repository descriptions.
  Search preserves this order. Home opens an empty draft with the last accepted
  project, saved per workspace/device independently of browsing defaults.
  Explicit project-page entry and an existing draft keep their selection. A local
  target restores its machine too; an incompatible Role is cleared through the
  existing machine handler. Deleted/unavailable targets become no project. Older
  installs without a saved target use existing available-project usage ranks.
  Restoration waits for catalogs and is canceled by manual machine/project choice.
  [Decision and evidence](../../../../../.agents/notes/implemented/feature/2026-10-28-mobile-new-chat-page.md).
- Bottom sheets: `mobile-workspace-switcher-sheet.tsx`, `mobile-create-workspace-sheet.tsx`,
  `mobile-delete-workspace-sheet.tsx`, `mobile-worktree-config-sheet.tsx`,
  `mobile-acp-history-sheet.tsx`, `mobile-project-skills-sheet.tsx` (read-only
  project skills, opened from the Skills row of the local and GitHub project
  Settings tab). Local-project deletion submits directly without a confirmation sheet.
- Session header sheets, wired in `../sessions/session-detail.tsx` under
  `if (isMobile)`: `mobile-session-tab-sheet.tsx` (the 💬 `MobileSessionTabButton`
  with its accent unread dot opens the tab switcher — grouped cards, Conversations
  rows reading `[hand|spinner|accent unread dot|empty] title [Main chip]
relative-time`, a collapsed `Archived (N)` disclosure whose rows restore and
  switch, then a Viewers card of Files/file/diff/PR/browser) and
  `mobile-session-menu-sheet.tsx` (the `…` button: machine/branch info, optional
  Owner row, Find/Fork/Rename/Copy/Archive).
- `mobile-file-viewer-drawer.tsx` — full-screen right drawer over the still-mounted
  conversation. Session files open read-only with an explicit edit toggle for
  writable files; reopening the drawer restores read-only mode. Session HTML opens in preview with an eye toggle for source;
  WebKit uses the shared script-free HTML/CSS preview. The project file browser
  also previews complete HTML by default with the same source toggle.
  Its [DrawerContent](../../ui/drawer.tsx) uses `width="full"` for 100% width without
  directional width caps. Caller classes and inline styles retain normal cascade
  precedence. Insets, borders, radii and keyboard handling keep their current owners.
  `glass-icon-button.tsx` — the frosted header's `GlassIconButton`
  (canvas-drawn glass disc; story `MobileFrostedHeader.stories.tsx`).

## Run config and pickers

- `mobile-native-select.tsx` — branded trigger over a real `<select>` for
  touch-native target lists; used by the new-chat header and footer rail.
- `mobile-footer-rail.tsx` — horizontal footer scroller with a right-edge fade
  while more controls remain; used by the new-chat composer.
- `mobile-new-chat-project-sheet.tsx` — mobile project picker: machine row, one
  search across local folders and GitHub repos, grouped results, add/connect.
- `mobile-session-run-config.tsx` (the one shared control),
  `mobile-run-config-button.tsx` (collapsed face: `[agent icon] model · reasoning ·
[mode face] · plan/fast`), `mobile-run-config-sheet.tsx`
  (Role/Agent/Model/Interaction/Reasoning/Permission/Plan/Fast rows plus
  provider-defined selects, all through coordinated inline pickers),
  `permission-mode-face.tsx` (classified by `@lody/shared`
  `classifyPermissionModeFace`), `mobile-inline-picker.tsx`,
  `mobile-settings-picker-trigger.tsx`.
- Desktop landing keyboard navigation:
  [chat-landing-keyboard-nav.md](chat-landing-keyboard-nav.md).
- Provider-defined pickers have a separate coordinator ID namespace, so an ACP
  option named `permission` or `model` cannot open or dismiss a built-in row.
  [Collision fix and builtin audit](../../../../../.agents/notes/implemented/bug-fix/2026-10-09-dimcode-mobile-permission-picker.md).
- `mobile-fast-plan-toggles.tsx` survives for the in-session composer only.

## Settings

- `mobile-settings-layout.tsx`, `mobile-settings-row.tsx`,
  `mobile-settings-picker-trigger.tsx`, and the per-area pages:
  `mobile-general-settings.tsx`, `mobile-account-settings.tsx`,
  `mobile-appearance-settings.tsx`, `mobile-about-settings.tsx`,
  `mobile-integrations-settings.tsx`, `mobile-stats-settings.tsx`,
  `mobile-project-settings.tsx`, `mobile-local-project-settings.tsx`,
  `mobile-github-project-settings.tsx`.

`mobile-about-settings.tsx` exposes Inbox and Prompt Shortcuts opt-ins under
Developer mode. Both use the shared feature gates; disabling Developer mode
retains the saved opt-ins while making the features unavailable.
