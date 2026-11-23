# Isolate ACP capability probe workspaces

Status: implemented
Translation: current

[中文](2026-10-25-acp-probe-workdir.zh.md)

## Abstract

Issue [#1844](https://github.com/LodyAI/Lody/issues/1844) reports Antigravity capability discovery failing when the daemon inherits `/` and the runtime creates workspace-local `.gemini/skills`. Capability probes now allocate unique temporary workspaces for all providers, preserving provider credentials and real-session project directories. Startup failure, cancellation and result-processing failure all reach directory cleanup after existing agent teardown. Cleanup remains best effort: removal failure cannot replace the probe result, and the runner's existing shutdown contract does not prove process termination.

## Decision and ownership

[`fetchAcpCapabilities`](../../../../apps/cli/src/agent/acp-capabilities.ts) owns one `mkdtemp` directory per invocation. It passes that absolute path to the runner for both process launch and `session/new`. Authentication preflight stays before allocation; an abort arriving during allocation is checked before starting the agent. The outer `finally` attempts recursive removal after the inner agent shutdown or failed startup cleanup. The startup gate and existing AbortSignal propagation remain intact.

Allocation failure rejects explicitly without falling back to inherited cwd. Removal failure emits a fixed diagnostic and preserves either discovered capabilities or the original probe error, even if logging also fails. Subsequent probes allocate new paths, so a busy directory does not fence another provider or retry. No credentials, provider home directories or user projects are deleted.

The existing runner catches process-termination failures and logs survivors. This change retains that contract and the previous Codex probe's best-effort deletion semantics; shutdown completion is not asserted to be proof of exit, and residual temporary files/processes remain possible. There is no new process supervisor, retained-failure registry or retry loop.

## Scope and alternatives

The [capability cache decision](../../implemented/bug-fix/2026-09-16-acp-capability-refresh-cache.md) requires real runtime probing. Keep its runtime/cache behavior; do not substitute static capabilities. A home-directory fallback would avoid the root-volume error but mix probe files with user configuration. Global `process.chdir` would affect concurrent daemon work. Unique disposable workspaces isolate concurrent probes without either effect.

Registry authentication separately uses inherited cwd, but only initializes/authenticates the protocol; it does not create the workspace session implicated in this report. Its behavior is unchanged. Real project sessions remain outside the changed function. Custom commands that rely on relative files in the daemon's launch directory should use absolute launch paths; capability probes are deliberately project-independent.

Native Effect migration was assessed in feature/fix mode against the [selection guide](../../../docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work). Startup, authentication and shutdown remain unfinished Promise orchestration; wrapping them would not complete a native unit. This fix retains their ownership rather than expanding the migration scope.

## Verification

The capability and runner suites pass 44 tests. New behavior tests write `.gemini/skills` in the supplied directory with inherited cwd reported as root; cover registry/custom/builtin providers, concurrent probes and deferred shutdown, startup/normalization failure, cancellation during allocation/startup, allocation/removal failure, retry after removal failure, throwing diagnostics, unexpected shutdown rejection, and preservation of the Codex profile home after verification failure. Filesystem operations are real except the explicitly injected failure boundaries; concurrency uses explicit signals, not sleeps.

Repository typechecking, lint, formatting, documentation and boundary checks passed. The full `pnpm test:ci` gate passed with system Git (`env -u GIT_EXEC_PATH PATH="/usr/bin:/bin:$PATH"`); the inherited session Git wrapper breaks an unrelated synthetic SSH fixture with `context_unreadable`.

Live Antigravity login/model responses were not exercised. Test coverage validates host workspace ownership, not upstream provider internals.
