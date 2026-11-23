# Codex reasoning is a live status, not session history

Status: rejected
Translation: current

[中文](2026-09-18-codex-transient-reasoning.zh.md)

## Abstract

The approach below shipped and was reverted the next day; it is preserved as the
rejected alternative, and the section after it records why. Builtin Codex emitted `agent_thought_chunk` through the ordinary ACP history
callback, so its transient reasoning remained visible after the turn ended and
in exported or reopened sessions. The client now intercepts only those Codex
chunks before `HistoryWriter`, extracts a bounded current summary, and publishes
it as `running.detail` through the session's existing ephemeral presence owner.
The activity row displays that detail only while the presence is fresh; ordinary
assistant/tool updates clear it and turn cleanup removes it. Existing persisted
thought entries are deliberately not rewritten, because opening history is not a
migration or authorization to delete user data.

## Rejected on 2026-09-20

This change shipped in PR #807 (merged 2026-09-19 without review) and was
reverted the next day. Two reasons, both owned by the Lody team:

- **Reasoning is session history by product intent.** Codex thought chunks must
  stay in the transcript like every other ACP provider's thoughts. Hiding them
  was the wrong fix for the reported symptom, so the `HistoryWriter` bypass and
  the `running.detail` presence field are removed rather than rate-limited.
- **It flooded the presence transport.** Every thought chunk changed
  `running.detail`, and `setPhase()` publishes any changed detail immediately.
  A single Codex session wrote 4,000 session-presence entries in three seconds.
  Session presence and the machine heartbeat share one workspace
  `EphemeralStreamCrdt`, whose `pendingLocal` queue is a strict FIFO with no
  coalescing, so the heartbeat behind that burst arrived with an `updatedAt`
  older than the 90-second freshness window and the machine showed as offline
  in that workspace only. The presence queue weakness itself is tracked
  separately; this note only records why the producer was removed.

The rest of this note is the original rationale, kept so the same approach is
not proposed again without addressing both points.

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
