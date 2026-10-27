# Run DeepSeek Harness with the user-installed Node.js

Status: implemented
Translation: current

[中文](2026-10-27-dsh-system-node.zh.md)

## Abstract

DeepSeek Harness 0.2.1-rc.2 fails before ACP initialization under Electron 44.9.3 because node-addon-require-builtin 0.1.9 rejects its Node/V8 fingerprint. Lody now resolves a standalone Node.js from the final launch PATH, checks it before npx, and uses that executable for Harness and the Windows npm entry. Missing, unsupported and unexecutable Node produce explicit frontend installation guidance. Users now own the Node.js installation and upgrades; Electron security updates no longer select the Harness runtime.

## Evidence and decision

The same cached native loader successfully reads `internal/modules/esm/loader` under Electron 44.7.0 (Node 24.21.0, V8 15.2.124.28-electron.0) and standalone Node 24.22.1. Electron 44.9.3 (Node 24.22.0, V8 15.2.124.43-electron.0) reproduces `Unsupported/no-context`, explicitly rejecting the runtime fingerprint. This minimal comparison isolates the loader failure; it is not a model/API or session-storage test.

The user approved switching to user-installed Node and explicit installation errors. This supersedes only runtime selection in the [bundled Node decision](2026-09-16-dsh-bundled-node-runtime.md) and [Electron compatibility decision](2026-10-10-dsh-electron-runtime.md). Retain npx closure pins, cache repair, explicit `runCli()`, provider homes and existing session compression rules. Do not roll back the [Electron security update](2026-10-26-runtime-dependency-security.md) or patch downloaded native binaries.

Resolve the first Node executable from absolute entries in the final login-shell/provider PATH. Ignore empty/relative entries so a session worktree cannot supply the executable implicitly. A broken first candidate fails visibly rather than silently selecting another installation. Validate the repository's existing Node security floors and Node-API 10; reject Electron executables. Remove `ELECTRON_RUN_AS_NODE` only from the DSH child environment. Keep PATH order, including the leading GitHub shim. Windows npm JS and the DSH forwarder use the same selected executable; existing hidden-console and process-tree behavior remain intact.

Session/capability, history and protocol-auth entry points run this check after their environment merge. Stable `DSH_NODE_NOT_FOUND`, `DSH_NODE_UNSUPPORTED` and `DSH_NODE_EXEC_FAILED` markers travel through existing error messages; the always-open frontend notice presents localized remediation and a Node.js download action. The original error, including detected version or execution failure, remains copyable. Capability source identity changes to force re-probing after adoption.

## Ownership and containment

The finite prerequisite probe is native Effect v4 over the existing process service, executed at the ACP Promise entry boundary. It has a five-second deadline, an output bound and the process service's read-only termination policy. Session/auth cancellation interrupts the probe; process Scope cleanup and release-failure ownership remain with the shared process service. A failed prerequisite stops only that launch; no sticky failure cache prevents retry after installation. History has no outer cancellation contract and uses the same bounded probe. The rest of ACP orchestration remains Promise-based; this is not an ACP transport migration.

## Verification and limits

Six CLI suites pass (163 tests), including PATH order and spaces, Windows npx forwarding, missing/unsupported/unexecutable Node, retry after installation, real generated bootstrap execution and cancellation of an in-flight prerequisite probe with confirmed child termination. Two frontend suites pass (21 tests); the existing notice Storybook gains a missing-Node state with a download action. CLI and components typechecks, changed-code Oxlint, process/public boundary guards, root formatting and documentation checks pass.

A real local ACP probe uses the current launch/bootstrap source, a previously packaged adapter, the cached 0.2.1-rc.2 package closure and a disposable home. Both standalone Node 24.22.1 and an Electron 44.9.3 host select PATH Node and complete `initialize` plus `session/new`, returning mode/preset/model/reasoning options. No model request or real credentials are used. This reuses a packaged adapter and bypasses npx installation with the existing cache; it is not a fresh installer or cold npm-download test.

Root `pnpm check` stops in the unchanged Codex adapter build: the reused installation has the earlier ACP SDK and cannot resolve the newly required `@agentclientprotocol/sdk/unstable` and `experimental/v2/unstable` exports. Effect lint also cannot run because this installation lacks `@effect/tsgo`. These are not passing full-repository checks. The fixture-only Magpie launch test now uses a disposable DSH home instead of the user's home. The local worktree initially had no installed dependencies or initialized adapters; verification reuses an existing dependency installation and initializes pinned submodules. No Node download, global installation, Harness package upgrade, Electron downgrade, user profile edit or session transcript is part of this change. Native Windows/Linux and signed-installer acceptance remain separate from local macOS tests.
