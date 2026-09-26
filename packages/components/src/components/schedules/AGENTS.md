# Schedule UI

`CLAUDE.md` is a symlink to this file. Decisions and rationale:
[scheduled tasks note](../../../../../.agents/notes/implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md).

- One workspace-shell Registry subscription supplies list and provenance links;
  details acquire/release one Schedule store through WorkspaceRuntime. All writes use
  `withScheduleStore`. Never load every definition for listing. Schedules are
  generally available: no developer/beta gate on navigation, commands, the
  Registry subscription, proposal cards or the Agent's Schedule tools.
- `schedule-view.tsx` is presentational with Storybook fixtures;
  `schedules-workspace.tsx` owns domain writes, selectors and composition.
  `schedule-save-blockers.ts` is the one save rule, `schedule-format.ts` the one
  vocabulary and the only place that constructs `Intl` formatters (normalize
  `locale` with `toIntlLocaleOrEn`; `zh_CN` is a RangeError). `AgentRunRef` and the project
  selector live in `components/shared`; the Agent and machine controls are the
  composer's (`sessions/desktop-run-config-menu.tsx`).
- Save needs an Agent with an explicit permission mode on an owned, capable
  machine; never a project (none = plain chat, end to end). No consent checkbox,
  directory-scope checkbox, full-access warning or resume dialog — do not add one
  back in any shape; ownership, capability and permission still gate save/run.
