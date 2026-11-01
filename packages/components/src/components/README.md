# Product surfaces

Binding rules live in [AGENTS.md](AGENTS.md); this index explains ownership.
Child directories such as `sessions/`, `mobile/`, `chat/`, and `archive/` own their scoped rules.

| Area                | Entry points                                                                                                                                   | Responsibility                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Sidebar             | [`loro-sidebar.tsx`](loro-sidebar.tsx), [`session-list.tsx`](session-list.tsx)                                                                 | Organizes workspace and session navigation.                      |
| Desktop layout      | [`web-workspace-layout.tsx`](web-workspace-layout.tsx), [`sidebar-update-banner.tsx`](sidebar-update-banner.tsx)                               | Owns the shell's safe areas and update notice.                   |
| Startup             | [`boot-navigate.tsx`](boot-navigate.tsx), [`preloaded-main-layout.tsx`](preloaded-main-layout.tsx)                                             | Retains the boot shell during redirects and layout code loading. |
| Provider readiness  | [`shared/agent-readiness-mark.tsx`](shared/agent-readiness-mark.tsx)                                                                           | Draws setup state across settings and onboarding.                |
| Shared cues         | [`shared/`](shared/)                                                                                                                           | Draws cross-surface drop, run-config, and transport cues.        |
| Session controls    | [`shared/workdir-mode-selector.tsx`](shared/workdir-mode-selector.tsx), [`shared/session-relation-card.tsx`](shared/session-relation-card.tsx) | Selects workdir mode and navigates session provenance.           |
| Conversation access | [`session-sharing.tsx`](session-sharing.tsx), [`sharing/`](sharing/)                                                                           | Presents team visibility and static sharing controls.            |

## About notices

[`settings/open-source-attributions-dialog.tsx`](settings/open-source-attributions-dialog.tsx)
keeps its heading outside one scrolling body containing the summary and both
notice groups. The height-capped ScrollArea is a flex column, and its viewport
can shrink to fit the dialog's available height. This keeps the last notice
reachable even when summary cards stack in a short window. See the
[scrolling fix](../../../../.agents/notes/implemented/bug-fix/2026-10-15-open-source-notices-scroll.md).

## Sidebar and session rows

Machine-section ordering uses [`sidebar-machine-order.ts`](sidebar-machine-order.ts)
and the presentation identity in [`local-probe.ts`](../atoms/local-probe.ts).
CLI outages preserve the known desktop machine's position; local actions still
use the live identity. See the [ordering Spec](../../../../specs/sidebar-project-ordering.md).

