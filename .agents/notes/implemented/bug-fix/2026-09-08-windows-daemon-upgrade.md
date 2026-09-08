# Launch Windows daemon upgrades through the npm command shim

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/488

[中文](2026-09-08-windows-daemon-upgrade.zh.md)

## Abstract

Remote daemon upgrades selected `npm.cmd` on Windows but passed it directly to
Node's native spawn, which cannot execute command scripts without an interpreter.
The upgrade now uses the CLI's existing `cross-spawn` dependency to resolve and
escape the Windows shim. A synthetic npm executable exercises the installation
arguments, success/failure result, and intent cleanup without installing packages.
Windows execution and a deployed remote upgrade remain unverified locally.

## Decision and scope

Use the same cross-platform launcher already used by CLI agent and process tools.
This avoids introducing another command-line quoting implementation or enabling a
shell on every platform. Package name, registry, target-version validation,
timeouts, cancellation, and watchdog handoff remain unchanged. This fixes the
existing Windows behavior rather than changing product intent or the protocol.

The separate lifecycle response-append failure that can leave an operation pending
is not part of this patch. No existing owning note was found for the upgrade launcher.

## Evidence and verification

- [Node's Windows command-script documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
  describes the interpreter requirement.
- [Implementation](../../../../apps/cli/src/lib/machine-lifecycle.ts) uses the existing
  dependency; no manifest or lockfile change is needed.
- [Regression tests](../../../../apps/cli/src/lib/machine-lifecycle-upgrade.test.ts)
  isolate PATH to a temporary npm shim in a directory containing spaces. They run
  a `.cmd` on Windows and a shell script on POSIX, with exit codes 0 and 1.
- Targeted lifecycle tests passed (10 tests) on macOS, and `pnpm check` passed
  after allowing the existing local IPC tests to create sockets outside the sandbox.
  Tests do not exercise registry access, native-module replacement, cancellation
  of the Windows process tree, or a real watchdog handoff.
