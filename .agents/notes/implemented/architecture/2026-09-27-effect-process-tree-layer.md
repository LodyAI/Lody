# One Effect v4 process foundation for Lody

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1065

[中文](2026-09-27-effect-process-tree-layer.zh.md)

## Abstract

Independent process shutdown loops could hang, leave descendants alive or report
failure as success. The process foundation now lives directly in shared and uses
Effect v4 services, scopes and bounded termination. ACP agents and session
containers consume that one implementation; other callers migrate in later
stack layers. Windows orphan descendants still require Job Objects, and real
Windows and cgroup hosts remain outside local verification.

The native process API and container ownership in this record are refined by
[the official process service decision](2026-10-09-effect-official-process-service.md).

## Scope and stack ownership

This note is revised with the unmerged stack to match the v4-first delivery order.
The [v4 baseline](2026-10-09-effect-v4-migration.md) belongs to #1070;
[the plan](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.md)
originated in #1057 and is restored onto main by #1355, because #1057 was merged
into its former base branch. #1065 owns the process core, CLI logger/containers, Session
shutdown, auxiliary ACP agents, authentication/history probes and their tests.
The core is created at `@lody/shared/node/process`, so subsequent PRs add
consumers without moving or copying the implementation.

## Ownership and termination

`NodeProcess` is the synchronous OS boundary, provided through `Context.Service`
and `Layer.effect`. Listeners are installed in the spawn step. `Deferred` values
separately track start, exit, stdio close and output overflow. `spawnScoped` uses
`acquireRelease`; facades expose the temporary Promise door to unmigrated callers.
The CLI composition module only supplies its logger and services; legacy Promise
entry points live in shared.

`ProcessTree` separates signalling from whole-tree liveness. POSIX groups remain
tracked after the leader exits; cgroup containers preserve limits and accounting.
`terminateTree` sends SIGTERM, waits a bounded grace period, sends SIGKILL and
waits within another bound. A surviving tree produces `TerminationFailed`.
Finalizer waits use Clock-bounded polling, because interruption-based timeouts do
not bound uninterruptible cleanup. Windows taskkill has a separate bounded
wait, checks exit status, and does not signal an already-exited root.

A failed spawn has no usable pid and must never signal pid 0. Windows bare
commands resolve only from absolute PATH entries, excluding the repository cwd.
Normal command exit preserves deliberately detached children; timeout,
interruption or output overflow terminates the owned tree. Lock-holding commands
receive SIGTERM grace to let git remove index.lock. Read-only probes can choose
a forced abandonment policy. Termination warnings reach a real logger.

## Session and failure handling

Only concurrent Session termination calls share a result. Once complete, a later
call runs cleanup again. Forced calls escalate immediately, including while a
graceful call is pending, without waiting for graceful terminal disposal. Events
carry the agent's exit data. A late-created agent is still cleaned up.

Callers that require proof of termination receive the typed error. Discarding or
archiving callers catch it and warn so cleanup failures do not replace a useful
result or skip cold-start fallback. Closed cgroup containers refuse new spawns;
forced termination reaches nested cgroups through cgroup.kill.

## Runtime boundary

This creates an Effect OS foundation, not a full Effect Session/Turn rewrite.
Session and ACP classes still use temporary Promise facades; the daemon-wide
runtime remains in the later session-resource stage. No v3 process implementation
or temporary CLI copy is introduced in this stack.

## Verification

Each reconstructed layer is checked independently with `pnpm check`, format and
document checks. TestClock and an injected process table cover escalation,
forced cancellation, surviving trees and bounded finalizers. Real isolated
subprocess tests wait for readiness signals and clean up the group, including
failed-spawn safety and an unrefed child's parent exiting naturally.

The tests are local evidence. No real Windows host, Linux cgroup hierarchy or
signed desktop installer has been tested. taskkill cannot retain descendants
whose Windows parent has already exited; [#429](https://github.com/LodyAI/Lody/issues/429)
remains partly addressed until the separate Job Object work.

## Remaining CLI consumers (#1069)

Git, worktree setup/GC, daemon commands, MCP, preview, file scanning, resource
probes and PTY termination use the same process facades. The CLI guard rejects
raw process APIs and process-spawning dependencies, including dynamic imports
and direct child kill forms. Standalone generated scripts and node-pty spawning
are named exceptions; PTY termination still uses the core.

The shared login-shell probe is introduced with its CLI caller. All fallback
shells share one deadline, printf delimiters preserve PATH, probe-only tmux and
update variables are restored to their original values, and multiline values
remain intact. CLI startup still unblocks after 3 seconds while the bounded
probe finishes in the background. shell-env is removed from CLI dependencies.
PTY hangup retains a bounded grace period before force-killing its group.

Current-main integration also migrates the new Simulator worker, native server,
guest helper, fixed xcrun commands and memory-provider CLI calls in #1069.
IPC ownership and guest EOF release remain with their owners; shared tree
termination replaces local signal loops. Global-only host Git identity and the
verified upgrade-installation handoff from main are preserved.

The timeout regressions for the login shell and daemon runner now wait for explicit
startup and advance virtual time. They still assert that roots and descendants
stop, and that a survivor reports failure. Disabling command grouping fails the
shell timeout case. The browser command-builder test only repeated its literal
mapping; it and the test-only export were removed. Platform opener behavior and
URL argument passing remain unchanged.
