# Subagent and task tabs

Status: implemented
Translation: current

[中文](2026-10-28-subagent-task-tabs.zh.md)

## Abstract

A turn's task panel listed agent runs and background shell commands in one list, so a reader could not tell which rows were agents. When a turn has both kinds, the panel now splits them into a Subagents tab, selected first, and a Tasks tab. Each tab shows a spinner while anything on it is live; tabs carry no counts, which the header summary already gives. A turn with only one kind keeps the single list. The split is inferred in the renderer from provider task types, because the published `taskKind` does not distinguish an agent from a command.

## Classification

`taskKind` does not mark agent versus command: the Claude lifecycle adapter
(`apps/cli/src/agent/claude-task-lifecycle.ts`) publishes `background` for any
backgrounded run, a backgrounded agent included, and `subagent` for everything
else, a foreground shell task included. `groupOf` in `subagent-task-state.tsx`
therefore puts a task under Tasks when its `taskKind` is `scheduled` or its
`taskType` (or, from Core metadata, its `actor`) is `local_bash`, `mcp_task` or
`monitor_mcp`. A task with `subagentType` or a normalized `run` is always a
subagent. An unrecognised type stays under Subagents, where every row was listed
before the split.

Each task is placed by its own type. A command started by a subagent appears as
a top-level row under Tasks rather than nested under its parent. Keeping such a
command with its parent would leave the Tasks tab incomplete.

## Behavior

- The header summary, its waiting count, and the rule that keeps a live panel
  open are unchanged and still count every task.
- The selected tab is component state. It survives task updates and resets
  only when the panel remounts.
- Inactive tab panels are unmounted. The dialog is still addressed by task id
  and is unaffected.

## Evidence and limits

`tests/subagent-task-panel.test.tsx` covers single-kind lists, a backgrounded
agent classified as a subagent, the default tab, per-tab running marks, and
a chosen tab persisting while tasks change. The component typecheck passes. The
`SubagentsAndCommands` story shows the mixed state. The type list follows the
current Claude Agent SDK task types; a new non-agent type will appear under
Subagents until it is added.
