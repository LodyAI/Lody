# Subagent events for Lody

Status: draft
Translation: current

[中文](subagent-events.zh.md)

When an agent delegates work, users should see the child's state and whatever
execution details its provider actually exposes. A running task with no text
feed must not look like a broken stream. This draft describes the target contract;
the first implementation covers Codex only, pending live user testing. It does not
claim that every provider offers equivalent output.

## Responsibilities and transport

`acp-extension-core` owns the shared types and validation. Provider adapters
translate native events; the host routes, persists and renders the normalized
events without interpreting provider names or private payloads.

Use one extension notification, `_lody/subagents/event`. Its root ACP
`sessionId` stays valid for today's connection ownership boundary; `runId`
identifies the child execution. Ordinary ACP output payloads are reused inside
the envelope, rather than redefining text, tools and rich content.

Negotiate `_meta.lody.subagentEvents: { version: 1 }` on both client and agent
initialization. This is separate from existing Core `subagents` v1, whose
list/output/cancel methods and lifecycle metadata remain compatible. Without
bilateral negotiation, use the existing provider path. For a negotiated run,
publish exactly one normalized lifecycle and content stream: do not also publish
its legacy task rows or native child output into the parent's transcript.

This carrier is a proposed trade-off: it adds a Core extension but avoids making
every Lody consumer implement the ACP draft and xAI's different child-session
protocols. Adapters may continue serving those native protocols to other clients.

## Schema

The following summarizes the compiled Core contract. `AcpOutput`
means the existing ACP union members named below, with their existing fields and
validation; it is not an arbitrary JSON object.

```ts
import type { SessionNotification } from '@agentclientprotocol/sdk';

type SubagentState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

type SubagentSupport = {
  stream: Array<'text' | 'thought' | 'tool' | 'plan'>;
  progress: boolean;
  outputRead: 'none' | 'live_tail' | 'final_tail';
  cancel: boolean;
};

type SubagentSnapshot = {
  state: SubagentState;
  // null = direct child of root; absent = lineage not yet established.
  parentRunId?: string | null;
  parentToolCallId?: string;
  name?: string;
  description?: string;
  modelId?: string;
  startedAtEpochSeconds?: number;
  endedAtEpochSeconds?: number;
  summary?: string;
  outputIncomplete?: true;
  reason?: { code: 'error' | 'timeout' | 'cancelled' | 'disconnected' | 'lost'; message?: string };
  support: SubagentSupport;
};

type SubagentProgress = {
  summary?: string | null;
  lastToolName?: string | null;
  toolsUsed?: string[] | null;
  durationMs?: number | null;
  turnCount?: number | null;
  toolCallCount?: number | null;
  errorCount?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  contextUsagePercent?: number | null;
};

// Existing ACP variants: agent_message_chunk, agent_thought_chunk,
// tool_call, tool_call_update, plan. Preserve content blocks and tool fields.
type AcpOutput = Extract<
  SessionNotification['update'],
  {
    sessionUpdate:
      'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update' | 'plan';
  }
>;

type SubagentEvent = {
  version: 1;
  sessionId: string;
  runId: string;
} & (
  | { type: 'snapshot'; snapshot: SubagentSnapshot }
  | { type: 'progress'; progress: SubagentProgress }
  | { type: 'output'; update: AcpOutput; nativeTurnId?: string; messageId?: string }
);
```

`AcpOutput` is a closed, discriminated ACP union. Permissions, questions, root config,
titles and accounting notifications are not output variants.

### Semantics

- `snapshot` is a complete replacement of the task's known metadata, emitted
  on discovery and material changes, including terminal state. Adapters merge
  sparse native facts before publishing; missing fields are unknown, not guessed.
  Initial recovery may already be terminal; do not synthesize a running phase.
- `progress` is a sparse update of current absolute observations. Omission keeps
  the prior observation; null clears it. Counters are nonnegative, not deltas.
  Context occupancy may decrease after compaction. Total consumed tokens and
  context tokens are distinct. Missing metrics remain absent, never zero-filled.
- `output` preserves ACP semantics: text/thought chunks append; tool updates
  merge by `(runId, toolCallId)`; plan updates replace that run's plan. Message
  and turn IDs, when available, are scoped to the child. These fields never
  replace the host's root-turn ownership or authorize a native fork.
