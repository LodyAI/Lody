# Schedule UI

`CLAUDE.md` is a symlink to this file.

- One workspace-shell Registry subscription supplies list and provenance links;
  details acquire/release one Schedule store through WorkspaceRuntime. All writes use
  `withScheduleStore`, retaining an active uploader ref until synchronization. Never load
  every definition for listing. The developer + beta gate hides navigation,
  commands and background subscriptions together on every platform.
- `schedule-view.tsx` is presentational and has Storybook fixtures;
  `schedules-workspace.tsx` owns domain writes, selectors and route composition.
  `schedule-save-blockers.ts` is the one save rule, `schedule-format.ts` the one
  vocabulary, `schedule-property-row.tsx` the one layout primitive (label left,
  live value right, rows appearing only when they apply).
  Agent/Project selectors and the `AgentRunRef` type live in `components/shared`.
- Save requires an Agent with an explicit permission mode on an owned, capable
  machine. It does NOT require a project: a schedule with none runs as a plain
  chat, end to end (optional `project` in the definition, registry row, draft and
  CLI target). Every save blocker must have a visible, actionable reason above
  Save; `collectScheduleSaveBlockers` drives the button, the explanation and the
  submission guard so the three cannot disagree.
- There is deliberately NO repeated confirmation on this path: no automation
  consent checkbox, no directory-scope checkbox (the worktree switch IS that
  choice, with an inline note when it is off), and no full-access warning or
  resume dialog. Permission mode stays visible and explicitly chosen. Do not
  reintroduce any of them in another shape — removing duplicate confirmation is
  not a relaxation of ownership, capability or permission validation, which all
  still gate save, resume and run.
  Run now confirms saved configuration and may overlap existing work. Pause does
  not cancel an already submitted Session.
- Frequency is a short menu, not a cron editor: every day / every weekday /
  every week (days) / every month (dates) / every few hours / every few minutes /
  once. `schedule-recurrence.ts` maps each both ways onto the unchanged
  persisted trigger union. Steps that divide the clock are written as aligned
  cron (`*​/15`, `0 *​/6`); others as intervals. A stored rule the menu cannot
  name is `unsupported`: shown read-only with its summary and a Replace action,
  re-emitted verbatim on save, never edited as text. There is no cron input
  anywhere in this UI; do not add one back.
- Cron day-of-week accepts 0 AND 7 for Sunday, so a RANGE must be expanded from
  its raw bounds and folded onto 0 only afterwards. Folding first turns `0-7`
  (every day) into `0-0` and reads it as Sundays only — a loss that is invisible
  until an unrelated time or zone edit rewrites the rule. Tests must cover a
  Sunday-7 range across an edit, not just its untouched round trip.
- A schedule is either timed or `manual` (`trigger.kind === 'manual'`): never
  planned by the clock, run only from Run now. The editor keeps the last timed
  rule while the toggle is on Manual, so flipping back does not reset it.
- Destination (`definition.destination`) says where runs go: a new chat per run,
  ONE chat the schedule owns (`own_session`, created by the first run, its id
  derived from schedule id + `epoch`, so "Start a new chat" is `epoch + 1` and
  no id is ever stored), or a chat the person picked (`existing_session`). Once
  runs go into a real chat, that chat fixes the Agent and machine and the
  schedule has no project of its own — `collectScheduleSaveBlockers` names the
  mismatch, and the container hides the Project row and follows the chat's
  Agent when one is picked. `ScheduleDestinationRows` is the presentational
  piece; the container resolves the chat from `sessionListAtom`.
- An agent can PROPOSE a schedule but never create one. `lody_schedule_propose`
  writes a `schedule_proposal` system notice and
  `ScheduleProposalNotice` renders it in the conversation; pressing Create on
  the card IS the creation — no form follows — with `proposalId` as the schedule
  id so a double click cannot make two. The card resolves its target through
  `resolveScheduleProposalTarget`: everything defaults to the conversation the
  proposal was made in (Agent, its effective mode from history, machine,
  project) and a named Role / Agent / machine / project overrides only that
  part. A named Agent without a Role gets Lody's builtin default mode, never the
  conversation's — that mode belongs to a different Agent. The card runs the
  same `collectScheduleSaveBlockers` as the editor and disables Create with the
  reasons shown, and it is gated by the same developer + beta flag.
- Owner-only reduction of authority (pause/delete) remains possible when the
  machine is gone or outdated. Creating/editing/resuming/running requires the
  target Machine protocol capability. Never fall back to a different Agent.
- History consists of ordinary Sessions with sparse `SessionMeta.scheduleId`;
  the Session info bar links back. Provider-native cron history is independent.
- Use shared time calculation for future slots. Wall-clock rules preview in their
  authored IANA zone; once/interval inputs use the explicitly labelled device
  zone. Runtime projections must match Machine, activation and definition
  fingerprint.
- The list is one column template shared by its header and every row. The actions
  column is a fixed width, never `auto`: content-sized it redistributed the `fr`
  columns per row and left Frequency and Next run visibly unaligned. The target
  column names the MACHINE as well as the agent and project — without it two
  same-named agents, and two chat-only rows, read identically.
- `schedule-format.ts` normalizes its `locale` argument with `toIntlLocaleOrEn`
  at every entry point, and is the only place here that constructs an `Intl`
  formatter. Callers pass the PRODUCT language, and Lody spells Chinese `zh_CN`,
  which every `Intl` constructor rejects with a RangeError — normalizing per call
  site means one missed caller crashes a page. Cover new formatters with the
  `zh_CN` render tests, not only pure-function tests: the formatters were already
  individually correct while the pages they back crashed.
- A row action must not be hover-only. Default it visible and hide it behind
  `[@media(hover:hover)]` so a touch device can still find it, and give any
  control whose only label is `hidden sm:inline` an explicit `aria-label`.
- `PropertyRow` sizes both tracks from content (`minmax(0,auto)` label,
  `minmax(0,1fr)` control), never from a `sm:` width. A viewport breakpoint
  cannot see the panel a schedule renders in, a hugging control track let the
  weekday toggles truncate the label away, and a hugging label track let a long
  translated label eat the row. `EditorInNarrowPanel` is the story that catches
  all three.
- Follows the app chrome rules in `src/ui/AGENTS.md`: sizes are `em` of
  `--ui-font-size` (editor rows 1em, list rows 0.9em, hints 0.8em, section
  labels 0.75em sentence case), weight stays `font-normal`, edges are 0.5px.
  Cards reuse `SETTINGS_ROW_CARD_CLASS` inside `data-settings-surface`, which
  lifts them to the popover fill in light themes; without it `--card` is gray
  and a grouped card reads as disabled. `em` compounds, so size leaves, not
  containers, and never put a 0.75em child inside a 0.9em row.
