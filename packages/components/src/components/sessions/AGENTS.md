# components/sessions — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

**Message architecture (how conversation data gets here):
context/message-flow.md.** Package-level
shortcuts: [packages/components/AGENTS.md](../../../AGENTS.md).

Session conversation page chain:

- Desktop top bar is ONE merged row (no repo-title header row): `SessionTabBar`
  with `leftSlot` (sidebar expand + macOS traffic-light inset via `className`)
  and `rightSlot` = a `SessionChatInterface headerVariant="toolbar"` instance
  (IDE launcher / Browser / "…" menu / sidebar toggle — no title, no PR badge).
  All macOS traffic-light insets (sidebar `h-[72px] pt-7` header, this bar's
  `pl-[4.5rem]`, `reserveMacTrafficLightInset`, landing `left-[96px]`, and the
  root drag strip) are gated on `!useElectronFullscreen()` — the main process
  pushes `lody:window-fullscreen-changed` and the lights auto-hide in native
  fullscreen, so no inset is reserved there. The traffic-light CENTERLINE is
  y=23px (`trafficLightPosition {x:20, y:16}` in `apps/electron/src/main/window.ts`
  - 7px button radius); every h-7 chrome button beside the lights centers on it
    (sidebar collapse `-top-0.5` in `loro-sidebar.tsx`, landing expand `top-[9px]`
    in `web-chat-landing-screen.tsx`) — re-derive those offsets if the Electron
    position or the card `mt-2`/border/`p-[2px]` stack changes. On Windows the native title bar is
    hidden (`titleBarStyle: 'hidden'` + theme-tinted `titleBarOverlay`, see
    `apps/electron/src/main/window-theme.ts`); the window instead reserves ONE
    36px drag band at the top — root drag strip `h-9` in `routes/__root.tsx` +
    `pt-9` in `web-workspace-layout.tsx`, both gated the same way — so no page
    (this bar included) reserves its own right-side inset for the caption buttons.
    Mobile never renders `SessionTabBar`; it uses `MobileSessionTabSheet` instead.
    Desktop tabs share width equally whenever all can reach `ACTIVE_TAB_MIN_WIDTH`;
    below that threshold the active tab keeps that width and the others share the remainder.
    **The tab pills' top border shares one line with the sidebar and side-panel
    cards at y=8**, since every floating card is `mt-2` (sidebar in
    `loro-app-sidebar.tsx`, side panel + terminal dock in `session-detail.tsx` /
    `terminal-dock.tsx`). The bar row therefore takes `mt-0.5`, NOT `mt-2`: its
    h-8 pills are centered in an h-11 row, so the row starts 6px higher and the
    pills land on 8 (2 + (44 − 32) / 2). Changing the row height, the pill height,
    or the cards' `mt-2` silently breaks that line — re-derive it, and measure
    with `getBoundingClientRect`, don't eyeball.
    **One canvas, and the ACTIVE tab is the heaviest thing in the row.**
    `bg-background` runs unbroken from this bar down through the message list and
    out to the frame; tabs sit ON that canvas and must not break it (do not give
    the bar row its own strip color). The active tab wears the app's
    floating-panel material — `bg-sidebar` + `border-sidebar-border/80` + the same
    drop shadow as the side panel / terminal dock — so "the one in a box" reads as
    the current page. Inactive tabs get a flat borderless wash
    (`bg-muted-foreground/[0.07]`) + dimmed text. Keep that weight order: among
    siblings in a row the eye scores chrome as selected, so anything that gives
    inactive tabs MORE chrome than the active one reads inverted (tried it — the
    active tab then looks like a static heading). A `solo` tab spans the row and
    therefore drops the fill; a full-width pill would paint the whole bar.
    **Keep the surface ladder ordered — canvas → inactive → active — and MEASURE
    it (`getComputedStyle`), don't eyeball the token names.** Light gets that
    ladder from `bg-sidebar` for free (canvas 241 → active 229). Dark does not, so
    the active pill carries `dark:bg-muted-foreground/[0.18]` +
    `dark:border-muted-foreground/[0.24]`: Vesper's `sideBar.background` is
    `#161616`, only 6 above the `#101010` canvas AND below the inactive wash (26),
    so `bg-sidebar` alone rendered the active tab as a dent with only its border
    holding it up. The override lands 16 → 26 → 42, border 70. Do NOT reach for
    `--tab-active` / `--tab-inactive` / `bg-tab-active`: both collapse onto
    `--background` in dark (Vesper `tab.inactiveBackground` == `editor.background`),
    which is why the original `/[0.22]` vs `/[0.12]` tints existed — a 10% gap that
    rendered as one gray and was the actual cause of "I can't tell which tab is
    active". Two alpha tints of one color are fine per se; the gap and the ordering
    are what matter. Text hierarchy DOES resolve in both themes — keep
    `--tab-*-foreground`. `session-side-panel-tab-bar.tsx` still uses the old alpha
    pills; its container is the floating card, not the canvas.
    Repo identity lives in the desktop-only `session-info-bar.tsx` glued above
    the composer (the "canonical cluster + fixed stage" bar detailed below; it
    replaced the header `PullRequestBadge` and the old `session-context-strip.tsx`)
    and in the "…" menu (Repository/Machine/branch info rows). `changesDiffStat`
    reads the active sidebar session's `SessionMeta.diffStats.allChange`, matching
    that sidebar row exactly; the bar must never trigger or independently total
    diff loads.
    In a multi-member workspace, `SessionAccessControl` sits in the desktop toolbar
    before the "…" menu only while effective access is `Private`; Team and unresolved
    states stay hidden. Single-member workspaces do not resolve or pass sharing state.
    Its menu action enters the existing parent-owned confirmation flow. Keep the full
    status/action in `SessionHeaderMenu` as the mobile/compact fallback.
    The "…" menu's `Change owner` submenu writes `SessionMeta.userId` — the OWNER
    field, which drives the sidebar My/Team split, the row author avatar, CLI
    Code Collab owner checks, and usage attribution. It is not sharing/visibility
    (that is machine + local-project grants, `use-session-sharing.ts`) and the two
    must stay separate actions. Gated on `useWorkspaceMembers().isMultiMember`:
    a solo workspace has nobody to hand the session to, so no owner UI renders.
    Any member may transfer, mirroring task owner assignment.
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
  Opening a viewer dedupes by viewer id and expands that panel.
  `Side Chat` is the dynamic conversation-panel exception: each launch forks the mounted left-side
  conversation's latest forkable Assistant turn and may create another right-panel tab. Its durable
  child Session carries `childSessionPlacement: 'side-panel'`, so it stays out of the top child-tab
  strip and gets no sidebar row of its own, while otherwise using normal Session
  history/config/runtime behavior. It DOES still roll up into its parent's sidebar row
  (`buildChildSessionsByParent` in `session-list-rows.ts` groups by bare `parentSessionId`) — side
  chat activity and unread state are meant to surface on the parent conversation, so do not add a
  placement filter there.
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
- Session Browser has strict dual engines. Public HTTP(S) uses only a declared public-browser
  capability (Electron `WebContentsView` today); loopback/private targets use Managed Preview and
  are the only pages eligible for Visual Annotation. Never fall back from a missing public engine
  to iframe, system browser, CLI, Preview Gateway, or a different Machine RPC plane.
  The composer info-bar Browser action is an explicit candidate-navigation request, not merely a
  panel-open action. It opens the reported candidate even when another page is already visible.
  That click IS the approval for that exact target: a remote route creates (or replaces) its tunnel
  immediately, with no confirmation dialog, because the CLI only accepts LOOPBACK targets from an
  agent report. Keep the auto-approval keyed on the parsed address being loopback — a private-LAN
  target, a typed address, and Share all still go through the confirmation flow.
  Consume the request after handling it so a later panel remount cannot replay stale user intent —
  but NOT while the candidate is still in flight. Session meta carries only the candidate status;
  its target lives in the session doc `preview` state, and the two planes sync independently, so a
  click landing between those writes must wait for the doc (bounded by the doc reaching `synced`)
  instead of consuming the request and leaving an empty panel.
  An empty Browser must always say WHY it is empty — a bare globe reads as a broken panel. With no
  reported candidate the empty state names that (the agent never called `lody_report_preview_candidate`,
  which is the common case, not a bug); with one, it points at the address bar.
  Annotation mode installs a full-viewport transparent interaction layer inside the managed page;
  it must remain the pointer target while hit-testing temporarily ignores it to inspect the page
  below. Do not revert to listener-only interception, which lets page pointer handlers activate.
  Draft and persisted comment UI render outside the iframe, so both must be registered with the
  injected runtime as tracked anchors. Their overlay position must come from refreshed resolved
  rects on page scroll; an initial click rect is only a pre-resolution placeholder.
  Injected annotation target payloads use path-relative `page.url` values; resolve them against the
  logical preview URL before stripping capability parameters. Treat parse failures as visible runtime
  errors instead of silently dropping the selection message.
  Creating a new preview comment immediately stages its visual-annotation reference in the matching
  session composer through the idempotent `addVisualAnnotationReference` path. Existing-comment
  controls use the separate toggle path so users can remove or re-add a staged reference.
  Preview comment create/resolve/unresolve/submitted writes MUST go through
  `runtime.writer.mutatePreviewVisualComments`; never call the preview comment store's `setState`
  from UI code. Preview comments are renderer-authored user data on every platform.
