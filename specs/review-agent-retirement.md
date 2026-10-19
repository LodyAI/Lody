# Review agent retirement

Status: draft
Translation: current

[中文](review-agent-retirement.zh.md)

A user opening experimental settings, Provider settings, or a session menu no
longer sees Review agent, Review this branch, or Auto review and merge.
This removes the experiment rather than making review automation generally available.
Roost history keeps its existing experimental opt-in.

The daemon no longer starts, resumes, or advances review automation, including
runs previously authorized by `SessionMeta.autoReview`. It no longer creates
reviewer sessions, dispatches fix rounds, or automatically merges through this
feature. MCP no longer advertises `lody_review_submit`.

Historical session metadata and workspace review documents are retained without
migration or deletion. The legacy `autoReview` pointer is inert and does not block
Edit & Resend. Existing reviewer conversations remain ordinary conversations;
an already running agent turn is not cancelled by a data migration.
These guarantees apply to the updated daemon; an older running daemon keeps its
older behavior until it is upgraded or stopped.

Manual pull request actions, review threads, session delegation, and scheduled
work retain their existing behavior. Shared PR and commit prompts stay available
to the manual quick actions.

## Evidence

- [Daemon composition](../apps/cli/src/lib/lody-fleet.ts)
- [MCP catalog](../apps/cli/src/mcp/lody-mcp-server.ts)
- [Session metadata](../packages/shared/src/schema.ts)
- [Manual PR prompts](../packages/shared/src/pr-prompts.ts)
- [Edit & Resend](../apps/cli/src/session/session-edit-and-resend-service.ts)
