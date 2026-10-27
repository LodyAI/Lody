# Product surfaces (`src/components`)

Parent/child scopes apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.

## Styling

- StyleX, not Tailwind; tokens/rules: `../../style/` and its `MIGRATION.md`.

## Sidebar and session rows

- Rows represent Sessions, never Tasks.
- Desktop Workspace, Local Project, Updated and Pinned rows support mention drag
  and Mark as unread (hidden when unread). Use `lib/session-mention-drag.ts` for
  conversation/landing drops; parent tabs use HTML5 drag, child tabs dnd-kit.
  `startSessionMentionDrag` / `armSessionMentionDrag` light `ConversationDropOverlay`
  before `dragenter`. Rows own `draggable`; navigation overlays set false.
- Full-width sidebar stays mounted/inert with scroll. Cmd+B animates content width
  (zero under reduced motion); hidden eager-sync/keyboard-nav pauses. Compact/settings
  remounts restore scroll. Compact nav is modal: inert content, restore focus,
  nested Escape first. [Spec](../../../../specs/desktop-windows.md).
- All lists use `lib/session-opened-by-tree.ts`; `sidebar-navigation-model.ts`
  owns matching keyboard navigation.
- Keep `openedBySessionId` (precise opener) distinct from `openedByRowSessionId`
  (row). `buildSidebarOpenerRowResolver` in `sessions/session-list-rows.ts` walks
  `parentSessionId` to root using `allActiveSessions`, never visible rows.
  Preserve the precise opener and independent child workspace; `parentSessionId`
  children stay out of `sessionListAtom` rows.
- Keep opener/unrelated rows flat-aligned. Leading slots show opener disclosure
  or child ├/└ regardless of work/unread/waiting; hover swaps either for ⋯ at the
  same 7px centre. Only children widen 14px→26px, indenting titles 12px without
  shifting backgrounds. `session-row-leading-slot.tsx` owns geometry; context-menu
  expand/collapse uses the same toggle.
- Conversation titles stay `font-normal`; pin with a glyph, never weight.
- Conversation/repo/nav radius, inset, ink, hover/selected fill and title clipping
  use `sidebar-surface.ts` / `sidebar.tokens.stylex.ts`. Tailwind wins conflicting
  properties; retain it only for groups, menu-open and focus states.
- Desktop work/wait/unread/send status lives only in `SessionRowStatusIndicator`
  within `SidebarRowEndSlot`, never leading slots. One 14px mark replaces resting
  Mergeable/worktree/PR/mobile-time content; +/- totals stay in hover cards.
  Folded groups: only `SidebarGroupActivityMark`, no counts.
  Mobile: [rules](mobile/AGENTS.md).
- Nesting must not hide Sessions: missing/cross-section/cross-group/cyclic or
  deeper-than-one-level openers render top-level. `MAX_VISIBLE_SESSIONS` /
  `SHOW_FULL_BUCKET_THRESHOLD` count top-level rows. Every list passes `rootRank`;
  latest-activity sorting ranks an opener by its freshest opened Session.
- `sidebarCollapsedOpenedBySessionsAtom` defaults expanded. Keep both navigation
  directions through the tree, each row's Go to Opener Session,
  `SessionHeaderMenu.openedByRelations`, successful create-Operation conversation
  cards and the precise opener. Mobile uses both opener fields and per-bucket
  trees without disclosure, per that scope.
- Follow [Session relations](../../../../specs/session-relations.md): archive
  includes contained Tabs; opened Sessions require
  `useArchiveSessionWithConfirmation`'s explicit choice. Restore/permanent delete
  include direct child Tabs only. `deleteArchivedSession` needs complete metadata;
  `deleteSessions(ids)` deletes exactly those IDs without relation discovery.
  Nested child Sessions are unsupported. Preserve opener provenance; reverse
  navigation requires hydrated opener and root.
  [Background](../../../../.agents/docs/components-sidebar-session-tree.md).

## Entry points, drafts, and layout

- Window: `bg-sidebar`; pages: one inset `WorkspaceCard`; sidebar never floats. [Layout](../../../../.agents/docs/components-package.md).
- Child-tab drafts use the ordinary first-message accept unit: `handleSendDraft`
  (`sessions/session-detail.tsx`) uses `startSession` to durably write meta and
  first user turn together before promotion. No create-then-hand-off, pending-turn
  refs or post-mount flushes. Preserved text crosses via input draft cache, never
  a component ref; `requestSessionDispatch` only accelerates the durable pointer.
  Close persists `isTabClosed`; legacy archives share the closed list and reopen
  through lifecycle restoration. Write failures stay visible.
- Login handoff confirms account, retains PKCE/channel on switch, and permits
  allowlisted schemes only.
- Desktop changelogs render sanitized Markdown in-app, raw HTML off. Only missing
  notes fall back to the website via `getChangelogUrl` + `openExternalUrl`, never a hardcoded URL.
- Shimmer, image viewing and Electron image copy/save follow
  [shared rules](shared/AGENTS.md). `ZoomableImageViewer` is the only viewer.
- `web-workspace-layout.tsx` owns desktop top/side safe-area insets, including iPad
  native shells. Adjacent surfaces own bottom insets (composer:
  `env(safe-area-inset-bottom)`); mobile uses its scoped inset rules.

## Conversation access

- `session-sharing.tsx` owns one desktop team/web header control: team visibility
  selects menu/button; public status selects its label; audience strip shows
  access. Disable unavailable audiences with reasons; no narrowing,
  tabs, search or second badge. Paths/base branch stay in ⋯. Closed headers read
  only `useSessionShareStatus`'s management row (`unknown` means not shared).
  Inline panel/⋯ dialog reuse one keyed publisher; panel stays open while publishing. [Contract](../../../../.agents/notes/implemented/feature/2026-09-14-session-header-share-control.md).

## Local projects

- Teammates' visible shared projects navigate and offer New chat; only removal
  is owner-only.
- Adding folders is workspace-scoped: say Add folder, not Add a local project;
  picker chooses the machine. Settings > Projects pills every
  addable machine, even without projects, and passes `initialMachineId`.
  `useAddLocalProjectMachines` owns the addable set/`canAddProjects`; never
  rederive per surface. Onboarding alone uses the this-machine desktop
  native picker.
- Local directory registration and standalone display are independent. Missing
  `standaloneVisible` means visible. Standalone lists filter hidden registrations;
  member resolution, repository-copy selection and session access retain them.
- Local-project deletion uses the existing action without confirmation or dependency
  UI. The daemon retains referenced registrations and sessions; unreferenced ones
  follow normal deletion. Explicit Add restores standalone display and identity.
- Direct folder selection is draft-only until save. Gate read-only inspection on
  `projectFolderSelection`; register missing directories before saving the complete
  Project. Retried saves reuse registrations; source paths stay out of definitions.

E2EE/terminals: read [rules](e2ee/AGENTS.md).
