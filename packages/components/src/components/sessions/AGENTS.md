# components/sessions

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Files: [README.md](README.md). Data: `context/message-flow.md`. Package:
[../../../AGENTS.md](../../../AGENTS.md). Scopes:
[components/](components/AGENTS.md), [message-queue/](message-queue/AGENTS.md).

Each rule is compressed; its heading links the full text. Read it before
changing those files.

## [Tabs and `?tab` routing](../../../../../.agents/docs/sessions-tabs-routing.md)

- Desktop chrome is ONE merged `SessionTabBar` row: traffic-light insets gated
  on `!useElectronFullscreen()`, pill/card geometry (y=8 line, `mt-0.5`,
  button centering) re-derived and MEASURED, never eyeballed.
- Keep the surface ladder canvas → inactive → active in both themes and MEASURE
  it; never give inactive tabs more chrome than the active one, and never use
  `--tab-active`/`--tab-inactive` (both collapse onto `--background` in dark).
- One leading status slot per tab, `waiting > working > unread > agent icon`;
  test `isWaiting` first, and never drop unread from a tab renderer.
- `?tab` is the single source of truth for the active tab: derive it from route
  search, navigate instead of setting state, never reintroduce mirrored state or
  URL↔state sync effects (#193), and never rewrite the URL from observed data.
- `Change owner` writes the OWNER `SessionMeta.userId`, never sharing/visibility;
  they stay separate actions.

## [Shell, side panel, side chats](../../../../../.agents/docs/sessions-side-panel.md)

- Desktop file/diff/browser/PR surfaces never split the conversation: they are
  closeable right-panel tabs. `sidePanelTabs` is the one strip order; every close
  handler takes its fallback neighbour from it.
- A Side Chat is a durable child Session (`childSessionPlacement: 'side-panel'`):
  no top tab, no sidebar row, but it still rolls up into the parent row. Only its
  explicit tab `X` deletes it; mount it lazily.
- `SessionMeta.openedBySessionId` is presentation-only provenance: never
  `parentSessionId`, never rolled into the opener, never filtered out of the
  list. Navigation carries root + exact tab ids.
- The collapsed side panel stays mounted: anything polling or connected in it
  must take an on-screen prop and pause itself.
- Panel mount is not preview ownership — never release an endpoint or revoke a
  tunnel from component cleanup.

## [Browser and Managed Preview](../../../../../.agents/docs/sessions-browser.md)

- The engine split is the agent machine's own LOOPBACK (Managed Preview) vs.
  everything else, LAN included (public browser capability). Never fall back from
  a missing public engine to iframe, system browser, CLI, or gateway.
- INVARIANT: a managed preview is never a pivot; approval cannot make a LAN
  target safe. Agent-authored navigation (`fromPageContent`) never opens a
  private-LAN destination — only the address bar may.
- Static HTML runs `allow-scripts`-only from a policy-owned `srcdoc`; truncated
  documents are never executable and static frames die with their tab.
- Preview comment writes go through `runtime.writer.mutatePreviewVisualComments`, never the store's `setState`.

## [Conversation surface](../../../../../.agents/docs/sessions-surface.md)

- Read receipts are gated on VISIBILITY, not on being mounted: keep the
  explicit per-surface `isVisible` prop.
- "Copy as Markdown" uses `buildConversationMarkdown`, never
  `buildReplayPromptFromHistory`; message text is never trimmed and what was
  trimmed must reach the toast.
- Read ACP capabilities via `useResolvedMachineMeta()` and selectors via
  `useSessionAcpSelectorContext()`; the controlled composer must not recompute
  selector options.
- Most rendering changes belong in `../ai-gui/view.tsx`; the conversation
  `VList` is vertical-only and wide content owns its own scroller.

## [Run config and Agent Roles](../../../../../.agents/docs/sessions-run-config.md)

- A Role never falls back: `machineId + agentConfigId` are exact, and an
  unavailable one stays listed, disabled, with its reason. A draft authorizes the
  whole Role; an existing session applies only its run config.
- A Role IS the whole configuration: other knobs render inert,
  `DesktopPermissionModeButton` is absent when the Role pins permission, and
  moving a knob unnames the Role instead of clearing values.
- Selection flows through `useAcpSessionConfigSelectionState`, a pure derivation:
  never store the resolved selection or reconcile it in an effect (#185).
- Freeze `agentRoleId` + `agentRoleRevision` into the Turn `inputConfig` on send;
  `SessionMeta.agentRoleId` is creation provenance and is never rewritten.
- Two durable authorities: the latest accepted/queued Turn `inputConfig`, and
  `SessionDoc.acpRuntimeConfig` fenced by `userTurnId`. Apply that baseline only
  to unedited composer fields, never infer runtime config from a permission
  click, and freeze a non-Plan mode for explicit execution actions.
- `AgentRoleDetailPane` is the ONE pane that reads a Role and shows only what it
  pins; `AgentRoleEditorDialog` is the one editor.

## [Live status and dispatch](../../../../../.agents/docs/sessions-live-status.md)

- Live working/waiting UI uses presence, never `SessionMeta.status`,
  `lastRunningSeen`, or the CLI dispatch pointers.
- The only frontend-derived activity state is the dispatched-but-not-started
  window; anchor on the turn's durable timestamp and stop at 30s.
- Submission routing has one conservative exception: queue behind an unfinished
  transcript when presence is absent. That barrier never relights Working UI.

## [Composer info bar](../../../../../.agents/docs/sessions-info-bar.md)

- Canonical cluster in CONSTANT order + exactly one staged item; no items hides
  the bar (unless syncing) and the stage never empties or relayouts on click.
- The stage icon is inert, colour is reserved for genuine status, and nothing
  in the bar pulses or relayouts.
- The Open preview chip stays gated on a real reported preview target, and
  repository actions are priority-ordered and never duplicated below the reply.

## [Auto review, status slot](../../../../../.agents/docs/sessions-auto-review.md)

- Auto review needs a usable reviewer row before a run starts; turning it ON
  confirms, turning it OFF does not. The banner is NOT gated on the
  experiment atom. Engine: `apps/cli/src/lib/review-automation/AGENTS.md`
- One priority-ordered status slot (browser-offline > machine-removed >
  machine-offline): states hand off, never stack; machine-offline never blocks
  sends; doc-stream degradation is never re-added.

## [Render cost](../../../../../.agents/docs/sessions-render-cost.md)

- Never subscribe page-level `activeSession` or message rows to Code Collab
  file-index Flock state or full `sessionMetaAtomFamily`; select what a row uses.
- Session-switch reset stays in the render-phase branch of `session-detail.tsx`;
  no second `useEffect([sessionId])`.
- A RESTORED side-panel state must not animate: bump `sidebarRestoreSeq` in the
  same commit as any non-user `isSidebarOpen` write.
- "Current branch" copy uses `SessionMeta.branchName` only.

## [File surfaces](../../../../../.agents/docs/sessions-file-surfaces.md)

- What a client may do with a session file is ONE model
  (`hooks/use-session-file-actions.ts` + `lib/session-file-actions.ts`): never
  promote a local-host action to a surface that cannot perform it, nor re-derive
  the split per surface.
- Local paths resolve on the OWNING machine from its workspace root plus a
  genuinely workspace-relative path; `lib/session-local-file-path.ts` rejects
  absolute and `..` paths.
- Viewers are intentionally NOT code-split; never reintroduce
  `lazy(() => import())` for them. v2 semantics: `specs/code-collab-v2.md`.

## [Stories](../../../../../.agents/docs/sessions-stories.md)

- Stories mirror production and never own UI: a story may only mock data and
  render the real component; appearance lives in the component.
  `SessionConversationPage.stories.tsx` hand-composes leaves and drifts — keep it
  minimal and verify UI changes in the real app.
