# components/mobile

Responsive mobile surfaces shared by narrow web and the desktop renderer. Binding
rules live in [AGENTS.md](AGENTS.md); background and reasoning live in
[ui-mobile.md](../../../../../.agents/docs/ui-mobile.md). This file is the
directory index. Stories: `src/stories/Mobile*.stories.tsx`.

## Screens and chrome

- `mobile-home-screen.tsx` — workspace home. `workspaceTabSpecs` builds the
  Inbox / Chat / Tasks / Projects dock tabs; the Tasks body is the shared
  `TasksListBody mobile embedded`, lazy-imported from
  `../tasks/tasks-workspace.tsx` (`embedded` skips the safe-area BaseHeader under
  the home chrome). The header's connection/pull pill is absolutely centred on the
  h-9 chrome row, and the pill bar expands above the scroll region.
- `mobile-project-screen.tsx`, `mobile-chat-landing-screen.tsx`,
  `mobile-archive-screen.tsx` — the other top-level screens.
- `mobile-workspace-layout.tsx`, `mobile-workspace-tabbar.tsx`,
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

- Bottom sheets: `mobile-new-chat-sheet.tsx`,
  `mobile-workspace-switcher-sheet.tsx`, `mobile-create-workspace-sheet.tsx`,
  `mobile-delete-workspace-sheet.tsx`, `mobile-worktree-config-sheet.tsx`,
  `mobile-acp-history-sheet.tsx`, `mobile-project-skills-sheet.tsx` (read-only
  project skills, opened from the Skills row of the local and GitHub project
  Settings tab), `mobile-remove-local-project-sheet.tsx`.
- Session header sheets, wired in `../sessions/session-detail.tsx` under
  `if (isMobile)`: `mobile-session-tab-sheet.tsx` (the 💬 `MobileSessionTabButton`
  with its accent unread dot opens the tab switcher — grouped cards, Conversations
  rows reading `[hand|spinner|accent unread dot|empty] title [Main chip]
  relative-time`, a collapsed `Archived (N)` disclosure whose rows restore and
  switch, then a Viewers card of Files/file/diff/PR/browser) and
  `mobile-session-menu-sheet.tsx` (the `…` button: machine/branch info, optional
  Owner row, Find/Fork/Rename/Copy/Archive).
- `mobile-file-viewer-drawer.tsx` — full-screen right drawer over the still-mounted
  conversation. `glass-icon-button.tsx` — the frosted header's `GlassIconButton`
  (canvas-drawn glass disc; story `MobileFrostedHeader.stories.tsx`).

## Run config and pickers

- `mobile-session-run-config.tsx` (the one shared control),
  `mobile-run-config-button.tsx` (collapsed face: `[agent icon] model · reasoning ·
  [mode face] · plan/fast`), `mobile-run-config-sheet.tsx`
  (Role/Agent/Model/Interaction/Reasoning/Permission/Plan/Fast rows plus
  provider-defined selects, all through coordinated inline pickers),
  `permission-mode-face.tsx` (classified by `@lody/shared`
  `classifyPermissionModeFace`), `mobile-inline-picker.tsx`,
  `mobile-settings-picker-trigger.tsx`.
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
