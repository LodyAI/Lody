# Lody Automations: scoped conditions and durable Session actions

Date: 2026-10-25
Updated: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-25-session-automation-coordinator.zh.md)

## Abstract

Lody needs to retain entrusted work while an Agent is idle, quota-limited or gone.
Automations persists conditions and action receipts under the local workspace owner,
while each Session registration fixes its continuation target at acceptance. External
JavaScript composes predicates over scoped `ctx` observations; Lody owns event-to-action
policy, authorization, scheduling and recovery. Session/Inbox remain the effect owners.
The implementation uses synthetic source, interpreter, queue and execution evidence;
it does not claim live provider cache/quota verification or all-platform packaging.

## Architecture and alternatives

The supplied EDA-001 v2 RFC is the architecture input. Its API examples are semantic
sketches, not mandatory names. The caller-facing refinement is programmable wait
conditions with internal action policy: no public business-condition enum, grant
graph, handler DSL or generic command runner. A Session can register and then exit;
`false` keeps waiting and `{resumeText, payload?}` requests one same-Session continuation.
Workspace is the runtime/storage owner, not an inferred continuation target.

[The module guide](../../../../apps/cli/src/automations/README.md) owns API details and
links to implementation boundaries. The public wait surface and native Session
settings are intentionally separate from internal event/action contracts. Internal
rules retain explicit Session/Project/Workspace scope and frozen ownership; programs
cannot widen their registering Session's authority or resolve a different target.

| Alternative                                    | Decision and reason                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Leave behavior unchanged                       | Existing Schedules cannot retain arbitrary conditions, exact native unfinished work or admission evidence after the Agent exits |
| Replace Schedules                              | Rejected: recurring timezone, misfire and overlap behavior already has an owner                                                 |
| Expose handler/action graphs or a business DSL | Rejected: ordinary callers need JS predicates; Lody already knows the resume/archive/compact policies                           |
| Default shell execution                        | Removed: process isolation does not constrain daemon credentials, files or network authority                                    |
| New execution/queue owner                      | Rejected: reuse Session admission, Inbox, queue promotion, Stop and release proof                                               |
| Separate timer scheduler                       | Unnecessary: accepted receipts persist `notBefore`; waits persist their next check/expiry; the existing runtime wakes them      |

The real additions are the private durable ledger, bounded JS interpreter/read bridge,
source evidence and coordination of existing owners. They do not replace business
resource ownership. Cradle's POC is not the authority for this API or trust boundary.

## Progressive Agent guidance

The caller should not infer `ctx` methods or repeatedly consult a separate manual.
The built-in Lody MCP server publishes the Automations skill through the Skills
extension, with frontmatter and a complete file manifest. The MCP host discovers
entries via `skills/list` and exposes their names and descriptions in its native
skill catalog. Its skill-loading path verifies and activates selected content read
through `resources/read`; a generic resource read alone is not activation.
Product-specific discovery or reader tools do not provide this integration.

The skill entry routes to focused observation and settings references. Command and
parameter schemas derive from the executing Zod contracts; the CI example is the
existing executable example. Production and development artifacts embed the text.
The bundle grants no permissions, and unknown URIs never become file or network reads.

