# Conversation surface: read receipts, Copy as Markdown, launchers, message list

`session-chat-interface.tsx` and the message-list renderer it drives.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `session-chat-interface.tsx` — conversation surface (draft variant:
  `draft-session-chat-interface.tsx`).
  **Read receipts are gated on VISIBILITY, not on being mounted.** Every child
  tab and side chat stays mounted behind the active one, so the mark-as-read
  effect takes an explicit `isVisible` prop (`../../lib/session-read-receipt.ts`)
  that `session-detail.tsx` derives per surface — top tabs `isActive`, side chats
  `isActive && isSidebarOpen` (a collapsed panel is only `invisible`). Dropping
  that prop silently marks every sub-session read the moment the parent opens.
  A manual Mark as unread moves `lastReadAt` behind the latest message while a
  surface may already be visible; that receipt gets no new opportunity until a
  new message arrives or the user leaves and reopens the surface.
  "Copy as Markdown" renders through `@lody/shared`
  `buildConversationMarkdown` (`packages/shared/src/conversation-markdown.ts`),
  NOT `buildReplayPromptFromHistory` — that one is the agent-facing replay
  prompt and its budget behaviour is load-bearing for CLI resume; keep the two
  separate. The copy targets ~20k estimated tokens AND 50k characters (both
  bounds, because CJK is ~1 token/char) and gets there by degrading tool
  output, terminal output, then thinking, oldest turns first.
  **Message text is never trimmed** — a conversation whose prose alone exceeds
  the budget returns `overBudget` instead of cutting it. Whatever was trimmed
  must reach the toast (`describeCopiedConversation`); silent truncation reads
  as "I copied everything".
  Header "Open in" / "Copy Path" launchers live here; shared launcher/path
  helpers are `../../lib/session-path-launchers.ts`,
  `../../lib/session-open-in-ide-path.ts`, and `../../lib/session-workspace-path.ts`.
  Header "Copy path" derives paths from the machine Flock doc `['dotlodyPath']`,
  falling back to local-project `rootPath`; `MachineMeta.workspacePaths[sessionId]` is
  legacy fallback only and must not get new writes.
  Launchers are desktop-bridge only (all `requiresElectron`; the split button is
  gated on `isElectronRendererForPathLaunch`, Copy Path stays in `SessionHeaderMenu`).
  Editors launch via their CLI first. VS Code alone falls back, after every CLI
  candidate fails, to `vscode://file/.../?windowId=_blank`; `_blank` is required
  because a plain scheme URL reuses the focused window and clobbers other
  worktrees. VS Code family uses `-n` (it de-dupes by folder, so re-opening focuses
  the existing window). Zed gets NO flag: `zed <path>` focuses an already-open
  worktree else opens a new window; its `-n`/`--new` forces a duplicate window
  every time (per editor `newWindowFlag` in `session-path-launchers.ts`). Warp is
  url-only (`warp://…new_tab`, via `shell.openExternal`).
  ACP selectors on existing sessions and child-tab drafts must go through
  `useSessionAcpSelectorContext()`. Session UI that reads ACP capabilities must
  use `useResolvedMachineMeta()` so machine Flock capability rows override
  legacy machine meta; never read `acpCapabilities` from the raw machine atom.
  The composer is controlled and must not recompute ACP selector options itself.
- **The message-list renderer is `../ai-gui/view.tsx`** (markdown/tool calls/terminal);
  most rendering changes land there, not here. `chat_failed` system notices render
  as compact left-aligned Coding Agent errors with no divider or persistent card;
  raw details live in a whole-row hover/focus tooltip, and the trigger uses a subtle
  error-tinted hover background. Keep the dedicated `SessionChatStream` story aligned
  with production. Its outer Virtua `VList` is vertical-only (`overflow-x-hidden`):
  wide markdown, tool output, and user content own their nested horizontal scrollers
  and must never make the whole conversation pane pan sideways.
