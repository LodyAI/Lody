# Product surfaces (`src/components`)

Parent/child scopes apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.

## Styling

- StyleX, not Tailwind; tokens/rules: `../../style/` and its `MIGRATION.md`.

## Sidebar and session rows

- Sidebar top-level groups (machines, GitHub Worktrees, Chats) all use
  `SIDEBAR_GROUP_LABEL_CLASS`, with no leading icon or sticky positioning; labels scroll
  with their rows. Project, repo and conversation rows
  are 1em. A machine is identified by its Offline pill and hover card
  (`sidebar-machine-card.tsx`); never show "offline" while its status is unknown.

- Sidebar rows represent Sessions, never Tasks.
- Desktop project grouping applies `selectVisibleLocalProjectSections`; its
  "Hide Empty Projects" switch is documented in the [README](README.md).
- Desktop Workspace, Local Project, Updated and Pinned rows support mention drag
  and Mark as unread (hidden when unread). Use `lib/session-mention-drag.ts` for
  conversation/landing drops; parent tabs and unpinned rows use HTML5 drag, child
  tabs and Pinned rows use dnd-kit via `dropSessionMentionAtPoint`.
  `startSessionMentionDrag` / `armSessionMentionDrag` must light
  `ConversationDropOverlay` before `dragenter`. Navigation overlays use
  `draggable={false}`; rows own `draggable`.
  Sidebar `DndContext`s keep `autoScroll={false}`;
  `use-session-drag-auto-scroll.ts` owns edge scrolling.
- Workspace selection navigates in place and preserves the current workspace's route
  on reselection. Browser `/chat` links retain native modified-click, middle-click and
  context-menu actions without switching the source page. Electron Cmd-click
  (Ctrl-click on Windows/Linux) and context menus open native workspace windows.
- Full-width sidebar stays mounted/inert with scroll. Cmd+B animates content width
  (zero under reduced motion); hidden eager-sync/keyboard-nav pauses. Compact/settings
  remounts restore scroll. Compact nav is modal: inert content, restore focus,
  nested Escape first. [Spec](../../../../specs/desktop-windows.md). It opens only once
  the synced compact state agrees; a close that never finishes is unmounted.
- Every list uses `lib/session-opened-by-tree.ts`; keyboard navigation uses
  `sidebar-navigation-model.ts`.
- `openedBySessionId` is the precise opener; `openedByRowSessionId` its row.
  `buildSidebarOpenerRowResolver` walks `parentSessionId` to root using sidebar
  `allActiveSessions`, not visible rows. Preserve opener and child workspace;
  parent children stay out of `sessionListAtom`. Read
  [session provenance rules](sessions/AGENTS.md#opener-provenance) before changing ownership.
- Opener and unrelated top-level rows retain flat-list alignment. In the leading slot,
  an opener shows disclosure, a child ├/└, nothing else — the ⋯ menu reveals in the
  end slot before Archive, in reserved columns with no fill of its own.
  Draw nesting regardless of hover or working/unread/waiting status. Children alone widen the slot 14px→26px, a 12px title indent that never
  shifts the background. Keep geometry in `session-row-leading-slot.tsx`; context-menu
  expand/collapse uses the same toggle.
- Conversation titles stay `font-normal`; pin with the glyph, never weight.
- Sidebar row radius, inset, ink, hover/selected fill and title clipping use
  `sidebar-surface.ts` / `sidebar.tokens.stylex.ts` on conversation, repo and nav rows.
  Compose overrides in the owner; native group/data hooks drive menu-open and focus states.
- Desktop work/wait/unread/send status belongs only in `SessionRowStatusIndicator`
  inside `SidebarRowEndSlot`, never the leading slot; it replaces resting `Mergeable`,
  worktree, PR icon or mobile time with one 14px mark. +/- totals: hover card only.
  Mobile: [mobile/AGENTS.md](mobile/AGENTS.md). Folded groups: only
  `SidebarGroupActivityMark`, no counts ([why](../../../../.agents/notes/implemented/feature/2026-09-26-sidebar-folded-group-status.md)).
- Never hide a Session through nesting: missing, cross-section, cycling, or
  deeper-than-one-level openers render top-level. In Workspace mode,
  `placeWorkspaceSessionsWithOpeners` first moves a Session whose opener renders in
  another group into that group. Before splitting desktop sections, pinned openers bring
  their visible opened-by descendants into Pinned without changing descendant pin flags. `MAX_VISIBLE_SESSIONS` /
  `UPDATED_BUCKET_PREVIEW_MAX` count top-level rows. Every list passes `rootRank` for
  latest-activity sorting; rank an opener by its freshest opened Session.
- Collapse state uses `sidebarCollapsedOpenedBySessionsAtom`, default expanded. Keep
  both navigation directions reachable through the tree, every sidebar row's "Go to
  Opener Session", `SessionHeaderMenu.openedByRelations`, and conversation cards for
  successful create Operations / the precise opener. Mobile lists use the same two
  fields and per-bucket tree without disclosure, per [mobile/AGENTS.md](mobile/AGENTS.md).
- Follow the [Session relation Spec](../../../../specs/session-relations.md): archive includes
  contained Tabs; opened Sessions only via `useArchiveSessionWithConfirmation`'s explicit choice.
  Restore and permanent delete include direct child Tabs only.
  `deleteArchivedSession` needs complete metadata; `deleteSessions(ids)` deletes those ids exactly,
  without relation discovery. Nested child Sessions are unsupported. Preserve opener provenance;
  expose reverse navigation only when opener and root resolve after hydration. See
  [tree rules](../../../../.agents/docs/components-sidebar-session-tree.md).

## Entry points, drafts, and layout

- iOS divisions separate workspace panes; never save the temporary sidebar width. [Decision](../../../../.agents/notes/implemented/bug-fix/2026-10-28-ios-vertical-division.md).
- Keep the touch resize grip and narrower navigation sidebar minimum scoped to wide mobile Web layouts.
- The window is `bg-sidebar`; pages use one inset `WorkspaceCard`. Keep the sidebar on the
  window, never floating. See [layout docs](../../../../.agents/docs/components-package.md).
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
  `ZoomableImageViewer` is the ONE image viewer; never add a second.
- `web-workspace-layout.tsx` owns top/side safe-area insets for desktop surfaces,
  including the iPad native shell. The bottom inset belongs to the adjacent surface
  (the composer uses `env(safe-area-inset-bottom)`); mobile insets per surface.

## Conversation access

- `session-sharing.tsx` owns the shared header control. Its button states Private,
  Team read-only or Team can edit. The panel offers Private and Team read-only;
  shared-machine editing links to machine settings. Only the machine owner can
  change session access; other members see disabled choices with a reason.
  Public links remain a separate section and a busy publisher keeps the panel open.
  Authoritative access comes through the platform `sessionAccess` port, never
  SessionMeta. [Contract](../../../../specs/session-access.md).

## Local projects

- Project rows follow visibility: shared projects navigate and offer New chat;
  only removal is owner-only.
- Adding folders is workspace-scoped: say "Add folder"; the picker chooses the
  machine. Settings > Projects lists every addable machine, including empty ones,
  and passes `initialMachineId`. `useAddLocalProjectMachines` owns the addable set
  and `canAddProjects`; do not rederive them per surface. Onboarding alone uses
  the this-machine desktop picker.
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

## Crash diagnostics

ErrorBoundary uploads one fixed-vocabulary exception per failure episode, including retries, until healthy content commits.

## Automation markers

Before changing workspace readiness or control identity markers, read
[sessions/automation/AGENTS.md](sessions/automation/AGENTS.md#control-and-readiness-markers).
