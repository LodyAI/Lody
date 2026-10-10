# Local-project Git lifecycle

Status: draft
Translation: current

[中文](local-project-git-lifecycle.zh.md)

## Scenario and responsibilities

A local-project owner observes repository facts or switches branches. Git
workflow orchestration runs in Effect, with paths, host configuration and the
process spawner provided by a Layer. Each command owns its process Scope, and
parallel observation joins cancellation and bounded process-tree cleanup before
reporting its failure. The caller can interrupt native work and wait for cleanup.
An unresolved tree remains a release failure carrying its recovery lease.

Expected non-repository, bare-root, missing-ref, detached-HEAD and absent optional
configuration statuses retain their domain meaning. Process startup, timeout,
output limits, signal termination, permission/I/O errors, repository corruption
and failed resource release must not become a successful absence result. Precise
ref verification preserves existing namespace and selector behavior; if a ref
vanishes before its hash is read, observation fails. Time ceilings remain five
seconds for probes and thirty seconds for checkout, with sixteen MiB per output
stream and the existing bounded abandonment policy.

Canonical roots and persisted project IDs stay stable across symlink aliases.
Pure hashing and branch planners remain ordinary functions. Host environment is read through the supplied capability for each command;
changes remain visible after runtime initialization and native Git authentication
remains unchanged.
Compatibility execution has one visible deprecated Legacy facade over the same
kernel, with an explicit signal-supported runner. Its synchronous filesystem
methods remain blocking. Remove that facade when the application runtime owns
all consuming CLI entrypoints.

This does not migrate worktree creation or GC, add cross-process Git mutation
serialization, roll back commands already performed before interruption, or
complete Session/ACP/Turn cancellation. Whole-tree cleanup does not certify every
external resource released or stdio drained. Real Windows descendant ownership
after root exit remains separate work.

## Evidence

- Implementation and owning suite: `packages/shared/src/node/local-project.ts`,
  `packages/shared/tests/local-project.test.ts`.
- [Decision](../.agents/notes/implemented/architecture/2026-10-10-effect-local-project-git.md).
- [Process release contract](process-scope-release.md).
