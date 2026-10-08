# Run GitHub credential adapters under the Lody runtime

Status: implemented
Translation: current

[中文](2026-10-08-github-host-node-runtime.zh.md)

## Abstract

Lody-generated Git and gh adapters started through PATH `node`, so a managed GitHub
checkout failed before the agent started on desktop hosts without Node. They now
re-execute under the runtime running the CLI and keep Electron's Node mode, without
changing which `node` user tools see. Tests were written but not run by the authoring
agent, and no packaged macOS or Windows run was performed.

## Evidence

Confirmed on macOS: with only system directories on PATH, the generated Git wrapper
exited 127 (`env: node: No such file or directory`); the same file under an explicit
Node printed the Git version. The desktop runs the CLI as Electron's helper with
`ELECTRON_RUN_AS_NODE=1`. The Git wrapper, HTTP adapters and gh shim used
`#!/usr/bin/env node`; the credential helper ran `!node` and the diagnostic helper probe
spawned `node`. Windows `.cmd` launchers already named `process.execPath`.

## Decision

`lib/host-node-launcher.ts` emits a two-line sh/CommonJS preamble for the Git wrapper,
HTTP adapters and gh shim: sh re-executes the file under the quoted runtime path (setting
Electron's Node mode), and Node reads the second line as a directive plus comment. File
names, `__filename`, `.cmd` entry points and vm-based tests are unchanged. The credential
helper command and diagnostic helper probe use the same runtime.

Rejected: an absolute-path shebang cannot hold the spaces in `Lody Helper.app` paths or
set Electron's mode; separate sh launchers with `.cjs` bodies add files and break the gh
shim's `__filename` self-exclusion; adding Lody's runtime to PATH would replace the
user's own `node`. Only Lody-owned launchers change.

Limits: generated files embed the runtime path and are rewritten by each managed
preparation, so a relocated app takes effect in the next session. Windows execution
through Git for Windows' sh is unverified.

## Verification

Regression tests run generated scripts, the Git wrapper, both HTTP adapters, the gh shim
and real `git credential fill` with an empty PATH, a runtime path containing spaces and
both runtime modes. They were not executed in the authoring environment. Related:
[command credentials](../architecture/2026-09-26-github-command-credentials.md),
issue [#1307](https://github.com/LodyAI/Lody/issues/1307).