- Only `completed`, `failed` and `cancelled` are terminal. `unknown` means loss
  of observation, not proof the process stopped. Timeout is `failed` only when
  execution failure is confirmed; a monitoring timeout is `unknown`. A cancelled
  RPC acknowledgement is not proof of task cancellation.
- Progress tokens are display information, not billing input. Existing Core
  usage accounting remains the only accounting path; never sum these into it.

## Identity, order, recovery and storage

`runId` is an opaque execution identity, scoped to the root ACP session. It is
not interchangeable with a reusable agent/thread ID. A restarted or reactivated
terminal child gets a new run ID; a proven continuation of a live run keeps it.
Adapters own provider identity mappings. Recovery reuses an ID only with native
evidence or a durable mapping; otherwise show prior observation as unknown and
do not merge a new run into it. Mapping durability is implementation work, not
a property guaranteed by currently shipped adapters.

Events are processed in delivery order on the ACP connection. The envelope has
no stream identity or sequence number and does not promise event retransmission,
duplicate detection or gap detection. A disconnect marks affected observations
incomplete; reconnect does not imply missing content was recovered and does not
authorize rerunning work. Do not automatically replay output into the live
append path; recovery needs a separate history reconciliation contract.

The adapter publishes a snapshot before a run's progress/content, buffering
native races within explicit limits. Unattributed events never become parent
output. Before a terminal snapshot, flush preceding content; ignore late content
for that terminated execution. Declared nesting is checked for cycles and cross-root
references; unresolved lineage remains unknown until corrected by a snapshot.

Host ownership is captured when the run is first bound to its initiating parent
tool/turn, not whichever turn is current during a later flush. Unresolved ownership
must remain pending/incomplete, not attach arbitrarily. A parent's prompt result
does not finish its children. Preserve each provider's existing prompt-completion
contract; this proposal does not create a background scheduler.

Persist received task state and content through the existing SessionMirror /
HistoryWriter owner. Model them as per-run transcripts within the owning Lody
session; native grandchildren can nest there without creating extra Lody child
Sessions or changing their one-level creation rule. Store the transcript in an
optional `subagent_task.run` containing the root `sessionId`, snapshot, latest
progress and items; `taskId` is the run ID. Child text/thought use streaming CRDT
text. No additional transcript retention cap is imposed. Do not store every heartbeat:
persist meaningful snapshot/progress state, batch output, and retain an explicit
incomplete/truncated marker when bounded delivery drops content. Output querying
is a separate bounded snapshot; never append repeated tails to a delta transcript.
Adapters report known content loss with `snapshot.outputIncomplete: true`, sticky
for that run. The host also marks affected runs incomplete on connection loss.
An absent flag does not prove complete native history before observation.

## Controls and rollout

Retain existing list/output/cancel RPCs. The adapter resolves run IDs to native
task IDs internally; do not assume their strings match. Before enabling normalized
run controls, Core needs a backward-compatible run-addressed selector (mutually exclusive with
the existing taskId), and output responses need explicit truncation/availability
metadata. The Codex phase offers neither per-run cancellation nor output reads.

Permission and question requests stay request/response interactions. For providers
that support them, map the child request to the root ACP connection plus validated
run ownership and use the existing host consent machinery. Never treat a tool
event as permission, route an unknown child to the parent by default, or enable
questionnaire/nested spawning in Pi children. Cancel is offered only when that
specific run supports it, with no fallback to cancelling the parent.

The first rollout includes Core, host routing, single-writer persistence, UI and
the bundled Codex adapter. Host and adapter must both negotiate before using the
carrier. The daemon advertises `subagentEvents` v1 for new live UI consumers;
persisted transcripts remain readable offline. Old histories are not rewritten.
Other adapters and any required managed-artifact publication wait for Codex testing.

Review focus: accept the Core envelope versus native child-session transport;
accept per-run transcripts inside one Lody session; accept truthful capability
degradation rather than promising identical output from all providers.

## Evidence and validation limits

Provider event inventory and rationale are in the
[proposal note](../.agents/notes/proposed/architecture/2026-09-26-subagent-events.md).
Codex synthetic tests cover routing, permissions, nested/reused runs, terminal
races and persistence across turns. Live provider verification remains outstanding.
The first storage projection retains text, thought, tools and plan; non-text
message chunks mark the run incomplete rather than being silently claimed as
retained. Tool content is preserved. The UI shows the latest action and a dialog
with all retained history. This draft has no linked approval yet.
