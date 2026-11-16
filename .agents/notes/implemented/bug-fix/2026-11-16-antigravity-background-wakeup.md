# Antigravity ACP v1 background task wakeup and GC protection

Status: implemented
Translation: current

[中文](2026-11-16-antigravity-background-wakeup.zh.md)

## Abstract

`agy acp` (`Antigravity ACP Server`, ACP v1) resolves `session/prompt` with `stopReason: "end_turn"` as soon as the model yields while background tools (`run_command`, `invoke_subagent`, `run_workflow`, `schedule`, `swarm`) are still running, and stops emitting `session/update` notifications on stdout afterward. Lody now tracks those post-`end_turn` background tasks inside `apps/cli/src/agent/`, keeps active turns open or publishes Core `sessionActivity` (`background` / `running`) via `onNativeWorkChanged`, and extracts unseen wakeup output through read-only `session/list` polling plus silent `session/load` snapshots without injecting synthetic prompts.

## Problem

In live `agy acp` sessions, several built-in Antigravity tools return control to the assistant turn before background work finishes:

- any non-daemon tool still `pending` or `in_progress` when `end_turn` arrives, as well as `run_command` or `run_workflow` whose output reports `"Tool is running as a background task with task id: ..."` (or a no-output `run_workflow` with omitted or zero `WaitMsBeforeAsync`);
- `invoke_subagent` and `send_message`, which acknowledge delegation without emitting child ACP events;
- non-daemon `schedule` timers/crons and `swarm` workers.

Because `agy acp` resolves `session/prompt` immediately at `end_turn` and detaches live stdout streaming from background wakeup turns, Lody marked the session `idle`, dropped all post-`end_turn` tool completions and wakeup assistant text, and allowed `SessionGCManager` to kill the `agy` subprocess after the 20-minute idle threshold — even while background commands or wakeups were actively running.

## Protocol Context

- **ACP v1 and v2**: `agy acp` negotiates `protocolVersion: 1` without `_lody/session/activity_update` (`sessionActivity` extension). Upstream ACP v2 drafts standardize session lifecycle capabilities such as `session/list` and `session/load`, which `agy acp` already exposes under ACP v1 `sessionCapabilities`, rather than introducing a generic server-pushed wakeup activity signal after `session/prompt` resolves. Once `session/prompt` returns `end_turn`, `agy acp` stops forwarding both `session/update` and `session/request_permission` over stdout, and computes workspace containment using `path.relative(cwd, realpath(target))`.
- **Lody native activity contract**: [Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md) establishes the `sessionActivity` model (`running` for active model work, `background` for live background waits protected up to 24 hours, `idle` / `null` otherwise). Synthesizing that signal inside `AgentClient` for `Antigravity ACP Server` reuses `SessionGCManager` and `Session` presence unchanged.
- **Shared server identity**: Custom provider configurations pointing at `agy acp` report `agentInfo.name === "Antigravity ACP Server"` rather than `cliType === "builtin"`, while legacy `antigravity-acp` does not. Unifying capability gating in `isAntigravityServer()` gives custom `Antigravity ACP Server` setups parity while keeping legacy servers untouched.

## Decision

Keep all compatibility inside `apps/cli/src/agent/` (`antigravity-background.ts` and `agent-client.ts`), preserving `MessageHandler`, `SessionGCManager`, `SessionActivePresence`, and `SessionExecutionService` unchanged:

1. **Read-only wake detection via `session/list` + silent `session/load`**:
   - Poll `connection.listSessions` (2s interval, bounded RPC timeout) and trigger a silent `connection.loadSession` capture when the target session's `updatedAt` changes, plus follow-up `sameSecondLoadCheckMs` (6s) checks within any active `wakeupPlannerGraceMs` window and a final pre-settle `session/load` check (except after cancelling an orphaned `pending` tool) so responses completed after their step `created_at` second are never dropped while idle multi-hour waits make zero snapshot loads; fall back to 10s `session/load` polling if `session/list` returns `-32601`.
   - Suppress live replay forwarding during background `antigravityLoadCapture` and initialize `AntigravitySessionTracker` from initial startup replay (`antigravityStartupCapture` + `seedBaseline`) and prepared replacement handoffs so historical turns never duplicate or re-trigger holds.
   - `AntigravitySessionTracker.consumeSnapshot()` diffs tool calls by `toolCallId` + `status` / output / placeholder-clearing transitions, slices assistant text and thinking characters past live streamed offsets (inserting a paragraph separator only at real turn/wakeup boundaries — never between consecutive streamed chunks of the same message — and only when continuing non-newline-terminated text without an intervening tool call), and deduplicates unchanged usage snapshots.

