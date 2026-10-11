# apps/cli/src/platform

CLI-specific Effect platform pieces. The process layer they build on is
`@lody/shared/node/process` (`packages/shared/src/node/process.ts`). Rules:
[AGENTS.md](AGENTS.md).

| File                          | Responsibility                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger.ts`                   | Routes `Effect.log*` into the daemon's Lody logger; a facade's `logPrefix` adds the `[owner]` label.                                                                                                        |
| `process-options.ts`           | Composes the official process service, injected OS boundary and CLI logger; performs no process execution or Promise conversion. |
| `sandbox/types.ts`            | `ProcessContainer` contract, resource types, termination policies.                                                                                                                                          |
| `sandbox/noop-container.ts`   | Container without limits; tracks groups until they are empty, including after the leader exits.                                                                                                             |
| `sandbox/cgroup-container.ts` | Linux cgroup v2 container: limits, accounting, limit-violation detection, `cgroup.kill`.                                                                                                                    |

`sandbox/process-tree-registry.ts` shares group tracking between containers. It
keeps failed trees available for retry and removes only groups proven empty.
Successful command Scopes close after setup, whole-group exit and drained stdio,
so a reused Session does not retain completed commands and their output buffers.
Cgroup attachment errors fail spawn; unreadable membership fails termination.
Cleanup retains resources whose release could not be confirmed.
