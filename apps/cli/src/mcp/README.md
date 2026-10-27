# MCP transport and orchestration background

## Local authorization

Workspace MCP definitions remain shared. Authentication values are local to the
executing machine and account: `authentication/service.ts` owns OAuth attempts, refresh
serialization, and session relay scopes; `authentication/io.ts` adapts the MCP SDK, browser
callback and HTTP streams. The deprecated Promise facade connects the existing
SessionManager and local Machine RPC to this native Effect service. Shutdown stops
sessions before closing the service.

The system credential store uses `@napi-rs/keyring` (Keychain, Credential Manager,
or Linux Secret Service), with no plaintext fallback. Discovery checks an actual
Bearer challenge and validates protected-resource and issuer metadata before
reporting OAuth support. Authorization opens only after a user action, uses PKCE,
and discards state/code/verifier on completion, cancellation or ten-minute expiry.
Provider consent and secure-store availability remain provider/host dependent.

Selected HTTP servers receive per-runtime loopback connections. Agents get a local
capability rather than upstream credentials; Linux also verifies socket ownership.
Unlike the built-in Lody MCP host, this relay preserves upstream GET/SSE streaming.
It forwards only MCP protocol headers, rejects redirects, bounds requests/queues,
and sanitizes failures. Session retirement and sign-out close these connections.
Stdio credentials go only to the selected local process environment. A requester
change retires an MCP-bearing Session before another user can reuse its processes.

Manual token/header/env values are split before shared writes. Exact `${VAR}`
references may remain shared and resolve only from the executing owner's environment.
Legacy shared values are stripped on read, without silent credential import or a
claim to erase old CRDT history. Existing shared credentials require explicit
reconfiguration. Sign-out forgets the local authorization; provider-side consent
revocation is not implemented. The [decision and validation limits](../../../../.agents/notes/implemented/architecture/2026-10-26-mcp-oauth-local-credentials.md)
record synthetic coverage and unverified host/provider behavior.

Binding rules remain in [AGENTS.md](AGENTS.md). This document explains interoperability
and lifecycle decisions behind them; it does not introduce additional requirements.

## Stdio lifetime

`commands/internal.ts` executes `serveStdioMcp` with the SDK/Node adapter in
`stdio/lifecycle.ts`. Its scoped connection waits for stdin EOF/close, SDK transport
close, SIGINT or SIGTERM. Input/output errors fail the command; malformed protocol
messages retain the SDK's existing error behavior. Subscriptions are installed before
connection, and partial startup is cleaned up before returning. Only after the command
finishes may `index.ts` close the shared shell-cache/Presence application runtime.

SDK 2.0.0 stdio `close()` synchronously detaches stream listeners and cancels SDK
requests, without asynchronous I/O. Tool handler Promises still belong to their
existing owners: SDK cancellation does not establish raw-work completion. This
migration covers the stdio host, not HTTP, daemon or tool orchestration.
See the [decision and verification](../../../../.agents/notes/implemented/bug-fix/2026-10-14-mcp-stdio-lifetime.md).

## HTTP and loopback

