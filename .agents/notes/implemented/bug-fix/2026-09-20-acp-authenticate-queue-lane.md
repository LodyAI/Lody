# Local control message lanes

Status: implemented
Translation: current
PR: [#2028](https://github.com/LodyAI/Lody/pull/2028)

[中文](2026-09-20-acp-authenticate-queue-lane.zh.md)

## Abstract

Slow logins, capability probes and installations must not serialize unrelated local daemon controls. `MessageProcessor` separates reads, cancellation, provider refreshes and binary operations, while restart and upgrade share a lifecycle lane. The authentication start/control split remains intact. Existing concurrency limits and execution-service deduplication still bound work; this change adds no lock or retry.

## Evidence and cause

The original authentication cancellation defect was reported in [#828](https://github.com/LodyAI/Lody/issues/828). Start held the default lane until login exited or its 285-second timeout fired. Cancel already terminated the process correctly but could not dispatch behind start; status and ping were also vulnerable.

In the operator-reported October 28 incident, the first builtin DeepSeek capability probe after a desktop update spent minutes downloading `@deepseek-ai/dsh` and its dependencies through npx on a weak connection. The operator counted 745 queue-wait warnings with `active=1`; machine status and other provider refreshes queued, the desktop showed the machine offline and session creation failed. These are supplied incident observations, not a download reproduced by the tests.

On the desktop local path, `MachineRuntime.dispatchLocalMessageForResponse` calls `MessageProcessor.enqueue`. `ConcurrentQueue.enqueue` maps `null` to one shared `__default__` chain. Authentication already had separate lanes, but other machine controls and session cancellation still shared that default. Three initialize/session-new attempts plus startup-slot waiting can greatly exceed the status client's ten-second deadline.

## Decision and ownership

`apps/cli/src/lib/message-processor.ts` assigns these lanes:

| Request | Lane / ordering |
| --- | --- |
| `session/cancel` | `session:${sessionId}:cancel`, independent of chat |
| `machine/status`, `machine/ping` | Separate read lanes, one per type |
| `machine/acp-capabilities-refresh` | Per `configId` |
| `machine/provider-rate-limits-refresh` | Per `configId`, separate from capabilities |
| `machine/acp-binary-status` | Separate read lane |
| `machine/acp-binary-install` | Per `agentType` |
| `machine/restart`, `machine/upgrade` | Shared `machine:lifecycle` |
| `machine/acp-authenticate` | Existing start lane and separate ordered cancel/submit control lane |

Unlisted messages retain their mapping. Create/chat ordering stays on the session main lane; actual cancellation remains handler-owned. Authentication cancel before registration still returns `not-running`, allowing another cancel.

Restart/upgrade handlers do not depend on earlier unrelated default-lane work: they verify authorization, retain a pending lifecycle action, reply and trigger its callback. Their mutual serialization remains necessary. `MachineRuntime` separately stops admission, cancels parked requests and drains for up to five seconds before cleanup. Cleanup responsibility is unchanged.

The existing queue concurrency limit remains. ACP starts still use `acp-session-start-gate.ts` (default two); `session-execution-service.ts` retains refresh/install in-flight ownership and deduplication. Effect migration is deferred: this changes lane selection and one recovery predicate within existing Promise owners, not a complete native lifecycle unit.

## Alternatives and consequences

- Cancel behind its chat or authentication start cannot release the work blocking it. A lane per authentication request reproduces this deadlock.
- Allowing concurrent authentication starts would lose their previous serialization; the single start lane preserves it and matches the login UI's one-flow-at-a-time behavior. `AcpAuthenticationManager.runningByAgentType` retains per-provider exclusion. The separate control lane keeps control order. Renderer optimistic cancel is unnecessary for correct dispatch.
- A global machine lane lets an ordinary slow probe block health checks and recovery. Per-provider lanes preserve same-config order; resource admission stays with the startup gate.
- Cold npx initialize timeout is not cache-corruption evidence. `acp-npx-startup-policy.ts` may remove matching package/version `_npx` directories, then runs `cleanupFailedAttempt` before retry, but retains `_cacache` and unrelated installs. True corruption signatures retain the existing targeted purge and whole Lody-cache fallback. Budgets, attempt counts and final errors are unchanged.

## Verification and limits

`apps/cli/tests/message-processor-permission-response.test.ts` uses explicit handler/completion signals to cover independent controls, same-config serialization, lifecycle order, chat cancellation and authentication controls. `apps/cli/src/agent/npx-cache.test.ts` covers retained downloaded bytes and unrelated installs after cold timeout, cleanup before retry, true-corruption clearing and the full retry round fitting the shared client backstop.

Tests verify dispatch and recovery policy, not weak-network download duration. Remote Machine RPC bypasses this local queue. The existing global queue limit still bounds admission when all slots are occupied; this change introduces no priority scheduler.
