# Shared source contracts

- New quote spans require `messageQuotes` v1 on the target machine. Execution
  includes the full snapshot as ordinary ACP text, independently of Agent identity.

- The package barrel (`index.ts`) only re-exports and declares types. Put runtime code in a
  module it re-exports, as `loro-streams-routing.ts` does: a bundle that imports a binding the
  barrel defines reaches every module the barrel re-exports, and each daemon process then
  evaluates their Zod schemas ([decision](../../../.agents/notes/implemented/architecture/2026-11-21-daemon-memory-footprint.md)).

Parent contracts apply. Before changing MCP catalog serialization, also read
[the authorization decision](../../../.agents/notes/implemented/architecture/2026-10-26-mcp-oauth-local-credentials.md).

- MCP definitions retain workspace synchronization; authentication values never enter
  shared rows. All writers call `assertPublicMcpServer`; literal token/header/env values
  go through local authentication RPC. Exact `${VAR}` references may remain shared.
- `authentication: 'local'` describes a service requirement, never a shared login state
  or machine binding. Read normalization strips legacy secrets without importing them
  into another user's vault or claiming to erase CRDT history.
- Keep local authentication DTOs separate from workspace catalog DTOs. Never add a
  workspace/remote RPC fallback for authentication configuration or tokens.

- MCP settings consumers save definitions before authorization and use only supported
  local-daemon authentication RPC. Private values never enter catalog writes; only an
  explicit authorization action opens the browser. Cancel owned attempts on editor
  disposal, fence late replies, and omit the scope helper line.

## Encrypted feature RPC

- `e2ee-rpc.ts` `E2EE_RPC_POLICIES` is the one exhaustive table of admitted methods: its
  lane (read, or write with an execution claim) and its scope decide who may sign and
  which authority the receiving machine applies. Signer preparation, reply verification
  and the receiver all derive from it; a new Machine RPC method must be classified there
  or named local-only. `machine` work stays the machine owner's own membership.
  `session` and `project` work may come from a shared member, is authorized against what
  it names and runs as the verified signer, passed beside the signed request, never a
  requested user. `session-read` methods also accept a current, revocable Session read
  grant ([session access](../../../specs/session-access.md)), rechecked per reply frame;
  an unknown Session is a denial. Guests never sign writes or project reads.
- `remoteControl` methods need the target's `e2eeRemoteControl` capability: the shared
  adapter refuses before signing, because an older machine drops the frame unread. A
  steer refused that way returns `unsupported`, a proven non-delivery that becomes a
  follow-up. CLI senders of an encrypted workspace use only its signed channel and never
  the plaintext Machine RPC token.

Encrypted Roost owners advertise `e2eeRoostHistory: 1`. Use signed feature requests for
`session/history-read` and `session/history-write`. Writes admit `accept_input` and
`accept_input_and_dispatch` with `{sessionId, operation, payload: {entry}}`; the user
entry carries its signed `e2eeIntent`. Read grants cannot authorize either write.

## Code Collab

- `codeCollabDiffBlobs` v1 gates the additive manifest/blob methods and opaque
  `[path, 'v']` generation siblings. Legacy file rows stay strict and unchanged;
  content hashes travel only through owner-scoped RPC, never the shared index.
- Encrypted manifest/blob calls are `session-read` methods without execution claims or
  write-operation logs, so a Guest with a current read grant may view them; every
  write-lane Code Collab method stays refused for Guests. Manifest file-read failures, including path
  containment refusals, are per-file; request authorization and validation still reject
  the request.
- File-index generation siblings count toward whole-state row/byte limits and
  every publication batch budget. Reserve their space before selecting file paths.
  [Rationale](../../../.agents/notes/implemented/architecture/2026-10-31-remote-diff-transport.md).

## Workspace MCP / Roles

- Catalog/defaults: workspace Flock; selections: turns. Missing project rows inherit
  workspace defaults; `[]` disables all. Resolve defaults only at authoring; no machine
  bindings. Preserve `mcpServerIds: []`; send the driving turn's selection to ACP,
  never reread history.
- MCP/Role catalog writes resolve on local Flock durability, followed by explicit
  upload. Settings neither await nor report upload; its failure never fails or rolls
  back a durable write. CLI reports its sync result. See
  [catalog explanation](../../../.agents/docs/workspace-catalog-durability.md).
- Roles use one workspace Flock `agentRole` family; sharing changes `visibility`.
  No secrets, API keys, MCP selections or memory contents. Apply
  `isSensitiveAgentRoleConfigOptionKey` on read/write. Permission pins use
  `runConfig.modeId` or `_permission`: hide the composer permission button,
  keep warning-tone markings. No Role-level auto-approval policy.
  Settings/mentions use `canReadAgentRole`/`canManageAgentRole`; explicit MCP
  lookup needs no mention grant.
- Each Role target binds `machineId + agentConfigId`; never guess or fall back. One
  target is a v1 row, more are v2 ([Spec](../../../specs/agent-role-machine-targets.md)).
  Unavailable targets stay listed, unmentionable; a retired model or mode pin counts
  only when an exact runtime probe lists alternatives. Freeze prompt/target/revision/config
  at acceptance; retries ignore edits. Session Role metadata: provenance only.
  `resolveSessionExecutionInputBlocks` owns text; raw blocks supply attachments.
- Memory stores provider/id references, frozen per turn; daemon/env rules:
  [memory contract](../../../specs/agent-role-memory.md).
- Keep `author`, human `userId`, and recipient execution config separate.
  [Contract](../../../specs/message-author-identity.md).

## Message schemas (message-schemas.ts)

- Wire schemas are strict: unknown fields fail validation, never pass through.
  `.brand()` marks branded id types; transport-local DTOs stay separate from
  durable history shapes.
- ACP extension dictionaries retain declared `_meta`/extension keys; closed
  execution configuration still selects declared fields.

## ACP history application (acp/history-apply.ts)

- Apply tool updates as sparse per-toolCallId patches; present content/locations
  lists replace the previous list. ACP content lists are replacements, never
  appends; dedupe replayed notifications.
- Terminal output arrives both in notification streams and tool results: keep
  one canonical combined output block, merge snapshot-style updates by overlap,
  never concatenate. In-place replacement avoids delete+reinsert CRDT churn.
- Plan/tool status only advances monotonically; `null` means "no information",
  never a cleared value. Keep `recordedAtMs` from the first persisted sighting.
- Parse `<thinking>`/`<proposed_plan>` only when a tag occupies its own line;
  inline mentions stay text. The content match must not pair a first opening
  tag with a later closing tag.
- rawOutput shapes are per-provider payload quirks (Codex aggregated output,
  Claude Code string output for search tools, Pi truncated flag); treat shape
  detection as best-effort and prefer explicit fields over guesses.
