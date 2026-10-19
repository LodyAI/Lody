# Validate managed runtime pins against their adapter SDK

Status: proposed
Translation: current

[中文](2026-10-13-managed-runtime-sdk-owner.zh.md)

## Abstract

Main could not install with its frozen lockfile after adapter dependency changes. Once installation succeeded, old runtime pins failed the adapter version guards; refreshing the Claude pin exposed a second mismatch because the CLI checked its own development SDK instead of the adapter SDK. This change regenerates the dependency graph, refreshes verified runtime manifests, and reads Claude metadata from the adapter that launches it. Strict version and artifact integrity checks remain. Local checks do not establish a successful Windows desktop download or a merged main CI run.

## Decision and evidence

The Claude adapter owns the SDK used by built-in launch. Its package and manifest JSON therefore own the expected SDK and Claude Code versions. The CLI development SDK can resolve a different version and must not determine the adapter runtime pin. Removing the guard would hide a real incompatible archive, so the guard stays and its metadata source changes.

Codex, Claude, Grok, and Pi manifests were refreshed after artifact hash and size verification. The lockfile follows the checked-in adapter manifests; dependency release-age policy remains unchanged. The two managed runtime test files pass all 39 tests with the refreshed pins and adapter metadata imports. Full repository verification is recorded in the PR when complete.

This is distinct from the [login download cancellation proposal](2026-09-21-acp-auth-runtime-download.md): it changes pin ownership, not login progress or cancellation. Native platform execution, Windows desktop onboarding, and main CI after merge remain separate evidence.