- `session-chat-interface.tsx` — conversation surface (draft variant:
  `draft-session-chat-interface.tsx`).
  **Read receipts are gated on VISIBILITY, not on being mounted.** Every child
  tab and side chat stays mounted behind the active one, so the mark-as-read
  effect takes an explicit `isVisible` prop (`../../lib/session-read-receipt.ts`)
  that `session-detail.tsx` derives per surface — top tabs `isActive`, side chats
  `isActive && isSidebarOpen` (a collapsed panel is only `invisible`). Dropping
  that prop silently marks every sub-session read the moment the parent opens.
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
- `session-chat-input-area.tsx` — composer; `message-queue-display.tsx` — queued turns.
  Child-tab suggestions are shared by draft and persisted child sessions through
  `child-tab-empty-state.tsx`; it uses the same `px-3` + `ConversationColumn` as
  the composer, so its right edge and max width must stay aligned automatically.
  Desktop run knobs are TWO footer buttons from `desktop-run-config-menu.tsx`:
  `DesktopRunConfigMenu` (`[agent icon] model · reasoning ⌄` face; dropdown =
  Agent/Model/Reasoning side submenus + Plan/Fast toggle rows) and
  `DesktopPermissionModeButton` (mode icon + full name; flat mode list). Both
  are also used by the desktop chat landing; `DesktopRunConfigMenu` receives an
  explicit agent selection/machine scope rather than reading `SessionMeta`.
  Agent/Model/Reasoning option selection closes the dropdown and must not return
  keyboard focus to its trigger; Plan/Fast toggle rows intentionally stay open.
  The selected mode is applied per TURN (it becomes the user entry's
  `inputConfig.modeId`; `resolveSessionConversationConfig` reads the latest turn
  back as the preference). So approving "Yes, implement this plan" — which only
  switches the mode of the running ACP turn — must ALSO drop the selector out of
  plan, or the next send quietly plans again. Driven from the CLICK
  (`hooks/use-plan-mode-exit-approval.ts` → `atoms/plan-mode-exit.ts`, read by
  the composer), never from the resolved outcome in history: this selection is
  per-device local state, so a history-derived signal would unset plan mode for
  a teammate who just armed it, and would fire again for an OLD approval
  replaying as the session doc syncs. Every interactive permission surface must
  call the notifier — there are two (`floating-permission-request.tsx` and the
  inline card in `../ai-gui/view.tsx`). It exits to the agent's default non-plan
  mode and deliberately does not infer `acceptEdits` from an `allow_always`
  answer: that consent was about this plan, not every later turn.
  `DesktopMachineMenu` is the matching elevated machine picker used by chat landing.
  Both render on the app-wide DropdownMenu surface (color-mix bg + layered
  float shadow). The old bottom bar row is gone: machine name + workdir badge moved to
  `SessionHeaderMenu` (`machineName` prop). Mobile keeps the single
  `MobileSessionRunConfig` button + sheet.
  Pending-attachment state machines: `pendingImages` (images) **and** `pendingFiles`
  (files; cloud upload via `@/lib/session-file-upload.ts` with sha256/textPreview,
  abort + part retry). Oversize images (>5 MiB) auto-degrade to files. Send blocks
  while either is uploading. Desktop same-machine uploads use
  `@/lib/electron-session-file-sender.ts` / `window.api.sendSessionFileLocal`, return
  a `transport:'local'` block into the same `pendingFiles[].uploaded` slot, and fall
  back to cloud on handoff failure. Image + file inputs use the same plain hidden
  `<input type="file">` on every platform (Windows included — the renderer no
  longer crashes once locale `.pak`s ship; see `apps/electron/AGENTS.md`).
