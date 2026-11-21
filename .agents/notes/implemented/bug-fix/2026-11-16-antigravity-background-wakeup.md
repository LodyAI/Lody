# Antigravity ACP v1 background work and idle GC

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` ends `session/prompt` with `end_turn` while its background work is still
running, then stops writing to stdout, so Lody's idle GC killed processes that were
still working. Lody now ends the turn normally and synthesizes Core `sessionActivity`
until that work has woken the model and gone quiet, using only side-effect-free
`session/list` polling. Output agy produces in those wakeups is not replayed into Lody:
the only API that returns it, `session/load`, restarts the session's MCP servers and
interrupted a tool call in a real run.

## Problem

`agy acp` (`Antigravity ACP Server`, ACP v1) resolves `session/prompt` with
`end_turn` as soon as the model yields, even while background work it started is
still running: `run_command` past its async threshold, `schedule` timers and crons,
`invoke_subagent` / `send_message`, `swarm` and async `run_workflow`. When that work
finishes, agy wakes the model inside its own session, but it no longer writes
`session/update` or `session/request_permission` to stdout. agy does not advertise
the Core `sessionActivity` extension, so Lody saw an idle session and
`SessionGCManager` killed the process after the idle timeout while the work was still
running.

## Decision

The fix stays inside `apps/cli/src/agent/` (`antigravity-background.ts` and
`AgentClient`). It reuses the native-work contract from
[Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md):
the turn ends at `end_turn`, and `sessionActivity` keeps the process alive.

- **Pending work at `end_turn`.** From the notifications streamed live during the
  turn, Lody counts one pending item for each unresolved tool that is still `pending`
  or `in_progress`, whose output is agy's "running as a background task" placeholder, or
  that dispatches work reporting only by waking the model (`invoke_subagent`,
  `send_message`, `swarm`, a `run_workflow` with no output). agy keeps a `schedule`
  `in_progress` until it fires, so timers need no special case. `IsDaemon: true`,
  failed, and cancelled tools are not counted. No agy tool arguments are parsed.
  Because agy delivers in-turn background completions via `<SYSTEM_MESSAGE>` without
  updating the original placeholder `tool_call`, Lody resolves an in-turn item when it
  sees a `<SYSTEM_MESSAGE>` `user_message_chunk` (matched by `sender=<taskId>` when
  present) or a new `agent_thought_chunk` after visible `agent_message_chunk` text
  with no intervening tool call.
- **Release by activity.** While items are pending, Lody polls `session/list` every
  2 seconds and reports `background`, or `running` while `updatedAt` is moving. A
  burst of `updatedAt` changes followed by 30 seconds of stillness counts as one item
  finished. Lody reports idle when no item remains, on explicit `session/cancel`, and
  after 24 hours at most, matching the Core `background` cap. If `session/list` is
  missing or keeps failing, the monitor keeps protecting until the cap.
- **Across turns.** Items still pending when the user sends another message carry
  into that turn, so earlier background work stays protected. If a post-turn wakeup
  burst was already in progress when the new turn starts, that item settles before
  carrying the remainder.
- **`cwd`.** Lody negotiates the `realpath` of the workdir as the Antigravity ACP
  `cwd`; agy compares edit targets by realpath, so a symlinked workdir otherwise made
  in-workspace edits ask for permission.

## Rejected alternatives

- **Replaying wakeup output from `session/load` snapshots.** Implemented and tested
  on a real agy 1.5.7 with `gemini-4-hydrogen-medium`; replay itself worked. Every
  load stopped and restarted the session's MCP servers: 19 loads and 20 server starts
  in 125 seconds at a 6-second rhythm. With loads throttled to one a minute and only
  after `updatedAt` had been still for 10 seconds, a 30-second MCP tool call was still
  cut off about 10.7 seconds in and returned `failed` with EOF, because `updatedAt`
  does not move while a tool runs. No timing rule can tell "done" from "waiting on a
  slow tool" from outside.
- **Loading with an empty `mcpServers` list.** Unverified; agy may detach the
  session's MCP servers for the rest of its life.
- **Reading agy's on-disk transcript.** Side-effect free, but an undocumented format
  that can change with any agy release.
- **Holding `session/prompt` open until background work finishes.** Locks the
  composer for up to 30 minutes and needs a second state machine; the native-work
  contract already covers background work after a turn.
- **Counting tasks from agy tool arguments** (`DurationSeconds`, `CronExpression`,
  `MaxIterations`, swarm `tasks`/`n`, `manage_*` kills). The count drifts as soon as
  agy changes an argument.
- **Synthetic prompts or steers after `end_turn`.** Root `AGENTS.md` forbids text
  that steers the agent.
- **Antigravity cases in `SessionGCManager` or `MessageHandler`.** Those consumers
  stay provider-neutral.

## Verification

`apps/cli/src/agent/antigravity-background.test.ts` drives the real `AgentClient`
against a fake `session/list`. It pins turn completion at `end_turn`, protection of
silent work beyond the idle timeout, one wakeup per pending item, the 24-hour cap,
continued protection when `session/list` fails, daemon and failed-tool exclusion,
carry-over across a new message, `realpath` negotiation, and that `session/load` is
never called. Real-machine runs covered the replay design that this note rejects; the
activity-only release rule has not been run against a real agy.

## Limits

- Output agy writes after `end_turn` does not appear in Lody. A side-effect-free read
  from agy would allow replay without the MCP restarts.
- Several items that wake agy in a single burst release only one item, so the
  session stays protected until the next burst or the 24-hour cap. Work the model
  starts during a wakeup is not counted.
- A post-`end_turn` tool waiting for a permission request agy does not forward still
  wedges that agy session until the user cancels; `realpath` negotiation removes the
  most common trigger.
