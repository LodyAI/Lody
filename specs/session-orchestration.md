# Session orchestration

Status: draft
Translation: current

[中文](session-orchestration.zh.md)

When an Agent delegates asynchronous work through Lody, each delegated target
continues the causal chain from the driving human turn. Lody accepts at most 16
such hops. A command issued by a turn already at depth 16 is rejected before an
Operation or target Session is created, with the non-retryable
`CHAIN_DEPTH_EXCEEDED` error.

The depth is a causal delegation count, not a general `parentSessionId` tree
depth. Creating a Session, sending work to another Session, and delivering an
Operation continuation each advance the target turn by one. A missing depth on
an ordinary human turn starts at zero. The limit remains fixed in the shared
protocol contract; changing it requires updating every producer, recovery path,
executable model, and this Spec.

The experimental Review agent automation is retired. It no longer runs outside
this delegation chain; see [Review agent retirement](review-agent-retirement.md).

## Session creation configuration

An orchestrator can select the target Agent's advertised configuration on
`lody_session_create` and `lody_session_create_many` without creating an Agent Role.
Optional `modeId` uses ACP mode ids; `configOptionValues` uses actual option ids
with string or boolean values. All advertised options are eligible, including
permission options without a category. Discovery reports modes and option
ids, types and choices; it omits current values and launch configuration.

Creation uses the CLI's target-capability validation. Unsupported modes, unknown
option ids and invalid values fail before a single Operation is accepted. Batch
item failures remain isolated. Batch defaults and items shallow-merge: an item's
map replaces the defaults map. Raw options retain the existing CLI inheritance
contract: a supplied map replaces the inherited map. Explicit raw mode/model
selectors override inherited scalar selectors. Omitting both new fields preserves
the existing inheritance and supported builtin defaults.

Explicit semantic model, reasoning, Fast and Plan controls retain their existing
precedence; resolving them must preserve unrelated raw options. Independent Plan
options coexist with permissions. If legacy Plan selects ACP mode `plan`, reject
a different explicit mode rather than silently overwriting it. An explicit Role
remains authoritative: manual target and configuration fields are ignored before
capability validation, command identity and dispatch.

An explicit permission selection may be broader than the parent's. The caller
must act within its user authorization. This interface introduces no permission
ranking, escalation approval rule or safety boundary relative to CLI creation.
Changing existing sessions through `lody_session_chat` is outside this change.

Explicit selectors participate in the canonical command fingerprint. Reordering
map keys is the same request; changing selections under an accepted Operation id
is `OPERATION_ID_REUSED`. Acceptance freezes each effective target dispatch config.
Retry and recovery use that config rather than recomputing requester defaults or
Role configuration. No Operation storage migration is required.

## Runtime model rejection

After acceptance, an agent rejection of the requested model must produce a
GUI-visible `agent_warning` identifying that model, including for Codex and Claude.
This applies to creation and subsequent turns, including resume, whether the model
is supplied as `modelId` or through its advertised config option. Runtime state
continues to reflect the agent's confirmed model. Reporting uses the existing
asynchronous warning path; it does not stop the turn or guarantee display before
the prompt starts.

## Frozen turn input

A failed Role-backed start retried through a different execution path must retain
the same accepted instructions and attachments. A turn's `inputConfig.prompt` is
its effective frozen text, including any Agent Config and Role instructions composed
at acceptance. `inputBlocks` retain authored text for display/editing and structured
attachments for execution; their raw text cannot override that frozen prompt.

Create, continue, steer and recovery share this interpretation. Role identity,
revision and snapshot remain provenance, never a request to resolve today's Role.
Legacy inputs without a prompt derive text from their existing blocks/history;
an explicit empty prompt contains no execution text and may accompany attachments.
Runtime instructions, attachment materialization and history replay remain separate
from the frozen task, so whole provider requests need not be byte-identical.

## Local and cloud execution

