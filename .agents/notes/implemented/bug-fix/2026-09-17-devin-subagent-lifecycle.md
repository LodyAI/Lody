# Devin subagent lifecycle entries

Status: implemented
Translation: current

[中文](2026-09-17-devin-subagent-lifecycle.zh.md)

## Abstract

Devin CLI (`devin acp`) renders subagents as instantly-completed tool calls because it only
emits structured lifecycle events after the client advertises its private
`cognition.ai/subagentSupport` capability. Lody now advertises that bit for `devin` agents and
maps the lifecycle `_meta` markers onto the existing `subagent_task` pipeline. The harder part
was where to stop subagent-internal updates: they are dropped at the notification ingress for
non-tool updates and suppressed in the history applier for tool updates, so usage metering,
runtime config, plan snapshots, and the transcript all stay clean while permission-requested
tool rows and file-edit evidence still resolve. The protocol is private and may drift, so every
drop is gated on a materialized task row or a known task id; unrecognized input fails open into
visible output.

## Problem

With `subagentSupport` negotiated, Devin sends `subagent_started`/`subagent_completed` markers on
`tool_call_update` rows keyed by the subagent's agentId, plus a `subagent_context` tag
(`parentAgentId`, or `"root"` for the main agent) on every update a subagent produced — text,
tool calls, usage, everything. Two production-path details made a naive parser insufficient:

- `filterNotificationsForHistory` compacts away non-terminal `tool_call_update`s without
  `rawInput`, which is exactly the shape of a `subagent_started` row; it now also exempts rows
  that parse as a Devin lifecycle marker, the same rule `_meta.lody.task` already enjoys.
- The same notification feeds several consumers outside the transcript funnel — usage metering,
  `config_option_update` state, plan snapshots, session titles, rich-content attachments — so a
  drop placed only in the history content builder could not protect them.

## Responsibilities

- `AgentClient.sessionUpdate` records task ids seen in lifecycle markers and drops
  context-tagged **non-tool** updates whose owner is a known task. This is the single choke
  point in front of usage, config, plan, title, and attachment consumers.
- `buildMessageContentFromNotification` maps lifecycle markers to `subagent_task` items and
  reads the context tag on a lifecycle row as `parentTaskId` for nesting.
- `NotificationOnHistoryApplier` drops context-tagged updates once the owning task row exists,
  except tool updates that merge into an already-persisted row — permission requests write a
  pending `tool_call` item before the tool runs, and a dropped terminal update would leave it
  pending forever.
- `packages/shared/src/acp/devin-subagent-task.ts` owns the private wire schema; parse failures
  return `null` and degrade to ordinary tool calls.

## Alternatives and trade-offs

Dropping all tagged updates at the ingress was smaller but regressed two behaviors that work
today: approved permission rows would never complete, and subagent file edits would vanish from
per-turn diffs (edit evidence is a separate pass over the notification batch). Stamping a
neutral marker and gating every consumer instead was rejected because the consumer list is not
enumerable — any future or missed consumer would silently leak. The split rule (non-tool at
ingress, tool rows in the applier) keeps each drop at the layer that owns the relevant state.

Accepted limits: subagent transcripts are discarded rather than nested — only the completion
summary is retained, matching what Claude/Codex task panels show. A permission-requested
subagent tool appears as a flat `tool_call` row with no task parentage, which is the price of
showing what the user approved. Fail-open covers unknown owner ids and unrecognized markers;
semantic drift under an already-known parent id (e.g. a nested lifecycle row in a new shape)
can still be classified as internal and dropped. The devin-gated cancel control
(`subagentControl`) is out of scope; the task panel's cancel affordance predates this change and
is not Devin-specific.

Three assumptions ride on Devin's private protocol and are unverifiable from code: the
permission request's `toolCallId` equals the tagged `tool_call_update`'s id (a mismatch would
leave the approved row pending forever); an `agentId` is unique per session rather than reused
across turns (reuse would merge a new subagent into an old task row); and `loadSession` replays
lifecycle markers before the tagged updates they own — until a marker re-arrives, the client's
known-id set is empty, so resumed-session internals briefly pass through instead of dropping.
Registration is a proxy for materialization: a marker row later rejected for invalid `content`
still registers the id, so that owner's internals drop at ingress while the applier's fail-open
is unreachable — a compound-malformed edge left as accepted drift risk. Two pre-existing gaps
this change inherits rather than creates: an `in_progress` task row spins forever if the agent
dies without `subagent_completed` (no reconcile exists for any provider), and `transcript.md`
export drops `subagent_task` items entirely (the JSON export keeps them verbatim).

## Validation

Parser contract tests pin the captured wire shapes; applier tests cover suppression,
fail-open on unknown owners, the permission-row merge, nested `parentTaskId`, terminal-status
monotonicity, and pass-through for unrecognized markers; an ingress test proves tagged non-tool
updates never reach `onUpdateMessage` or the usage meter; a pipeline test proves the started
row survives history filtering and lands as a `subagent_task`. Shared and CLI typechecks pass.
Not verified: real Devin traffic beyond the captured handshake and lifecycle sequence, and
Devin's `subagents/*` control methods.

PR: https://github.com/LodyAI/Lody/pull/767 (closes #765)
