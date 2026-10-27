# Exact release-age exception for the Codex ACP SDK upgrade

Status: implemented
Translation: current

[中文](2026-10-27-codex-acp-sdk-release-age-exception.zh.md)

## Abstract

Commit `b6e34c7de` advanced the `acp-extension-codex` submodule to `@agentclientprotocol/sdk ~2.0.2` and `@openai/codex ^0.164.0`, and `87fcf52aa` moved the Codex runtime manifest to 0.164.0, but `pnpm-lock.yaml` was not regenerated. Every frozen install on main, and so every CI job and PR, failed with `ERR_PNPM_OUTDATED_LOCKFILE`. Both releases were published on 2026-10-23, inside the seven-day `minimumReleaseAge` quarantine, so the lockfile could not be resolved at all. The owner chose exact `minimumReleaseAgeExclude` entries (SDK 2.0.2; Codex 0.164.0 and its six platform builds, appended to the existing single Codex rule) plus the regenerated lockfile. Later releases remain quarantined.

## Scope and evidence

- The lockfile diff is limited to the `packages/acp-extension-codex` importer: SDK `1.5.1 → 2.0.2`, Codex `0.160.1 → 0.164.0` with its platform aliases. The unreferenced SDK 1.5.1 entry is dropped; other importers keep SDK 1.8.0.
- `pnpm install --frozen-lockfile` succeeds, and `acp-extension-codex` builds against SDK 2.0.2.
- CLI suites that previously failed at import with `Codex runtime manifest 0.164.0 does not match @openai/codex 0.160.1` pass (`provider-setup-manager`, `terminal-pty-service`, `codex-profile-store`, `local-control-handler`).

## Alternatives

Waiting until 2026-10-30 needs no policy exception but leaves CI red for every PR until then. Reverting `b6e34c7de` and `87fcf52aa` undoes the upgrade that main intends to ship.

## Limits

No authenticated Codex ACP prompt was run with 0.164.0 in this change. The exception records the owner's approval of these exact versions; it is not a security review of their contents.
