# Codex reasoning is a live status, not session history

Status: implemented
Translation: current

[中文](2026-09-18-codex-transient-reasoning.zh.md)

## Abstract

Builtin Codex emitted `agent_thought_chunk` through the ordinary ACP history
callback, so its transient reasoning remained visible after the turn ended and
in exported or reopened sessions. The client now intercepts only those Codex
chunks before `HistoryWriter`, extracts a bounded current summary, and publishes
it as `running.detail` through the session's existing ephemeral presence owner.
The activity row displays that detail only while the presence is fresh; ordinary
assistant/tool updates clear it and turn cleanup removes it. Existing persisted
thought entries are deliberately not rewritten, because opening history is not a
migration or authorization to delete user data.

## Decision

### Intercept at the ACP client boundary

Filtering in the renderer would merely hide a persisted item. Filtering in the
history applier would be too broad: standard `agent_thought_chunk` updates from
other ACP providers still have the normal transcript contract. `AgentClient`
already knows the selected provider, so it is the narrow boundary that can keep
Codex-only reasoning out of every downstream history consumer without changing
other providers.

### Carry only a bounded live label

`SessionActivePresenceController` is the single publisher and clearer for live
session state. A `running.detail` field carries at most 280 characters; its
presence schema rejects larger values. This keeps the status row useful without
turning presence into another transcript store. A tool, answer, or plan clears
the label, and the controller clears the whole presence at turn end.

## Verification

`agent-client-session-preparation.test.ts` proves Codex thoughts never invoke
the history callback while a non-Codex thought still does, and that a tool clears
the live label. `session-active-presence.test.ts`, `presence.test.ts`, and
`session-status-machine.test.ts` cover presence publication, schema bounds, and
the running-status shape. The existing component typecheck confirms the activity
row reads the new transient detail.
