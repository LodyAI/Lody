# MCP transport and orchestration background

Binding rules remain in [AGENTS.md](AGENTS.md). This document explains interoperability
and lifecycle decisions behind them; it does not introduce additional requirements.

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

## Operation acceptance

- MCP session tools use stable machine/session/agent-config ids and strict, narrow input schemas.
  Create/chat Commands require a caller-chosen Operation id, and Create persists the Operation
  before its fallible availability step: a transient post-accept failure returns the active fixed
  target for daemon replay, and `session_create({ operationId, resume: true })` recovers it without
  the prompt. Completion is delivered automatically — no public wait tool — and legacy `wait=true`
  is a temporary adapter new callers must not use.

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

## Local routing

- Local Session/catalog tools route through `session/call-tool` to the daemon's
  existing repo. `session-tool-router.ts` reuses SDK-parsed MCP arguments and
  parses daemon inputs; `session-command-environment.ts` scopes identity and
  host operations with AsyncLocalStorage. Require an active local user Turn and
  exact workspace/machine scope; never open a second local writer replica.
  Cloud keeps its authenticated command runtime and remote recovery confirmation.

