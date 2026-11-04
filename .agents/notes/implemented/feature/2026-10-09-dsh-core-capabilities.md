# DSH Core controls and execution ownership

Status: implemented
Translation: current

[中文](2026-10-09-dsh-core-capabilities.zh.md)

## Abstract

Harness already supported most Core operations, but the adapter exposed only stream,
usage and restoration features. The adapter now bridges read-only history, steering,
goal controls, subagent queries/cancellation, background task state and logical
worktree identity. Native services remain authoritative, while ACP owns root prompt
lifetime across automatic goal rounds. Scheduled wakeups and account rate-limit
windows stay unsupported because the current composition cannot satisfy those
contracts; declarations do not imply universal remote subagent cancellation.

## Decision and evidence

Rechecked the published Harness 0.2.0-rc.2 declarations and JavaScript installed by
the exact profile closure against Core 0.1.9. This supersedes the preliminary
0.1.5 audit. The [Harness upgrade](2026-10-09-dsh-harness-upgrade.md) and
[session restoration](2026-10-09-dsh-session-restore.md) remain separate decisions.
The user requested all feasible Core bridges after upgrading Harness.

- SessionQuery observations are immutable leased cuts. Reusing replay projection
  avoids agents.resume, writer locks, storage repair and model calls. Standard list
  filters delegated sessions. Host history selection now prefers advertised Core
  history and fails closed for built-in Codex/DeepSeek without it.
- Steering uses non-waking injection and matches durable user/message IDs, not
  queue acceptance or inbox claim. A native-turn fence rejects messages that would
  cross into another turn; settlement removes unconsumed input and resolves failure.
- GoalService owns CAS state and the native round driver. Goal set/resume ignore
  fallback text and keep the ACP prompt open through native round checkpoints.
  Pause/clear are independent requests. Cancellation pauses before draining;
  active-but-disarmed maps to paused, and round-limit to limited. No token budget
  or goal-specific token accounting is synthesized.
- Child carrier ancestry establishes root ownership. Queries use Core run IDs,
  retain observed executions and bounded text tails, and reject foreign IDs.
  Local Agent cancellation also drains continuable direct children; remote runs
  advertise final-tail/no-cancel. No historical residency-to-running inference.
- New Jobs events supply owner-scoped task snapshots without reading model output.
  Upstream defaults idle completion delivery to wakeup. Registration overlays
  quiet on native job-tool rows, preserving vendored source declarations, and
  root pre-step admission rejects work without an owned prompt. Retry activities
  and current-context usage use native events/tokenMeter, not cumulative totals.
- Worktree identity lives in an atomic adapter catalog sidecar. Validated absolute
  directories can group native cwd sessions without modifying execution paths,
  permissions or Harness storage. Forks inherit the association unless overridden.

Rejected alternatives: advertising capabilities without request implementations;
using loadSession for browsing; acknowledging steering on queue insertion; ending
Goal's prompt after one native round; consuming background output during UI reads;
interpreting HTTP retry delays as quota windows. Experimental schedule currently
opens independent followups and has no compatible owned-work admission transport.

## Validation and limits

Adapter build/unit/format checks and the native Core probe cover actual synthetic
model turns, steering consumption/cancellation, automatic Goal rounds, pause/resume,
round exhaustion, read-only history, project persistence and job cursor isolation.
Existing native restoration/migration, fork, profile/settings and question probes
remain applicable. Unit subagent coverage checks run identity, ancestry, retained
output and foreign-ID refusal. No real model, account or user transcript is used.

The nested host checkout lacks root dependencies and several submodules: root
check/format/public-boundary and the full host suite cannot establish a clean pass;
existing docs-link failures are reported separately. Native Windows execution and
remote provider cancellation are not claimed. `rateLimits` and `tasks.scheduled`
remain absent; subagent catalog queries cover this activation, not cold history.

Provider: [PR #28](https://github.com/LodyAI/acp-extension-dsh/pull/28).
Host: [PR #1353](https://github.com/LodyAI/Lody/pull/1353).
Intent: [draft Spec](../../../../specs/deepseek-harness-core-capabilities.md).
