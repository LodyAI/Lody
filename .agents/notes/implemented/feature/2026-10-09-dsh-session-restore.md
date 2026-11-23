# DSH native ACP session restoration

Status: implemented
Translation: current

Provider PR: [acp-extension-dsh #28](https://github.com/LodyAI/acp-extension-dsh/pull/28)

[中文](2026-10-09-dsh-session-restore.zh.md)

## Abstract

DSH previously exposed fork but no load/resume, causing host restoration to fall back
to a new native session with text history. The adapter now uses the pinned Harness
0.1.5-rc.2 `agents.resume` transaction and declares both ACP capabilities. Load replays
root history; resume does not. Real storage probes confirm original identity and
continued model context across processes; historical child-agent replay remains out
of scope.

## Decision and evidence

This extends the [fork decision](2026-10-06-dsh-session-fork.md), whose load/resume
exclusion described its original scope. No Harness upgrade or host fallback change
is needed. The [restore Spec](../../../../specs/deepseek-harness-session-restore.md)
is draft, without a claim of human approval.

The native factory takes writer ownership and repairs interrupted logs before
unpublished setup. Read the reconstructed session inside that setup rather than
querying a potentially stale snapshot before resume. Preserve cwd and identity,
reject subagent activation, rebuild preset/model and requested MCP, and publish
only after restoration/replay succeeds. Failure releases the native handle and MCP
reservations. Harness recovery can append repair events even if later setup fails.

Replaying native events projects root messages/tools/titles without prompting a
model. Resume skips display replay and historical attachment reads. Both rebuild
accounting silently; subsequent deltas exclude the reconstructed baseline. Model
switches previously lived only in adapter memory until a request header was written;
now initial selection and model/reasoning changes are checkpointed as native
`model/selection` events. Profile revision v16 invalidates cached capabilities.

## Validation and limits

- Adapter build and 45 unit tests pass, including original-ID continuation, ordered
  replay, silent resume, stored selection, cwd/missing/subagent rejection, duplicate
  activation, setup reservation cleanup and missing-image recovery.
- The native probe uses separate processes with the exact published Harness runtime,
  synthetic models/presets and isolated temporary state. Both JSONL and zstd pass
  creation, cold load, interrupted-tail repair, continued model context, cold resume
  and cumulative/new-only usage checks.
- The existing full settings/profile probe additionally checks model and permission
  selection after close/load. No real model service or user session data is used.
- Root desktop build is unavailable in this nested checkout because workspace
  dependencies are missing (`rimraf`); pre-commit `pnpm check` and `pnpm format`
  are likewise blocked by missing workspace dependencies/Oxfmt. Root docs check sees missing links into
  other uninitialized submodules. Full desktop packaging, actual remote models,
  historical child-agent replay and attachment lifecycle across real installations
  are not claimed.
