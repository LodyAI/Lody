# apps/cli/src/platform

Effect services at the bottom of the CLI's layer map (L0 platform, L1 OS leaf).
Rules: [AGENTS.md](AGENTS.md).

| File | Responsibility |
| --- | --- |
| `logger.ts` | Routes `Effect.log*` into the daemon's Lody logger; `LOG_PREFIX_ANNOTATION` adds the `[owner]` prefix. |
| `promise-facade.ts` | TEMPORARY door for Promise callers: `runCommandText`, `runCommandTextSync`, `startProcess`, `isPidAliveSync`, `makePlatformRunner`; rejects with the typed error (spawn failures as the raw OS error). |
| `process/node-process.ts` | `NodeProcess` service: the only access to `spawn` and `process.kill`. |
| `process/errors.ts` | `SpawnFailed`, `TerminationFailed`. |
| `process/process-tree.ts` | `ProcessTree` (POSIX group, Windows tree, lone child), `terminateTree`, `waitUntilGone`. |
| `process/command.ts` | `runCommand` / `runCommandOk` (collect output, bounded, tree killed on timeout), `runCommandSync` for sync-only callers, `isPidAlive`. |
| `process/managed-process.ts` | `spawnProcess` / `spawnScoped`: a child with its tree, start/exit Deferreds and whole-tree termination; `windowsDetached` gives a daemon its own console on Windows. |
| `sandbox/types.ts` | `ProcessContainer` contract, resource types, termination policies. |
| `sandbox/noop-container.ts` | Container without limits; tracks groups until they are empty, including after the leader exits. |
| `sandbox/cgroup-container.ts` | Linux cgroup v2 container: limits, accounting, limit-violation detection, `cgroup.kill`. |
