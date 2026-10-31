# Session configuration ownership

Status: draft
Translation: current

[中文](session-config-ownership.zh.md)

## Scenario and decision

After an agent leaves Plan to implement an approved plan, a later message must not
restore Plan because history is still loading or a capability catalog refreshed.
The session execution owner maintains confirmed runtime configuration independently
of transcript hydration. Private edits describe the next request; immutable Turn
inputs describe accepted work. Neither proves that the agent changed state.
This proposes replacing current baseline and failure policies, not describing
shipped behavior.

The composer uses confirmed values plus private edits. A held or queued send shows
its frozen request separately and does not seed another message's defaults. History
is not a routine fallback. Capability refresh can mark a value unavailable but cannot
replace it with a default or first available choice. New-session defaults are initial
requests until the agent confirms them.

## Applying a request

Existing admission consumes only captured private edit generations. Inputs derived
from a confirmed snapshot identify its revision; the execution owner rejects a stale
baseline before accepting the input, preserving the request for correction. Local
held-send admission remains distinct from owner acceptance. Already accepted queue
entries keep their frozen configuration even if the running agent subsequently
changes mode; that request remains visible on the entry. Queue deletion or reordering
does not change current configuration.

Owner acceptance is the durable acceptance of the immutable input by the execution
owner through the existing input receipt/writer boundary. Its receipt identifies
the input and successful baseline check. Retry or restart with that same accepted
identity reuses the receipt without checking its old revision again; a local
held-send record alone is not this proof. Previously owner-accepted legacy entries
retain their accepted status. No second send journal is introduced.

Apply mode, model and dependent options in order. Every concrete value in an accepted
request is required. A refusal, contradictory confirmation, missing operation or
unknown outcome fails that input before its prompt is submitted. Display a safe
diagnostic identifying the field and reason, irrespective of provider. Retain confirmed
partial changes; do not roll back, downgrade, switch protocols after a refusal, or
automatically replay uncertain input. Preserve the frozen request for inspection
and explicit retry or correction.

Native steer does not reapply configuration while a prompt is running. It may use
the active connection only when the frozen requirements match its confirmed state;
known configuration mismatch follows the existing ordinary-queue route and is shown
as queued. A configuration error or unknown result is not proven steer non-delivery
and must not trigger automatic promotion or replay. Ordinary proven non-delivery
keeps its existing policy. If a connection must be retired, the active prompt's
outcome is settled and reported through its existing lifecycle owner too.

Confirmed state must be locally durable before dependent prompt submission. A write
failure must be visible; remote synchronization is not the submission barrier. An
agent-initiated change updates current configuration through the same owner, without
rewriting the driving Turn. Old connection observations cannot update a replacement
connection. Necessary generation and request checks live at that boundary, not in UI.

## Initialization and compatibility

Opening a conversation does not start an ACP process. Before the first live snapshot,
show runtime configuration as unconfirmed. Allow a request that explicitly uses agent
defaults for unspecified fields; normal dispatch establishes or loads the agent,
confirms its state, applies explicit requirements, and persists it before submitting
the prompt. An absent field means inherit; it is not an empty value, false, or a
request to restore an old historical choice.

Old sessions obtain initial confirmation from session load/resume/new, using supported
legacy acknowledgements where applicable. Do not reconstruct current configuration by
walking old Turns. Existing accepted inputs retain their requirements. A stored old
snapshot may be displayed as last known, but is not confirmation from a new connection.
Unsupported confirmation fails visibly.

Negotiate the new configuration contract through machine capabilities. A new client
exposes an update-required state for a machine lacking it instead of quietly using
the old fallback chain. History viewing and Stop remain available. No blanket history
rewrite or provider migration is required.

## Scope and evidence

The [design note](../.agents/notes/implemented/architecture/2026-10-31-session-config-ownership.md)
owns architecture, alternatives, Effect dependencies and validation limits.
[Private drafts](session-run-config-drafts.md) retain local ownership and admission;
their effective-baseline rule would change to this contract.
[Orchestration's rejection policy](session-orchestration.md#runtime-model-rejection)
would change from warning-and-continue to failing the affected input. Role, memory,
MCP and attachment ownership remain governed by their existing contracts. This
proposal is not implemented or approved; compatibility and queue-default changes
require review with the configuration ownership decision.
