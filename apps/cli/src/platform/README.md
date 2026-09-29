# apps/cli/src/platform

Effect services at the bottom of the CLI's layer map (L0 platform, L1 OS leaf).
Rules: [AGENTS.md](AGENTS.md).

| File | Responsibility |
| --- | --- |
| `logger.ts` | Routes `Effect.log*` into the daemon's Lody logger; `LOG_PREFIX_ANNOTATION` adds the `[owner]` prefix. |
| `promise-facade.ts` | TEMPORARY runner that lets Promise callers use these services and rejects with the typed error. |
| `process/node-process.ts` | `NodeProcess` service: the only access to `spawn` and `process.kill`. |
| `process/errors.ts` | `SpawnFailed`, `TerminationFailed`. |
| `process/process-tree.ts` | `ProcessTree` (POSIX group, Windows tree, lone child), `terminateTree`, `waitUntilGone`. |
| `process/managed-process.ts` | `spawnProcess` / `spawnScoped`: a child with its tree, start/exit Deferreds and whole-tree termination. |
| `sandbox/types.ts` | `ProcessContainer` contract, resource types, termination policies. |
| `sandbox/noop-container.ts` | Container without limits; tracks groups until they are empty, including after the leader exits. |
| `sandbox/cgroup-container.ts` | Linux cgroup v2 container: limits, accounting, limit-violation detection, `cgroup.kill`. |