The sidebar spans `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, `session-list.tsx`, and
`sidebar-*.tsx`. `sessions/session-list-rows.ts` resolves row relationships, while
`lib/session-opened-by-tree.ts` builds the presentation tree.

Header controls use the local `CuidaSidebarExpandOutline` SVG for the sidebar toggle
and Lucide `ChevronLeft` / `ChevronRight` for history navigation, in 16px boxes.
Cuida's source and Apache-2.0 license are retained beside the icon component.

The Add folder and view controls use Lucide `FolderPlus` and `SlidersHorizontal`
with 16px boxes and a 1.5 stroke width. Section-header actions both use the `mini`
ghost Button: 24px square, 6px corner radius, and shared colors and hover treatment.
The filter accepts `triggerSize` so callers use the Button size contract rather than
overriding its dimensions with CSS.

Section labels scroll with their rows, per the
[sidebar section scrolling Spec](../../../../specs/sidebar-section-scrolling.md).

GitHub repository groups and local project folders both expose a desktop drag handle.
Their orders are persisted per workspace; local project keys also include the owning
machine so projects from different devices cannot collide. See the
[sidebar project ordering Spec](../../../../specs/sidebar-project-ordering.md).

[Sidebar relationship rationale](../../../../.agents/docs/components-sidebar-session-tree.md)
explains why exact opener navigation and root-row indentation use separate ids.
A child Tab may open an independent Session: the row sits under the root, but its
navigation must still return to the precise creating Tab.

Updated organize mode is a mixed recency list. The sidebar view popover hosts a
`Details` group under the View and Tasks groups with a switch per second-line
segment: `Show Project` (folder / muted GitHub owner mark + project name) and
`Show Branch`. Both switches are persistent content preferences and stay
interactive in every organize mode — each segment appears on the rows that
carry it, and the Workspace branch/time line collapses entirely when the
branch switch is off. A new or unset branch preference starts off; a previously
saved choice is preserved. See the [default decision](../../../../.agents/notes/implemented/feature/2026-10-19-sidebar-branch-details-off-by-default.md).
GitHub owner marks keep their original colors at a fixed
60% opacity in every row state. Nested opened Sessions stay one title line so
the tree trunk still meets. Workspace-mode Pinned omits the project line.
Decisions:
[project context](../../../../.agents/notes/implemented/feature/2026-09-20-sidebar-updated-project-context.md),
[display preference](../../../../.agents/notes/implemented/feature/2026-09-20-sidebar-updated-project-display-preference.md),
and [details group](../../../../.agents/notes/implemented/feature/2026-10-18-sidebar-row-details-group.md).

## Entry points and layout

- Remote Add folder: `local-projects/use-remote-directory-picker.ts` owns navigation,
  creation and registration state. Both layouts use `remote-directory-new-folder-control.tsx`
  for a single-name form, shown only when the target advertises
  `localProjectCreateDirectory`. Creation enters the new directory; Add registers it
  separately. Errors preserve the name, and pending operations cannot be repeated.
  [Decision and verification](../../../../.agents/notes/implemented/feature/2026-10-14-remote-directory-creation.md).

- Entry and workspace-gate redirects use `BootNavigate` to hint target geometry;
  `PreloadedMainLayout` owns the boot-shell Suspense fallback. Inside `RootOutlet`'s
  error boundary, `BootShellBoundary` supplies live route/sidebar/viewport state and
  router `state.isLoading || state.status === 'pending'` to one persistent frame:
  `isLoading` alone can clear before the pending match renders. Committed gates own its
  path and status; if Suspense cleans up the outgoing owner, pending navigation
  retains the last committed presentation. With no owners and navigation settled,
  the provider releases the frame and clears that memory so later session navigation
  cannot revive it. Static BootShell and `WorkspaceCard`
  share frame geometry. `DocumentStyle` replaces the inline first-paint sheet
  after commit and keeps live CSS mutable during updates; React's immutable
  `style href` resources cannot own it. The card's content `LoadingPlaceholder` retains the
  same mark while workspace data resolves. See [startup intent](../../../../specs/app-startup-landing.md),
  the [first-paint decision](../../../../.agents/notes/implemented/feature/2026-09-26-boot-shell-first-paint.md),
  and its [layout-handoff follow-up](../../../../.agents/notes/implemented/feature/2026-10-19-boot-shell-layout-handoff.md).

- Sidebar footer: Help (`?`), Archive, Settings, in that order. Help retains the
  documentation, GitHub repository, community, GitHub Issues feedback, and bug-report menu.
  Desktop Help opens to the right of its button with bottom edges aligned; mobile Help opens upward.
  Archive is a direct
  button and becomes the return action while open. Desktop controls are 28px and use
  the navigation rows' ink and fills (`sidebarSurface.iconButton`, shared with the
  header's icon buttons); mobile actions retain their touch targets. See the
  [footer Spec](../../../../specs/sidebar-footer.md).

- [Zen layout](../../../../specs/zen-layout.md): `AppCommands` dispatches the shared
  layout action; the mounted desktop Session publishes its right-panel controls.

- Sidebar Search, immediately below New Chat, opens the shared command palette
  through `lib/commands/palette-state.ts`; see the [Spec](../../../../specs/sidebar-search.md).
- Chat landing: `chat/chat-landing.tsx`.
- Desktop Settings: [`settings/desktop-settings-modal.tsx`](settings/desktop-settings-modal.tsx)
  collapses its sidebar to an icon rail when the panel is at most 720px wide:
  same rows and selection, labels and group headings fold away, and each icon
  keeps an accessible name and a hover tooltip. The page and its editors stay
  mounted through resizing; header actions wrap within the pane. [Decision and
  verification](../../../../.agents/notes/implemented/bug-fix/2026-10-01-narrow-settings-panel.md).
- Machine settings' connected Agent badges in
  [`settings/my-machine-connected-resources.tsx`](settings/my-machine-connected-resources.tsx)
  use the shared `AgentIcon`, including provider-brand inference and custom/unknown
  Agent fallbacks, in the Badge's leading icon slot.
- GitHub personal identity authorization stays available in cloud-capable native
  clients: Authorize opens the current workspace's `/settings/github` on
  `VITE_SITE_URL` (default `https://lody.ai`) in the external browser. Complete
  account linking there with the same Lody account; the client's reactive settings
  query reflects completion. Browser settings keep their existing OAuth flow.
