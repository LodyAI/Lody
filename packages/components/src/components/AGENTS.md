# Product surfaces (`src/components`)

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.
Child directories (`sessions/`, `mobile/`, `chat/`, `settings/`, …) own their own rules.

## Sidebar and session rows

Files: `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, `session-list.tsx`,
`sidebar-*.tsx`, `sessions/session-list-rows.ts`, `lib/session-opened-by-tree.ts`.
Reasoning: [components-sidebar-session-tree.md](../../../../.agents/docs/components-sidebar-session-tree.md).

- Sidebar rows are Sessions, not Tasks. Every desktop row supports session-mention
  drag and Mark as unread through the shared menu (hidden when already unread),
  including Workspace, Local Project, Updated, and Pinned renderers.
- Parent tabs use HTML5 drag; child tabs arm the dnd-kit in-flight store.
  `startSessionMentionDrag` / `armSessionMentionDrag` must light
  `ConversationDropOverlay` before `dragenter`. Put `draggable` on the row and
  `draggable={false}` on its navigation anchor.
- Every session list and `sidebar-navigation-model.ts` uses
  `lib/session-opened-by-tree.ts`: session-list groups, local-project sections,
  Updated, and Pinned. Supply `allActiveSessions` from the sidebar, not list rows.
- Keep `openedBySessionId` as the precise opener for navigation and
  `openedByRowSessionId` as the sidebar indentation target. Resolve the latter with
  `buildSidebarOpenerRowResolver` by walking `parentSessionId` to a root row; never
  rewrite the precise opener. Opened Sessions retain independent workspace/lifecycle;
  `parentSessionId` child Tabs stay excluded by `sessionListAtom`.
- Keep opener and unrelated top-level alignment unchanged. In `sidebar-row-shared.tsx`,
  the leading slot always draws the tree, regardless of working/unread/waiting state:
  disclosure for openers, ├/└ for children, swapping to ⋯ on hover at the same 7px
  centre. Only children widen the slot from 14px to 26px (12px title indent, unchanged
  row background). The context menu and disclosure use the same toggle callback.
- Desktop working/waiting/unread flags go only to `SessionRowStatusIndicator` in
  `SidebarRowEndSlot`. Status replaces resting metrics with one 14px mark; metrics
  remain in the hover info card. Mobile keeps its separate leading-node rule in
  [mobile/AGENTS.md](mobile/AGENTS.md).
- Never hide a Session: missing, cross-section, cross-group, cycling, or
  deeper-than-one-level openers fall back to top-level rows. Preview caps
  (`MAX_VISIBLE_SESSIONS` / `SHOW_FULL_BUCKET_THRESHOLD`) count top-level rows.
  Every surface passes `rootRank`; rank an opener by its freshest opened Session.
- Share `sidebarCollapsedOpenedBySessionsAtom`, default EXPANDED. Keep both navigation
  directions reachable through the tree, every row's "Go to Opener Session" menu,
  `SessionHeaderMenu.openedByRelations`, and create-Operation/opener conversation
  cards. Mobile uses the same two fields per bucket without a disclosure.
- Root archive/restore/delete traverses child Tabs and independently opened
  descendants. Tabs share the root's machine lifecycle command; opened Sessions
  enqueue their own. Archive lists retain opened-by indentation and keep child Tabs
  inside their owning Session's archived-tab UI.

## Entry points, drafts, and layout

- Chat landing: `chat/chat-landing.tsx`.
- Child-tab drafts send through the same accept unit as every other first message:
  `handleSendDraft` (`sessions/session-detail.tsx`) writes Session meta plus the first
  user turn together via `startSession` and only then promotes the draft tab;
  `requestSessionDispatch` is acceleration on top of the durable pointer. Never
  reintroduce a create-then-hand-off flow (pending-turn refs, post-mount ref flushes): a
  promoted tab must not exist before its first message is locally durable, and preserved
  composer text crosses the promotion via the input draft cache, not a component ref.
  `archiveSession` falls back to the rendered meta cache when the repo read lags
  hydration, and a close failure surfaces a toast — never a silent no-op.
- Desktop update prompt: `sidebar-update-banner.tsx` plus `update-changelog-dialog.tsx`,
  driven by the pure selectors in `lib/electron-update-banner.ts`. The changelog opens
  in-app; remote release notes render as sanitized Markdown with raw HTML off. The
  website is only the no-notes fallback, through `getChangelogUrl` and
  `openExternalUrl`, never a hardcoded link.
- `AgentActivityIndicator`, `ZoomableImageViewer`, and Electron image preview
  copy/save keep their own rules in [shared/AGENTS.md](shared/AGENTS.md);
  `ZoomableImageViewer` is the ONE image viewer, so never add a second one.
- `web-workspace-layout.tsx` owns the top and side safe-area inset for every desktop
  surface (`getWebWorkspaceLayoutRootClassName`): the iPad native shell renders the
  DESKTOP layout (`detectAppDeviceClass()` is `tablet`, viewport >= 768) with
  `viewport-fit=cover`. It stops at the sides — the bottom inset belongs to the surface
  against it (the composer shell pads itself by `env(safe-area-inset-bottom)`), and the
  mobile layout insets per surface.

## Local projects

- Adding a folder is a workspace action, not a this-machine action: the picker chooses
  the machine, so every entry point says "Add folder" rather than "Add a local project".
  Settings > Projects therefore pills EVERY machine the user may add to, including ones
  with no project yet, and its add action passes that machine as `initialMachineId`.
  Whoever needs the addable set reads `useAddLocalProjectMachines` — the ownership rule
  (`canAddProjects`) has one home and must not be re-derived per surface. Onboarding is
  the deliberate exception: it drives the desktop native picker and really is
  this-machine only.
- A pending local-project removal is a visible lifecycle state, not an absent project:
  keep the project and its existing Sessions discoverable while the owning machine is
  offline or retrying, but exclude it from new-Session selectors. Once the catalog row
  is gone, archived Sessions remain readable and deletable; Restore stays unavailable
  until the same local project is added again.
- Local-project removal may optionally clean Lody-created Session worktrees, but the
  option defaults off and is available only after the owning machine preflights every
  worktree. Always state that the original project directory is never deleted; list
  dirty worktrees and keep them by default. A completed cleanup result is not pending
  removal and must be acknowledged visibly even when some worktrees were kept or failed.
