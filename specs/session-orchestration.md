# Session orchestration

Status: draft
Translation: current

[中文](session-orchestration.zh.md)

When an Agent delegates asynchronous work through Lody, each delegated target
continues the causal chain from the driving human turn. Lody accepts at most 32
such hops. A command issued by a turn already at depth 32 is rejected before an
Operation or target Session is created, with the non-retryable
`CHAIN_DEPTH_EXCEEDED` error.

The depth is a causal delegation count, not a general `parentSessionId` tree
depth. Creating a Session, sending work to another Session, and delivering an
Operation continuation each advance the target turn by one. A missing depth on
an ordinary human turn starts at zero. The limit remains fixed in the shared
protocol contract; changing it requires updating every producer, recovery path,
executable model, and this Spec.

Machine-side review automation runs outside this MCP delegation chain. It keeps
its own round, token, and authority budgets while reacting to external review and
CI state.

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

The CLI `lody session create --agent-role <idOrName>` resolves the same catalog
Role by fixed id or unique name. The Role's machine, agent config, run
configuration and Prompt prefix take precedence; overridden manual flags are
reported as ignored, and the work-context flags (`--repo`, `--local-project`,
`--branch`, `--worktree`) still apply.

An explicit permission selection may be broader than the parent's. The caller
must act within its user authorization. This interface introduces no permission
ranking, escalation approval rule or safety boundary relative to CLI creation.
Changing existing sessions through `lody_session_chat` is outside this change.

Explicit selectors participate in the canonical command fingerprint. Reordering
map keys is the same request; changing selections under an accepted Operation id
is `OPERATION_ID_REUSED`. Acceptance freezes each effective target dispatch config.
Retry and recovery use that config rather than recomputing requester defaults or
Role configuration. No Operation storage migration is required.

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

## Implementation evidence

The implementation guard is `apps/cli/src/mcp/lody-mcp-server.ts`, the shared
limit is `packages/shared/src/session-orchestration.ts`, and the executable
Operation model is `apps/cli/src/orchestration/operation-model.ts`.

This draft records the requested limit of 32. Runtime and deployed-client
acceptance remain to be verified after dependencies are installed.
