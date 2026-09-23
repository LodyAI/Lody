# Keep the host subagent client limited to current consumers

Status: implemented
Translation: current

[中文](2026-09-12-subagent-client-surface.zh.md)

## Abstract

Lody's AgentClient exposed subagent list and output methods with no callers.
The execution service only needs cancellation; task display consumes history
metadata. Removing those wrappers and their list schema leaves cancellation
directly responsible for capability and connection checks. Provider-side Core
list/output contracts remain available and unchanged.

## Decision and evidence

Repository searches found no consumers of `AgentClient.listSubagents` or
`AgentClient.getSubagentOutput`; `SessionExecutionService` calls `cancelSubagent`.
The removed generic dispatcher only served these three wrappers, so its remaining
validation and request move into cancellation without a replacement abstraction.
Existing persisted task readers and provider implementations are unaffected.

Keeping unused wrappers for a future task browser would retain a host API and
schema without current demand. Such a browser must add its actual host wiring
when implemented. Current users give up no action. Existing cancellation tests
remain the regression protection; no tests are added solely for these deletions.

This accompanies [Lody PR #605](https://github.com/LodyAI/Lody/pull/605).
