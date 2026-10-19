# Native login-shell probe and application-owned cache

Status: implemented
Translation: current
PR: [#1397](https://github.com/LodyAI/Lody/pull/1397)

[中文](2026-10-10-effect-login-shell-probe.zh.md)

## Abstract

The finite probe now composes the existing native process service, and CLI/Electron
shared caches use one Effect kernel owned by their application Scope. Local waiters
can time out or cancel without stopping siblings; application shutdown stops and
joins the producer. Failed release preserves its process recovery owners and prevents
successful quit/replacement until cleanup is confirmed. Remaining launcher APIs are
explicit Legacy execution boundaries; Session/Turn/Loro lifecycle migration is pending.

## Probe policy

LoginShellHost supplies platform, environment snapshot and shell selection.
LoginShellEnvironmentLive captures it with the official process spawner; passive
loginShellEnvLayer reuses Lody's bounded backend. Each command owns its Scope.
Candidate order, login/interactive argv, bashrc handling, delimiters, 8 MiB output
limit and restoration of injected variables remain unchanged. Clock supplies the
shared 15-second command budget across fallbacks, with a separate process-cleanup
bound. Only a single completed CommandFailed or ENOENT permits fallback. Unsupported
or absent shells return null; permission, stream, timeout and release errors retain
the complete Cause. No new spawn, collector or termination backend is introduced.

## Cache and application ownership

LoginShellCacheLive uses Ref/Semaphore for one producer Fiber in an owned child Scope.
It retains the producer Exit, not a Promise or timer. get/peek/warmup compose Effect;
get's optional Clock timeout affects only its reader. CLI keeps the 3-second empty
overlay while pending; later success or failure reaches both asynchronous and
synchronous readers. A reporter records failures by safe error name without logging
shell output or environment. Electron retains its full probe wait and opt-out/null
behavior. Reader cancellation never marks the remote process released.

Shutdown closes admission, interrupts and joins the producer before closing its
Scope, and shares a Deferred receipt across concurrent calls. Process-release
failures become LoginShellCacheShutdownFailed with all transferred process leases.
The application makeApplicationRuntime owner avoids relying on repeated Scope.close
joining the first close: concurrent callers await one receipt. A failed completed
close retries transferred leases, retaining the original Cause even if recovery
also fails. Binding a replacement requires confirmed release of its predecessor.

CLI index and Electron startApplication compose these first application runtimes.
CLI daemon shutdown retains session-stop/flush/document teardown inside fleet.shutdown,
then closes the shell owner before releasing the host lease; fatal and one-shot
entries also await disposal. Failed graceful cleanup cannot exit successfully.
Electron's existing renderer-unload approval runs before teardown; its quit barrier
waits for the CLI and native application owner and keeps failures available for a
later quit. Startup failure also awaits application disposal before failure exit.
The existing explicit force-exit policy remains; abrupt OS death cannot await Scope.
These roots own this service, not the as-yet-unmigrated daemon Session/Turn/Loro stack.

probeLoginShellEnvLegacy and resetLoginShellEnvCacheLegacy are deleted after their
consumers migrate. Remaining launcher accessors and the application binding bridge
carry visible Legacy names/@deprecated; remove them when callers receive the native
service. The generic application close door is also explicitly closeLegacy while
application orchestration remains Promise-based. No second probe/cache implementation
or implicit lazy runtime is provided.

## Evidence and limits

Implementation follows the installed Effect/@effect-vitest 4.0.2 Context, Layer,
Scope, Fiber, ManagedRuntime and TestClock sources plus the owning Effect skill.
Real throwaway profiles and the existing fake OS table cover probe behavior, tree
cleanup and retained process leases. New behavioral coverage checks reader timeout
and cancellation, late results/failures, concurrent cleanup, refused new requests,
real process descendants, failed disposal and repeated recovery, cold synchronous
access, replacement refusal, daemon failure exit and Electron quit/retry ordering.
Experiments and validation isolation live outside product code. No new Spec or
migration PR is created. Local Linux checks do not establish macOS/Windows login,
Windows root-exit descendant ownership, delegated cgroups, packaging or production.
[Process ownership](2026-09-27-effect-process-tree-layer.md) and
[complete release failures](../bug-fix/2026-10-10-effect-process-release-failure.md)
remain prerequisites; installers, startup gate, ACP/Session/Turn and Loro are separate units.

Verification of the final assembled source against main 45753fe61e0427043f5cb14c91b33e996ca376b0:
workspace typechecks and type-aware lint pass with zero errors. Full pnpm check
reaches CLI testing: 3753 pass, one skip, and the previously reproduced Roost
signed-prefix 30-second timeout; no full green check is claimed. Supplemental
Shared passes 112 files / 1415 cases and Electron passes 216 cases. Eight related
CLI suites pass 124 cases; the shared lock/shell/process suites pass 89 cases.
Six temporary ablations are caught: removing the cleanup bound, reissuing an old
successful unlink, dropping file cleanup Cause, cancelling the shared producer
with a reader, discarding the original failed recovery owner, and declaring failed
shell release successful. Original/restored lock and shell suites pass 28/18 cases.
Scripts remain outside product code. Formatting, all five boundary guards and docs
check pass. Validation children isolate Git/PATH/temp/lock inputs; global Git
configuration, original checkout HEAD and dirty submodule gitlinks remain unchanged.
During validation main advanced with unrelated changes; these fixes retain the
explicit tested snapshot, not a claim of integration with that later head.
