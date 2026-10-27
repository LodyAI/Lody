# Run DeepSeek Harness with the user-installed Node.js

Status: implemented
Translation: current

[中文](2026-10-27-dsh-system-node.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1948

## Abstract

DeepSeek Harness 0.2.1-rc.2 fails before ACP initialization under Electron 44.9.3 because node-addon-require-builtin 0.1.9 rejects its Node/V8 fingerprint. Lody now resolves a standalone Node.js from the final launch PATH, checks it before npx, and uses that executable for Harness and the Windows npm entry. Missing, unsupported and unexecutable Node produce explicit frontend installation guidance. Users now own the Node.js installation and upgrades; Electron security updates no longer select the Harness runtime.

## Evidence and decision

The same cached native loader successfully reads `internal/modules/esm/loader` under Electron 44.7.0 (Node 24.21.0, V8 15.2.124.28-electron.0) and standalone Node 24.22.1. Electron 44.9.3 (Node 24.22.0, V8 15.2.124.43-electron.0) reproduces `Unsupported/no-context`, explicitly rejecting the runtime fingerprint. This minimal comparison isolates the loader failure; it is not a model/API or session-storage test.

The user approved switching to user-installed Node and explicit installation errors. This supersedes only runtime selection in the [bundled Node decision](2026-09-16-dsh-bundled-node-runtime.md) and [Electron compatibility decision](2026-10-10-dsh-electron-runtime.md). Retain npx closure pins, cache repair, explicit `runCli()`, provider homes and existing session compression rules. Do not roll back the [Electron security update](2026-10-26-runtime-dependency-security.md) or patch downloaded native binaries.

Resolve the first Node executable from absolute entries in the final login-shell/provider PATH. Ignore empty/relative entries so a session worktree cannot supply the executable implicitly. A broken first candidate fails visibly rather than silently selecting another installation. Validate the repository's existing Node security floors and Node-API 10; reject Electron executables. Remove `ELECTRON_RUN_AS_NODE` only from the DSH child environment. Keep PATH order, including the leading GitHub shim. Windows npm JS and the DSH forwarder use the same selected executable; existing hidden-console and process-tree behavior remain intact.

Normal sessions run the check in `Session.createAgent`, inside each startup attempt after shell/cache, credential and memory environment merges. The returned environment feeds both executable resolution and `sandbox.spawn`. Capability/quota, history and protocol-auth entry points use the same check after their respective environment merges. Stable `DSH_NODE_NOT_FOUND`, `DSH_NODE_UNSUPPORTED` and `DSH_NODE_EXEC_FAILED` markers travel through existing error messages; the always-open frontend notice presents localized remediation and a Node.js download action. The original error, including detected version or execution failure, remains copyable. Capability source identity changes to force re-probing after adoption.

The initial implementation at `44ff47f2c` omitted the normal `Session.createAgent` path while removing `LODY_DSH_NODE_EXECUTABLE` from the launch overlay. All normal DSH sessions therefore lacked the forwarder's required environment; Windows also skipped npm JS dispatch. **Correction to the original verification claim:** the earlier isolated ACP check exercised the generated bootstrap, not the normal Session path. The Session-specific check and behavioral tests below establish that boundary now; capability-probe success alone does not.

## Ownership and containment

The finite prerequisite probe is native Effect v4 over the existing process service, executed at the ACP Promise entry boundary. It has a five-second deadline, an output bound and the process service's read-only termination policy. Session/auth cancellation interrupts the probe; process Scope cleanup and release-failure ownership remain with the shared process service. A failed prerequisite stops only that launch; no sticky failure cache prevents retry after installation. History has no outer cancellation contract and uses the same bounded probe. The rest of ACP orchestration remains Promise-based; this is not an ACP transport migration.

## Verification and limits

Nine CLI suites pass (192 tests), covering the Session environment, resource-limit and termination suites as well as Harness startup, runtime guards, runner, authentication, history and agent settings. New `Session.createAgent` cases verify missing Node before sandbox spawn, recovery after installation, the Windows npm JS branch, final memory/provider/shell environment, cancellation with confirmed probe termination and revalidation on npm recovery attempts. Temporarily removing the Session call makes both the missing-Node and Windows-dispatch regression tests fail. The previous frontend suites (21 tests) cover unchanged UI behavior. CLI typecheck, changed-code type-aware Oxlint, process/public boundary guards, root formatting and documentation checks pass.

Real isolated checks now call **`Session.createAgent` itself**, through its normal environment construction, sandbox and ACP client, under standalone Node 24.22.1 and an Electron 44.9.3 host. Both complete `initialize` and `session/new`, populate the Session client/model capabilities, then terminate. These checks reuse the previously packaged adapter and cached 0.2.1-rc.2 closure via a cache-only npx shim; they send no model request and use no real credentials or built-in MCP server. They do not validate npm cold installation, a newly packaged installer or native Windows/Linux.

An initial Electron-hosted attempt using the VitePlus Node shim hit the existing five-second prerequisite deadline; the next identical attempt succeeded without configuration changes. A direct Node 24.22.1 PATH control also passes. This establishes retryability for that observed timeout, not acceptance of cold or slow Node-manager resolution.

Root `pnpm check` stops in the unchanged Codex adapter build: the reused installation has the earlier ACP SDK and cannot resolve the newly required `@agentclientprotocol/sdk/unstable` and `experimental/v2/unstable` exports. Effect lint also cannot run because this installation lacks `@effect/tsgo`. These are not passing full-repository checks. The fixture-only Magpie launch test now uses a disposable DSH home instead of the user's home. The local worktree initially had no installed dependencies or initialized adapters; verification reuses an existing dependency installation and initializes pinned submodules. No Node download, global installation, Harness package upgrade, Electron downgrade, user profile edit or session transcript is part of this change. Native Windows/Linux and signed-installer acceptance remain separate from local macOS tests.