An OSS Agent Role mention must create work without a Lody account or authenticated
product-cloud requests. Session/catalog MCP calls enter the daemon holding the
local workspace. It derives identity from the active Turn, checks the exact local
machine and project, and executes the same Role resolution and durable Operation
state machine used by cloud. Hosted repository contexts remain unavailable;
registered local projects and plain chat are supported.

Recovery uses the frozen prompt, Role revision and dispatch configuration. Before
replaying a missing target input, cloud confirms remote document catch-up; OSS
confirms the authoritative daemon repo and rechecks the fixed Turn under the
existing materialization claim. Missing cloud connectivity never counts as local
authority in a cloud workspace. Completion uses the existing single-owner Delivery
protocol. No persisted schema or hosted API changes are required.

## User-controlled conversation-tree stop

The related-conversations tree exposes a confirmed stop action for the whole
creation/containment tree. A durable user-owned barrier blocks execution, MCP
delegation and automatic completion wake-ups until the user explicitly restores
collaboration. Active turns stop through normal cancellation; pending input is
preserved without promotion. Late completions retain their result and record
`COLLABORATION_STOPPED` without replaying that continuation after restoration.
Descendants created after the snapshot inherit stopped ancestors. This does not
include unrelated existing conversations merely contacted through MCP.

Every target machine must advertise the control capability before the UI writes
metadata. Offline machines enforce the barrier after receiving it; the UI must
not promise simultaneous cancellation or rollback of already performed work.

## Idempotent message consumption

When A sends work to B and B finishes, repeated notifications, retries and Worker
replacement must not make A consume the same completion again. Identity is the
machine-local pair `(requesterSessionId, operationId)`, with a fixed target input,
Delivery and completion Turn. Retries retain that pair and the original source
Turn, requester and command. A different Operation id denotes new work, even if
its text is identical; content equality is not a deduplication key.

Acceptance and completion use SQLite transactions. The Host-lease Worker claims
Delivery under the requester Session mutex, writes the fixed completion Turn,
then records `prepared`. Its `started` fence commits before submitting to ACP.
Confirmed pre-provider interruption may release preparation for bounded recovery.
Once submitted, a Delivery prompt is never automatically submitted again. A
disconnected transport, even without observed output, is uncertain consumption;
retain the completion/output and surface `DELIVERY_EXECUTION_UNCERTAIN`. Startup
recovery applies the same rule. Successful/cancelled settlement consumes the
claim; a failed settlement write retries settlement rather than provider execution.

Persistence and consumption acknowledgement belong to the message orchestration
store, not a model-provider protocol. This behavior applies to every runtime
without changing ACP clients, adapters or negotiated capabilities. Duplicate
notifications only reconcile the same durable Delivery. Successful settlement
records its consumption; retries after a failed write settle the same claim.
This guarantees at most one submission for a completion, not guaranteed successful
model execution under a crash between the durable start fence and submission.
Ordinary user-turn stale-connection recovery retains its existing behavior.

Consumed results may expire after seven days, but cleanup atomically retains a
small retired-id record without prompts or outputs. That id can never be accepted
again in the same store, including by older writers using the database triggers.
Modern callers receive non-retryable `OPERATION_ID_REUSED`; lookup of the expired
result still reports absence. Records grow with completed Operations. Deleting
the store resets this guarantee; ids already removed before this migration
cannot be reconstructed. Downgraded Workers retain their old ACP retry behavior.

## Implementation evidence

The implementation guard is `apps/cli/src/mcp/lody-mcp-server.ts`, the shared
limit is `packages/shared/src/session-orchestration.ts`, and the executable
Operation model is `apps/cli/src/orchestration/operation-model.ts`.

Consumption and retention are implemented in
`apps/cli/src/orchestration/operation-store.ts`, continuation submission in
`apps/cli/src/session/session-execution-service.ts`, and reconciliation in
`apps/cli/src/orchestration/operation-coordinator.ts`. Their owning suites cover
transport failure, claim/settlement races, restart and result expiry.

This draft records the requested limit of 16. Runtime and deployed-client
acceptance remain to be verified after dependencies are installed.
