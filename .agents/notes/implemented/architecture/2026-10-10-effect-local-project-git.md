# Native local-project Git workflows

Status: implemented
Translation: current

PR: [#1381](https://github.com/LodyAI/Lody/pull/1381)

[中文](2026-10-10-effect-local-project-git.zh.md)

## Abstract

Local-project helpers orchestrated Promise commands and converted startup,
timeout and cleanup failures into a null exit status, allowing repository
observation to report a successful non-Git result. Their single kernel now uses
native Effect workflows with filesystem, host configuration and the existing
bounded process service supplied through Layers. CLI entrypoints consume that
kernel through one visible Legacy facade while pure selectors and project
identity calculation remain ordinary functions. Cancellation joins command tree
cleanup and parallel tracking probes cancel their peers on failure. This unit
prepares worktree setup; it does not complete worktree GC, Session ownership or
the daemon's application runtime.

## Services and compatibility

LocalProjectsLive captures LocalProjectPaths, LocalProjectHost and the official
ChildProcessSpawner. Each public workflow requires LocalProjects; its internal
sequence and parallel queries compose Effects directly. LocalProjectPathsLive
uses the official FileSystem, supplied by NodeFileSystem.layer at composition.
The small path port also allows the synchronous compatibility methods to execute
the same normalization and identity kernel with explicit blocking filesystem
operations. Canonical formatting, SHA identity and branch-selector planning stay
ordinary computations. There is no second Git or process implementation.

localProjectLayer is passive default composition. The single deprecated
localProjectsLegacy facade owns a lazily initialized process-lifetime
ManagedRuntime, projects failures without losing process recovery leases and
runs the native kernel for existing CLI command, control, session, metadata and
worktree-observation consumers. Its runPromise supports an explicit AbortSignal.
The old Promise exports and synchronous root/identity exports are replaced by
native names; all remaining compatibility imports and calls keep Legacy visible.
The synchronous facade remains blocking and does not acquire automatic
interruption. Delete the facade when these CLI entrypoints receive LocalProjects
from the daemon/application runtime; worktree setup and GC are still Promise
orchestration in this revision.

This unit depends on the
[process release correction](../bug-fix/2026-10-10-effect-process-release-failure.md):
failed scoped termination previously only logged a warning. Native Git failure
and cancellation tests exposed it, so it is delivered separately. Git facts can
be reviewed independently of FileLocks; worktree setup needs both. The
[migration roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)
owns the broader dependency graph. Runtime/install and ACP transport have their
own dependencies rather than a global serial layer ordering.

## Preserved behavior and changed guarantees

The [canonical path decision](../bug-fix/2026-09-26-local-project-symlink-worktree-path.md)
and [native GitHub authentication decision](../feature/2026-09-29-local-project-native-github-auth.md)
remain authoritative. Existing project IDs, exact-ref selectors, local/remote
precedence, unborn and detached HEAD, branch collision handling, dirty-tree
refusal and tracking-worktree restrictions are preserved. This does not alter
native Git credentials or allow authenticated product-cloud composition.

Only expected Git statuses produce domain absence: a non-repository or bare-root probe,
missing verified ref, detached symbolic ref and absent optional configuration.
Spawn, deadline, output limit, filesystem permission/I/O, corruption and failed
release propagate instead of returning false, empty results or branch-not-found.
An exact ref is first verified with show-ref --verify --quiet, then read with
--verify --hash, preserving Git versions whose missing-ref hash probe reports 128. A ref disappearing between those commands fails observably. This adds one
read command per existing ref. Tracking probes validate their status inside each
parallel Effect, so an error interrupts and joins its siblings before returning.

The default command ceilings remain five seconds for probes, thirty seconds for
checkout and sixteen MiB per output stream. A command interruption uses the
existing two-second graceful tree policy; unresolved release remains a failure
with a recovery lease. Host environment is read through a Layer-provided Effect for each command,
with the same noninteractive Git settings. Updates remain visible after runtime
initialization, preserving native Git environment configuration. Explicit injection makes a later login-environment
service possible without pretending that service has already migrated.

The [draft Spec](../../../../specs/local-project-git-lifecycle.md) records the
changed failure guarantee. Cleanup success is not a cross-process Git mutation
transaction. This unit adds no implicit file-lock serialization or rollback of
Git operations already performed before cancellation.

## Validation and limits

The owning suite retains its real Git behavior tests and adds native path/sync
identity parity, corrupt metadata, startup failure, timeout plus tree cleanup,
interruption, retained failed release and parallel failure cleanup. The parallel
case observes live trees and resulting failure through Deferred and TestClock;
it does not assert mock counts. The owning suite passes 46 cases; shared and CLI
type checks pass. Seven ablations are caught: process failure becoming absence,
corruption becoming absence, skipped canonicalization, swallowed path permission,
missing-ref failure, frozen host environment and a detached command owner. The
baseline and restored source pass. Full pnpm check passes type checks and lint (zero errors), but its CLI phase
hits the Roost signed-prefix 30-second timeout previously reproduced on clean
main; 3693 cases pass, one fails and one is skipped. Supplemental shared testing
passes 113 files / 1386 cases, Electron passes 214 cases, and all process,
platform, public, import and i18n guards pass. The relevant CLI consumer suite
passes 12 files / 245 cases. The isolated full CLI rerun has the same sole timeout (3693 pass, one fail, one
skipped). It does not establish a green full check.
Format, format:check and docs check pass. Validation isolates Git configuration
and temporary-package contamination only in child processes.

These are local Linux results, not real Windows,
delegated cgroups, packaged installation or production evidence. Windows root
exit before descendants remains separate Job Object work. Session, ACP, Turn,
root ManagedRuntime and Loro lifetimes remain unfinished dependencies.
