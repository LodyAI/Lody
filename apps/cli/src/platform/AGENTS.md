# apps/cli/src/platform

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

L0 platform and L1 OS-leaf services of the Effect migration. File map:
[README.md](README.md). Effect usage and boundary rules:
[cli-effect-ts](../../../../.agents/docs/cli-effect-ts.md). Decision record:
[process tree layer](../../../../.agents/notes/implemented/architecture/2026-09-27-effect-process-tree-layer.md).

## Rules

- Code here is Effect-only: no Promise-returning APIs, no `setTimeout`/`setInterval`,
  `AbortController`, lifecycle `EventEmitter`s or module-level mutable state, and
  no `Effect.run*`. The one exception is `promise-facade.ts`, the temporary door
  for Promise callers; list every facade in cli-effect-ts.
- Only `process/node-process.ts` imports `child_process`/`cross-spawn` or calls
  `process.kill`, in the whole CLI. Everything else reaches the OS through the
  `NodeProcess` service, which tests replace with `tests/fake-process-table.ts`.
  `scripts/check-cli-process-boundary.mjs` enforces it; its allowlist holds only
  source text of standalone scripts and the node-pty loader, each with a reason.
- Missing a capability (a new spawn shape, a pid-only kill)? Add it here with a
  test and a facade entry; never work around the layer in the caller.
- End processes only through `terminateTree`. Do not add another
  SIGTERM→wait→SIGKILL loop anywhere in the CLI; extend `ProcessTree` instead.
- Every wait is bounded. A tree that cannot be proven gone fails with
  `TerminationFailed`; this layer never reports it as success. A caller that
  cannot act on it logs it at `warn`, naming the tree.
- Liveness covers the whole tree (process group, cgroup), not just the root:
  a group whose leader exited keeps its members reachable until it is empty.
- Subscribe to a child's events in the same synchronous step as the spawn
  (`SpawnSpec.onSpawned`, an `Effect.async` register). A listener attached
  after a yield can miss a fast exit or spawn error.
- Tests use `@effect/vitest` with `TestClock` and the fake process table; a
  real-process test waits on explicit readiness output, never on elapsed time.
