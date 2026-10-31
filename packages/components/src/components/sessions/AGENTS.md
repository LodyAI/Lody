# components/sessions

`CLAUDE.md` symlinks here. Edit `AGENTS.md` only.

Read parent rules and linked context.

## [Tabs and `?tab` routing](../../../../../.agents/docs/sessions-tabs-routing.md)

- ONE `SessionTabBar` row; traffic-light insets gated on `!useElectronFullscreen()`.
  Hide IDE/share pills below `SESSION_PAGE_HEADER_PILLS_MIN_WIDTH_PX`; keep them on `⋯`.
- Conversation and side-panel tabs share `TAB_PILL_*_CLASS`. Never
  `--tab-active`/`--tab-inactive` (both collapse onto `--background` in dark).
- One leading status slot per tab, `waiting > working > unread > agent icon`;
  Test `isWaiting` first; use `sessionHasUnreadMessages` to exclude closed/archived output.
- `?tab` owns selection; never mirror it in state (#193). Confirmed shared closure
  may replace the current choice with a neighbour or local draft. Close writes
  `isTabClosed`, never archive/delete; reopen clears only it, never unarchives.
- Cmd/Ctrl+W ownership: [command rules](../../lib/commands/AGENTS.md).
- `Change owner` writes the OWNER `SessionMeta.userId`, never sharing/visibility;
  they stay separate actions.

## [Shell, side panel, side chats](../../../../../.agents/docs/sessions-side-panel.md)

- Desktop file/diff/browser/PR viewers are closeable right-panel tabs; never split
  the conversation. `sidePanelTabs` owns order and close fallback neighbours.
- Side Chat is a durable child Session (`childSessionPlacement: 'side-panel'`):
  no top tab or sidebar row; rolls up into the parent row. Only tab close deletes it;
  mount lazily.
- `SessionMeta.openedBySessionId` is presentation-only provenance: never
  `parentSessionId`, never rolled into the opener, never filtered out of the
  list. Navigation carries root + exact tab ids.
- The collapsed side panel stays mounted: polling/connections need an on-screen
  prop and must pause while hidden.
- Panel mount is not preview ownership — never release an endpoint or revoke a
  tunnel from component cleanup.

## [Browser and Managed Preview](../../../../../.agents/docs/sessions-browser.md)

- Managed Preview accepts only the agent machine's LOOPBACK. All other addresses
  require public-browser capability; no iframe/system-browser/CLI/gateway fallback.
- Approval cannot authorize LAN previews. Agent-authored navigation
  (`fromPageContent`) never opens private LAN; only the address bar may.
- Preload one bounded frame after live confirmation; require atomic moves, no
  polling, and cleanup safe after Browser takeover.
- Static HTML requires policy-owned `srcdoc`. Scripts require credentialless and
  `allow-scripts` only; otherwise use navigation-stripped HTML with an empty sandbox.
  Never preview truncated text; static frames die with their tab.
- Encrypted remote preview controls require the existing protected feature host
  and verified write role; never fall back to ordinary preview proofs. Explain
  that page bytes pass through the tunnel service as plaintext.
- Preview comment writes go through `runtime.writer.mutatePreviewVisualComments`, never the store's `setState`.

## [Conversation surface](../../../../../.agents/docs/sessions-surface.md)

- Mobile chat composers/questions own keyboard lift; other side panels use
  `nativeKeyboardInset`. Wide sessions inherit root padding once.
- Message-list crash fallback preserves the composer and copies the shared report
  with the original error and React component stacks.
- Read receipts require per-surface `isVisible`, never mere mounting.
- Every user management action uses `useSessionActions`; its shared guard checks current Repo metadata for every affected target before side effects, including contained/opened sessions.
- Encrypted history uses the bound runtime's document access without expanding machine/project execution indexes. Unavailable targets mount only the document reader, without machine probes or RPC. [Boundary](../../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md#member-visibility-a4).
- Keep question drafts on navigation and IME Enter; show failures.
- Markdown copy uses `buildConversationMarkdown`, not `buildReplayPromptFromHistory`:
  keep prose whole, cap thinking rather than drop it, toast every omission, and
  include the selected message regardless of ACP fork support.
- Read ACP capabilities via `useResolvedMachineMeta()` and selectors via
  `useSessionAcpSelectorContext()`; never recompute options in the composer.
- Rendering changes mostly belong in `../ai-gui/view.tsx`; conversation `VList`
  is vertical-only; wide content owns its scroller.

## [Run config and Agent Roles](../../../../../.agents/docs/sessions-run-config.md)

- A Role never falls back: `machineId + agentConfigId` are exact, and an
  unavailable one stays listed, disabled, with its reason. A draft authorizes the
  whole Role; an existing session applies only its run config.
- A Role IS the whole configuration: other knobs are inert;
  `DesktopPermissionModeButton` is absent when permission is pinned; moving a
  knob unnames the Role without clearing values.
- Selection flows through `useAcpSessionConfigSelectionState`, a pure derivation:
  never store the resolved selection or reconcile it in an effect (#185).
- Freeze `agentRoleId` + `agentRoleRevision` into the Turn `inputConfig` on send;
  `SessionMeta.agentRoleId` is creation provenance and is never rewritten.
- Two durable authorities: the latest accepted/queued Turn `inputConfig`, and
  `SessionDoc.acpRuntimeConfig` fenced by `userTurnId`. Apply that baseline only
  to unedited composer fields, never infer runtime config from a permission
  click, and freeze a non-Plan mode for explicit execution actions.
- `AgentRoleDetailPane` is the ONE pane that reads a Role and shows only what it
  pins; `AgentRoleEditorDialog` is the one editor. When the pane cannot fit,
  `ComposerAgentRolePanel` puts agent · model on a second line instead.

## [Live status and dispatch](../../../../../.agents/docs/sessions-live-status.md)

- Presence owns Working/Waiting UI, not `SessionMeta.status`, `lastRunningSeen`,
  or CLI dispatch pointers.
- Only derived activity: dispatched-but-not-started; use durable turn time, stop at 30s.
- No presence: queue behind unfinished turns; never relight Working.
- Busy composer without authoritative steer uses Queue.
- Interrupt-and-send cancels with `{ interrupt: true }`, never the Stop identity:
  an Inbox-aware Stop pauses and cancels every queued input, losing the guidance (#2050).
- Uploads: [contract](../../../../../specs/composer-send-during-upload.md).

## [Composer info bar](../../../../../.agents/docs/sessions-info-bar.md)

- Keep cluster order and one nonempty stage when items exist. Hide only without
  items or ambient content. Machine (desktop name/mobile icon) stays unstaged;
  ownership appears only in details. Scheduled drafts live in the composer, never the bar.
- Stage icons stay inert; reserve colour for genuine status; no pulses.
- Open preview stays gated on a real reported target; repository actions are
  priority-ordered (dirty ⇒ Commit & Push), collapse into one, never duplicated
  below the reply.

## [Session status slot](../../../../../.agents/docs/sessions-auto-review.md)

- One priority-ordered status slot (browser-offline > machine-removed >
  machine-offline): states hand off, never stack; machine-offline never blocks
  sends; doc-stream degradation is never re-added.

## [Render cost](../../../../../.agents/docs/sessions-render-cost.md)

- Reuse controller; lazy-mount child bodies.
- Never subscribe page-level `activeSession` or message rows to Code Collab
  file-index Flock state or full `sessionMetaAtomFamily`; select what a row uses.
- Session-switch reset stays in the render-phase branch of `session-detail.tsx`;
  no second `useEffect([sessionId])`.
- A RESTORED side-panel state must not animate: bump `sidebarRestoreSeq` in the
  same commit as any non-user `isSidebarOpen` write.
- "Current branch" copy uses `SessionMeta.branchName` only.
- PR summaries: shared lifecycle reads, no UI writes/API grants; local PRs open externally.

## [File surfaces](../../../../../.agents/docs/sessions-file-surfaces.md)

- File actions use `hooks/use-session-file-actions.ts` + `lib/session-file-actions.ts`;
  never duplicate capability checks or expose unavailable local-host actions.
- A failed conversation file-link index must release its optional cache lease and
  pause until the conversation is shown again, leaving Files/Changes free to recover.
- Mobile Changes starts at the shared file list; exact file/comment links open diffs.
  Retain diffs on Back; preserve drafts/expansion/focus. Viewport-gate bodies,
  pause hidden reads and use shared parse Workers for multi-file cache misses.
- Local paths use the OWNING machine's workspace root + workspace-relative path;
  `lib/session-local-file-path.ts` rejects absolute/`..`.
- Static viewer shells; Office engines load on activation/idle; pause hidden video.
  PDFs: 64 KiB ranges, 8 MP canvases; retain bundled Worker entry/export.

## [Stories](../../../../../.agents/docs/sessions-stories.md)

- Stories render real components and only mock data; appearance lives in production.
  Keep stories minimal; verify UI changes in the app.
