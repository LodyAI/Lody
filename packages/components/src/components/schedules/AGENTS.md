# Schedule UI

`CLAUDE.md` links here. Rationale:
[scheduled tasks note](../../../../../.agents/notes/implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md).

- One shell Registry subscription supplies list/provenance; details acquire/release
  one WorkspaceRuntime Schedule store. Writes await mode admission through `withScheduleStore`; full messages
  have their own editor. Listing opens only scheduled-message bodies: local
  first, one-shot sync when missing. No developer/beta gate on navigation,
  commands, Registry, proposals or Agent tools.
- `schedule-view.tsx` is presentational with Storybook fixtures;
  `schedules-workspace.tsx` owns domain writes, selectors and composition.
  `schedule-save-blockers.ts` is the one save rule, `schedule-format.ts` the one
  vocabulary and the only place that constructs `Intl` formatters (normalize
  `locale` with `toIntlLocaleOrEn`; `zh_CN` is a RangeError). `AgentRunRef` and the project
  selector live in `components/shared`; the Agent and machine controls are the
  composer's (`sessions/desktop-run-config-menu.tsx`).
- Save/run require an Agent on an owned, capable machine. The composer supplies
  displayed defaults; do not require an explicit permission pin or capability
  cache just to save. Ordinary Session config validation owns runtime support.
  No project is required (none = plain chat). No consent checkbox, directory-scope
  checkbox, full-access warning or resume dialog.
- List is the page. `routes/…/schedules.tsx` is a layout route that mounts
  `SchedulesWorkspace` once (its index and `$scheduleId` children render
  nothing). On desktop the open schedule is a 720px modal over the list
  (`ScheduleDetailModal`); Escape, close and the backdrop return to the list.
  Mobile pushes a page (`ScheduleDetailPage`) with a back button. Both use one
  `ScheduleDetailFrame`: `ScheduleDetailHeader` (kind, name, status in words,
  an enable `Switch` or Run for a manual task, a ⋯ menu with delete, close),
  then Settings / Run history tabs; a scheduled message and a new schedule have
  no tabs. The form's footer is sticky inside the modal body. Top-of-pane
  headers join the Electron drag strip (`useWindowDragRegionClass`) with
  buttons `WINDOW_DRAG_EXEMPT_CLASS`, or the strip swallows their clicks.
  Hidden desktop nav: PanelLeft expand at 96px on macOS Electron.
- Run history: a new chat per run lists Sessions with `SessionMeta.scheduleId`;
  a schedule that posts into one chat leads with that chat and reads its runs
  from it (`useScheduleChatRuns`: user turns whose `scheduleRun.scheduleId`
  matches, via `readAll` only while the tab is open). Nothing new is stored.
- The editor reuses the composer's parts: one box holds name, a hairline, the
  prompt and, along its bottom, the composer's own Agent controls
  (`ScheduleAgentControls` = `DesktopRunConfigMenu` + `DesktopPermissionModeButton`).
  Preserve ACP value types through save; never stringify option values.
  Under the box are the chat landing's context pills — `DesktopMachineMenu`, the
  project chip, the worktree checkbox. Destination and trigger share one card;
  timed/manual is a row (`Tabs`) in it. The name is larger and semibold and
  autofocuses on a new schedule. Do not fork look-alikes of
  these controls; pass props to the shared ones.
- Machine choices are owned machines with agents. New schedules use
  `pickScheduleAgent` over `readChatLandingDefaults`, then `seedScheduleAgentRunRef`
  to restore the landing's Agent, model, options and advertised permissions from
  `agentDefaultsCache`. Reseed on machine or Agent changes; never carry credentials.
- `collectScheduleSaveIssues` tags every blocker with the control that fixes it
  (`form | machine | agent | destination`) and `missing | invalid`. Each is an
  exclamation mark (`FieldIssueMark`) next to that control, never a list at the
  bottom; `missing` shows only after a save attempt, `invalid` at once. Only
  `form` reasons sit beside Save and disable it; everything else lets Save
  run the guard, mark and focus the first empty field. There is no project
  mark: beside the project chip it reads as "a project is required".
- Time and date are typed only: the native picker button is hidden
  (`[&::-webkit-calendar-picker-indicator]:hidden`). Prompt: no resize handle;
  grow from 4 lines to `max(6lh, 50dvh)`, then scroll. Field marks are absolute.
- No time zone control. Input, preview and kind changes use `MachineMeta.timeZone`
  (device zone for older CLIs). Once retains its instant across machine changes;
  calendar rules retain wall time. [Time contract](../../../../../specs/schedule-time.md).
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
  back to a different Agent.
- List (`schedule-list.tsx`): two sections, Scheduled tasks and Scheduled
  messages. Only messages get an ⓘ popover saying they send once; tasks need
  none. Rows are name + summary (frequency · Agent · machine), destination (a
  chat destination is a button that opens the chat) and status in words from
  `describeScheduleState`; colour and glyph mark only states needing a look.
  A scheduled message shows its own text (the stored title is fallback only)
  on the viewer's clock. No status pills or dots, no resizable columns. Project
  and status filters and sort sit above the sections. Every row has a ⋯ menu and the same
  context menu (open, run, pause/resume, open chat, last run, delete); delete
  always confirms. The hover action is Run for a manual task, Pause/Resume
  (`RotateCcw`, never `Play`) for a timed one, Delete for a finished message;
  it is visible by default and hidden only behind `@media (hover: hover)`.
  "Clear finished" deletes every finished scheduled message after one confirm.
  Run from the list starts at once with a toast.
- Chrome: every control is an `@lody/ui` primitive (Button, Input, Select,
  Combobox, Menu, Popover, Switch, Tabs, Tooltip, ContextMenu, Skeleton,
  `@/ui/dialog`); `className` carries
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
- The terminal Claude quota-failure banner enables Session capacity recovery; it does
  not create a Schedule. Existing reservations remain under the Schedule owner.
  [Prior shortcut](../../../../../.agents/notes/implemented/feature/2026-10-27-quota-continue.md).
