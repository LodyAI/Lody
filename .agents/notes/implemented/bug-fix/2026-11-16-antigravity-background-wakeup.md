# Antigravity ACP v1 background task wakeup and GC protection

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` ends `session/prompt` with `end_turn` while its background work is still
running, then stops writing to stdout. Lody therefore lost the wakeup output and
garbage-collected live processes. Lody now ends the turn normally, synthesizes Core
`sessionActivity` while background work is pending, and replays unseen output into
the finished turn from read-only `session/load` snapshots. Pending work is detected
from tool status plus a quiet window rather than from agy tool arguments; the cost is
polling latency and a bounded wait for work that stays silent.

## Problem

`agy acp` (`Antigravity ACP Server`, ACP v1) resolves `session/prompt` with
`end_turn` as soon as the model yields, even while background work it started is
still running: `run_command` past its async threshold, `schedule` timers and crons,
`invoke_subagent` / `send_message`, `swarm` and async `run_workflow`. When that work
finishes, agy wakes the model inside its own session, but it no longer writes
`session/update` or `session/request_permission` to stdout. agy does not advertise
the Core `sessionActivity` extension, so Lody saw an idle session. The wakeup output
never reached history, and `SessionGCManager` killed the process after the idle
timeout while the work was still running.

## Decision

The fix stays inside `apps/cli/src/agent/` (`antigravity-background.ts` and
`AgentClient`). It reuses the existing native-work contract from
[Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md):
the turn ends at `end_turn` as usual, and output that arrives later is written to the
finished turn, the same way Claude background tasks are handled.

- **Synthesized `sessionActivity`.** When a turn ends with background work,
  `AgentClient` starts a monitor and reports `background`, or `running` for a few
  seconds after new output. The monitor reports idle once no turn tool is `pending` or
  `in_progress` and nothing has changed for a quiet window. The window is 30 seconds,
  or 10 minutes when the turn dispatched work whose only completion signal is a later
  wakeup (subagents, `send_message`, swarm, a workflow with no output, or a tool whose
  output is agy's "running as a background task" placeholder). agy keeps a `schedule`
  `in_progress` until it fires, so timers need no special case. Daemon processes
  (`IsDaemon: true`) are never counted. A monitor lasts at most 24 hours, matching the
  Core `background` cap. Work that has not settled when the user sends another message
  carries into that turn, so the monitor resumes after it and still replays the
  completion; the tool's own update lands in the entry where the tool first appeared.
- **Read-only replay.** The monitor polls `session/list` every 2 seconds and runs
  `session/load` when `updatedAt` changes. While output changed in the last 90
  seconds, it also reloads every 6 seconds, and it reloads once more before releasing.
  agy stamps `updatedAt` with the second a step started, so a slow reply can finish
  without changing it. Servers without `session/list` are loaded every 10 seconds.
  Replayed notifications are captured instead of forwarded.
  `AntigravitySessionTracker` folds each tool's replayed states, emits a tool only
  when its final state differs from what Lody already showed, and slices assistant
  and thought text by the character count already streamed after the last user
  message. History replayed at resume is recorded as a baseline and never re-emitted.
- **Exclusive transcript access.** A new prompt, cancel or detached close stops the
  monitor and waits for its in-flight load. Config, mode and model changes pause it
  and then resume it, so notifications streamed by those RPCs are never mistaken for
  replay.
- **Orphaned permission requests.** A tool that turns `pending` after `end_turn`
  without a forwarded permission request would wedge agy. After 4 seconds Lody emits
  it as `failed` and sends `session/cancel`. The `realpath` `cwd` negotiation
  described in the agent README removes the most common trigger: in-workspace edits
  under a symlinked workdir.

## Rejected alternatives

- **Holding `session/prompt` open until background work finishes.** The first
  implementation held the turn for up to 30 minutes, then handed off to a second
  monitor. That locks the composer and needs a second state machine, which the
  native-work contract already makes unnecessary.
- **Counting tasks from agy tool arguments** (`DurationSeconds`, `CronExpression`,
  `MaxIterations`, swarm `tasks`/`n`, `manage_*` kills). The count drifts as soon as
  agy changes an argument. Tool status plus a quiet window needs no knowledge of those
  arguments.
- **Synthetic prompts or steers after `end_turn`.** Root `AGENTS.md` forbids text
  that steers the agent, and it would pollute the session.
- **Antigravity cases in `SessionGCManager` or `MessageHandler`.** Those consumers
  stay provider-neutral.

## Verification

`apps/cli/src/agent/antigravity-background.test.ts` drives the real `AgentClient`
against a fake agy transcript. It pins turn completion at `end_turn`, the
`background` → `running` → idle trajectory, replay without duplicates (including
resume history and split reply chunks), the frozen-`updatedAt` reload, timer and
subagent waits, daemon exclusion, pausing around config changes, orphaned permission
recovery and `realpath` negotiation. The rewrite has not been re-run against a real
`agy acp`.

## Limits

- Output appears with polling delay: about 2 seconds, or 10 without `session/list`.
- Work that stays silent longer than the dispatch quiet window loses protection. If
  it wakes the model after the monitor stopped, that output is not replayed.
- Each load replays the whole transcript, so cost grows with session length. Whether
  agy re-attaches MCP servers on every `session/load` has not been measured on a real
  machine.
- `session/cancel` for an orphaned permission request also cancels whatever else
  that wakeup was doing.