ACP supplies the existing `mcpServers` connection descriptor. The Agent's MCP host
owns discovery, verification and activation under the standard Skills extension.
No private ACP capability, directory cache, native plugin injection or model-facing
reader is required by that protocol. Adding those mechanisms to ACP startup would
make Lody own a second consumption path; this design deliberately removes that bridge.
The [MCP guide](../../../../apps/cli/src/mcp/README.md#skills-over-mcp) owns the delivery
contract and host compatibility limits. Code Mode and third-party skill installation
remain outside this change.

A connected MCP server does not prove native Skills support. A synthetic stdio
server test with Codex 0.160.1 and Claude Agent SDK 0.3.293 observed no Skills
extension discovery during initialization. A Codex turn read the advertised skill
as an ordinary MCP resource and followed it; the Claude turn was blocked by missing
login. The [MCP guide](../../../../apps/cli/src/mcp/README.md#skills-over-mcp)
records the test scope and limits. Automatic native discovery remains unconfirmed;
local skill roots or SDK plugins are different integration paths.

## Conditions, sources and admission

`ctx` contains bound Session/Workspace identity, time and authorized reads. Data adapters
expose Session/group state, associated PRs, workflow runs, sanitized capacity and scoped
facts. JS combines these observations; a read resource is not a predefined predicate.
Programs have no ambient Node, process environment, filesystem or network. Source
credentials stay with existing owners. Reads recheck ownership and cancellation.

CI observations use the existing PR poller, credential resolver and quota/cooldown
owners. Queries filter by current HEAD, preserving Run/Attempt identity and gaps.
First observation establishes a baseline; direct predicate evaluation can still satisfy
an already-ready wait. Active waits and undelivered continuations retain observation
demand, including terminal PRs. Actions denial has its own repository cooldown and
cannot disable ordinary PR observation. Out-of-order results cannot roll back attempts.

Host-captured evidence commits separately from the JS result. A match is final;
source/authority checks continue during preparation, admission and queued work. Changed
HEAD, PR association or attempt supersedes stale work. Completion of another job in
the same attempt does not itself invalidate the attempt identity. Immediately before
native prompt submission, the Session owner verifies referenced checkout HEADs,
including Project members through validated existing worktree paths. Guest payloads
cannot supply this authority.

A due action writes one deduplicated `timer.due` fact from its durable receipt. Restart
recovers eligibility without creating a new invocation. A timer proves only elapsed
time; fresh capacity observations or an explicitly enabled bounded recovery attempt
must still pass normal admission. Missing observations remain unknown.

## Lifetime and recovery contract

- **Trigger:** source observations or persisted deadlines wake the local runtime.
  Registrations bind the author and Session before checking. Checks may repeat after
  interruption; result acceptance, evidence and continuation identity commit together.
- **Owner:** Fleet retains a workspace runtime; native Effect owns workers, their
  bounded reads and reconciliation. Existing Session/Inbox owners commit effects.
- **Cancellation:** revoke admission first, interrupt/join the exact check or input,
  and preserve unrelated work. Expiry prevents accepting a late condition result.
- **Handoff:** stable invocation/Session/Turn IDs and a submission fence precede effects.
  Busy targets enqueue; Stop is never cleared and unavailable targets are not replaced.
- **Recovery:** interrupted checks retry; uncertain submissions reconcile the same
  input. Raw Legacy owner calls are joined, not detached on timeout. Five consecutive
  check failures become inspectable failure. Uncertain native effects remain blocked.

The native Effect 4.0.2 unit is the loop, interpreter worker and read bridge. Explicit
Legacy composition/Session/Repo adapters remain until their owners migrate; wrapping
them in Effect is not a completed migration. Private launch snapshots and credential
fingerprints do not enter queue history or tool-visible activities. Local automations
make no authenticated product-cloud requests.

Encrypted workspaces withhold Automations through the shared workspace content policy,
including startup, explicit control and background retries, until an encrypted automation
channel is implemented. Existing encrypted PR-poller isolation remains intact.

## Native policies

Failure finalization evidence for quota recovery is distinct from successful history
finalization; it cannot authorize unread-success publication.

Settings default off and affect future observations. Enabling capacity recovery also admits a recorded failure for the current input once. Disabling revokes new submissions;
cancellation addresses an accepted input. Policy dispatch is internal Lody code.

- **Quota recovery:** typed exhaustion retains the original native conversation,
  launch binding, input and tool boundary before release. All observed windows count;
  partial snapshots cannot erase an exhausted weekly window. New input supersedes old
  work. Missing release or unresolved tool effects block continuation.
- **Merge archive:** existing PR facts initiate group settlement, including children,
  queued input, Goals, native work and automations. Admission barriers protect rechecks;
  the root commits last and partial progress is reconciled. A child with an unconfirmed
  release retains its parent admission until raw prompt completion or confirmed recovery;
  transport disconnection alone does not prove completion.
- **Idle compact:** context occupancy must reach the threshold; the original idle turn,
  finite deadline and advertised native `/compact` must still be valid. New input or
  expiry invalidates maintenance. Configured cache lifetime is an operator estimate,
  not provider evidence or a guarantee of discounted inference.

## Evidence and limits

Validation uses a standalone checkout of the pinned dependency graph; this nested
worktree has no installed modules. Synthetic tests exercise source parsing and quota
isolation, scoped reads, asynchronous JS, persisted completion/evidence, restart,
cancellation, expiry, stale HEAD/reruns, queue acknowledgement loss and actual Session
execution with synthetic native transports. Emitted worker loading and cleanup are
validated separately from interpreter tests. These automated suites use no live Claude
process, provider quota probe or prompt.

Skills validation covers modern HTTP discovery, stdio artifacts, exact resource bytes
and digests, unknown URI rejection and runnable registration/CI examples. Tests use
standard MCP clients and the actual server handlers. They do not establish automatic
summary injection, activation or model skill selection in a native Agent. These
automated suites use no live Claude process or model turn; the separate host probes
and their limits are described above.

Source observation is polling-based and therefore has explicit freshness/gap limits.
The current adapters do not expose arbitrary external services; another data source
must define its authority and observation contract at its existing owner. Live provider
cache/quota behavior and all-platform Electron packaging remain outside verification.
Documentation checks have pre-existing missing-reference and size failures; these
checks neither establish RFC conformance nor approve this proposed note.