2. **Two-tier lifecycle handling and session-unwedging safeguards**:
   - **Canonical workspace `cwd` normalization**: Before `session/new`, `session/load`, `session/resume`, `unstable_forkSession`, and poll RPCs, `AgentClient` resolves `workdir` with `fs.realpath` (falling back to `workdir` when absent, while keeping `LODY_MCP_WORKDIR` and `resolvePath` unchanged) so symlinked directories such as macOS `/tmp` or `/var/folders` do not trigger false out-of-workspace `write_file` permission gates inside `agy acp`.
   - **Tier 1 (`hold`, up to 30 minutes)**: When `end_turn` leaves any active (`pending` / `in_progress`) non-daemon tool other than `schedule` / `swarm`, background task placeholder output, no-output immediate `run_workflow`, or `invoke_subagent` / `send_message` work open (excluding canceled subagents via `manage_subagents`), `AgentClient.prompt()` stays pending while streaming wakeup deltas until all holdable work finishes and a 25-second quiet/failed-tool grace window expires (`settleQuietMs` / `failedWakeupToolGraceMs`), or Stop abort (`abortSignal`) immediately aborts the hold and forwards `session/cancel`. If multiple subagents coalesce into one wakeup (or a `schedule`/`swarm` remains armed in the same turn), remaining work hands off to Tier 2 after the first wakeup's quiet window instead of holding the prompt open for 30 minutes.
   - **Tier 2 (`background` / `running`, up to 24 hours)**: Non-daemon `schedule`/`swarm` tasks (excluded from Tier 1 even though `agy acp` keeps `schedule`/`swarm` `in_progress` until fired, including multi-worker `swarm` counts and excluding `IsDaemon: true` processes/crons and `manage_task` kills), coalesced subagent remainders, and Tier 1 holds crossing 30 minutes settle `prompt()` and transition to a detached `sessionActivity` monitor calling `onNativeWorkChanged('background' | 'running' | null)`.
   - **Orphaned post-`end_turn` permission recovery**: Because `agy acp` drops `session/request_permission` after `end_turn`, any tool entering `status: "pending"` post-`end_turn` without a recorded `requestPermission` call (`notifyLivePermissionRequest`) expires after `orphanedPendingToolGraceMs` (4 seconds) across both Tier 1 and Tier 2: `AgentClient` emits a synthetic failed `tool_call_update` (`ORPHANED_POST_TURN_PERMISSION_MESSAGE`) and sends `session/cancel` to unwind the wedged wakeup cleanly without hitting 30-minute or 24-hour timeouts.
   - Any subsequent user prompt, cancel, close, mode/model/config change, replacement adoption, or transport disconnect drains the detached monitor cleanly first.

## Rejected Alternatives

- **Sending synthetic follow-up prompts or steers after `end_turn`**: Rejected because `AGENTS.md` forbids unsolicited prompts/steers; every synthetic delivery appends unwanted conversation turns and alters planner behavior.
- **Holding `session/prompt()` indefinitely for timers, crons, and swarms**: Rejected because holding the composer lock for minutes or hours blocks follow-up user messages; Tier 2 `sessionActivity` protects the process from GC while leaving the session interruptible.
- **Modifying `SessionGCManager` or `MessageHandler` for Antigravity heuristics**: Rejected to preserve provider neutrality outside `apps/cli/src/agent/` and reuse the Core `sessionActivity` contract directly.

## Limits

- `agy acp` writes persistent state only for persisted session snapshots; wakeup deltas appear at `session/list` polling granularity (2s with `session/list`, 10s without) rather than zero-latency streaming after `end_turn`.
- Polling stops cleanly after `maxConsecutiveFailures` (5) consecutive RPC errors, after 24 hours (`detachedMaxDurationMs`), or on transport/abort signals so hung or dead runtimes never leak background loops.
- `IsDaemon: true` commands and daemon cron jobs remain excluded so long-lived dev servers do not prevent idle GC indefinitely.
