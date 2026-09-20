# Product surfaces

Binding rules live in [AGENTS.md](AGENTS.md); this index explains ownership.
Child directories such as `sessions/`, `mobile/`, and `chat/` own their scoped rules.

## Sidebar and session rows

The sidebar spans `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, `session-list.tsx`, and
`sidebar-*.tsx`. `sessions/session-list-rows.ts` resolves row relationships, while
`lib/session-opened-by-tree.ts` builds the presentation tree.

GitHub repository groups and local project folders both expose a desktop drag handle.
Their orders are persisted per workspace; local project keys also include the owning
machine so projects from different devices cannot collide. See the
[sidebar project ordering Spec](../../../../specs/sidebar-project-ordering.md).

[Sidebar relationship rationale](../../../../.agents/docs/components-sidebar-session-tree.md)
explains why exact opener navigation and root-row indentation use separate ids.
A child Tab may open an independent Session: the row sits under the root, but its
navigation must still return to the precise creating Tab.

Updated organize mode is a mixed recency list, so a top-level row shows a second
line with folder / GitHub owner mark + project name. Nested opened Sessions stay
one title line so the 30px tree trunk still meets. Workspace-mode Pinned omits
the line. Decision:
[updated project context](../../../../.agents/notes/implemented/feature/2026-09-20-sidebar-updated-project-context.md).

## Entry points and layout

- Sidebar Search, immediately below New Chat, opens the shared command palette
  through `lib/commands/palette-state.ts`; see the [Spec](../../../../specs/sidebar-search.md).
- Chat landing: `chat/chat-landing.tsx`.
- Browser desktop sign-in handoff: `login-page.tsx` under `?client_id=electron`,
  the page the desktop app opens in the system browser. A desktop sign-out leaves
  this browser signed in as the previous account, so the page names that account
  and transfers it only on an explicit choice, keeps the attempt's
  `state`/`code_challenge` when the user switches accounts, discards a transfer
  that lands after the switch, and renders the `lody://auth/callback` URL as a link
  beside the automatic navigation — a browser that refuses a custom-scheme
  navigation reports nothing back, so the link must already be on screen.
  [Decision](../../../../.agents/notes/implemented/bug-fix/2026-09-15-electron-browser-signin-account-choice.md).
- Desktop update prompt: `sidebar-update-banner.tsx` and
  `update-changelog-dialog.tsx`, driven by the pure selectors in
  `lib/electron-update-banner.ts`.
- Desktop safe areas: `web-workspace-layout.tsx` and
  `getWebWorkspaceLayoutRootClassName`. The iPad native shell renders the desktop
  layout (`detectAppDeviceClass()` is `tablet`, viewport >= 768) with
  `viewport-fit=cover`, which is why desktop top/side padding also matters there.
  The composer owns its bottom edge; a global bottom inset would double-pad it.

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
