# apps/cli/src/platform

CLI-specific Effect platform pieces. The process layer they build on is
`@lody/shared/node/process` (`packages/shared/src/node/process.ts`). Rules:
[AGENTS.md](AGENTS.md).

| File                          | Responsibility                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logger.ts`                   | Routes `Effect.log*`, allowlisted annotations and Cause categories into the existing daemon logger; trace follows its opt-in sink policy and `logPrefix` adds the owner label. |
| `presence.ts`                 | Supplies presence host capabilities and the published native SDK transport, projecting safe stage diagnostics into the existing logger.                                        |
| `process-options.ts`          | Composes the official process service, injected OS boundary and CLI logger; performs no process execution or Promise conversion.                                               |
| `sandbox/types.ts`            | `ProcessContainer` contract, resource types, termination policies.                                                                                                             |
| `sandbox/noop-container.ts`   | Container without limits; tracks groups until they are empty, including after the leader exits.                                                                                |
| `sandbox/cgroup-container.ts` | Linux cgroup v2 container: limits, accounting, limit-violation detection, `cgroup.kill`.                                                                                       |

`sandbox/process-tree-registry.ts` shares group tracking between containers. It
keeps failed trees available for retry and removes only groups proven empty.
Successful command Scopes close after setup, whole-group exit and drained stdio,
so a reused Session does not retain completed commands and their output buffers.
Cgroup attachment errors fail spawn; unreadable membership fails termination.
Cleanup retains resources whose release could not be confirmed.

The pinned streams-crdt patch retains Effect's HTTP response wrapper with each
ephemeral body lease. Collecting that wrapper aborts the underlying request, so
keeping only the raw `Response` can cancel an active presence SSE connection.
The lease releases both together at EOF or confirmed cleanup.

Presence WS defaults off; `LODY_LORO_STREAMS_WS_ENABLED=true` or `1` opts in,
while explicit `webSocketEnabled` overrides the environment. The main gateway
and workspace pool key are separate from the retained presence HTTP shard.
`presence-legacy.ts:createPresenceWebSocketAuthLegacy` is the SDK callback
execution boundary: `reauth` maps to `unauthorized`, other reasons to `request`,
and `previousToken` survives for exact rejected-token eviction. The actual token
callback has no `status` parameter. Provider failures reject the callback and an
absent token is an error, never an anonymous connection.

The pinned `@loro-dev/streams-client` 0.14.0, `@loro-dev/streams-crdt` 0.22.1,
and `loro-repo` 0.26.0 packages implement `webSocket.url` and Repo forwarding;
enabling the flag remains a separate rollout step. Physical connection reuse
still needs acceptance against a live WS gateway.
