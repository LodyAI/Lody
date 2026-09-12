# Accept an unsplit ACP terminal command line

Status: implemented
Translation: pending

## Abstract

ACP `terminal/create` carries an executable plus argv, but several agents send
the whole shell line in `command` with empty `args`; spawned literally it fails
with `ENOENT`, and the failure was invisible or fatal depending on the sandbox —
Linux surfaced an untyped errno `-2` that made agents drop the session, darwin
returned a terminal id whose `wait_for_exit` never resolved. Lody now spawns the
protocol pair as before and rebuilds a command only in that one shape (empty
`args`, whitespace, no file at that path), through a non-interactive, non-login
`sh -c` (`cmd.exe /c` on Windows). A spawn that still fails rejects
`terminal/create` with a JSON-RPC code and records an exit status, so no waiter
hangs. The fallback cannot tell a genuine one-word-with-spaces intent from an
unsplit line beyond the file check, so it stays deliberately narrow rather than
becoming a general shell mode.

## Problem and ownership

Splitting a command line is the agent's job under the Agent Client Protocol, and
`ShellTerminalManager` owns process execution. The compatibility handling is
therefore interoperability at the execution boundary, not a correction of Lody's
protocol reading: `command` + `args` stays the contract and the default path.

Two distinct defects met in the same call. The first is resolution: cross-spawn
gets `ls -al` as `argv[0]` and the OS has no such executable. The second is
reporting. `sandbox.spawn` behaves differently per platform — the cgroup sandbox
awaits the child's pid and rejects, while the POSIX fallback resolves the handle
and lets the error arrive later on the process error channel. The terminal's
`onError` hook only logged, so the late error resolved nothing: `createTerminal`
had already returned an id and `waitForTerminalExit` waited forever. Both
platforms therefore needed the same typed answer.

## Decision

Three changes, each narrow:

1. `resolveTerminalSpawnTarget` rebuilds a command only when `args` is empty,
   `command` contains whitespace, and `stat` finds no file at that path relative
   to the workdir. The file check is what preserves an executable path that
   contains a space; `args.length > 0` is never wrapped, so a caller that
   already split its argv keeps exact spawn semantics.
2. `waitForSpawnConfirmation` awaits the child's pid when it is not already set,
   so a spawn failure rejects `createTerminal` instead of publishing a terminal
   that can never exit. A started process costs nothing here: Node assigns `pid`
   synchronously, so the check returns immediately.
3. `ENOENT`/`EACCES` become `TerminalSpawnError`, which `AgentClient.createTerminal`
   answers as `acp.RequestError.invalidParams` (`-32602`). A command that cannot
   be executed is a bad request, and a numeric JSON-RPC code is what lets an
   agent report the failure instead of treating it as a dead connection. The
   terminal's `onError` hook now also records an exit status, so a process error
   after a successful start completes pending waits rather than hanging them.

`sh -c` is intentional. `bash -lc` would run the user's login profile, changing
`PATH`, shell options and environment behind a command the agent asked to run in
the session's own environment, and would fail where bash is absent.

Separately, `resolveCustomACPSetting` now expands a leading `~` in a custom
agent's launch command, which is typed by a human and is not expanded by
`spawn`. Terminal command lines are deliberately excluded: those come from the
agent, and the shell fallback already expands `~` when it is the one running.

## Alternatives

- Wrap whenever `args` is empty, without the file check ([#470](https://github.com/LodyAI/Lody/pull/470)).
  Simpler, but it sends an executable whose path contains a space through the
  shell, where quoting and metacharacters then apply to a path Lody was given
  verbatim.
- Split the line in Lody and spawn `argv[0]` directly. That requires a
  shell-accurate parser for quoting, escapes and operators; `sh` already has one
  and is what the agent's own line was written for.
- Report the failure only as terminal output with a non-zero exit status. The
  agent would see a terminal that "ran" and print nothing useful, and the
  session-level cause would stay invisible.

## Verification

`apps/cli/tests/terminal-manager.test.ts` covers the spawn decision against a
stub sandbox — the unsplit line on POSIX and Windows, an untouched split argv, an
executable path containing a space, a command line that already carries args,
both spawn-failure shapes (sandbox rejection and late error channel), and a
pending wait completed by a process error — plus two POSIX cases against a real
process through `createNoopSessionSandbox`: an unsplit `printf` line whose output
and exit code come back, and an unresolvable executable that rejects instead of
publishing a terminal. `apps/cli/tests/agent-setting.test.ts` covers the `~`
expansion. Ablation: removing the file check fails the space-in-path test,
removing the spawn confirmation fails the late-error test, and removing the
`onError` exit record leaves the wait test hanging until its timeout.

Not verified here: a live agent that sends an unsplit line (the reporter's
`codebuddy-code`), and Windows `cmd.exe` behavior on a real host — the Windows
branch is covered only through the injected platform, and the real-process cases
skip on Windows.

Issue: [#469](https://github.com/LodyAI/Lody/issues/469).
