# Loro Streams UserSpace and `{workspaceId}:` Stream Prefix Contract

Every workspace-owned Loro Streams resource must map deterministically to a single
`UserSpace` (`space_id = workspaceId`). Loro Streams uses `space_id` as the unit of
storage accounting, workspace lifecycle and deletion fencing, and per-seat rate and
egress guardrails. See [shared contracts](../../packages/shared/AGENTS.md) for the
binding workspace rule.

## Mandatory `{workspaceId}:{localStreamId}` prefix contract

Loro Streams splits each stream path segment on the **first `:`** into
`(space_id, local_stream_id)`:

- **Total length**: UTF-8 encoded `streamId` must be `<= 512` bytes (validated by
  `isValidLoroStreamsResourceId` in
  [`loro-streams-routing.ts`](../../packages/shared/src/loro-streams-routing.ts)).
- **`space_id` syntax**: must match `^[A-Za-z0-9_-]{1,128}$` — no `:`, `/`,
  whitespace, NUL, `..`, or leading `_`.
- **Discriminator placement**: every workspace-owned stream must place
  `{workspaceId}:` first and place any feature, document, or subsystem discriminator
  **after** `{workspaceId}:`.

| Workspace resource | Canonical stream ID | Owner helper |
| --- | --- | --- |
| Workspace metadata | `{workspaceId}:meta` | `getLoroMetaStreamId` in [`loro-streams-routing.ts`](../../packages/shared/src/loro-streams-routing.ts) |
| Session history and state | `{workspaceId}:s:{sessionId}` | `getLoroSessionStreamId` in [`loro-streams-routing.ts`](../../packages/shared/src/loro-streams-routing.ts) |
| Code Collab Flock indexes | `{workspaceId}:fi:{owner}`, `{workspaceId}:fis:{owner}` | `getCodeCollabFileIndexFlockDocId` / `SignalFlockDocId` |
| Prompt Shortcuts | `{workspaceId}:shortcut-index`, `{workspaceId}:shortcut:{bodyDocId}` | [`prompt-shortcuts/access.ts`](../../packages/shared/src/prompt-shortcuts/access.ts) |
| Encrypted content and control ledgers | `{workspaceId}:...`, `{workspaceId}:ledger:{genesisHash}` | Workspace E2EE stream builders |

## Forbidden anti-pattern

Never place a feature tag before `{workspaceId}` (for example,
`ledger:{workspaceId}:...` or legacy `shortcut-body:{docId}` /
`shortcut-index:{workspaceId}:...`).

Because Loro Streams splits on the first `:`, a leading feature tag causes it to treat
`"ledger"` or `"shortcut-body"` as one global `space_id` shared across all workspaces.
That collapses separate workspaces into a single `UserSpace`, breaking per-workspace
rate and egress isolation, storage attribution, and workspace-scoped deletion fencing.

## Cross-bucket workspace sharing and token scope

When a deployment separates workspace streams across multiple buckets under the same
tenant organization (`tid` / `oid`), Loro Streams unifies guardrails by
`(tenant, workspaceId)` rather than per bucket alone. Per-space rate and egress limits
scale from the JWT `scope.space_paid_seats` claim.

Using a consistent `{workspaceId}:` prefix across every bucket guarantees that
metadata, sessions, Flock indexes, Prompt Shortcuts, encrypted content, and control
ledgers all resolve to the same `UserSpace` and share one quota, accounting, and
deletion boundary.
