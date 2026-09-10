# Product surfaces (`src/components`)

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.
Child directories (`sessions/`, `mobile/`, `chat/`, `settings/`, …) own their own rules.

## Sidebar and session rows

Ownership and explanations: [README.md](README.md).

- Sidebar rows represent Sessions, never Tasks.
- Every desktop row supports session-mention drag and Mark as unread in the shared ⋯
  menu (Workspace, Local Project, Updated, and Pinned); hide Mark as unread on unread rows.
  Use `lib/session-mention-drag.ts` for drops on the conversation page or landing.
  Parent tabs in `session-tab-bar.tsx` use HTML5 drag; child tabs use the dnd-kit
  in-flight store. `startSessionMentionDrag` / `armSessionMentionDrag` must light
  `ConversationDropOverlay` before `dragenter`. Navigation overlays use
  `draggable={false}`; put `draggable` on the row.
- Every list uses `lib/session-opened-by-tree.ts`: `session-list.tsx` groups, local-project
  sections, Updated/Pinned in `sidebar-updated-session-list.tsx`, and
  `sidebar-navigation-model.ts` for matching keyboard navigation.
- Keep the relations distinct: `openedBySessionId` is the precise opener;
  `openedByRowSessionId` is its sidebar row. `buildSidebarOpenerRowResolver` in
  `sessions/session-list-rows.ts` walks `parentSessionId` to the root row using the
  sidebar's `allActiveSessions`, never a set re-derived from visible rows. Never rewrite
  the precise opener to the root. Opened Sessions retain independent workspace/lifecycle;
  `parentSessionId` children remain excluded from `sessionListAtom` sidebar rows.
- Opener and unrelated top-level rows retain flat-list alignment. In the leading slot,
  an opener shows disclosure and a child shows ├/└; hover swaps either for ⋯ at the same
  7px centre. Draw nesting regardless of working/unread/waiting status. Only children
  widen the slot from 14px to 26px for a 12px title indent without shifting the background.
  Keep geometry in `sidebar-row-shared.tsx`; context-menu expand/collapse uses the same
  toggle callback.
- Desktop working/waiting/unread status belongs only in `SessionRowStatusIndicator`
  inside `SidebarRowEndSlot`. Pass those three flags to the end slot, never the leading
  slot. Status replaces resting line diff, `Mergeable`, worktree glyph, PR icon, or mobile
  time with one 14px mark; retain metrics in the desktop hover info card. Mobile chat
  leading-node rules remain in [mobile/AGENTS.md](mobile/AGENTS.md).
- Never hide a Session through nesting: missing, cross-section, cross-group, cycling,
  or deeper-than-one-level openers render top-level. `MAX_VISIBLE_SESSIONS` /
  `SHOW_FULL_BUCKET_THRESHOLD` count top-level rows. Every list passes `rootRank` for
  latest-activity sorting; rank an opener by its freshest opened Session.
- Collapse state uses `sidebarCollapsedOpenedBySessionsAtom`, default expanded. Keep
  both navigation directions reachable through the tree, every sidebar row's "Go to
  Opener Session", `SessionHeaderMenu.openedByRelations`, and conversation cards for
  successful create Operations / the precise opener. Mobile lists use the same two
  fields and per-bucket tree without disclosure, per [mobile/AGENTS.md](mobile/AGENTS.md).
- Root archive/restore/delete traverses child Tabs and all independently opened
  descendants. Child Tabs share the root machine lifecycle command; opened Sessions
  enqueue their own. Archived lists retain opened-by indentation, with child Tabs
  inside their owning Session's archived-tab UI.

## Entry points, drafts, and layout

- Child-tab drafts send through the same accept unit as every other first message:
  `handleSendDraft` (`sessions/session-detail.tsx`) writes Session meta plus the first
  user turn together via `startSession` and only then promotes the draft tab;
  `requestSessionDispatch` is acceleration on top of the durable pointer. Never
  reintroduce a create-then-hand-off flow (pending-turn refs, post-mount ref flushes): a
  promoted tab must not exist before its first message is locally durable, and preserved
  composer text crosses the promotion via the input draft cache, not a component ref.
  `archiveSession` falls back to the rendered meta cache when the repo read lags
  hydration, and a close failure surfaces a toast — never a silent no-op.
- Desktop changelogs open in-app as sanitized Markdown with raw HTML off. Only
  missing notes fall back to the website, via `getChangelogUrl` and
  `openExternalUrl`, never a hardcoded link.
- `AgentActivityIndicator`, `ZoomableImageViewer`, and Electron image preview
  copy/save keep their own rules in [shared/AGENTS.md](shared/AGENTS.md);
  `ZoomableImageViewer` is the ONE image viewer, so never add a second one.
- `web-workspace-layout.tsx` owns top/side safe-area insets for desktop surfaces,
  including the iPad native shell. The bottom inset belongs to the adjacent surface
  (the composer uses `env(safe-area-inset-bottom)`); mobile insets per surface.

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
