# Official Effect skills and version-matched references

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1410

[中文](2026-10-11-effect-reference-skills.zh.md)

## Abstract

Agents need Effect guidance that matches Lody's dependency rather than a moving
upstream API. Two official skills are installed locally with overrides preserving
locked versions and behavioral acceptance. Effect 4.0.2 already ships its guide,
examples and implementation source, so a tracked source subtree is not recommended
for this purpose. No subtree was added; supplementary upstream tests and migration
guides can be fetched at an explicit release tag/commit when needed.

## Evidence and ownership

- `pnpm-workspace.yaml` pins Effect and its test helper to 4.0.2. This worktree
  has no installed dependencies, so the public npm 4.0.2 tarball was inspected
  in a temporary directory rather than modifying dependency declarations.
- That release contains `AGENTS.md`, `ai-docs` and `src` (about 20 MiB of source,
  356 KiB of examples on the inspection filesystem). Its guide links services,
  Layers, resources, testing and existing-application integration examples.
- Skills come from [the official repository at the recorded commit](https://github.com/Effect-TS/skills/tree/155c50c911f9c99c294ef8a4461981c5bbe6453e).
  The upstream setup installs latest and the migration considers tests optional.
  Local overrides preserve the catalog and require relevant behavioral tests.
- Root instructions require the consuming dependency's guide; canonical skills
  live in `.agents/skills` with Claude symlinks. Refresh provenance and local
  adjustments are recorded in [the skill README](../../../skills/README.md).
  Existing [Effect guidance](../../../docs/cli-effect-ts.md) owns Lody semantics.

## Alternatives and recommendation

A subtree makes references available before dependency installation and can include
upstream tests and migration data absent from the npm release. It also adds a
second source version, tracked third-party files, and manual update/review work.
Pinning a subtree solves drift only if every dependency update also updates it;
tracking main instead increases the chance of using an API outside Lody's release.
No recurring gap requiring a tracked copy was demonstrated here.

Prefer installed references for normal work. For implementation debugging or v3
migration, fetch only the needed upstream material into a temporary untracked
checkout, pin it to the target release tag/commit, and verify signatures against
the actual dependency. Revisit a subtree if repeated work needs upstream tests or
an installation-free reference and has an owner for version synchronization.

## Later guidance revision

The [charter revision](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#migration-guidance-and-progress)
adapts the general effect-ts entry into a contract-first Lody lifecycle workflow,
replacing conflicting upstream installation steps while retaining provenance and
MIT licensing. The explicitly scoped v3-to-v4 skill and version-matched reference
policy remain unchanged. Responsibility splitting is optional for large mixed
modules; ordinary small migrations do not need a prescribed file layout.

The follow-up in [#1452](https://github.com/LodyAI/Lody/pull/1452) selects the task
mode before migration planning and reads the resolved release guide fully once
per version in the current context. The owning guide defines five applicable
behavior questions; the charter separates delivery state from verification and
records synthetic guidance-evaluation cases. This avoids repeating a full migration
workflow during review/debug while retaining lifecycle acceptance for implementation.

Factual correction: v4.0.2 `src/internal/effect.ts` implements `runPromise` rejection
through `causeSquash`, so a single typed failure is already the original error,
not a `FiberFailure` wrapper. `runPromiseExit` remains useful for inspecting the
complete Cause before a domain-specific projection; plain squash can lose combined
failures and recovery ownership. `Stream.runCollect`/`runDrain` return Effects and
are composition operators, not runtime execution entries.

## Verification limits

This change affects instructions and skills only; dependencies and runtime code
are unchanged. Tarball inspection verifies reference availability, not Lody
shutdown/cancellation/synchronization behavior or agent effectiveness. No Lody behavioral
suite was run for this documentation-only change. Five temporary deterministic
probes against the exact 4.0.2 npm reference passed on Node 22.22.0: single-failure
projection, lazy Promise retry, late mutation after an abort-ignoring Promise's
wait is interrupted, cooperative abort, and ManagedRuntime sharing/release order.
They use explicit signals rather than sleeps and establish upstream semantics only,
not integration behavior in this dependency-free worktree. The probes were rerun
for the #1452 follow-up; the skill metadata validator also passed. Synthetic prompt
cases have expected outcomes but have not been independently evaluated.
Document checks and installation verification are reported separately from runtime
acceptance.
