# Message author identity

Status: draft
Translation: current

[中文](message-author-identity.zh.md)

## Scenario

When Agent A delegates a prompt to Agent B through Lody MCP, B's conversation
shows A as its sender. If A uses a Role, its emoji and name take precedence over
the Agent name. B's reply identifies B, and a subsequent B-to-C message identifies
B, while the original human remains the authorization principal throughout.

## Contract

- Conversation `role` describes input/output/system semantics. `userId` retains
  human authorization/attribution; optional versioned `author` describes the
  message producer. An Agent-authored prompt is still a user-role input to B.
- The source author freezes Session/Turn, Agent Config, name, icon/brand identity,
  optional Role id/revision/name/emoji, and an allowlisted model/run summary.
  Actual runtime model information is distinguished from configured selections.
  Never store launch environments, prompts, credentials, arbitrary option maps,
  or avatar image bytes in author metadata.
- MCP obtains authors from the exact active invocation and its corresponding
  assistant snapshot; legacy active runs may use their frozen input config and
  local metadata. Tool arguments cannot choose an author. Human permissions,
  machine access, chain-depth limits and recipient configuration stay unchanged.
- Operation acceptance freezes source authors and target Role presentation
  atomically. Create/chat and their batch/recovery paths propagate those values.
  Role deletion or renaming cannot change an accepted snapshot. Optional extension
  storage preserves strict legacy Operation readers; old executors may still
  produce legacy messages without author metadata.
- Composer submissions freeze the selected Role's display snapshot per turn.
  Explicit None clears Role presentation. Session creation provenance must not
  label every future turn. Unconfigured CLI/MCP follow-ups retain the target's
  selection; explicit execution overrides clear its Role marker.
- Assistant opening captures its own author once, retaining it on reopening.
  A's identity never becomes B's assistant identity. Operation completion
  envelopes retain system identity rather than impersonating a batch member.
- Role names appear even in solo workspaces. Agent inputs use Agent/Role avatars;
  assistant bodies remain full-width without an author identity entry or popover. Input author detail popovers
  expose source model settings and an existing source-conversation navigator,
  never a human contact card. Rendering performs no catalog/source-document reads.
- Human editing/resending creates a new human-authored input. Stored copy/fork and
  structured history export retain author metadata. Legacy history remains readable
  without eager backfill or rewriting. Missing historical identity is not guessed
  from titles, parent relationships or the current Role catalog.

## Performance and compatibility

Metadata is bounded and written once at submission, execution opening or Operation
acceptance. Streaming text updates do not resolve or rewrite identity. Catalog
lookups use local state and run outside token processing; no new product-cloud
request is introduced. Storage grows with authored turns, not token chunks. Device
frame-time and large-history memory performance have not been benchmarked.

## Evidence

- [Shared author contract](../packages/shared/src/message-author.ts)
- [MCP capture](../apps/cli/src/mcp/lody-mcp-server.ts)
- [Operation extension storage](../apps/cli/src/orchestration/operation-store.ts)
- [Runtime capture](../apps/cli/src/session/message-author.ts)
- [Presentation](../packages/components/src/components/ai-gui/message-author-identity.tsx)

When a Role exists, use the shared getAgentRoleEmoji contract, including its catalog default when no custom emoji is set. Only authors without a Role fall back to the source provider logo. If provider metadata is unavailable, use the Agent name initial; do not guess a provider.
