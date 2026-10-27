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
  scroll region.
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
  `mobile-filter-pill-bar.tsx`, `mobile-filter-drawer.tsx`.
- `MOBILE_CHAT_PREVIEW_MAX_ROOTS` is 5 — the desktop `MAX_VISIBLE_SESSIONS`,
  copied rather than imported so the mobile bundle skips `session-list.tsx`.

## Sheets and session surfaces

- `mobile-new-chat-sheet.tsx` hosts the new-chat page: the session-style
  composer stays at the bottom, with machine and project in that order above it.
  Local Git worktree and branch share a row; GitHub exposes its branch. Run
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
  and same-entry URL replacements; later visits and Back retain their animation. The existing
  project and agent selection handlers retain draft and scope semantics. The
  project list mixes all sources using the desktop recency/name/id comparator,
  with a pinned “No project selected” option. Groups and local folders use type icons;
  GitHub rows and the selected value share the desktop owner avatar, falling back to
  the GitHub icon while loading or on failure. GitHub rows omit repository descriptions.
  Search preserves this order.
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
  conversation. Session HTML opens in preview with an eye toggle for source;
  WebKit uses the shared script-free HTML/CSS preview. The project file browser
  also previews complete HTML by default with the same source toggle.
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
- Provider-defined pickers have a separate coordinator ID namespace, so an ACP
  option named `permission` or `model` cannot open or dismiss a built-in row.
  [Collision fix and builtin audit](../../../../../.agents/notes/implemented/bug-fix/2026-10-09-dimcode-mobile-permission-picker.md).
- `mobile-session-composer-footer.tsx` still exports the legacy
  `MobileModelPickerLabel` helpers for any remaining chip faces;
  `mobile-fast-plan-toggles.tsx` survives for the in-session composer only.

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
