# Product surfaces (`src/components`)

Ancestor/scoped rules apply. `CLAUDE.md` links here; edit `AGENTS.md` only.

## Sidebar and session rows

- Sidebar rows represent Sessions, never Tasks.
- Desktop Workspace, Local Project, Updated and Pinned rows support mention drag
  and Mark as unread (hide on unread). Use `lib/session-mention-drag.ts` for
  conversation/landing drops; parent tabs use HTML5 drag, child tabs dnd-kit.
  `startSessionMentionDrag` / `armSessionMentionDrag` must light
  `ConversationDropOverlay` before `dragenter`. Navigation overlays use
  `draggable={false}`; rows own `draggable`.
- Full-width sidebar stays mounted/inert with scroll; Cmd+B animates content width
  (zero for reduced motion); pause hidden eager-sync/keyboard-nav. Compact/settings
  remounts restore scroll. Compact nav is modal: inert content, restore focus,
  nested Escape first. [Spec](../../../../specs/desktop-windows.md).
- Every list uses `lib/session-opened-by-tree.ts`; keyboard navigation uses
  `sidebar-navigation-model.ts`.
- `openedBySessionId` is the precise opener; `openedByRowSessionId` is its row.
  `buildSidebarOpenerRowResolver` in `sessions/session-list-rows.ts` walks
  `parentSessionId` to root using sidebar `allActiveSessions`, not visible rows.
  Preserve the precise opener and independent child workspace. `parentSessionId`
  children stay out of `sessionListAtom` rows.
- Opener and unrelated top-level rows retain flat-list alignment. In the leading slot,
  an opener shows disclosure and a child shows ├/└; hover swaps either for ⋯ at the same
  7px centre. Draw nesting regardless of working/unread/waiting status. Only children
  widen the slot from 14px to 26px for a 12px title indent without shifting the background.
  Keep geometry in `session-row-leading-slot.tsx`; context-menu expand/collapse uses
  the same toggle.
- Conversation titles stay `font-normal`; pin with the glyph, never weight.
- Sidebar row radius, inset, ink, hover/selected fill and title clipping use
  `sidebar-surface.ts` / `sidebar.tokens.stylex.ts` on conversation, repo and nav rows.
  Tailwind wins same-property conflicts; keep it only for groups, menu-open and focus states.
- Desktop work/wait/unread/send status belongs only in `SessionRowStatusIndicator`
  inside `SidebarRowEndSlot`, never the leading slot; it replaces resting `Mergeable`,
  worktree, PR icon or mobile time with one 14px mark. +/- totals: hover card only.
  Mobile: [mobile/AGENTS.md](mobile/AGENTS.md). Folded groups: only
  `SidebarGroupActivityMark`, no counts ([why](../../../../.agents/notes/implemented/feature/2026-09-26-sidebar-folded-group-status.md)).
- Never hide a Session through nesting: missing, cross-section, cycling, or
  deeper-than-one-level openers render top-level. In Workspace mode,
  `placeWorkspaceSessionsWithOpeners` first moves a Session whose opener renders in
  another group into that group; Pinned and Updated keep natural membership. `MAX_VISIBLE_SESSIONS` /
  `SHOW_FULL_BUCKET_THRESHOLD` count top-level rows. Every list passes `rootRank` for
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

- The window is `bg-sidebar`; pages use one inset `WorkspaceCard`. Keep the sidebar on the
  window, never as a floating surface. See [layout docs](../../../../.agents/docs/components-package.md).
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

- `session-sharing.tsx` owns one desktop header control for team and web access: team visibility
  selects menu/button, public status selects the label, and its audience strip shows current access.
  Unavailable audiences are disabled with a reason; narrowing, tabs, search, and a second badge are
  forbidden. Paths and base branch stay in `⋯`. Closed headers read only the `useSessionShareStatus`
  management row (`unknown` means not shared). The inline panel and `⋯` dialog reuse one keyed
  publisher; the panel stays open while publishing. [Contract](../../../../.agents/notes/implemented/feature/2026-09-14-session-header-share-control.md).

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