- Login page: `login-page.tsx` is an inset dithered visual
  (`login-dither-visual.tsx`, WebGL, theme-coloured, reduced-motion aware) beside an
  anchored sign-in column; on narrow screens the visual stacks on top and folds
  away for the email form. The header and legal notice stay mounted in ordinary
  CSS flow. `login-view-slot.tsx` keeps the OAuth and email panels mounted in a
  clipped horizontal track; one MotionValue drives translation and interpolated
  intrinsic height together. Email sign-in and sign-up reuse the same form and
  input elements. Only the name and forgot-password rows expand or contract,
  with the viewport following their flow height in the same frame. Switching
  never fades the form or scales its controls. Reversals start from current
  numeric values, offscreen panels are inert and excluded from accessibility,
  and email focuses after the slide completes without scrolling. Reduced motion
  commits directly. Providers are one group of equal secondary buttons; the
  method this device last completed is marked "Last used" via
  `lib/last-login-method.ts`, written only on a completed sign-in.
  [Decision](../../../../.agents/notes/implemented/feature/2026-10-17-login-inset-visual-last-used.md),
  [retained sign-up transition fix](../../../../.agents/notes/implemented/bug-fix/2026-10-18-login-view-switching.md).
- Browser desktop sign-in handoff: `login-page.tsx` under `?client_id=electron`,
  the page the desktop app opens in the system browser. A desktop sign-out leaves
  this browser signed in as the previous account, so the page names that account
  and transfers it only on an explicit choice, keeps the attempt's
  `state`/`code_challenge` when the user switches accounts, discards a transfer
  that lands after the switch, and renders the `lody://auth/callback` URL as a link
  beside the automatic navigation — a browser that refuses a custom-scheme
  navigation reports nothing back, so the link must already be on screen.
  [Decision](../../../../.agents/notes/implemented/bug-fix/2026-09-15-electron-browser-signin-account-choice.md).
  The post-transfer Storybook states mount the real LoginPage in a same-origin
  sandboxed iframe that blocks custom-protocol launch while the trusted fixture
  keeps its sandbox intact. It is not an isolation boundary for hostile scripts.
  Manual link activation is recorded without opening external software; these
  states cover UI, not OS handoff.
- Desktop update prompt: `sidebar-update-banner.tsx` and
  `update-changelog-dialog.tsx`, driven by the pure selectors in
  `lib/electron-update-banner.ts`.
- Desktop safe areas: `web-workspace-layout.tsx` and
  `getWebWorkspaceLayoutRootClassName`. The iPad native shell renders the desktop
  layout (`detectAppDeviceClass()` is `tablet`, viewport >= 768) with
  `viewport-fit=cover`, which is why desktop top/side padding also matters there.
  The composer owns its bottom edge; a global bottom inset would double-pad it.
  [`workspace-layout-utils.ts`](workspace-layout-utils.ts) owns the shared StyleX
  root/content classes and the element-local safe-area and native-keyboard readers.
  Its retained `h-svh` hook also serves the old-browser fallback and Electron devbar;
  it is not an unused utility.
  The persistent
  [`workspace inset browser suite`](../../tests/e2e/workspace-layout-insets.spec.ts)
  checks the real composer fixtures, local inset readers, natural keyboard-padding
  transition, focus and draft retention against a running Storybook build.
