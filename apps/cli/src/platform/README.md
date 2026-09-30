# apps/cli/src/platform

CLI-specific Effect platform pieces. The process layer they build on is
`@lody/shared/node/process` (`packages/shared/src/node/process.ts`). Rules:
[AGENTS.md](AGENTS.md).

| File | Responsibility |
| --- | --- |
| `logger.ts` | Routes `Effect.log*` into the daemon's Lody logger; a facade's `logPrefix` adds the `[owner]` label. |
| `promise-facade.ts` | TEMPORARY door for CLI Promise callers to the shared facades (`runCommandText`, `runCommandTextSync`, `startProcess`, `terminateChildTree`, `isPidAliveSync`, `makePlatformRunner`), adding the CLI logger. |
| `sandbox/types.ts` | `ProcessContainer` contract, resource types, termination policies. |
| `sandbox/noop-container.ts` | Container without limits; tracks groups until they are empty, including after the leader exits. |
| `sandbox/cgroup-container.ts` | Linux cgroup v2 container: limits, accounting, limit-violation detection, `cgroup.kill`. |
