# Product surfaces (`src/components`)

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.
Child directories (`sessions/`, `mobile/`, `chat/`, `settings/`, …) own their own rules.

## Sidebar and session rows

Files: `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, `session-list.tsx`,
`sidebar-*.tsx`, `sessions/session-list-rows.ts`, `lib/session-opened-by-tree.ts`.
Reasoning: [components-sidebar-session-tree.md](../../../../.agents/docs/components-sidebar-session-tree.md).

- Sidebar rows are sessions, not Tasks.
- EVERY desktop session row is a drag source for a session mention
  (`lib/session-mention-drag.ts`, dropped on the conversation page or the landing).
  Session tabs in `session-tab-bar.tsx` are the same gesture: parent tabs HTML5-drag,
  child session tabs arm the in-flight store from dnd-kit. `startSessionMentionDrag` /
  `armSessionMentionDrag` light `ConversationDropOverlay` immediately, before
  `dragenter`. A row whose surface is a navigation `<a>` overlay must put `draggable` on
  the ROW and `draggable={false}` on that anchor.
- EVERY desktop row also exposes Mark as unread from that shared ⋯ menu — Workspace,
  Local Project, Updated, and Pinned renderers must all wire it; hide the action once
  the row is unread.
- `SessionMeta.openedBySessionId` (a Session created BY another, e.g. the
  `lody_session_create` MCP tool) indents that row under its opener via
  `lib/session-opened-by-tree.ts`. EVERY session list uses it — `session-list.tsx`
  groups, the local-project sections, and `sidebar-updated-session-list.tsx` (Updated
  bucket and Pinned section) — plus `sidebar-navigation-model.ts`, so keyboard nav
  matches what is rendered.
- It is presentation only and is NOT `parentSessionId`: opened Sessions keep their own
  workspace/lifecycle and stay first-class rows, while `parentSessionId` children never
  reach the sidebar at all (`sessionListAtom`).
- TWO fields, never merged: `openedBySessionId` is the PRECISE opener and drives
  navigation; `openedByRowSessionId` is the sidebar ROW to indent under. They differ when
  an agent inside a child Tab creates a Session, so `buildSidebarOpenerRowResolver`
  (`sessions/session-list-rows.ts`) walks `parentSessionId` up to the root row. Never
  "simplify" that by rewriting `openedBySessionId` to the root: "Go to Opener Session"
  and the conversation's "Opened by" entry must land on the exact Tab that created it.
- The opener and unrelated top-level rows keep the exact flat-list alignment. The shared
  leading slot owns the node-centre affordance: an idle opener shows its disclosure at
  rest and swaps it for ⋯ on row hover; an idle child shows ├/└ and swaps those for ⋯ in
  the SAME 7px-centred position. STATUS OUTRANKS THE TREE on both sides: an active
  (working / unread / waiting) child drops the trunk and elbow, and an active opener
  drops its disclosure — never both. Gate the opener on the whole activity set, not just
  `isWorking`, and keep the context menu's expand/collapse item wired to the same toggle
  callback so a busy opener stays foldable. Only a child widens that slot from 14px to
  26px, producing the 12px title indent without shifting the row background. Keep
  connector geometry in `sidebar-row-shared.tsx`.
- The resolver needs `allActiveSessions`, so any new list must take it from the sidebar
  rather than re-deriving it from rows.
- The tree never hides a Session: a missing, cross-section, cross-group, cycling, or
  deeper-than-one-level opener degrades to a top-level row, and the preview cap
  (`MAX_VISIBLE_SESSIONS` / `SHOW_FULL_BUCKET_THRESHOLD`) counts top-level rows.
- Every list here is sorted by latest activity, so each surface passes `rootRank` and an
  opener is ranked by its FRESHEST opened Session.
- Collapse state is the shared `sidebarCollapsedOpenedBySessionsAtom` and defaults to
  EXPANDED. Both navigation directions must stay reachable: the tree and the row context
  menu's "Go to Opener Session" in every sidebar list,
  `SessionHeaderMenu.openedByRelations`, and the in-conversation cards for successful
  create Operations / the opened Session's precise opener. The mobile chat lists render
  the same tree from the same two fields, per bucket, minus the disclosure — see
  [mobile/AGENTS.md](mobile/AGENTS.md).
- Session lifecycle actions traverse both relations: a root archive, restore, or delete
  includes child Tabs and every independently opened descendant. Child Tabs share the
  root's machine lifecycle command; independently opened Sessions enqueue their own. The
  archive list keeps the opened-by indentation while child Tabs remain inside their
  owning Session's archived-tab UI.

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
