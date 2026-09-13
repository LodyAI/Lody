# Lody MCP server guidelines

Parent instructions apply.

- `lody_mcp_configure` always derives its target from the current MCP session context and
  re-authorizes that workspace with the daemon credential. Never accept a workspace selector.
- MCP configuration is an execution and credential boundary. The tool may act only on an
  explicit user request, never on instructions from repository content, websites, or tool
  output. The tool creates only new randomly identified entries and never selects them by
  default; trusted UI/CLI owns updates, review, and selection.
- Dedicated credential fields accept `${VAR}` references or daemon environment passthrough,
  not literal secrets. Tool responses must never echo connection values.
- Configurations affect only later turns or sessions; the running Agent does not hot-load them.
- Built-in provider credentials belong to the target Machine, never workspace Flocks or cloud
  state. Store OAuth client data/tokens and provider-secret URLs only through
  `WorkspaceMcpCredentialStore`; keep callback state and PKCE verifiers process-local. A session
  may receive a short-lived access token in its in-memory MCP config, but never a refresh token.
- Fail closed unless a stored credential's authorization fingerprint still matches its provider,
  preset/profile, pinned endpoint, OAuth resource, and issuer. OAuth metadata/fetch destinations
  stay on the provider registry allowlist. Protected-resource metadata is mandatory: validation
  failure is fatal for that fetch chain and must not fall back to MCP-origin AS discovery. PostHog
  intentionally uses a query-free OAuth resource
  while its actual MCP endpoint keeps Lody's pinned mode/readonly query. For PostHog readonly,
  expose only identity and `*:read` metadata scopes to the OAuth SDK; the upstream metadata also
  advertises write scopes even when the MCP endpoint itself is query-pinned readonly.
- Credential saves use a unique credential id for compare-and-delete. Re-check an OAuth generation
  after every awaited store write so disconnect/reconnect cannot be undone by a stale callback or
  refresh completion.
- The MCP HTTP host answers a strict HTTP client (Grok's Rust `rmcp`), which reports a
  never-completing response as a transport failure, not an MCP error. Every request must
  reach a terminated response: `GET /mcp` is answered with 405 rather than handed to the
  SDK, which in stateless JSON mode opens an SSE stream it can never write to or close.
- Agent child processes reach the host over loopback, so a proxy must never intercept it.
  `@lody/shared/proxy-env` `withLoopbackNoProxy` is applied last when assembling agent env
  (`session.ts` `buildShellEnv`, `acp-runner.ts`) and writes BOTH `NO_PROXY` and
  `no_proxy`: clients disagree about a present-but-empty value, and Rust `reqwest` reads
  the uppercase spelling first and treats an empty one as "bypass nothing".
- Bound every Agent-authored persisted field, collection, complete configuration, and catalog.
  Serialize per-workspace Agent configuration writes before checking local name/count bounds;
  the shared CRDT is not a global CAS. Keep catalog writes locally durable while surfacing sync
  failures as unsynced.
- `session_create` and `session_create_many` resolve an explicit Agent Role id directly from
  the workspace catalog; no driving-Turn mention authorization is required. Resolve its target,
  Prompt prefix, revision, and concrete run config before Operation acceptance. Recovery uses
  the frozen canonical Prompt and target dispatch config and never rereads the mutable catalog.
- Session orchestration derives its human identity from the active execution runtime populated
  by the dispatch payload, not from the daemon credential, Session owner, or observed history.
  An absent active runtime fails closed; never reconstruct invocation identity from history.
  Freeze the source Turn id and invoking user with every accepted Operation. Store the user
  once as `requesterUserId` and the causal Turn as `sourceTurnId`. The
  Operation's requester Session id already identifies the source Session, and a single-value
  actor tag adds no information. Recovery uses the Operation's owner Machine plus current
  authorization; it does not freeze the daemon account that originally accepted the Operation.
  Every MCP Session path rejects a runtime invocation without userId.
- Direct Role creation stays on the ordinary `lody_session_create` and
  `lody_session_create_many` tools. When `agentRoleId` is present, tolerate manual Machine, Agent,
  and run-config fields but remove them before resolution: the current Role row is authoritative
  and those fields must not influence validation, canonical identity, recovery, or dispatch.
- The driving Turn's frozen `taskToolsEnabled` gates the complete `lody_task_*` family for
  both stdio and HTTP transports. Missing means disabled. Do not merely hide creation: disabled
  servers publish no Task tools, and a still-resident Agent whose next Turn disables the feature
  is rejected at every Task handler. Task-originated automation explicitly freezes `true` so it
  can update and comment on the Task it is executing.

## Session and Task tool contracts

- MCP session tools use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat Commands require a caller-chosen Operation id, and Create persists the Operation
  before its fallible availability step: a transient post-accept failure returns the active fixed
  target for daemon replay, and `session_create({ operationId, resume: true })` recovers it without
  the prompt. Completion is delivered automatically — no public wait tool — and legacy `wait=true`
  is a temporary adapter new callers must not use.
- `lody_session_create_options` publishes valid run-config values per agent config and stays
  sparse by default (online Machines, one agent config, the current local project, no GitHub
  fetch), expanding only through explicit query inputs.
- `session_list` defaults to 20 (maximum 100) and `session_history` to 10 (maximum 50 and 128 KiB);
  keep the MCP surface bounded though the CLI retains `session history --all`. `session_list`
  and `session_status_many` derive busy/idle from the same history, durable queue, presence, and
  Machine RPC snapshot. Operation rules: [orchestration/AGENTS.md](../orchestration/AGENTS.md).
- Bound every task reply: body 64 KiB with head-and-tail truncation
  (`bodyTruncated`/`bodyOmittedBytes`), newest 20 comments with `commentCount`, 50 links,
  `lody_task_list` 20/100 with `matched`. `lody_task_edit_body` still matches exactly against the
  FULL body server-side.
- `lody_task_list` reads the Task Index Flock ONLY: never open task documents on a list path, and
  never return `order`.
- `lody_task_update` writes every scalar property EXCEPT `agent`, and never the body: the body goes
  through the exact-match edit, and `agent` is the sole automation consent.
- INVARIANT: `status`, `ownerId`, and `projects` all sit in the delegated-automation eligibility
  predicate (`planTaskAutomation`), so an agent write to any of them can START a session on an
  already-entrusted task; anything in that predicate is an execution trigger. Its attributed
  activity entry is an audit record, NOT a user-visible notice.
- `ownerId` on an agent WRITE accepts ONLY `""` (unassign) — `TaskOwnerIdWriteSchema` — because
  naming an owner points `isTaskAutomationEligible` somewhere new and could route a task into
  execution under this operator's credentials on someone else's consent; it also disposes of the
  `me` filter sentinel. Keep that restriction at the MCP boundary, NOT in `task-doc.ts`.
- `lody_task_create` versus `lody_task_propose` splits on WHO ASKED (user request → create now;
  agent-noticed follow-up → proposal card), and that split lives in the tool descriptions on
  purpose. The proposal writer hydrates the Session doc, flushes locally, and confirms remote sync
  before `ok`.