- The MCP HTTP host answers a strict HTTP client (Grok's Rust `rmcp`), which reports a
  never-completing response as a transport failure, not an MCP error. Every request must
  reach a terminated response: `GET /mcp` is answered with 405 rather than handed to the
  SDK, which in stateless JSON mode opens an SSE stream it can never write to or close.
- Agent child processes reach the host over loopback, so a proxy must never intercept it.
  `@lody/shared/proxy-env` `withLoopbackNoProxy` is applied last when assembling agent env
  (`session.ts` `buildShellEnv`, `acp-runner.ts`) and writes BOTH `NO_PROXY` and
  `no_proxy`: clients disagree about a present-but-empty value, and Rust `reqwest` reads
  the uppercase spelling first and treats an empty one as "bypass nothing".

## Operation identity

- Session orchestration derives its human identity from the active execution runtime populated
  by the dispatch payload, not from the daemon credential, Session owner, or observed history.
  An absent active runtime fails closed; never reconstruct invocation identity from history.
  Freeze the source Turn id and invoking user with every accepted Operation. Store the user
  once as `requesterUserId` and the causal Turn as `sourceTurnId`. The
  Operation's requester Session id already identifies the source Session, and a single-value
  actor tag adds no information. Recovery uses the Operation's owner Machine plus current
  authorization; it does not freeze the daemon account that originally accepted the Operation.
  Every MCP Session path rejects a runtime invocation without userId.

## Machine presence

- Machine liveness is THREE-state. `getOnlineMachineIds()` returning null means the presence room
  could not be joined — status UNKNOWN, never offline. Block a dispatch or report `MACHINE_OFFLINE`
  only for a definite `offline`; an unknown Machine proceeds and fails against its own deadline,
  and a surface reporting liveness carries the state, not a boolean. Collapsing unknown to offline
  refused healthy Machines and silently emptied candidate lists during a cold start or reconnect
  backoff. Contract: `specs/loro-ephemeral-presence-channel.md`.

## Session placement guidance

Single and batch create descriptions tell agents to explicitly set
`useCurrentSessionAsParent=false` for sidebar sub-conversations; batch calls can
set it in `defaults`. Use `true` only for an explicitly requested Tab within the
current conversation. This is caller guidance: runtime defaults remain unchanged,
including same-machine Local Project Role creation choosing a Tab when the field
and `workContext` are omitted. An independent conversation can use `workContext`
to select its project. See [session relations](../../../../specs/session-relations.md).

## Operation acceptance

- MCP session tools use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat Commands require a caller-chosen Operation id, and Create persists the Operation
  before its fallible availability step: a transient post-accept failure returns the active fixed
  target for daemon replay, and `session_create({ operationId, resume: true })` recovers it without
  the prompt. Completion is delivered automatically — no public wait tool — and legacy `wait=true`
  is a temporary adapter new callers must not use.
- Single create can outlast a client's tool timeout, and Agents then tend to retry under a fresh
  id. While the original is active, an identical create from the same source Turn adopts it and
  returns its snapshot with a `notice` instead of creating a second Session
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-10-21-mcp-create-fresh-id-retry.md)).

## Machine catalog retry guidance

- A retryable Machine catalog `SYNC_UNAVAILABLE` means freshness could not be confirmed
  and the local catalog could not validate a selection. It does not prove that an id is
  valid; a typo or inaccessible catalog may remain unresolved. Permanent transport/auth
  failures and explicit validation errors retain their existing non-retryable classification.
- Without an active Operation handle, an Agent must wait at least 5 seconds between calls
  and make at most **3 total attempts** (initial call plus 2 retries) for the same request.
  Reuse the identical arguments and `operationId`; never mint ids to bypass this budget.
  After the third failure, stop and report the catalog blocker so the user can check the
  selection, access, and connectivity. This is caller guidance, not a server-enforced counter.
- Chat can fail after acceptance. Retrying with the same id recovers the existing fixed
  target rather than appending a second prompt. Once an active handle is returned, stop
  resubmitting: the daemon owns recovery and completion arrives automatically. Existing
  Operation status tools remain available for an intentional status check; do not poll in a loop.
- The Agent call budget does not shorten an accepted Operation's deadline. Daemon
  materialization retains its existing 1–30 second backoff until the Operation deadline
  (24 hours by default, configurable up to 7 days), always rechecking the fixed target
  Turn before writing.

## Role dispatch

