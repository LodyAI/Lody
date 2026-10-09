# packages/shared/src/node

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Node-only helpers shared by the CLI, the desktop main process and the CLI
supervisor. Package rules: [shared](../../AGENTS.md).

## Process layer (`process.ts`)

The one implementation that starts, awaits and signals OS processes for the CLI,
Electron main, the CLI supervisor and these helpers. Effect usage and boundary
rules: [cli-effect-ts](../../../../.agents/docs/cli-effect-ts.md). Decision
record: [process tree layer](../../../../.agents/notes/implemented/architecture/2026-09-27-effect-process-tree-layer.md).

- Effect callers use `effect/process` commands and `ChildProcessSpawner`,
  provided by `ProcessSpawnerLive` with Lody's bounded backend. Process acquisition
  requires Scope; only legacy Promise entry points use raw handle compatibility.
  Temporary execution entry points carry the `Legacy` suffix and `@deprecated`;
  keep it visible in imports and calls. New Effect workflows compose core APIs
  and execute once at their owning application entry point.
  Use the workspace Effect v4 catalog and `Context.Service` / `Layer.effect`;
  follow the pinned-version APIs in cli-effect-ts, not v3 compatibility helpers.
- New or refactored process callers use the official Effect service or shared
  legacy Promise entry points; never add raw spawn or kill paths, and never put
  an Effect through a Promise facade and wrap it back into Effect.
  ACP and remaining CLI callers use this layer, enforced by the CLI process guard.
  Existing Node git/lock helpers, Electron and supervisor migrate in the next PR;
  the guard expands with those consumers.
- `process.ts` stays one module with no relative imports: Electron's
  `node --test` cannot resolve extensionless relative imports.
- Missing a capability (a new spawn shape, a pid-only kill)? Add it to
  `process.ts` with a test and a facade; never work around the layer in a caller.
- End processes through the official Effect handle or `terminateTree`; never add another
  SIGTERM→wait→SIGKILL loop. Every wait is bounded, and a tree that cannot be
  proven gone fails with `TerminationFailed`, never success. A caller that
  cannot act on it logs it at `warn`, naming the tree.
- Termination often runs in a finalizer, where nothing is interruptible: bound
  its waits by the clock (`waitUntilGone`), never by `timeout*` or a race.
- Never signal a child without a pid (pid 0 is the caller's own group), and
  never resolve a Windows command from the working directory.
- Liveness covers the whole tree (process group, cgroup), not just the root.
- A command that exits on its own keeps what it deliberately left running; only
  a caller that stops waiting (timeout, interruption, output limit) ends the tree.
- Scope owns process acquisition before configuration or other interruptible
  post-spawn work. Failed owner hooks also release the acquired process.
- Subscribe to a child's events in the same synchronous step as the spawn
  (`SpawnSpec.onSpawned`, an `Effect.callback` register).
- The Effect core has no Promise APIs, timers, `AbortController`s or mutable
  module state; the facade section at the end of `process.ts` is the only
  Promise door. Tests use `@effect/vitest` with `TestClock` and
  `process-testing.ts` (the fake process table); a real-process test waits on
  explicit readiness output, never on elapsed time.
