# DeepSeek Harness Core capabilities

Status: draft
Translation: current

[中文](deepseek-harness-core-capabilities.zh.md)

## Owned execution and history

A client using DeepSeek Harness can browse stored sessions without activating them,
steer a running turn, manage goals, and observe delegated/background work. Every
model execution remains attributable to a client-owned prompt. Capability metadata
must describe the interfaces actually available in the selected composition.

History discovery uses standard session/list. Core sessionHistory replays a root
session through a read-only observation, without resume, repair writes or model
execution. Lody prefers the advertised read-only method and fails closed for its
built-in DeepSeek provider if that contract is absent. Load/resume retain their
separate [restoration behavior](deepseek-harness-session-restore.md).

Steering applies to the active native turn and its existing configuration. Its
applied notification follows durable message consumption. Idle, cancelled or
rejected input must not start a later turn accidentally.

Goal set/resume carry Core goalControl inside session/prompt. The prompt stays open
across native automatic rounds; pause/clear remain reachable out of band. Cancel
pauses continuation. A native round limit is reported as limited, not as an invented
token budget. A disarmed active native goal cannot claim that continuation is active.
Background completions may update task state but do not independently wake an idle
root Agent; model-facing notices wait for an owned prompt.

Subagent requests use execution IDs and enforce root ownership. Lists cover observed
runs in the current activation; local execution supports cancellation, remote
execution only the output/lifecycle its provider publishes. Session residency is
not execution status. Retry activities terminate on retry start or turn end.
Current context usage stays separate from cumulative token accounting.

## Worktree identity and limits

A worktreeProject association names a resolvable absolute original project directory.
It survives runtime restart and is inherited by forks unless overridden. History
listing by that project includes associated worktree sessions. Actual cwd, sandbox,
MCP and worktree lifecycle remain unchanged. Association storage belongs to the
adapter; native session storage remains Harness-owned.

The current API-key composition has no account quota-window source, so rateLimits
is absent. Experimental scheduled wakeups do not have an ACP execution-ownership
transport, so tasks.scheduled is absent. These omissions must remain visible rather
than being represented by empty successful responses or unsupported declarations.

## Evidence

- [Provider contract and native probe](../packages/acp-extension-dsh/README.md#core-controls).
- [Implementation decision](../.agents/notes/implemented/feature/2026-10-09-dsh-core-capabilities.md).