- `session_create` and `session_create_many` resolve an explicit Agent Role id directly from
  the workspace catalog; no driving-Turn mention authorization is required. Resolve its target,
  Prompt prefix, revision, and concrete run config before Operation acceptance. Recovery uses
  the frozen canonical Prompt and target dispatch config and never rereads the mutable catalog.
  A Role may target any reachable Machine, whatever the requester's context; a Local Project
  requester defaults to a child only for a same-Machine Role. `readDelegatedMachineAccess`
  requires both the executing Machine owner and the driving human to be able to use the target
  (owned, or shared plus shared project); never decide it from synced `MachineMeta.ownerUserId`
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-28-mcp-cross-machine-agent-role.md)).

## Chat configuration

- Chat follow-ups inherit omitted mode/model/options from the target's last model turn
  (else its last matching turn). Explicit fields and category options
  win; a model change drops old options. Validate effort/Fast against the final model:
  probe mismatch cannot reject them, and missing per-model data defers to runtime. Drop
  incompatible inherited selectors; fill builtin mode only when still empty.
  ([note](../../../../.agents/notes/implemented/bug-fix/2026-09-17-chat-follow-up-inherits-target-run-config.md))

MCP create/chat (including batches) accept optional `mcpServerIds`. Explicit `[]`
selects none. Creation without ids resolves target-project defaults, or workspace
defaults when the project has no preference; continuation without ids inherits the
target conversation's selection. Acceptance records ids in the existing per-target
Operation configuration, so materialization/recovery does not reread edited defaults.
Batch item values override batch defaults, including an explicit empty selection;
omitted values preserve the existing target-default behavior.
Role pins do not override an explicit MCP selection. CLI create/chat expose the same
choice as `--mcp-server-ids '<JSON array>'`. See the
[project default Spec](../../../../specs/project-default-mcp.md).

## Daemon routing

- Session/catalog tools route through `session/call-tool` to the daemon's
  existing repo in both compositions. `session-tool-router.ts` reuses SDK-parsed
  MCP arguments and parses daemon inputs; `session-command-environment.ts` lends
  the daemon replica (`runWithDaemonWorkspace`) and, on the local platform, also
  scopes identity and host operations with AsyncLocalStorage. Require exact
  workspace/machine scope and an active invoking Turn (the local user's on the
  local platform); never open a second replica. Cloud keeps its authenticated command behavior and
  remote recovery confirmation; only the replica changes. Schedule tools use the
  daemon's schedule control, and cancel/archive run in-process rather than through
  a child `lody` CLI. Calls keep a ten-minute IPC bound; legacy `wait: true` adds
  its maximum wait. See
  the [decision](../../../../.agents/notes/implemented/architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.md).

## Bounded collaboration

If A sends an Agent-authored input to B, B cannot issue a new `session_chat` back to
A while that exact input drives its active turn. This is a per-turn sender restriction,
not a parent/child relationship or a permanent restriction between conversations.
Single and legacy chats return non-retryable `REVERSE_CHAT_FORBIDDEN` before accepting
work. Mixed batches retain unrelated items; a batch containing only reverse targets
is rejected without creating an Operation. Matching accepted retries retain their
existing identity and do not append another prompt.

The runtime selects the exact source input id; its history author supplies only the
sender provenance, never human authorization. Missing input history blocks a new chat;
legacy inputs without Agent sender metadata cannot be classified by this guard. A new
human-authored turn does not inherit an earlier input's restriction. This small fix does
not change completion scheduling or add a note tool or ancestor graph.

The shared causal chain limit is 16 hops, including delegated target turns and
completion continuations. A turn at the cap cannot start another Operation;
the existing guard returns non-retryable `CHAIN_DEPTH_EXCEEDED` before acceptance.
This is a depth limit, not a shared total-message or fan-out budget.

MCP initialization instructions and all four create/chat tool descriptions tell
agents to send only task-advancing messages, omit acknowledgments and courtesy
replies, and use automatic completion delivery instead of manually sending the
same result back. At the cap, report remaining work to the user without retrying
or creating another session to evade the limit. These prompts guide behavior;
the runtime guard enforces the depth bound.