- Sidebar toggle: `WebWorkspaceLayout` retains the full-width sidebar, animates
  its transform and the adjacent content width together, and honors reduced motion.
  `SidebarVisibilityGate` pauses sidebar-only sources while hidden. Compact
  navigation uses [`CompactNavigationDialog`](compact-navigation-dialog.tsx) for
  focus containment, nested dismissal and return focus; its content scope is inert
  while open. See [desktop layout intent](../../../../specs/desktop-windows.md).
  Compact
  presentation and settings navigation can still remount it: `LoroSidebar` saves
  its viewport offset by workspace in `atoms/sidebar-state.ts` and restores it
  before paint. [Decision](../../../../.agents/notes/implemented/bug-fix/2026-09-26-sidebar-content-width-animation.md).

## Provider readiness

[`shared/agent-readiness-mark.tsx`](shared/agent-readiness-mark.tsx) draws the
provider's cold, arriving, and ready states in setup and onboarding. It owns its
StyleX sizes, tones, `surface="avatar"` onboarding variant, and progress orbit;
the indeterminate arc animates an HTML wrapper around the SVG to remain
compositable on Retina displays. The migration keeps the previous rendered
geometry and palette; its verification and the one product-theme colour bridge
are recorded in the
[StyleX migration note](../../../../.agents/notes/implemented/simplification/2026-09-26-agent-readiness-stylex.md).

## Shared cues

The [conversation drop overlay](shared/conversation-drop-overlay.tsx) paints a
non-interactive mask over the active drop zone; the parent owns hit testing and
drag state.
The [MCP transport icon](shared/mcp-transport.tsx) supplies the transport glyph to
settings controls. Their visual rules are component-local StyleX, with the
overlay's light/dark alpha tied to the app's explicit theme. See the
[migration decision](../../../../.agents/notes/implemented/simplification/2026-09-26-shared-cues-stylex.md)
for the visual-equivalence boundary.

## Session controls

The [workdir mode selector](shared/workdir-mode-selector.tsx) offers local and
worktree modes in a compact menu. The companion worktree checkbox pill uses its
flat `surface="context"` presentation in the chat landing composer. An
unavailable worktree remains visible with
its reason; after session creation the current mode is an inert, tooltip-named
value rather than a disabled action. The
[session relation card](shared/session-relation-card.tsx) presents opened/opened-by
provenance in the conversation and operation stream, with navigation enabled
only while its exact target is available. Both components own their visual
rules in StyleX; the [session-control decision](../../../../.agents/notes/implemented/simplification/2026-09-26-session-controls-stylex.md)
records the preservation boundary.

## Conversation access

`session-sharing.tsx` holds the desktop header's access surface: the team
visibility copy (`getSessionSharingLabel` / `getSessionSharingDescription`), the
list-row `SessionSharingIndicator`, the `SessionArchivedBadge`, the team-share
confirmation dialogs, and `SessionAccessControl` — the one header control
carrying both team visibility and static publication.

Team visibility is resolved by `hooks/use-session-sharing.ts` over
`lib/session-sharing.ts`. Static publication lives in `sharing/`, with
`hooks/use-session-share-management.ts` owning the editor and its read-only
companion `useSessionShareStatus` answering the header's "already shared?".
`sessions/session-chat-interface.tsx` owns the editor instance both the control
and the "…" menu open. Rationale:
[header share control](../../../../.agents/notes/implemented/feature/2026-09-14-session-header-share-control.md).

## PR auto-archive

`auto-archive-pr-watcher.tsx` keeps observed PR transitions separate from unfinished
archive attempts. Its owning window retries the existing Session action with capped
backoff and drops superseded work on scope changes. The action's automatic-only
progress receipt records accepted targets; its cancellation check uses the
authoritative snapshot before retry side effects, so restoring a partially archived
Session or Tab supersedes the unfinished operation. Startup and restore still only
establish the PR baseline.
See the [retry decision](../../../../.agents/notes/implemented/bug-fix/2026-10-17-pr-auto-archive-retry.md).
