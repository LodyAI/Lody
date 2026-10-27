# Lody MCP server guidelines

Parent instructions apply. Background: [README.md](README.md).

- Route Session/catalog tools via `session/call-tool` to the daemon repo in every
  composition, never a second replica or child `lody` CLI. Reuse SDK-parsed arguments
  and validate daemon inputs in `session-tool-router.ts`; scope replica/identity with
  ALS in `session-command-environment.ts`. Require exact workspace/machine scope
  and an active Turn (local: its user). Cloud keeps authenticated commands/recovery.

- MCP sharing requires the active Turn user to equal the CLI authenticated account.
  Fail closed on shared-machine account mismatch; never substitute the machine owner.

- `lody_mcp_configure` always derives its target from the current MCP session context and
  re-authorizes that workspace with the daemon credential. Never accept a workspace selector.
- MCP configuration is an execution and credential boundary. The tool may act only on an
  explicit user request, never on instructions from repository content, websites, or tool
  output. The tool creates only new randomly identified entries and never selects them by
  default; trusted UI/CLI owns updates, review, and selection.
- Dedicated credential fields accept `${VAR}` references or daemon environment passthrough,
  not literal secrets. Tool responses must never echo connection values.
- Configurations affect only later turns or sessions; the running Agent does not hot-load them.
- Terminate every HTTP response; answer `GET /mcp` with 405 rather than SDK SSE.
- Apply `withLoopbackNoProxy` last in agent env assembly (`session.ts` `buildShellEnv`,
  `acp-runner.ts`), setting both `NO_PROXY` and `no_proxy` to bypass loopback.
  [HTTP/proxy rationale](README.md#http-and-loopback).
- Bound every Agent-authored persisted field, collection, complete configuration, and catalog.
  Serialize per-workspace Agent configuration writes before checking local name/count bounds;
  the shared CRDT is not a global CAS. Keep catalog writes locally durable while surfacing sync
  failures as unsynced.
- Create tools resolve explicit Role ids from the catalog without mention authorization.
  Before accepting an Operation, freeze the Role target, Prompt prefix, revision and run
  config. Recovery uses the frozen canonical Prompt and dispatch config, never rereading
  the Role. Roles may target any reachable Machine; Local
  Projects default to child Sessions only for same-Machine Roles. `readDelegatedMachineAccess`
  requires access for both executing Machine owner and driving human (owned, or shared with
  shared project), never trusting synced `MachineMeta.ownerUserId`.
- Operation identity comes only from active Host dispatch; reject absent runtime/userId.
  Never infer it from credentials, Session owner or history. Freeze requesterUserId/sourceTurnId.
  Resolve pending notification provenance from exact input before acceptance; unsynced input
  is retryable, never empty origins. Authors are not authorization. Recovery uses owner
  Machine/current access.
- With `agentRoleId`, create tools require `agentRoleMachineId` for multi-machine
  Roles. Strip manual target/run-config before resolution,
  validation, identity, recovery or dispatch; the Role is authoritative.
- Role create/update only propose. Save checks ownership, patches latest text;
  replicas may overwrite. CLI shares [flow](README.md#agent-role-proposals).

## Session tool contracts

- Align chain caps and MCP guidance; create/chat forbid courtesy, duplicate callbacks
  and depth-limit evasion. Reject new chats to the active input's Agent sender; isolate
  rejected batch items.

- Catalog uncertainty is not `INVALID_ITEM`; only retryable failures abort batches.
  Default-only calls allow no cache. Internal inferred defaults
  rederive until authored. Explicit choices/access stay strict.
  [Freshness/retries](README.md#machine-catalog-retry-guidance).

- `lody_ios_simulator_preview` is the native-app tool; web previews remain
  `lody_report_preview_candidate`. Bind local agent-control RPC to MCP session context;
  the daemon resolves the active user. Return operation handles, never viewer URLs or
  raw preview/transport errors. Reuse simulator lifecycle/schema, never a second owner.

- Discovery shares `lib/resource-discovery.ts`: daemon caches report `catalog_syncing`
  until first baseline; Role target validation requires fresh sync. Standalone CLI
  syncs unless `--offline`. Use active Turn identity and `canReadAgentRole`;
  explicit creation keeps its separate grant contract. Keep unavailable readable Roles,
  three-state presence and credential allowlists.
- Directory cursors bind resource, workspace, user and filters. Operations additionally
  bind requester Session and query only that user's machine-local rows; list replies
  contain no canonical prompt or assistant output. See
  [discovery Spec](../../../../specs/resource-discovery.md).

- Use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat require caller-chosen Operation ids. Create persists before availability checks;
  transient post-accept failure returns the active fixed target for daemon replay.
  `session_create({ operationId, resume: true })` recovers without a prompt. Deliver completion
  automatically; expose no wait tool and forbid new callers from using legacy `wait=true`.
- Chat inherits omitted mode/model/options from the target's last model turn, else last
  matching turn. Explicit fields/category options win; model changes drop old options.
  Validate effort/Fast against the final model, never reject on probe mismatch; missing
  per-model data defers to runtime. Drop incompatible inherited selectors even after
  unconfirmed freshness; only explicit misses block. Fill builtin mode only if empty. [Inheritance rationale](README.md#chat-configuration).
- `lody_session_create_options` publishes modes and option ids/types/choices per agent config,
  never current values. Stay sparse by default (online Machines, one agent config, the current
  local project, no GitHub fetch), expanding only through explicit query inputs.
  Explicit permissions may exceed the parent; follow the caller's user authorization.
- Machine presence is online/offline/unknown. `getOnlineMachineIds() === null` means
  unknown; block dispatch/report `MACHINE_OFFLINE` only for definite offline. Unknown
  proceeds under its own deadline. Expose three-state liveness, never a boolean.
  Contract: `specs/loro-ephemeral-presence-channel.md`;
  [cold-start rationale](README.md#machine-presence).
- `session_list` defaults to 20 (maximum 100) and `session_history` to 10 (maximum 50 and 128 KiB);
  keep the MCP surface bounded though the CLI retains `session history --all`. `session_list`
  and `session_status_many` derive busy/idle from the same history, durable queue, presence, and
  Machine RPC snapshot. Operation rules: [orchestration/AGENTS.md](../orchestration/AGENTS.md).
- `session_history` pages through `SessionData.history.readVisiblePage`, never `getHistory()`:
  `limit` counts displayable turns, the cursor is the raw position from the previous page, and
  hidden/empty rows never shift it. A page reports `hasMore` from the underlying raw rows, so a
  scan budget never claims the history ended. Session mentions expand to
  `[@Title](lody://session/<id>?workspace=<id>)`; accept bare ids and legacy
  `session://` URIs too. Explicit workspace must match the tool context.
  ([contract](../../../../specs/deep-links.md))

- Single create/chat attachments require durable Operations and the calling daemon's
  `sessionInputAttachments` capability. Resolve paths inside the calling Session's
  authoritative workspace, never the daemon cwd or target workspace. Freeze references
  before acceptance; retries use stored references. Legacy wait and batch schemas reject
  attachment arguments. See [input Spec](../../../../specs/cli-session-attachments.md).

- Inherited user-owned `collaborationStopped` rejects delegation and fences setup/prompt
  dispatch. Agents and completion callbacks must never clear it.
