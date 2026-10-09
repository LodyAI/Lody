# apps/cli/src/platform

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

CLI-specific Effect platform pieces over the shared process layer. File map:
[README.md](README.md). The process layer itself and its rules:
[shared node](../../../../packages/shared/src/node/AGENTS.md). Effect usage:
[cli-effect-ts](../../../../.agents/docs/cli-effect-ts.md).

## Rules

- Code here is Effect-only: no Promise-returning APIs, no `setTimeout`/`setInterval`,
  `AbortController`, lifecycle `EventEmitter`s or module-level mutable state, and
  no `Effect.run*`. `process-options.ts` only composes the process Layer and
  logger; it never executes an Effect. Legacy Promise entry points call the
  shared compatibility functions directly; list them in cli-effect-ts.
- Session process containers (`sandbox/`) spawn and end processes only through
  `@lody/shared/node/process`; they add containment (groups, cgroups), limits and
  accounting, never another termination path. Capture the official process
  spawner and Session Scope; a failed or interrupted spawn closes its child
  Scope before returning, and successful acquisition remains Session-owned.
