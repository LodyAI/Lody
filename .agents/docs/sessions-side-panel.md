# Session detail shell: side panel, side chats, opened sessions, browser mount

The outer session shell, its right-hand side panel, side chats, session-to-session relationships, and preview/browser mounting.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `session-detail.tsx` — outer shell/tabs (desktop: `desktop-session-detail-layout.tsx`;
  mobile drill pages use `../mobile/mobile-drill-page-layout.tsx`). All Changes UI lives here via
  `session-changes-sidebar.tsx` (story: `SessionChangesSidebar.stories.tsx`). Desktop file/diff
  viewers never split the conversation surface: opt-in Files, All Changes, Browser, conditional PR,
  and file/conversation-diff/turn-diff tabs all live in the right panel under
  `session-side-panel-tab-bar.tsx`, and every tab is closeable. Functional panels start from an empty
  state, are added through its launcher or `+` menu, return to that menu when closed, and persist
  their open order/current selection per parent session in frontend local storage. Closing the active
  tab selects its previous sibling (or the next sibling when closing the first tab); only a truly
  empty tab list renders the empty state. `sidePanelTabs` is the SINGLE statement of strip order
  (fixed panels → side chats → viewers) and every close handler must take its fallback neighbour from
  the derived `sidePanelTabIds`; hand-building a partial order per close path silently breaks
  "previous sibling" as soon as a new tab kind lands between the existing ones.
  Opening a viewer dedupes by viewer id and expands that panel. Every desktop viewer activation
  path goes through `selectSidePanelTab`, so fixed panels, side chats, and viewers remain mutually
  exclusive even when content opens the viewer without a tab-strip click.
  `Side Chat` is the dynamic conversation-panel exception: each launch forks the mounted left-side
  conversation's latest forkable Assistant turn and may create another right-panel tab. Its durable
  child Session carries `childSessionPlacement: 'side-panel'`, so it stays out of the top child-tab
  strip and gets no sidebar row of its own, while otherwise using normal Session
  history/config/runtime behavior. It DOES still roll up into its parent's sidebar row
  (`buildChildSessionsByParent` in `session-list-rows.ts` groups by bare `parentSessionId`) — side
  chat activity and unread state are meant to surface on the parent conversation, so do not add a
  placement filter there.
  Do NOT confuse that with `SessionMeta.openedBySessionId`, which records the Session that CREATED
  another (the `lody_session_create` MCP tool, or `lody session create` run inside a session). That
  one is presentation-only provenance: the opened Session stays INDEPENDENT — own workspace,
  machine, project, lifecycle, sidebar row — and is only INDENTED under its opener by
  `lib/session-opened-by-tree.ts`. It must never be turned into a `parentSessionId`, never roll
  its activity into the opener's row, and never be filtered out of the session list. Both
  directions of that link are navigable: the sidebar tree plus its "Go to Opener Session" row menu,
  `SessionHeaderMenu`'s `openedByRelations` ("Opened by …" / "Opened sessions"), and
  in-conversation relationship cards. A successful `session_create` Operation completion links to
  each exact `target.sessionId`; the opened Session's first scroll row links back to its exact
  `openedBySessionId` and shows the opener's live title. The latter is passed through
  `SessionChatStream.leadingContent`, never persisted as fake history. These are wired from
  `session-chat-interface.tsx` via `openedSessionsAtomFamily` — that atom excludes
  `parentSessionId` rows on purpose, so a Session is never presented in both relationships.
  An agent running inside a CHILD TAB can create one of these, so the opener is often a Tab with
  no sidebar row. `openedBySessionId` always keeps that PRECISE Tab, while new creates also persist
  `openedByRootSessionId` when a root route is required. Navigation must carry both dimensions
  (`SessionNavigationTarget`: root `sessionId` + exact `tabSessionId`) and encode the latter through
  `session-tab-url.ts`; opening only one id either loses the Tab or routes to a hidden child. For
  pre-existing data, `resolveOpenedByNavigationTarget` derives the root from the opener's
  `parentSessionId`. Sidebar indentation uses the same persisted root first, then the legacy
  `buildSidebarOpenerRowResolver` fallback (`SessionListRow.openedByRowSessionId`). Do not collapse
  the two ids into one field, and do not give the child Tab a sidebar row to nest under.
  Unlike a fixed panel, a side chat is a tab the moment it exists, so mounting every one of them
  would open a Loro session doc per side chat even for a user who never expands the panel: mount one
  when it is first selected (`mountedSideSessionIds`), plus any fork target still waiting to report
  durable history, and keep it mounted after that.
  Show the launcher only when the active conversation's provider has authoritative native-fork
  support; keep it visible but disabled when that conversation's machine is explicitly offline. That
  offline rule lives ONLY in `getSideChatLauncherState` — the shared fork entry point stays
  offline-clickable per `docs/acp-session-fork.md` §3.2.
  Right-panel selection, collapse, route changes, and component cleanup must never delete it. Only its
  explicit tab `X` terminates the ACP runtime and then permanently deletes the Session doc; if either
  step fails, keep the tab so the user can retry. Parent-session permanent deletion may still cascade
  through all children.
  Native fork handoff keeps the source conversation active after RPC acknowledgement while the
  new child tab mounts and syncs in the background; activate it only after its real chat surface
  reports durable history ready, so the user never sees the target's transient empty state.
  The header/mobile "More" menu forks the latest completed rendered assistant turn through the
  mounted active chat surface's ref; the split desktop toolbar must not mount or subscribe to a
  second session doc merely to discover that turn. Keep its capability, archive, pending/loading,
  and RPC path identical to the assistant-footer fork action.
  When the authoritative capability cache advertises worktree forking for a Git-backed project,
  those entry points first offer shared-workspace Tab or new-worktree Session. A worktree fork keeps
  the source route active after the accepted response, persists its target id locally so refresh can
  reattach, and navigates only after the target publishes committed root-Session meta. Dirty-source
  confirmation means committed `HEAD` only; never imply that uncommitted or untracked files move.
  Browser side-panel state and the mobile deep link are named `browser` / `?browser=1`; the removed
  `preview` values are not migrated. Once opened, keep `SessionBrowserPanel` mounted while other fixed side-panel
  tabs are active so managed DOM state and Electron native-view history survive tab switches.
  The desktop layout also keeps the whole side panel mounted while COLLAPSED (it only hides it), so
  anything in there that polls or holds a connection must take an explicit on-screen prop and pause
  itself — `SessionBrowserPanel active` and `PrTabContainer visible` (which reaches
  `useGitHubPrDetails`, where it gates the same pause path as a hidden tab). Adding a poller to that
  subtree without such a prop silently keeps it running for collapsed sidebars.
  Panel mount is not preview ownership: never release a local endpoint or revoke a remote tunnel
  from component cleanup. The CLI owns local endpoints by session until explicit release/session
  cleanup, while active remote connections live in the session doc until revoke/expiry. The renderer
  retains logical Browser address/history for up to 50 sessions and keeps at most five Managed
  Preview iframes alive (`managed-preview-frame-cache.ts`: one LRU frame per session, destroyed
  after 30min parked) so route/session switches preserve the page's browsing context. That cache
  ONLY engages where an atomic `moveBefore` exists — a detach/attach pair rebuilds the browsing
  context, so on other engines parking + re-hosting costs two reloads and the module deliberately
  falls back to a fresh iframe per mount. Do not "fix" that with an appendChild path. A parked frame
  keeps its viewer URL and capability token live in this renderer, so it must die once that
  capability is no longer the session's current one; derive that from panel state (an open address
  with no managed `viewerUrl`) plus explicit revoke, and do not scatter new imperative
  `clearManagedPreviewFrame` calls at each release site — the local-endpoint one used to sit behind
  an early return and missed remote tunnels entirely. On a cache miss, reacquire the idempotent
  local endpoint or reuse a still-usable session connection without creating a new tunnel.
  `SessionBrowserPanel` keys its internal controller by session ID so state, effects, and
  `useSessionDoc` never survive an in-place session switch.
  Electron public-browser restoration only reattaches the existing `WebContentsView`; it must not
  issue another navigation to the cached URL, which would silently reload and lose page state.
