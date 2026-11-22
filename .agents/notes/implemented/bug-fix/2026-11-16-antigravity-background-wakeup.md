# Antigravity ACP v1 background work and idle GC

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` (`Antigravity ACP Server`, ACP v1) ends `session/prompt` with `end_turn` while
background work is still running, stops writing to stdout, and does not advertise Core
`sessionActivity`. Lody previously synthesized `sessionActivity` from stdout tool
heuristics and `session/list` `updatedAt` polling, then removed that heuristic because
over-counted tasks locked sessions in `running` presence, suppressed unread/completion
notifications, and polled `session/list` every 2 seconds for up to 24 hours. Lody now
keeps only deterministic Antigravity compatibility (`isAntigravityServer`, `realpath`
`cwd` negotiation) and consumes Core `sessionActivity` only when an agent authoritatively
advertises it.

## Problem

`agy acp` does not advertise Core `sessionActivity` (`_lody/session/activity_update`).
When `run_command` exceeds `WaitMsBeforeAsync`, `agy` emits a placeholder output
(`Tool is running as a background task with task id: ...`) and delivers completion via an
internal `<SYSTEM_MESSAGE>` without updating the original `tool_call`. Guessing a pending
count from stdout notifications and decrementing on `session/list` `updatedAt` bursts
failed in production:

- Background commands that completed inside the same turn (including plain-text wakeups
  with no `agent_thought_chunk`) stayed counted as pending at `end_turn`.
- Multiple background tasks finishing in one `updatedAt` burst decremented `pending` by
  only 1, leaving the remainder stuck until the 24-hour cap.
- Feeding an unreliable heuristic into `AgentClient.reportsSessionActivity()` /
  `getNativeWork()` caused `SessionActivePresence` to broadcast `running` ("working"),
  `SessionExecutionService` to suppress completion notifications and later emit false
  `nativeWorkInterrupted` notices, and `runAntigravityPollLoop` to poll `session/list`
  every 2 seconds for 24 hours.

## Decision

- **No heuristic `sessionActivity` synthesis.** `AgentClient.reportsSessionActivity()`
  returns `true` only when the agent advertises Core `sessionActivity` v1. Without an
  authoritative signal from `agy`, turns finish immediately at `end_turn` and normal idle
  GC applies, matching [Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md).
  If a future `agy` release advertises Core `sessionActivity` v1, `AgentClient` will
  consume it directly without heuristics.
- **Keep deterministic Antigravity compatibility.** `antigravity-background.ts` retains
  `isAntigravityServer` (builtin `antigravity` and custom `Antigravity ACP Server` parity,
  excluding legacy `antigravity-acp`), and `AgentClient` keeps negotiating the `realpath`
  of the workdir as the Antigravity ACP `cwd` so symlinked workdirs do not trigger
  out-of-workspace edit prompts.

## Rejected alternatives

- **Synthesizing `sessionActivity` from stdout tool notifications + `session/list` polling.**
  Implemented on 2026-11-16 and removed on 2026-11-22: without an authoritative task-count
  signal from `agy`, false positives permanently stuck sessions in `running` presence for
  up to 24 hours.
- **Replaying wakeup output from `session/load` snapshots.** Tested on real `agy` 1.5.7;
  every `session/load` stopped and restarted the session's MCP servers, interrupting
  in-progress tool calls.
- **Reading `agy`'s on-disk transcript.** Undocumented internal format that can change with
  any `agy` release.
- **Holding `session/prompt` open or sending synthetic steers after `end_turn`.** Locks
  the composer or violates root `AGENTS.md`.

## Verification

`apps/cli/src/agent/antigravity-background.test.ts` drives the real `AgentClient` and
pins: builtin/custom `Antigravity ACP Server` parity vs legacy `antigravity-acp`, that no
synthetic `nativeWork` or `session/list` / `session/load` polling occurs after `end_turn`
when Core `sessionActivity` is absent, that authoritative Core `sessionActivity` v1 is
honored if advertised, and `realpath` `cwd` negotiation.