- `floating-permission-request.tsx`: floating permissions + ask-user-question;
  hidden-composer mobile keyboard lift/scroll lives there.
  `notification-permission-prompt.tsx` and the inner content of `session-pin.tsx`
  use the same `ConversationColumn` as the stream and composer; keep full-bleed
  bands outside that column, but never let their interactive content span the pane.
- Live working/waiting UI (spinners, permission badges, Stop visibility, tab/dock
  status) must use presence (`sessionLiveStatusAtomFamily` or an explicit
  `liveSessionStatuses` map), not `SessionMeta.status` / `lastRunningSeen`.
  Session meta status is durable/historical state and can be stale until a write
  lands; presence is the single source for "is working now". The meta dispatch
  pointers (`latestUserMsgId` / `lastHandledUserMsgId` / `processingUserMsgId`)
  are CLI dispatch mechanics and must not drive UI either — a stale meta plane
  once left finished conversations showing "Starting…" forever. The one
  frontend-derived activity state is the dispatched-but-not-started window,
  read from the trailing `pending`/`seen` user turn in session history via
  `lib/session-dispatch-state.ts`; history is the same doc the transcript
  renders from, so it cannot contradict the visible conversation. That pre-start
  window is TIME-BOUNDED: `resolveUnstartedTrailingDispatchAtMs` anchors on the
  turn's own durable `timestamp` and the UI stops showing "Starting…" once
  `UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS` (30s) elapses with no CLI presence.
  The bound exists because a crashed daemon / desynced dispatch pointer / stuck
  sync otherwise left "Starting…" showing forever (reading as a stuck-busy
  agent) — presence never arrived to clear it, and the machine could still look
  online. Anchor on the durable timestamp, NOT a component mount time: a stalled
  turn must report its full age immediately after a reload instead of restarting
  the 30s clock. The window only needs to cover send → the CLI's FIRST
  `initializing` presence (published the moment the turn owns the session); every
  later phase reports its own presence, so do not widen the timeout to cover a
  whole agent run. Durable resolution of a truly stalled turn still comes from
  CLI-side reconciliation on the next daemon start; the timeout only bounds the
  optimistic UI. That pre-start label is additionally suppressed whenever the
  status chip has an active connection/machine problem (`statusStripState !=
null`: browser offline, machine removed or offline) — the chip owns that story,
  and "Starting…" next to "machine offline" is a contradiction. `isSessionWorking`
  (Stop visibility, busy-send queue routing) shares the SAME time-bounded
  pre-start signal, so a stalled dispatch no longer holds the composer in a busy
  state either.
