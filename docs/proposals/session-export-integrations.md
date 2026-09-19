# Session Export and External Integrations

Status: non-normative proposal

This document records design goals for discussion. It is not a public API
specification and makes no backward-compatibility promise before a versioned
v1 contract is explicitly published.

## Summary

Lody sessions are useful beyond the Lody UI. A user may want to archive a
conversation, index it in a personal knowledge system, run compliance checks,
or move it into another local-first tool. Today, those integrations have to
choose between scraping provider files and polling the UI-facing MCP tools.
Neither approach gives an external consumer a durable synchronization
contract.

This proposal suggests a provider-neutral, read-only session export direction.
It does not add an integration for any specific third-party product. A later
phase may add an opt-in local delivery mechanism built on a future, versioned
event model.

## Why This Belongs in Lody

The Lody session is the canonical conversation when a user works through Lody.
The child ACP runtime is an execution provider, not the owner of the Lody
conversation. Provider transcript files cannot represent messages sent from
Lody's desktop, web, mobile, or CLI surfaces, and they cannot reliably express
Lody session relationships such as forks, parent sessions, workspaces, or
Agent Config selections.

Lody already has the important primitives:

- session metadata and stable session IDs;
- visible transcript history stored in the session document;
- workspace, machine, Agent Config, and parent-session provenance;
- bounded JSON and JSONL CLI output;
- local-first synchronization through the Loro stack.

The missing piece is a contract for consumers that need to synchronize that
canonical state without depending on private storage or provider-specific
behavior.

## Goals

- Export the user-visible transcript owned by Lody.
- Support first import, incremental sync, retry, and crash recovery.
- Preserve stable session and message identity across machines and exports.
- Make workspace and session visibility the authorization boundary.
- Preserve enough provenance to distinguish a Lody host from its child runtime.
- Keep the contract useful to backup, search, audit, and knowledge tools alike.
- Work in the local-first build without requiring a cloud account.

## Non-goals

- Embedding a knowledge-base, webhook vendor, or external service in Lody.
- Exporting hidden reasoning, credentials, provider logs, or raw tool output.
- Replacing ACP or changing how an ACP runtime is started.
- Making every child runtime transcript a second Lody conversation.
- Promising real-time delivery before a durable event log exists.
- Solving cross-workspace authorization for an external service.

## Proposed API Surface

### Phase 1: pull-based export (direction only)

Add a machine-readable command alongside the existing session commands:

```text
lody session export <session-id> --jsonl
lody session export <session-id> --jsonl --cursor <cursor>
```

The exact command name and response shape are open for maintainer feedback.
The important design goals are that a future v1 output should be stable,
bounded, and designed for replay.
The existing human-facing `session history` command remains unchanged.

An illustrative, non-normative export page might have this shape:

```json
{
  "version": 1,
  "workspaceId": "workspace-id",
  "session": {
    "id": "session-id",
    "parentSessionId": "parent-id",
    "machineId": "machine-id",
    "agentConfigId": "agent-config-id",
    "createdAt": "2026-08-27T00:00:00Z",
    "updatedAt": "2026-08-27T00:05:00Z"
  },
  "items": [
    {
      "eventId": "session-id:message-id",
      "sequence": 12,
      "kind": "message",
      "messageId": "message-id",
      "role": "user",
      "text": "A visible user message",
      "timestamp": "2026-08-27T00:05:00Z"
    }
  ],
  "nextCursor": "opaque-cursor",
  "watermark": 12,
  "hasMore": false
}
```

The wire format is illustrative. Field names should reuse the existing public
DTO vocabulary rather than introducing a second model. In particular,
`SessionHistoryInput` and `SessionMeta` should remain the source of truth for
the transcript and session metadata.

Durable goals for a future v1 contract:

1. `eventId` is stable for the same logical item and unique within the
   session. Consumers must be able to retry a page without creating a second
   item.
2. `sequence` is monotonic within one session export stream. It is a cursor,
   not a timestamp and not a global ordering claim.
3. A cursor is opaque. Consumers must not parse or manufacture one.
4. A bounded response must never silently drop older items.
5. A future export contract should define how a consumer resumes across
   concurrent local-first writes.
6. Deletion, archive, fork, and restore should be represented as lifecycle
   records or durable metadata, not inferred from missing messages.

The event schema, cursor encoding, sequence semantics, concurrent-write
ordering, and compatibility policy remain intentionally undecided until the
native Harness and Session ownership model is clearer.

### Phase 2: opt-in local delivery

