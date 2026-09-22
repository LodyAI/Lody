# Keep DSH background subprocesses windowless on Windows

Status: implemented
Translation: current

[中文](2026-09-22-dsh-windows-console-popups.zh.md)

## Abstract

DSH could repeatedly open Windows console windows even though Lody hid its direct
ACP child. The pinned npm/DSH launch chain creates further children, and the DSH
Job runner also calls native process APIs without a no-window flag. The host now
applies console suppression inside those launch boundaries while preserving
stdio, environment, exit handling and Job containment. Synthetic process tests
pass on macOS; Windows packaged execution remains an acceptance check.

## Evidence and decision

The reported diagnostics show Windows DSH startup, several cancelled draft
preparations, then successful ACP initialization and session establishment. They
do not establish an infinite preparation loop. Changing selection or context can
legitimately cancel preparation; this fix does not change that lifecycle. No
captured logs or user/session identifiers are committed.

Inspection of the pinned `@deepseek-ai/dsh@0.1.5-rc.2` closure found:

- The Node forwarder omitted `windowsHide`; npm's `@npmcli/run-script` also
  creates its shell without it. Hiding Lody's direct child is not inherited.
- `dsh-subprocess-local/lib/index.js` launches the Windows Job runner without
  `windowsHide`. The fallback subprocess path already specifies it.
- `dsh-win32-process/lib/index.js` calls `CreateProcessW` with flags `1028`
  (suspended plus Unicode environment), without `CREATE_NO_WINDOW`. Its
  STARTUPINFO configures stdio but does not hide the window. Fixing only Node's
  spawn leaves this native launch uncovered. Microsoft documents the
  [no-window creation flag](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

This extends the [Windows command-length fix](2026-09-21-dsh-windows-command-length.md):
the selected npm JS entry gets a Windows-only import prelude, the forwarder
explicitly hides its child, and the DSH bootstrap installs the same async spawn
policy before importing upstream code. Intercepting `ChildProcess.prototype.spawn`
covers normalized CJS/ESM spawn, execFile and fork calls without rewriting overloads.
The daemon and other providers do not install this policy.

The Windows bootstrap wraps the pinned native binding table, adding only
`CREATE_NO_WINDOW` to `CreateProcessW`/`CreateProcessAsUserW`. It passes that
prelude to the exact pinned Job runner as a Node argument; ordinary agent commands
and MCP servers do not receive a `NODE_OPTIONS` hook. Resolve the closure's real
path before matching the runner, because Node resolves imported entries through
symlinks. There is no source rewrite, npm-cache mutation, version change or
containment fallback. Preserve suspended creation, Job assignment, token handling,
IPC and all stdio carriers. POSIX launch behavior remains unchanged.

This compatibility shim depends on the pinned closure's runner path and native
binding API; reassess both when upgrading DSH. Native npx executables retain the
existing direct-launch path; the npm prelude applies to standard npm JS installs.
An upstream fix would be preferable once it is available in the pinned release.

## Verification

The existing runtime suite executes synthetic npm and DSH modules with the full
package argv and actual Node children. An observer records the normalized spawn
options while native API fixtures expose the complete creation arguments. Tests
cover both platform policies, the separate Job runner, preserved arguments and
native flags, repeated successful subprocess output, and stderr/nonzero exit
propagation. Existing missing-npm, npm failure, profile and compression checks remain.
These are deterministic, local tests; they do not prove Windows GUI behavior or
native FFI execution. Windows acceptance should exercise cold startup, capability
refresh, repeated commands and cancellation in the packaged desktop.

`pnpm check`, `pnpm format`, and `pnpm run docs check` passed on macOS.

## Integration

- [Lody PR #891](https://github.com/LodyAI/Lody/pull/891)