- `info-chip.tsx` + `session-info-chips.tsx` + `session-info-bar.tsx`: the
  info bar follows the "canonical cluster + fixed stage" model. Cluster =
  collapsed items as uniform icon chips in CONSTANT order (status > goal >
  schedule > task > context/PR; items return to their own slot — never
  MRU-reshuffle). The `task` chip appears only on a Session linked to a Task and
  is the way back to it; a new item picks a fixed slot in that list rather than
  appending, and must never reorder the others. Note the separate, deliberately
  different order in `session-info-bar.tsx` for choosing which item opens on the
  stage (context first, as the most informative default) — that is stage
  preference, not cluster order, and the two are not meant to match. Stage = the rightmost item. Invariants: no items → the bar
  hides; with items, EXACTLY one is always expanded on the stage (there is no
  fully-collapsed state, and the stage never empties). Click semantics
  (researched; do not overload a second click): cluster chip = promote onto
  stage; stage ICON = inert marker (NOT a button — clicking the rightmost
  item must never collapse or relayout; no persistent highlight bg — the
  cluster│stage divider alone conveys activation); stage SUMMARY + resting ↗
  = the item's single detail surface (popover or action). The deliberate
  multi-action exception is the context stage: its PR marker opens PR details,
  branch text copies `SessionMeta.branchName`, and ±diff selects the fixed All Changes
  side-panel tab (it must never create a duplicate `diff:all-changes` viewer tab); the
  repository name stays inert. A session with an on-disk location also renders
  its location glyph as a `LocationControl` copy button (StageChip
  `iconOverride` when no PR, else in the `leading` slot). The glyph reflects the
  session's identity, NOT just its on-disk layout: a GitHub session
  (`workspaceLocation.kind === 'github-worktree'`, set when `repoFullName` is
  present) shows the GitHub mark — GitHub projects are ALWAYS worktrees, so the
  worktree mark there is redundant noise (mirrors the sidebar, which suppresses
  its worktree badge for GitHub rows). A LOCAL worktree shows the worktree mark
  and a local folder the folder mark (symmetric); worktree-ness is only
  informative for local sessions. Hover tooltip "GitHub/Worktree/Folder · click
  to copy path", click copies the resolved path (`resolveSessionWorkspacePath`,
  threaded as `workspaceLocation = {kind, path}`; a `github-worktree` still
  copies the worktree checkout path) + toasts. Remote/repo-only sessions have no
  local path → `workspaceLocation` is null and the leading icon stays an inert
  branch glyph.
  The bar also takes an ambient `syncing` prop (desktop only — mobile shows
  catch-up in its header instead): a plain `SessionSyncingIndicator` pinned
  to the bar's RIGHT edge, outside the cluster/stage model; it must never
  become a cluster item or steal stage focus. Its label hides below a 560px
  container width (spinner stays, via `SessionSyncingIndicator
labelClassName`) so the stage diffstat never clips. Wired from
  `session-chat-interface.tsx` as `!isMobile && effectiveTitleSyncing` (the
  same `isSyncingRoomSyncState` + 400ms `useDelayedFlag` signal the mobile
  header uses). With NO items the bar still hides UNLESS syncing — catch-up
  is the one state allowed to render the bar alone on a context-less chat
  session (no staged item, no divider; the spinner keeps its right-edge pin
  via an `ml-auto` wrapper). Regression coverage:
  `tests/session-info-bar-syncing.test.tsx` + the `SyncOnly` /
  `EmptyNotSyncingHidden` stories.
  The control has a HOVER bg only (not persistent) and never relayouts, so it
  respects the no-collapse spirit while adding the copy affordance. CI is NOT its own
  cluster item: the `PrCiPill` (a "CI" text pill tinted by verdict, "done/
  total" while running) rides inside the context item's expanded stage
  content, right after the PR number, so it is only visible when the PR is
  expanded; one click toggles its check-run popover (`PrCiRun[]` is
  presentational; production maps the active PR's live GitHub check-run fetch
  into it). Color budget: ambient
  chips (status/goal/schedule) render NEUTRAL (goal state reads from its
  pulse + popover, not an inline tint); color is reserved for genuine
  status — the expanded PR status icon and the ±diff counts.
  No pulsing/blinking anywhere in the bar (goal active + CI running used to
  pulse; removed — the row must stay visually still). Context chip: the
  COLLAPSED chip is ALWAYS a neutral branch icon with NO "#1234" label (that
  variable-width number was the source of the hand-off layout jump); the
  EXPANDED chip's icon reflects PR state (open/merged/closed) or a branch
  icon when there is no PR, and carries "#1234" + CI pill there. Its action:
  the PR marker opens the PR tab, branch copies the current branch, and ±diff
  opens the existing fixed All Changes side-panel tab; file-row and comment-reference
  actions may still create a diff viewer because they carry a precise file/comment focus.
  The context stage is also the single owner of agent-driven GitHub/worktree actions:
  a changed worktree without a PR shows `Create PR` + `Commit & Push`. For an open
  associated PR, compact poller state selects exactly one higher-priority path:
  conflicts show `Resolve Conflicts` (an immediate agent prompt), failed/error CI
  shows `Fix CI Errors` (refresh details, include a bounded failed-check snapshot,
  then send an agent prompt), and proven readiness shows the shared Merge split-button.
  Its dropdown selects merge/squash/rebase without merging; the primary half performs
  the selected method. Other dirty PRs retain `Commit & Push`. Do not infer that PR
  review comments are actionable, so there is no automatic `Fix PR Comments` action.
  The action array is priority ordered:
  the first action renders as the single explicit TEXT button in the `StageChip` trailing slot;
  when more actions exist, a small chevron beside it opens the remaining actions in an
  upward-opening menu. The primary action + chevron form one subtle, borderless background
  surface with a low-contrast internal divider (single actions use the same surface without the chevron). Neither half
  leaves an external focus outline/ring; keyboard focus stays visible as an internal background tint.
  Under 420px,
  compact chip values/PR number and the CI pill yield their
  space so the primary action stays fully visible. Actions must not be duplicated below the
  assistant response. Reply-specific
  decisions such as Implement plan / Continue discussing stay with
  that reply because they are not repository actions. Open preview is a plain
  `ActionChip` at the end of the cluster (emerald MonitorPlay, no stage
  form, opts out of promote/recency) — it replaced the desktop toolbar
  Browser button AND the mobile header preview + PR badge (both removed;
  mobile reaches Files/PR/Browser via the tab sheet's viewer entries). That
  chip is AGENT-DRIVEN and must stay gated on the session actually having a
  preview target (`hasReportedPreviewTarget` over the `SessionMeta` preview
  summary: a `lody_report_preview_candidate` candidate, or a still-live
  connection). It is not a generic "open the Browser panel" button — rendering
  it on every session promised a preview that did not exist and landed on the
  no-candidate empty state; the side-panel launcher / `+` menu (and the mobile
  tab sheet) remain the unconditional way in. Because this standalone action can
  be the only info-bar content in a context-less Session, it must keep the bar
  rendered without a staged item. Focus is recency-driven
  (item appears/changes → takes the stage); stage content leaves only by
  promoting another item or its data disappearing. NO hand-off animation —
  the stage remounts per item, so any fade/slide reads as jitter; stage
  content appears instantly. Radix gotcha: popover anchors use PopoverAnchor (not Trigger) and
  must preventDefault onPointerDownOutside when the target is the anchor,
  or dismiss + click-toggle cancel out. GoalChip's popover reuses
  `GoalActionButton`/`formatTokensCompact` from `session-goal-banner.tsx`.
  Goal controls are transport-gated: the current `/goal …` prompt bridge is
  Codex-only, so provider-neutral snapshots remain read-only until their advertised
  `_session/goal` method is routed through the session control plane; Stop must never
  synthesize `pause` for those providers. An `active` goal is persistent session state,
  not proof that an ACP prompt is running: current busy/running UI, message queue routing,
  and completion prompts must use live turn presence only. Active goal state may still
  gate destructive history rewrites and expose an explicit Codex Pause control.
  ScheduleChip reuses `useResolvedScheduledTasks`/`ScheduledTaskList` from
  `scheduled-tasks-panel.tsx` (same adaptive countdown clock, cannot drift).
  The message queue intentionally stays OUT of the bar. The bar renders on
  BOTH desktop and mobile from `session-chat-interface.tsx` (status + goal +
  schedule + context); it fully replaced the sticky `SessionGoalBanner`, the
  in-composer `ScheduledTasksPanel`, the mobile `SessionStatusStrip`
  instance, and the `create-pr` quick action — none of those render in
  production anymore (SessionStatusStrip stays exported for its story only).
  Production CI detail is fetched only for the active associated PR through
  `useGitHubPrDetails`; compact `pullRequestState` remains the cheap sidebar/action
  decision feed. An inactive proven-ready session replaces its sidebar diff stat
  with the green bordered Mergeable pill; the active row hides both because the
  Info Bar owns the merge control.
- Auto review and merge (`auto-review-menu-item.tsx`, `auto-review-info.tsx`,
  `auto-review-status.tsx`, `../../hooks/use-auto-review.ts`): a per-session
  checkbox in the "…" menu behind `reviewAgentFeatureEnabledAtom`, plus an
  always-visible status banner above the info bar while a run is active.
  A session may start either review mode only after its machine has a usable
  reviewer row (`agentConfigId` + ACP run config) in the workspace review Flock
  doc. Missing/stale configuration opens the setup explanation and routes to
  General settings; never let the engine discover this only after spending a
  run. The General settings table lists every visible machine and reuses the
  composer run-config dropdowns for Agent/Model/Reasoning/Permission.
  A checkbox, not a button: this is a standing mode that survives restarts and
  must be revocable. Turning it ON confirms first (automatic merge is not
  reversible); turning it OFF does not — stopping an automation must never be the
  harder direction. **The banner is deliberately NOT gated** on the experiment
  atom: a run lives on the machine and keeps going, so hiding it after someone
  switches the experiment off would recreate the exact failure it prevents —
  finding out only when a PR merged itself. The gate is per-device UI; the
  authorization is `SessionMeta.autoReview`, which only a human may write.
  Structural coverage: `tests/review-agent-gate-coverage.test.ts`. Engine and
  invariants: `apps/cli/src/lib/review-automation/AGENTS.md`.
- `session-status-strip.tsx`: ONE priority-ordered status slot for
  connection/machine problems (browser-offline > machine-removed >
  machine-offline); states hand off, never stack. Doc-stream degradation is
  deliberately NOT a status (was removed by product decision — the reconnect
  loop owns recovery and surfacing it read as noise); do not re-add a "may be
  out of date" state. The status renders as the info bar's status chip on
  BOTH platforms via `useSessionStatusPresentation` (the standalone
  `SessionStatusStrip` component no longer renders in production — story
  coverage only). Machine liveness is presence-based
  (`useMachineOnlineStatus`, three-state — 'unknown' must not claim offline).
  `isMachineRemoved` (meta gone, blocks send; gated on `docMetaCacheReadyAtom`)
  is distinct from machine-offline (informational only: sends are written
  durably and run on reconnect — do not block them; neutral tone, not warning).
  The header `SessionSyncingIndicator` only covers active catch-up
  (`isSyncingRoomSyncState`) behind a ~400ms `useDelayedFlag`.
- Stories: composer/input-area/queue/draft variants under `src/stories/`;
  attachment-rich list case is `SessionChatStream` → `HumanAndAgentAttachments`;
  shared full-page session conversation coverage is `SessionConversationPage.stories.tsx`
  using `session-conversation-page.tsx`.
- **Storybook-fidelity invariant (stories mirror production, they don't own UI).**
  A `*.stories.tsx` may only mock data/providers and render the REAL component.
  NEVER put appearance (color/spacing/border/sizing that changes how a component
  looks) in a story — it must live in the component under `src/components/**` or
  it never reaches production. To iterate on a component's look, edit the
  component and preview via its DEDICATED story (e.g. `PermissionRequestCard.stories.tsx`,
  which renders that real component directly). `SessionConversationPage.stories.tsx`
  is an INTEGRATION harness: the real page (`session-chat-interface.tsx` /
  `session-detail.tsx`) can't render in Storybook (needs the workspace
  runtime/Convex/Machine-RPC), so it hand-composes leaf components. That
  hand-composition MUST mirror production and drifts silently — keep it minimal
  and keep these in sync: (1) mobile vs desktop header mirrors `session-detail.tsx`
  `if (isMobile)` (mobile `BaseHeader`, `...` menu top-right via `actions`) and
  the desktop merged `SessionTabBar` row + context strip (see the top-bar bullet
  above); (2) `useIsMobile()` reads
  `window.innerWidth` (not any CSS phone frame) → mobile stories resize the
  preview iframe via the `withMobileViewport` decorator so `isMobile` is true;
  (3) mobile renders full-bleed (no fake bezel/padding). After ANY UI change,
  verify in the real app (mobile included) — a story's preview chrome is not
  production. Audit tip: `grep -nE '(bg-|text-|rounded-|shadow-|border-|w-\[|h-\[)' src/stories/*.stories.tsx`
  on component instances is a smell; that styling belongs in the component.
- `session-detail.tsx` must not subscribe page-level `activeSession` to Code Collab
  file-index Flock state. That state can update from file watchers and should only
  invalidate file surfaces, not the whole chat/message list.
- Message rows must not subscribe to full `sessionMetaAtomFamily`. Select only
  the fields needed by row UI (for example avatar `cliType`/`agentType`/`env`) so
  Code Collab shared-state metadata does not wake idle markdown rows.
- Treat Code Collab file-index Flock state as large/path-keyed state. Keep it out
  of repo meta and subscribe from file provider hooks only.
- `session-detail.tsx` owns session-switch local UI reset. Keep the reset in the
  render-phase `localStateSessionId !== sessionId` branch; do not add a second
  `useEffect([sessionId])` reset that replays the same state updates.
- **A RESTORED side-panel state must not animate.** The desktop panel animates
  `flex-grow`/`min-width`, so one 220ms expand runs style → layout → paint →
  compositing for the whole detail tree every frame — measured at ~400ms of
  near-saturated main thread per session switch. Any code path that sets
  `isSidebarOpen` from persisted/URL state rather than from a user action must
  bump `sidebarRestoreSeq` in the same commit (today: the session-switch reset
  branch and the `?pr=` deep-link effect); `DesktopSessionDetailLayout` then
  applies it in one frame and re-arms the transition on the next rAF. User
  toggles (`handleToggleSidebar`, `handleOpenPrTab`, viewer/browser opens) still
  animate and must NOT bump it.
- Branch UI shortcut: "current branch" copy uses `SessionMeta.branchName` only.
  `SessionMeta.baseBranch` / `project.branch` are start/base refs; they may be
  shown as base fallback, but must not be copied or labeled as current. The
  mobile bottom `SessionInfoBar` omits branch information; desktop keeps it.

Code Collab file surfaces (data chain: [packages/components/AGENTS.md](../../../AGENTS.md)):

- Diff page: `session-conversation-diff-panel.tsx`, data from
  `use-session-conversation-diff-data.ts`.
- Editor window (Monaco): `session-monaco-text-viewer.tsx` inside
  `session-file-content-view.tsx`.
- v2 semantics for file tree, All Changes, refresh/save conflicts, and CLI-local
  turn diff RPC: `specs/code-collab-v2.md`.
- **File tree: ONE row renderer** (`VirtualFileTree` in `components/file-tree-view.tsx`)
  and ONE virtualization gate, counting VISIBLE rows. A second tree-wide count
  used to swap in Radix `TreeView`, so a lazily growing tree thrashed between two
  row implementations — do not reintroduce either. An empty virtual range renders
  NO rows (never `rows.map`) and keeps the total-size spacer: the ScrollArea
  viewport is an ANCESTOR ref, so it is still null when TanStack reads
  `getScrollElement()`, making the first range always empty — a full-render
  fallback there mounted the whole tree. Re-`measure()` on viewport attach/resize
  (as `shared/option-selector.tsx` does). Rows are `memo`'d against per-frame
  scroll re-renders, which needs `pruneExpandedFileTreeIds` to return its input
  Set on a no-op prune (watcher ticks churn `data`) and icon factories to cache by
  resolved icon name. Coverage: `tests/file-tree-virtual-rows.test.tsx`.
- **Viewers are intentionally NOT code-split** (file viewer, diff viewer, diff
  panel, inner Monaco/Markdown are static imports). Code-splitting only pays off
  over a network; in the local Electron bundle a lazy `import()` adds no benefit
  and a stale/eval-broken chunk surfaced as "Viewer failed to load / the app may have updated".
  Do not reintroduce `lazy(() => import())` for these — there must be no separate
  viewer chunk that can fail to load. The old `*-lazy.tsx` wrappers + stale-asset
  ErrorBoundary fallbacks were removed for this reason.
