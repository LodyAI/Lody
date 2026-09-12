# Session orchestration chain depth

Status: draft
Translation: current

[中文](session-orchestration.zh.md)

When an Agent delegates asynchronous work through Lody, each delegated target
continues the causal chain from the driving human turn. Lody accepts at most 32
such hops. A command issued by a turn already at depth 32 is rejected before an
Operation or target Session is created, with the non-retryable
`CHAIN_DEPTH_EXCEEDED` error.

The depth is a causal delegation count, not a general `parentSessionId` tree
depth. Creating a Session, sending work to another Session, and delivering an
Operation continuation each advance the target turn by one. A missing depth on
an ordinary human turn starts at zero. The limit remains fixed in the shared
protocol contract; changing it requires updating every producer, recovery path,
executable model, and this Spec.

Machine-side review automation runs outside this MCP delegation chain. It keeps
its own round, token, and authority budgets while reacting to external review and
CI state.

## Evidence

The implementation guard is `apps/cli/src/mcp/lody-mcp-server.ts`, the shared
limit is `packages/shared/src/session-orchestration.ts`, and the executable
Operation model is `apps/cli/src/orchestration/operation-model.ts`.

This draft records the requested limit of 32. Runtime and deployed-client
acceptance remain to be verified after dependencies are installed.
