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
  the precise opener to the root. Opened Sessions retain independent workspaces;
  `parentSessionId` children remain excluded from `sessionListAtom` sidebar rows.
- Opener and unrelated top-level rows retain flat-list alignment. In the leading slot,
  an opener shows disclosure and a child shows ├/└; hover swaps either for ⋯ at the same
  7px centre. Draw nesting regardless of working/unread/waiting status. Only children
  widen the slot from 14px to 26px for a 12px title indent without shifting the background.
  Keep geometry in `session-row-leading-slot.tsx` (re-exported by
  `sidebar-row-shared.tsx`); context-menu expand/collapse uses the same toggle.
- Conversation titles stay `font-normal`; pin with the glyph, never weight.
- Desktop working/waiting/unread status belongs only in `SessionRowStatusIndicator`
  inside `SidebarRowEndSlot`. Pass those three flags to the end slot, never the leading
  slot. Status replaces resting `Mergeable`, worktree glyph, PR icon, or mobile
  time with one 14px mark. No +/- totals on the row (hover card only). Mobile
  leading-node rules remain in
  [mobile/AGENTS.md](mobile/AGENTS.md).
- Never hide a Session through nesting: missing, cross-section, cross-group, cycling,
  or deeper-than-one-level openers render top-level. `MAX_VISIBLE_SESSIONS` /
  `SHOW_FULL_BUCKET_THRESHOLD` count top-level rows. Every list passes `rootRank` for
  latest-activity sorting; rank an opener by its freshest opened Session.
- Collapse state uses `sidebarCollapsedOpenedBySessionsAtom`, default expanded. Keep
  both navigation directions reachable through the tree, every sidebar row's "Go to
  Opener Session", `SessionHeaderMenu.openedByRelations`, and conversation cards for
  successful create Operations / the precise opener. Mobile lists use the same two
  fields and per-bucket tree without disclosure, per [mobile/AGENTS.md](mobile/AGENTS.md).
- Follow the [Session relation contract](../../../../specs/session-relations.md): root
  archive recursively includes contained Tabs and opened Sessions, using the shared
  archive selector and a complete metadata cache. Restore and archived-root permanent
  delete include only direct child Tabs. `deleteArchivedSession` requires a complete metadata
  cache before selecting that destructive set; `deleteSessions(ids)` deletes exactly
  the supplied ids without relation discovery or a cache-readiness requirement so
  compensation and explicit child/side-session cleanup remain available during
  hydration. Nested child Sessions are unsupported. Keep dangling `openedBy*`
  provenance after deleting an opener, but expose reverse navigation only when the
  exact opener and route root both resolve after hydration. Archived lists still use
  opened-by provenance for indentation, with child Tabs inside their owning Session's
  archived-tab UI.

## Entry points, drafts, and layout

- Child-tab drafts send through the same accept unit as every other first message:
  `handleSendDraft` (`sessions/session-detail.tsx`) writes Session meta plus the first
  user turn together via `startSession` and only then promotes the draft tab;
  `requestSessionDispatch` is acceleration on top of the durable pointer. Never
  reintroduce a create-then-hand-off flow (pending-turn refs, post-mount ref flushes): a
  promoted tab must not exist before its first message is locally durable, and preserved
  composer text crosses the promotion via the input draft cache, not a component ref.
  Tab close persists `isTabClosed`; legacy archives share the closed list and reopen
  through lifecycle restoration. Failed writes remain visible to the user.
- Login handoff: confirm account; retain PKCE/channel on switch; allowlisted schemes only.
- Desktop changelogs open in-app as sanitized Markdown with raw HTML off. Only
  missing notes fall back to the website, via `getChangelogUrl` and
  `openExternalUrl`, never a hardcoded link.
- The live agent status shimmer, `ZoomableImageViewer`, and Electron image preview
  copy/save keep their own rules in [shared/AGENTS.md](shared/AGENTS.md);
  `ZoomableImageViewer` is the ONE image viewer, so never add a second one.
- `web-workspace-layout.tsx` owns top/side safe-area insets for desktop surfaces,
  including the iPad native shell. The bottom inset belongs to the adjacent surface
  (the composer uses `env(safe-area-inset-bottom)`); mobile insets per surface.

## Conversation access

- `session-sharing.tsx` owns ONE desktop header control for both access axes.
  Team visibility picks the shape — private keeps the menu explaining its
  inherited machine/project scope before either sharing action, anything else is
  a plain button — and a published link picks the label in both shapes, being
  the wider disclosure. Never add a second badge beside it; the private scope
  stays the menu's first block.
- `useSessionShareStatus` is the only cloud read a header makes while the share
  editor is CLOSED: the management row, never a source document. `unknown` reads
  as not-yet-shared, so the label upgrades in place instead of flashing in.
- The page owns that editor: header control and `…` menu open the same
  `SessionShareDialog`, keyed by session id so a switching tab cannot retarget it.

## Local projects

- Project rows follow visibility, not machine ownership: a teammate's shared project
  navigates and offers New chat; only removal is owner-only.
- Adding a folder is a workspace action, not a this-machine action: the picker chooses
  the machine, so every entry point says "Add folder", not "Add a local project".
  Settings > Projects pills EVERY machine the user may add to, even ones with no project
  yet, and passes it as `initialMachineId`. The addable set comes from
  `useAddLocalProjectMachines`; the ownership rule (`canAddProjects`) has one home and
  must not be re-derived per surface. Onboarding is the deliberate exception: its
  desktop native picker really is this-machine only.
- A pending local-project removal is a visible lifecycle state, not an absent project:
  keep the project and its Sessions discoverable while the owning machine is offline or
  retrying, but exclude it from new-Session selectors. Once the catalog row is gone,
  archived Sessions stay readable and deletable; Restore waits until the same local
  project is added again.
- Local-project removal may optionally clean Lody-created Session worktrees, but the
  option defaults off and appears only after the owning machine preflights every
  worktree. Always state the original project directory is never deleted; list dirty
  worktrees and keep them by default. A completed cleanup is not pending removal and
  must be visibly acknowledged even when worktrees were kept or failed.
