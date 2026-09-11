# Product surfaces

Binding rules live in [AGENTS.md](AGENTS.md); this index explains ownership.
Child directories such as `sessions/`, `mobile/`, and `chat/` own their scoped rules.

## Sidebar and session rows

The sidebar spans `loro-sidebar.tsx`, `loro-app-sidebar.tsx`, `session-list.tsx`, and
`sidebar-*.tsx`. `sessions/session-list-rows.ts` resolves row relationships, while
`lib/session-opened-by-tree.ts` builds the presentation tree.

[Sidebar relationship rationale](../../../../.agents/docs/components-sidebar-session-tree.md)
explains why exact opener navigation and root-row indentation use separate ids.
A child Tab may open an independent Session: the row sits under the root, but its
navigation must still return to the precise creating Tab.

## Entry points and layout

- Sidebar Search, immediately below New Chat, opens the shared command palette
  through `lib/commands/palette-state.ts`; see the [Spec](../../../../specs/sidebar-search.md).
- Chat landing: `chat/chat-landing.tsx`.
- Desktop update prompt: `sidebar-update-banner.tsx` and
  `update-changelog-dialog.tsx`, driven by the pure selectors in
  `lib/electron-update-banner.ts`.
- Desktop safe areas: `web-workspace-layout.tsx` and
  `getWebWorkspaceLayoutRootClassName`. The iPad native shell renders the desktop
  layout (`detectAppDeviceClass()` is `tablet`, viewport >= 768) with
  `viewport-fit=cover`, which is why desktop top/side padding also matters there.
  The composer owns its bottom edge; a global bottom inset would double-pad it.