Once the export model is stable and versioned, expose the same records through an explicitly
opt-in local delivery mechanism. Candidate transports are:

- a JSONL outbox under the Lody data directory;
- a `--follow` CLI stream;
- a local IPC subscription for applications running on the same machine.

The outbox is preferable to an in-process callback as the first delivery
primitive: it survives an Lody restart, gives consumers a replay boundary, and
keeps delivery failure out of the session write path. Delivery acknowledgements
must be owned by the consumer and must not make the Lody session unavailable.

The eventual event families should be provider-neutral:

```text
session.created
session.message_committed
session.turn_completed
session.forked
session.archived
session.restored
session.deleted
```

`session.message_committed` is a candidate durable boundary for transcript export.
`session.turn_completed` is useful for consumers that want to trigger work
after a turn, but it must not be the only way to obtain content.

## Visibility and Privacy

Any future export should follow the same visibility boundary as Lody's existing
user-facing session history. It includes visible user and assistant content
and excludes hidden reasoning, credentials, raw provider logs, and internal
tool payloads. Attachments should be represented by the existing session-file
metadata and an explicitly authorized download path, not embedded blindly in a
JSONL event.

An external consumer can read only sessions the current Lody principal could
read. Workspace membership is not permission to read every machine's private
local state. Local export must not bypass the existing session access policy.

## Provenance and Agent Identity

The export should carry Lody provenance without pretending that every runtime
configuration is a durable person:

- `workspaceId` identifies the workspace;
- `session.id` identifies the Lody conversation;
- `machineId` identifies the execution machine when available;
- `agentConfigId` identifies the selected Lody configuration when available;
- `parentSessionId` identifies a child relationship when applicable;
- an optional runtime/provider label describes the child ACP implementation.

Consumers may map an Agent Config to their own durable identity, but Lody must
not make that mapping for them. A generic Codex preset and a named reviewer
role are different product concepts even when they launch the same binary.

## Idempotency and Recovery

An external synchronizer should be able to implement this loop:

1. Read the last acknowledged cursor for one workspace, session, and
   destination.
2. Request the next export page.
3. Upsert items by `(sessionId, eventId)`.
4. Acknowledge the page only after the destination commits it.
5. Persist the returned cursor atomically.
6. Replay the page after a crash; the destination must observe no duplicate.

The consumer checkpoint must include the export version and destination
identity. A parser or destination change must not silently reuse an incompatible
checkpoint. If the source detects deletion, replacement, or an invalid cursor,
it should return a typed reconciliation error rather than skipping content.

## Relationship to ACP

ACP remains the runtime protocol. This proposal does not change ACP
`session/update`, `loadSession`, or runtime startup. Lody owns the exported
conversation after it has applied ACP updates to its session document.

The existing `_lody/session/history/read` extension is intentionally not reused
as the external export API. It is an internal runtime-to-Lody replay bridge and
currently returns an empty response after causing the host to replay history.
Making it an external synchronization protocol would couple consumers to ACP
runtime behavior and would make non-ACP or host-authored messages difficult to
represent.

## Implementation Sequence

1. After the ownership model is settled, reuse existing transcript and session metadata types in a small public
   export DTO module.
2. Define and version cursor, event identity, and page-boundary helpers with tests.
3. Add a read-only CLI export path and JSON/JSONL tests using synthetic data.
4. Verify local mode, workspace access checks, archive/fork behavior, and
   Windows path handling.
5. Add an outbox only after pull export has proven its identity and recovery
   semantics.
6. Document the versioned contract for external consumers without naming or requiring a
   particular integration.

## Open Questions

- Should export be session-scoped only, or should a workspace-wide export be
  added after the session primitive is stable?
- Should lifecycle records share the transcript sequence or use a separate
  event sequence?
- Should attachment downloads be part of export v1 or remain an explicit
  follow-up?
- Is a JSONL outbox acceptable for the local-first data directory, or should
  the first delivery surface be a local IPC stream?
- Should the public DTO live in `@lody/shared`, `@lody/cloud-api`, or a new
  small package with no private cloud dependencies?

## Suggested Validation

- Exporting an unchanged session twice produces identical event identities.
- Appending one visible turn returns only the new suffix after the prior
  cursor.
- A crash between consumer commit and checkpoint persistence is safe to replay.
- Forked sessions retain their independent IDs and parent relationship.
- Archive and restore do not erase transcript content.
- A user cannot export a session outside their existing workspace access.
- JSON and JSONL output are valid on POSIX and Windows.
- Hidden reasoning, tool payloads, and credentials never appear in export.
