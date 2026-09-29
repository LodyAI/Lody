# Pin the merged Codex adapter with its matching Core release

Status: proposed
Translation: current

[中文](2026-09-27-codex-adapter-core-pins.zh.md)

## Abstract

Lody's current Codex adapter pin predates the merged managed-account refresh fix, while the newer adapter consumes contracts from Core 0.1.9. Pinning the adapter alone would leave the workspace with a mismatched Core dependency, so this change advances both submodules and the Core lockfile importer together. The host does not advertise the new subagent-event capability, and this PR does not implement the account-management host behavior tracked separately in [#1027](https://github.com/LodyAI/Lody/pull/1027).

## Decision and scope

- Pin `acp-extension-codex` to its merged main commit `0d7bb30` ([adapter #58](https://github.com/LodyAI/acp-extension-codex/pull/58)). This includes the managed ChatGPT refresh-contention classification on all four session-open paths, including `loadSession`.
- Pin `acp-extension-core` to published 0.1.9 commit `c806162` ([Core #15](https://github.com/LodyAI/acp-extension-core/pull/15)). The adapter's preceding #56 commit consumes that normalized subagent-event contract.
- Record Core's SDK dependency in the root `pnpm-lock.yaml` importer. Leave Lody's capability advertisement and account-management implementation to their owning changes.

An adapter-only pin was rejected because its newer Core contract would be resolved against the older 0.1.8 workspace checkout. Keeping these three versioned inputs together also lets the host account-management PR depend on a merged, independently verifiable upgrade rather than duplicate the gitlink change.

## Verification and limits

The paired commits were already exercised on the account-management branch: Core's 8 tests and the adapter's 825 tests passed, with 27 adapter tests skipped; both typechecks passed. On this standalone branch, install, formatting, documentation checks, public-boundary checks, root typecheck and lint passed. The complete `pnpm check` stopped at the unrelated `code-review-helper` test's 5-second timeout under concurrent load; the same test passed in isolation. CI against current `main` remains to be checked. No authenticated live account refresh is claimed, and the root host does not currently advertise `subagentEvents`.
