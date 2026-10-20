# Windows Host access denied

Status: implemented
Translation: current

[中文](2026-10-20-windows-host-access-denied.zh.md)

## Abstract

On Windows a desktop could show "connecting" forever when a Lody runtime had
been started elevated in another logon session (session 0, full administrator
token). That runtime's named pipes carry the default DACL of an elevated token,
which grants write access only to SYSTEM and Administrators, so the same user's
non-elevated desktop is refused with Win32 error 5 on every probe and retried
every 60 seconds without end. The Host lease now reports such an endpoint as
`accessDenied`, the supervisor stops with a fatal state instead of retrying,
and Settings → Daemon explains what to do. This makes the failure visible; it
does not let the two privilege levels share a runtime.

## Decision and evidence

Electron reserves the runtime by binding the per-user Host pipe
(`local-cli-host-lease.ts`). libuv translates `ERROR_ACCESS_DENIED` on the
first-instance `CreateNamedPipeW` into `EADDRINUSE`, so the bind looks like an
ordinary occupied Host; the follow-up identity probe then fails as `EPERM`
(libuv's mapping of the same Win32 error on connect). Before this change the
probe swallowed that error, the lease returned `occupied` with no record, and
the supervisor scheduled an uncounted retry, which can never reach fatal.

- The lease probe keeps the error class: `EPERM` or `EACCES` from connect yields
  `{ status: 'occupied', record: null, accessDenied: true }`. Other callers
  keep treating it as occupied; the TS and CJS modules stay in parity.
- `SupervisorOwnership.acquire` gains `inaccessible`. The supervisor marks it
  fatal; an explicit start or restart clears the verdict and acquires again, so
  quitting the foreign process and pressing Restart recovers without relaunching.
- `ElectronCliState.hostAccessDenied` carries the reason as data, so the
  renderer shows translated copy. The Nightly startup dialog uses the same
  explanation.

Fatal was chosen over a labelled retry loop: the access check is deterministic,
a retry repeats it unchanged, and the
[failure containment guide](../../../docs/failure-containment.md) warns that
retrying a persistent failure forever is as unavailable as a fence.

## Alternatives not taken

- `listen({ readableAll, writableAll })` calls libuv's `uv_pipe_chmod`, which
  adds an `Everyone` read/write entry. The pipes are also created without
  `PIPE_REJECT_REMOTE_CLIENTS`, so that would widen control access well beyond
  the user.
- Creating the pipes with an explicit user-SID DACL would let the two privilege
  levels share a runtime, but Node exposes no security attributes: it needs a
  native pipe server for every local channel. Deferred until that sharing is a
  supported configuration.

## Verification and limits

A Unix-socket test with mode `000` reproduces the refusal as `EACCES` through
the real connect path for both module formats; it fails on the previous code.
A supervisor test covers fatal without retries and recovery on restart. The
Windows `EPERM` mapping comes from libuv source (`src/win/error.c`,
`src/win/pipe.c`), not from a Windows run. How the elevated session-0 runtime
was started on the affected machine is still unknown; this change does not
prevent it.
