# Native login-shell environment probes

Status: implemented
Translation: current

[中文](2026-10-10-effect-login-shell-probe.zh.md)

## Abstract

The shared login-shell probe used a Promise loop around Legacy process execution
and collapsed infrastructure, timeout and release failures into an absent environment.
LoginShellEnvironment now composes the existing native command API through an injected
host and official process service, with a shared Clock deadline for candidate shells.
CLI and Electron consumers use one marked probe facade; their remaining caches are
explicitly Legacy and retain failures rather than caching success. This finite probe
migration does not establish application ownership of those background caches.

## Decision and responsibilities

LoginShellHost supplies platform, environment snapshot and login-shell selection.
LoginShellEnvironmentLive captures it and ChildProcessSpawner through Layer.effect;
loginShellEnvLayer only composes those dependencies and the existing bounded Lody
process backend. Native probeLoginShellEnv composes the service without execution.
Each runCommandOk owns its command Scope. Cancellation propagates to that command
and waits for tree/stdio cleanup; failed release retains the process recovery owner.
There is no new spawn, stream collection or termination implementation.

Candidate shells retain the existing user/default shell then zsh/bash order, login
and interactive argv, bashrc handling, delimiters, 8 MiB output limit and restoration
of probe-only environment variables from the invocation snapshot. Clock replaces
Date.now and the total default command-wait budget remains 15 seconds across
fallbacks. Process cleanup has its existing separate bounded wait, so the configured
execution deadline is not a promise about total elapsed release time.

Only a single completed CommandFailed or absent candidate executable (ENOENT) permits
fallback. An unsupported/absent environment after known candidates returns null;
Windows returns null without evaluating a POSIX host environment. Permission/startup,
stream/output-limit, timeout and release failures remain failures. Mixed Cause is
re-emitted, never reduced to optional absence. The [draft contract](../../../../specs/login-shell-environment-lifecycle.md)
records the intentional change from silently falling back after failed probes.

probeLoginShellEnvLegacy is the only Promise door for this kernel. It forwards the
entry signal and uses runPromiseSquashedLegacy to preserve all process leases.
The old unmarked Promise probe name now denotes native Effect composition. CLI
getLoginShellEnvLegacy / getCachedLoginShellEnvSyncLegacy and Electron
getUserShellEnvCachedLegacy visibly identify the remaining Promise cache owners;
no aliases hide Legacy in consumers. Delete the facade after those application
owners receive the service, and delete the cache accessors after their consumers
migrate to the application-owned shell cache.

The CLI's existing three-second local wait ceiling is preserved: a caller may use
an empty overlay while a probe is still pending, and successful late completion
updates later readers. This is distinct from a failed probe. Early failure rejects;
late failure replaces the cache with the same rejected error, is reported by safe
error name, and is thrown by later synchronous reads. Logs contain no environment,
profile output or raw error. Warm-up attaches a rejection observer because the
cache itself records the failure. Electron already retains a rejected cache Promise
and now receives the actual probe failure instead of null.

The remaining module Promise, timer and process-lifetime cache are not native
lifecycle ownership. One pending CLI waiter does not cancel the shared cache, reset
is a test-only compatibility operation, and daemon shutdown does not yet join that
background probe. Do not claim unified ManagedRuntime/root Scope from this leaf.

## Evidence and validation

Implementation uses the workspace-pinned Effect and @effect/vitest 4.0.2. The
[official v4 service/layer migration](https://github.com/Effect-TS/effect/blob/main/migration/services.md)
and [Clock service documentation](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Clock.ts)
were checked against installed Context, Layer, Clock, TestClock and process sources.
Native ownership tests use Deferred/TestClock and the existing in-memory OS table;
real throwaway-home profiles retain login exports, multiline values and fallback.
Actual CLI cache, Session env, ACP runner/authentication and history consumers are
verified together: Shared probe/process suites pass 53 cases and five CLI
consumer suites pass 74. Seven isolated ablations are caught: swallowed native
failure, a reset fallback budget, wall-clock substitution, omitted probe-variable
restoration, a mutable invocation environment, permission treated as optional,
and failed cache entries turned into empty success. Restored native/cache suites
pass eight/four cases; experiment scripts remain outside the repository.

Root pnpm check passes all workspace types and lint (zero errors), then CLI
reports 3,721 passing, one skipped and one Roost signed-prefix timeout. The exact
CLI and Shared baseline source (9692d13) with the same two-worker CLI/component
load also reproduces that timeout; running the baseline case alone passes. The
baseline preview additionally lacks root fixture files for its SQLite suite,
which is a preview setup failure, not a product change. No full green pnpm check
is claimed and no coverage is removed. Supplemental Shared passes 113 files /
1,383 tests and Electron passes 215 tests; all i18n/import/platform/process/public
guards pass. pnpm format, format:check, scoped source/test formatting, initial docs
status and final docs check pass, with no protected topic changed. Validation
child environments isolate Git pollution without changing user global config.

Local Linux verification does not establish real Windows, macOS login behavior,
delegated cgroups, packaging or production validation. The earlier
[process-layer decision](2026-09-27-effect-process-tree-layer.md) owns the compatible
profile and local-wait behavior; [release-failure ownership](../bug-fix/2026-10-10-effect-process-release-failure.md)
is a prerequisite for reliable failure projection. Runtime installers, startup gate,
connection/session ownership and native application caches remain separate units.
