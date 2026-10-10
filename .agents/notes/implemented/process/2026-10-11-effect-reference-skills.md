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

## Verification limits

This change affects instructions and skills only; dependencies and runtime code
are unchanged. Tarball inspection verifies reference availability, not Lody
shutdown/cancellation/synchronization behavior or agent effectiveness. No behavioral
suite was run for this documentation-only change. Document checks and installation
verification are reported separately from runtime acceptance.