- The list is the page; no tabs, no dialog. `routes/…/schedules.tsx` is a
  layout route that mounts `SchedulesWorkspace` once (its index and `$scheduleId`
  children render nothing), so opening a schedule animates instead of
  remounting. On desktop it slides in beside the table (`ScheduleSplitView`,
  under the list header via `renderBody`, so title/search/New never move; the
  panel itself rises full height over the header's trailing end); the
  table keeps every column, scrolling sideways; the boundary is a drag handle
  (`scheduleSplitListWidthAtom`). A click on blank page space closes it
  (`onBlankClick`; rows, controls, the panel and portalled popups excluded).
  Mobile pushes a page. The header
  (`ScheduleDetailToolbar`) is close plus compact icon actions; run history is
  the panel's last section, under the editor (no second drawer). Top-of-pane headers join the Electron drag strip
  (`useWindowDragRegionClass`) with buttons `WINDOW_DRAG_EXEMPT_CLASS`, or the
  strip swallows their clicks. Saving and closing return to the full list.
- The editor reuses the composer's parts: one box holds name, a hairline, the
  prompt and, along its bottom, the composer's own Agent controls
  (`ScheduleAgentControls` = `DesktopRunConfigMenu` + `DesktopPermissionModeButton`).
  Under the box are the chat landing's context pills — `DesktopMachineMenu`, the
  project chip, the worktree checkbox. Destination and trigger share one card;
  timed/manual is a row (`Tabs`) in it. The name is larger and semibold and
  autofocuses on a new schedule. Do not fork look-alikes of
  these controls; pass props to the shared ones.
- The machine is its own choice (owned machines with agents). A new schedule
  opens as the chat landing left things: `pickScheduleAgent` over
  `readChatLandingDefaults`, then `seedScheduleAgentRunRef` fills that Agent's
  remembered model, options and permission (`agentDefaultsCache`). A new machine
  or a newly picked Agent is seeded the same way, so the controls always show a
  complete choice; the seed fills permission exactly where
  `hasExplicitSchedulePermission` reads it and never carries credential options.
- `collectScheduleSaveIssues` tags every blocker with the control that fixes it
  (`form | machine | agent | destination`) and `missing | invalid`. Each is an
  exclamation mark (`FieldIssueMark`) next to that control, never a list at the
  bottom; `missing` shows only after a save attempt, `invalid` at once. Only
  `form` reasons sit beside Save and disable it; everything else lets Save
  run the guard, mark and focus the first empty field. There is no project
  mark: beside the project chip it reads as "a project is required".
- Time and date are typed only: the native picker button is hidden
  (`[&::-webkit-calendar-picker-indicator]:hidden`), which in Chromium also
  removes the popup. The prompt has no resize handle: it grows with its text
  from 4 to 6 lines (`[field-sizing:content]` + `lh` bounds), then scrolls.
  Field marks float (`absolute`) so they never narrow the text.
- No time zone control. Wall-clock rules and one-off times are read on the owning
  machine's clock (`MachineMeta.timeZone`, device zone for older CLIs) via
  `withScheduleRecurrenceTimeZone` / `zonedLocalInputToInstant`. The preview names
  the machine.
- Frequency is a short menu, never cron: every day / weekday / week (days) / month
  (dates) / few hours / few minutes / once, plus Manual. A stored rule the menu
  cannot name is `unsupported`: read-only summary plus Replace, re-emitted
  verbatim. An untouched rule is re-emitted unchanged (fingerprint stability).
  Cron day-of-week ranges expand from raw bounds before folding 7 onto 0.
- Manual (`trigger.kind === 'manual'`) is never planned; the editor keeps the last
  timed rule while toggled to Manual.
- Destination: new chat per run, ONE owned chat (`own_session`, id derived from
  schedule id + `epoch`, "Start a new chat" = `epoch + 1`, never stored), or a
  picked chat. A chat destination has no project and follows the chat's Agent;
  mismatches are `invalid` issues on the Agent controls / chat row.
- An agent can only PROPOSE (`schedule_proposal` notice →
  `ScheduleProposalNotice`); Create on the card is the creation, with
  `proposalId` as schedule id. Edit reshapes name, prompt and rule in the card
  only (never written back to the notice, so a retried proposal still matches);
  a created card has no edit. `resolveScheduleProposalTarget` defaults to the
  proposing conversation; a named Role/Agent/machine/project overrides only that
  part; a named Agent without a Role gets the builtin default mode. Same save
  rule, same gate, trigger on the target machine's clock.
- Owner-only pause/delete stays possible when the machine is gone or outdated;
  create/edit/resume/run require the machine's protocol capability. Never fall
  back to a different Agent. Run history is ordinary Sessions with sparse
  `SessionMeta.scheduleId`.
- List (`schedule-list.tsx`): one column template for header and rows; Name,
  Frequency and Next run are resizable from the header (pointer, arrow keys,
  double-click resets), persisted per device in `scheduleListColumnWidthsAtom`,
  as `minmax(72px, width)` so a narrow panel still fits. The header cell must
  not clip — the handle hangs into the gap. A manual row's button is Run
  (`Play`); a timed row's is Pause/Resume (Resume is `RotateCcw`, never `Play`). Every row
  has a context menu (open, run, pause/resume, last run, delete). Run from the
  list starts at once with a toast; delete always confirms. Cells align to their
  first line; the target column names the machine; row actions are visible by
  default and hidden only behind `[@media(hover:hover)]`.
- Chrome: every control is an `@lody/ui` primitive (Button, Input, Select,
  Combobox, Tooltip, ContextMenu, Skeleton, `@/ui/dialog`); `className` carries
  layout only. Cards are `scheduleCardProps()` (the settings `settingsCard`
  StyleX) inside `data-settings-surface`. Copy is `em` of `--ui-font-size`, two
  inks (`foreground`, `muted-foreground`), `font-normal` except the name.
- Alignment is measured, not eyeballed: property rows are 44px, labels share
  one left line, every row's last visible mark ends on one right inset (selects
  are solid `Select.Trigger`s; only the native time input bleeds `-mr-2`); a row with a hint
  or multi-line control pins its label to the first line. `PropertyRow` tracks
  are content-sized (`minmax(0,auto)` / `minmax(0,1fr)`), never from `sm:`;
  `EditorInNarrowPanel` catches regressions.
- `AnimatePresence` children must carry their own `key` (`<Reveal key=… >`);
  a key set only inside the child reads as `""` and breaks exit animations.
