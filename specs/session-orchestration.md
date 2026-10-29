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

## Replying to the current task sender

When an Agent-authored input from A drives B's active turn, B must not create a
new chat back to A. Single and legacy chats fail before dispatch with non-retryable
`REVERSE_CHAT_FORBIDDEN`. Batch items targeting A fail independently; a batch of
only such targets is rejected before Operation acceptance. Other targets remain
available, and already accepted retries retain their fixed identity.

This restriction uses the exact active input's sender, not Session containment or
older conversation history. A later human input or an input from another Session
replaces this scope. Known Agent sender provenance is required; legacy inputs
without it remain readable and retain existing behavior. This change does not add
note tools or change result delivery timing.

## Agent chat to a busy Session

An orchestrating Agent sends corrections or new information to a Session that is
still working. `lody_session_chat` and `lody_session_chat_many` steer that input
into the running turn whenever the target runs on the calling Machine and its
agent accepts steering, regardless of the human's queue or guide preference and
of who started the running turn. The steered input gets its own reply, which
becomes the Operation result; an earlier turn it interrupts ends at that point.

A steer that is provably not delivered becomes the next ordinary turn, as it
does for a human. An uncertain delivery is never replayed: the item fails with
non-retryable `STEER_DELIVERY_UNKNOWN`, and the requesting Agent decides whether
to resend. Idle targets, targets on other Machines and recovery replay keep
ordinary dispatch. Evidence: `sendSessionChatResult` in
`apps/cli/src/commands/session.ts`, its suite `session-default-fallback.test.ts`,
and item reconciliation in `apps/cli/src/orchestration/coordinator-workflow.ts`.

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
Role configuration. Effective inherited mode/model/options retain internal provenance;
replay keeps compatible values and drops incompatible inherited values, even when catalog
freshness is unconfirmed. Current explicit selections remain strict. Effort and Fast use
the effective target model on both initial validation and frozen replay.

Internally synthesized builtin modes retain separate provenance so replay does not
reinterpret a fallback default as an explicit user selection. Before the fixed UserTurn
is authored, the default is re-derived against available capabilities. Interrupted
materialization preserves only authored values reachable from its frozen inherited or
synthesized provenance, without rewriting history or relaxing the complete immutable-input
identity check. Provenance fields are not public MCP input or Session history. Existing
stored inherited-default markers remain readable; no storage migration is required.

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
authority in a cloud workspace. Completion writes directly to the native Inbox in
the same Operation transaction; the result-consumption rules below control execution.
This changes local persisted storage, not the hosted API.

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

## Inbox database unavailable at startup

Failure to open or activate Inbox must not prevent workspace startup or ordinary
human conversations. Report degraded availability through the existing runtime
warning channel; Inbox-dependent Agent tasks and automatic continuations return
an explicit unavailable error without accessing the database. The coordinator owns
bounded-backoff recovery, canceled on shutdown; incompatible schema/protocol errors
do not auto-retry. Recovery preserves existing submission evidence and never replays
unknown input. Authentication, E2EE and local/cloud boundaries remain unchanged.

## Idempotent message consumption

Operation completion receipts enter the durable Inbox with wake eligibility. If a
Session is idle, unpaused and has no unreleased resources or accepted queued input,
one wakeable receipt grants a persistent automatic intent. Busy Sessions defer
consumption until normal completion and actual release. Stop blocks receipt-driven
wakes until fresh human or Agent-chat input. Result persistence and wake intent creation
share the completion transaction; reopen recovers an unsubmitted intent without a new event.
Suppressing user-facing completion notifications for Agent-initiated turns does not
suppress Operation receipts or their wake eligibility.

Wake eligibility is distinct from membership: one wakeable receipt carries all
unconsumed, unclaimed results in the same Session/User queue, including passive
results. Snapshot the queue watermark and freeze members only when claiming the
batch. Arrivals before claim coalesce; arrivals after claim stay queued for a later
batch. Duplicate receipts/releases never create duplicate execution; empty queues
never start a model. Submitted or unknown members never re-enter another batch.

Stop, fresh input acceptance and actual transport initiation share Session admission.
Inbox-aware Stop persists pause before cancellation and cancels pre-Stop queued input eligibility
while retaining history. The pause blocks only automatic completion wakes. Input sent
after Stop by a human or by another Session's Agent chat ranks the same: it is admitted,
clears the pause and carries saved results; old instructions require a new send.
Receipts still decide only whether an input is recorded as human. Failed exits
never auto-continue; unreleased resources block all successors. Normal future human
turns resume the same receipt-driven scheduling rule. A failed exit alone grants no
wake, but a later wakeable receipt may grant one after physical resource release.

Missing or incomplete recovery journals must remain visible and recoverable. A local
operator may explicitly attest that all old resources, including unrecorded ones,
have been released while holding exclusive Host ownership; known live resources or
uncertain probes still block recovery. Atomically retire the exact old execution and
pause the session. Do not replay unknown submissions or manufacture a normal-release
intent. Only fresh human or Agent-chat input resumes work afterward. A dead daemon PID alone
is not release evidence. This maintenance action is not available through Agent/MCP tools.

An automatic batch yields atomically to pre-submission human acceptance. A human input
already being prepared survives later queued human input. Keep admission from the
submission fence through synchronous transport initiation, without an intervening
async check. Fresh input cannot revive a Stop-canceled execution. Execution identities
and queued input identities remain distinct.

Members and batchId are fixed. Preserve human text, attachments, config and causal
depth; results are reference data. Automatic depth advances the maximum current/member
depth by one. Never submit an empty automatic batch. Preview is bounded to 64 KiB;
read complete contents through Session/user-bound pages of at most 128 KiB. Large
individual members use ordered JSON fragments, not additional model turns.

Post-fence uncertainty is permanent unknown submission, never replay. Human-plus-batch
inputs also disable whole-input stale-ACP replay. Retry settlement writes only. Raw
request/resource release differs from waiter cancellation or Scope close: retain full
failures, shared shutdown receipts and independent recovery owners until actual release.

Preserve released Operation rows, author/input snapshots, recovery state and retired
IDs across upgrade; active Operations continue reconciliation. Delete only per-Delivery
storage/execution and unclaimed compatibility result copies. Never import or replay
the old completion-notification backlog. Preserve current Inbox pause, resource ownership and
unknown/submitted batch evidence; deleting data is not proof of physical release.
Schema/protocol v2 requires host launch v3. Supported launches end the previous
Worker before ownership transfer and reject earlier contracts before storage access.
Passive result data does not count as running work. Preserve ordinary no-batch user
recovery, retired current Operation IDs and tree-stop rules.

Stop producers negotiate Inbox v2 before adding cancelId/pauseInbox or publishing a
control-request marker. Without it, use the released cancel fields and assistant Turn
ID marker. A new CLI treats Stop without pause-protocol fields as ordinary execution
cancellation, without persistent Inbox pause that an old client cannot resume. Missing
receipts still do not imply human authority. Inbox-aware Stop retains the pause rules above.

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

## User Stop of delegated work

When a user manually stops the exact input delegated to a target Session, that
target is terminally cancelled and remains queryable, but its cancellation is
not an automatic receipt to the delegating Agent. It cannot enter a later human
or automatic batch, including after restart or deadline reconciliation. A new
user message in the target starts independent work and never revives this receipt.
In a multi-target Operation, only the manually stopped targets are omitted from
the automatic receipt; other targets retain normal result delivery. If all
targets are omitted, no receipt or wake is created. Errors, deadlines, and
explicit requester Operation cancellation keep their existing behavior.
