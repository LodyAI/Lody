# Align the root lockfile with the Codex submodule

Status: implemented
Translation: current

[中文](2026-10-27-codex-root-lockfile.zh.md)

## Abstract

Main upgraded the Codex submodule without updating its root workspace lockfile. PR merge checks therefore failed during frozen installation before running tests. Regenerating the lockfile aligns ACP SDK 2.0.2 and Codex 0.164.0 with that submodule. Exact release-age exceptions permit these selected versions while preserving the seven-day policy for future versions.

## Decision and evidence

The complete CI and Desktop E2E logs for [PR #1935](https://github.com/LodyAI/Lody/pull/1935) report `ERR_PNPM_OUTDATED_LOCKFILE`: the importer still selected SDK `~1.5.0` and Codex `^0.160.1`, whereas the merged submodule requires `~2.0.2` and `^0.164.0`. Local frozen installation reproduced this mismatch. The SDK and Codex resolutions match the submodule's package-lock pins.

Keep frozen installation enabled. Update only the affected dependency graph and exact release-age exceptions, including Codex's platform packages. Extend each package's existing exception because pnpm 10.20 uses its first matching rule. No runtime source, submodule source, workflow, or global quarantine duration changes are needed.

## Verification and limits

Frozen installation, root typechecking, Codex typechecking, formatting, static/boundary checks, documentation checks and the Ed25519 subgroup-edge test pass locally. Full `pnpm check` reaches CLI tests: 4868 pass, four skip, and the existing native Git transport test fails with `context_unreadable` in this environment. This does not establish a complete local suite pass; remote checks must validate the pushed merge.
