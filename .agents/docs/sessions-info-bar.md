# Composer info bar: canonical cluster + fixed stage

`info-chip.tsx`, `session-info-chips.tsx`, and `session-info-bar.tsx` — the desktop/mobile bar glued above the composer.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

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
  a changed GitHub-capable workspace without a PR shows `Create PR` + `Commit & Push`,
  including a direct Local Project with a resolved GitHub repository. For an open
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
  synthesize `pause` for those providers. Paused and blocked Codex goals both expose
  Resume; a blocked goal is waiting for explicit user continuation, not terminal.
  An `active` goal is persistent session state,
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
