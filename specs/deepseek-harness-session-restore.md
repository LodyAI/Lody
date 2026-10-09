# DeepSeek Harness session restoration

Status: draft
Translation: current

[中文](deepseek-harness-session-restore.zh.md)

## Scenario and contract

A client continues a persisted DeepSeek Harness conversation after its ACP runtime
has stopped. The provider advertises standard ACP `loadSession` and session `resume`.
Both restore the original native session identity through Harness; neither forks nor
creates a replacement with a replay prompt. Harness owns storage locking and recovery
of interrupted turns. Missing/busy sessions, a mismatched cwd, delegated subagent
identities and unavailable persisted configuration fail explicitly.

Before returning, the adapter composes the stored Agent preset, restores the model
and reasoning selection, reads native permission/Plan state and initializes the
request's MCP servers. Model selections made before another prompt are durable.
A failed activation releases its runtime and MCP reservations so a corrected retry
can restore the same identity. Native recovery may append repair events; restoration
is not a read-only history API.

`session/load` replays root user messages, assistant text/thoughts/images, tool events
and titles before returning. Synthetic injected context is not a human message.
Historical child-agent transcripts are outside this contract. Missing required image
content fails load. `session/resume` restores without transcript replay. Both rebuild
usage accounting without charging historical work again; later deltas cover new work.
Neither operation rolls back project files. The client owns display deduplication.

## Evidence

- [Adapter behavior and native probe](../packages/acp-extension-dsh/README.md#session-restoration).
- [Implementation decision](../.agents/notes/implemented/feature/2026-10-09-dsh-session-restore.md).
- [Separate fork contract](deepseek-harness-session-fork.md).
