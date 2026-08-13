# Tasks UI contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
The root and `packages/components/AGENTS.md` guidelines also apply.

Tasks represent intent; Sessions represent execution. Use a Session for work that
starts now and a Task for work recorded for later.

## Core invariants

- The complete UI is gated by `tasksFeatureEnabledAtom` (developer mode AND the
  per-device Tasks beta toggle). When disabled, routes, navigation, commands,
  quick-add, subscriptions, watchers, chips, and proposal cards must not mount. Task
  CLI/MCP storage is deliberately independent of this presentation gate.
- The Task document is authoritative. Mutations update it first, then derive and
  publish the index row with the shared `buildTaskIndexRow`/`countTaskLinks` helpers.
  Board and list views read only the index and must never open every Task document.
- `useTaskIndexSync` clears the old index during workspace changes before opening the
  next index Flock. Otherwise stale tasks appear authoritative while the new room opens.
- Task documents do not publish ordinary doc metadata. Enumeration for sync, export,
  and deletion must use `listWorkspaceTaskIds` and the Task Index.
- Do not add a second execution-state system. `status` is declarative; running,
  needs-user, PR, and CI state is derived from linked Sessions and PR metadata.
- `needs_review` advances only on a transition observed by the current client. PR
  reconciliation is deterministic and may catch up at startup. Unknown or stale PR
  state never counts as complete.
- Session termination for review means archived or all linked PRs merged/closed, not
  idle. A Session is idle between ordinary turns.

## Delegation and authorization

- `ownerId` is a human user id or `''` for unassigned. `agent` is separate explicit
  delegation consent; an empty value means automation must not start.
- Selecting an Agent for a one-off run writes `lastRunConfig`, not `agent`. Only
  `onToggleDelegation` may change `agent`. Do not let a picker silently grant automation
  consent before the user presses Run.
- Automatic execution lives in `apps/cli/src/lib/task-automation`; do not implement a
  frontend scheduler that only works while the UI is open.
- `backlog` and `todo` are both pre-execution triage states. Keep eligibility checks in
  the automation plan, scheduler, and `computeTaskQueuePositions` aligned.
- Agent-authored task updates are direct and audited. Agents may not set delegation and
  may only clear, not assign, a human owner at the MCP boundary.
- Comments never trigger execution. An explicit agent mention dispatches work into a
  Session and leaves a dispatch marker. Mention matching must consume the longest
  matched range so `@Design Agent` does not also match `@Design`.

## UI behavior

- Task creation has no required fields. An empty title falls back to the first body
  line, and completely empty input closes without creating. Property chips retain safe
  defaults.
- Board view always renders every status column; list view omits empty groups. List rows
  are fixed-height single lines, not stacked cards.
- Board drag-and-drop updates only the moved row's fractional `order`; cross-column
  moves also update `status`. List view is not draggable.
- The desktop shell pins All Tasks and opens Task details as closable tabs. The URL is
  the active-tab source of truth. Mobile retains a list/detail navigation stack.
- The desktop new-task entry lives on the sidebar Tasks row. Do not add a duplicate
  header action that appears only after navigating to Tasks; mobile keeps its header
  action because it has no persistent sidebar.
- `TaskProjectSelector` wraps the shared `UnifiedProjectSelectorView`. Keep
  `ProjectRef` conversion in `task-project-key.ts`; do not fork project search or
  ranking for Tasks.
- Unknown owners render a neutral user icon, never a raw user id.
- Task surface tokens may customize the light theme only. Dark mode aliases global
  popover/border/hover tokens so themes such as Vesper stay intact.

## Body editor

- Task bodies remain Markdown. `task-body-editor.tsx` is a lightweight lazy boundary;
  only `task-body-editor-surface.tsx` imports meowdown and its heavy dependencies.
- Loro text is authoritative. Apply remote changes through `setState(markdown)` without
  passing a selection, reject self-echoes while editing, flush before unmount, and key
  the editor by `taskId`.
- Keep both meowdown stylesheets, explicit `mode="hide"`, the app theme variable mapping,
  and the manual `handle.editor.unmount()` cleanup.
- Selection-toolbar pointer-down handlers must preserve editor focus. Keep the popover
  hoisted above the surrounding scroll area.
- Task images are stored as `lody-image://<imageId>` references. Comments remain a
  textarea, though they may upload and preview images before send.

## File map and tests

- `tasks-workspace.tsx`: route/tab shell.
- `tasks-board-view.tsx`: board/list presentation and drag interaction.
- `task-detail-view.tsx`: detail container; `task-properties-panel.tsx`: desktop rail.
- `task-status-watcher.tsx`: the two status-reconciliation rules.
- `task-quick-add-dialog{,-container}.tsx`: global capture surface.
- `task-attach-session-dialog.tsx`: bidirectional Task/Session association.
- `task-proposal-notice.tsx`: durable agent proposal card.
- Data hooks live under `hooks/use-task-*`; shared schemas/index/order logic belongs in
  `@lody/shared`.
- Pure presentational pieces require Stories. Workspace/router containers and the null
  status watcher do not; test their extracted behavior instead of fabricating providers.
- jsdom has no layout engine and cannot host the full ProseMirror editor. Use pure unit
  tests for extracted decisions and browser Stories for layout/editor behavior.