Completed work is persisted and batched at normal release or fresh human input; result
arrival alone never wakes idle or paused sessions. `lody_operation_batch_get` reads
a fixed, Session/user-bound batch without new work. Pages are bounded to 128 KiB; large
individual members return ordered `member-json` fragments. This reader does not grant
submission permission. Human recovery provenance comes from fixed UI/CLI producers,
never model tool fields, role or userId.

## Agent Role proposals

`lody_agent_role_create` and `lody_agent_role_update` publish a durable review card
in the invoking conversation; neither writes the Role catalog. Both use the active
Turn's human identity and the daemon Session tool route in both compositions. Save is a renderer
catalog write by that user. Updating requires Role ownership and patches only name,
description and promptPrefix against the latest row. There is no revision precondition:
concurrent replicas use the existing Flock merge behavior. Deleted Roles are not recreated.
New Roles are private, bind explicit machineId + agentConfigId, and use Agent defaults.

Reuse requestId for retries. The same request returns the stored pending/saved/dismissed
outcome; changed input under that id fails. The generated Role id lives in the card, so
retrying a create confirmation does not create another Role. An upload failure does not
roll back a locally durable save. Accepted Operations retain their frozen configurations.

CLI uses the same tools and confirmation flow. It needs an active conversation via
`--session` or `LODY_SESSION_ID`; `--workspace` selects the workspace when ambiguous.

All writable fields can be passed directly:

```sh
lody agent-role create --name "Reviewer" --description "Review code" \
  --prompt-prefix "Find actionable bugs" --machine-id MACHINE_ID --agent-config-id CONFIG_ID
lody agent-role update ROLE_ID --name "Reviewer" --description "" \
  --prompt-prefix "Focus on correctness"
```

Creation requires `--name`, `--machine-id`, and `--agent-config-id`; description and
prompt prefix are optional. Updates accept `--name`, `--description`, and
`--prompt-prefix`, and require at least one field. Omitted fields stay unchanged;
`--description ""` and `--prompt-prefix ""` clear the corresponding text.
For multiline instructions, the shell can supply `--prompt-prefix "$(cat reviewer.md)"`.

JSON file input remains available, but cannot be combined with direct Role field
options. Session, workspace, request-id, and output options work with either mode.

```sh
lody agent-role create --file role.json --request-id reviewer-create
lody agent-role update ROLE_ID --file patch.json --request-id reviewer-update
```

A create file contains `name`, `machineId`, `agentConfigId`, and optional `description`
and `promptPrefix`. An update file contains only the changed `name`, `description`,
or `promptPrefix`; an empty string clears description/instructions. Neither accepts
credentials, MCP selections, ownership, visibility, or run configuration. The command
prints the requestId and pending result; it does not claim the Role was saved.


`role.json`:

```json
{
  "name": "Reviewer",
  "machineId": "MACHINE_ID",
  "agentConfigId": "CONFIG_ID",
  "description": "Review code",
  "promptPrefix": "Check correctness.\nReport actionable bugs."
}
```

`patch.json`:

```json
{
  "description": "",
  "promptPrefix": "Focus on correctness.\nExplain each finding."
}
```

Files must contain a single UTF-8 JSON object, using the camelCase keys shown above.
The update file is the patch itself: do not wrap it in `patch`; pass the Role ID as the
command argument. Pass retry IDs with `--request-id`. JSON strings use `\n` for line
breaks; comments and trailing commas are not valid JSON.

All field values are strings. Creation requires `name`, `machineId`, and `agentConfigId`.
Updates require at least one supported field. Omitted update fields stay unchanged;
`""` clears description or instructions, while `null` is rejected. Names must be nonempty,
mention-compatible and at most 60 characters after trimming; descriptions allow up to
140 Unicode code points; instructions allow up to 32,768 characters before trimming.
Machine/config IDs must be nonempty and at most 128 characters after trimming.
Unsupported fields are rejected.
