# Process Scope release failure

Status: draft
Translation: current

[中文](process-scope-release.zh.md)

## Scenario and responsibilities

An owner finishes or cancels scoped process work. Bounded termination cannot prove
that the process tree is gone. That Scope must report failure even when its body
succeeded; logging is not successful release.

The process backend keeps the unresolved tree in a recovery lease attached to the
Scope's failure. The receiver retains that lease until liveness confirms absence
or another bounded termination succeeds. A failed retry preserves ownership;
forced termination may proceed while a graceful retry waits. An observed-gone
lease is retired; subsequent calls and the polling of concurrent retries cannot
signal another generation with the
same numeric identifier. Identifier reuse before observed absence remains outside
this guarantee.

A timeout or body error and release failures may coexist. Promise compatibility
must preserve all recovery leases along with the primary failure. Calling
Scope.close again is not a cleanup retry. Confirmed tree absence does not imply
stdio drainage, successful document flush or complete Session/daemon shutdown.
Successful commands retain helpers deliberately left running under the existing
process contract. Real Windows descendants after root exit require separate
ownership work.

## Evidence

- Implementation and tests: `packages/shared/src/node/process.ts`,
  `packages/shared/tests/process.test.ts`.
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-10-effect-process-release-failure.md).
- [Binding process rules](../packages/shared/src/node/AGENTS.md).
