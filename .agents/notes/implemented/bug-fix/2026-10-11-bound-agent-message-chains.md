# Bound agent message chains and discourage empty replies

Status: implemented
Translation: current

[中文](2026-10-11-bound-agent-message-chains.zh.md)

## Abstract

Agent conversations can repeatedly wake one another with acknowledgments or duplicate
result callbacks. The existing causal delegation limit is reduced from 32 to 16,
and MCP instructions require task-advancing messages and automatic result delivery.
This bounds delegation depth earlier while preserving substantive follow-up work.
It does not introduce a shared fan-out budget or detect message meaning at runtime.

## Decision and evidence

This supersedes the numeric limit in the [earlier chain-depth decision](2026-09-08-raise-async-chain-depth.md).
The [orchestration Spec](../../../../specs/session-orchestration.md) remains draft.
The shared constant feeds the MCP acceptance guard and executable Operation model;
create/chat, batch dispatch, recovery and completion continue propagating existing
causal depth. Commands at depth 16 or above remain non-retryable failures before
acceptance. Long legitimate delegations may consequently stop sooner.

One guidance string is included in MCP initialization and all four create/chat tool
descriptions. It prohibits courtesy-only replies, requests for acknowledgments,
redundant status updates and manually duplicating automatically delivered results.
At the limit, agents must report remaining work to the user instead of retrying or
creating another session to evade the guard. Prompt guidance is not enforcement of
message semantics; the existing runtime guard enforces only chain depth.

## Verification and limits

The existing model boundary test now accepts depth 15 and rejects depths 16, 17 and
32 without changing state. Targeted Vitest and CLI type checks could not start:
this nested checkout has no installed dependencies (`vitest` and `tsgo` missing).
Changed TypeScript files were formatted with Oxfmt, and `git diff --check` passed.
Repository documentation checks remain blocked by existing broken links, including
missing ACP submodule files. Full runtime and deployed-client validation remain open.
