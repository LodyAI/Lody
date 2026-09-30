# Terminate ACP process trees through one Effect process layer

Status: implemented
Translation: current
PR: [#1065](https://github.com/LodyAI/Lody/pull/1065)

[中文](2026-09-27-effect-process-tree-layer.zh.md)

## Abstract

The CLI had at least five hand-written copies of "SIGTERM, wait, SIGKILL". They
differed in the details:
- some waited with no bound;
- some left their timers running;
- some ignored processes killed by a signal;
- one swallowed sandbox failures but still reported the session as terminated.

Descendants of an ACP wrapper that had already exited were never signalled again,
and on Windows only the wrapper was killed. This change adds the first two layers
of the [bottom-up Effect migration](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md):
- an Effect process layer, with one `NodeProcess` service at the OS boundary;
- process trees whose liveness covers every member;
- one bounded termination policy that fails with a typed error instead of hanging
  or pretending to succeed.

Session agents, terminal commands, capability/title/login agents, history agents
and the login status probe now all end through it. Windows descendants whose
parent has already exited remain out of reach, so
[#429](https://github.com/LodyAI/Lody/issues/429) is only partly addressed.
No live-provider or Windows run was part of this verification.

## Scope

This is PR1 of the [turn execution and ACP process ownership plan](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.md):
L0 platform plus the L1 process leaf. It covers every ACP-related process:
- session sandboxes (the ACP agent, `exec` commands, ACP terminals);
- auxiliary agents started by `spawnAcpProcess` (capability probe, title
  generator, protocol login, history catalog);
- the builtin login status probe.

Other spawners, such as git and the worktree setup runner, move onto the same
service in the next PR.

`Session`, `TerminalManager` and the auxiliary callers are still Promise code.
They reach the Effect layer through temporary facades (`session-sandbox.ts`,
`terminateAcpProcessTree`), listed in
[cli-effect-ts](../../../docs/cli-effect-ts.md#temporary-promise-facades) and
deleted when their layer migrates.

## Decisions

**One tree abstraction, whole-tree liveness.** A `ProcessTree` has two parts:
- `isAlive` answers for every member. For a POSIX group it uses `kill(-pgid, 0)`;
  for a cgroup it reads `cgroup.procs`.
- `signal` reaches every member.

`terminateTree` checks liveness, sends SIGTERM, waits out a bounded grace period,
sends SIGKILL, and waits again within a bound. Because liveness is not the
root's exit event, termination keeps going after an npx or shell wrapper exits
while the agent it started runs on. A real-process test shows that case: a
leader exits, its `sleep` grandchild keeps running, and termination kills it.

**Failure is typed and depends on the caller.** When a tree cannot be proven
gone, termination fails with `TerminationFailed`: `still-alive` or
`signal-failed`. Each caller handles it differently:
- `Session.terminate` still clears its references and emits `terminated`, so
  lifecycle bookkeeping behaves as before, but it now rejects with the error. The
  session rule "drain, or confirm termination" therefore no longer mistakes a
  survivor for an idle agent.
- Auxiliary agents are never reused. For them `shutdownLocalAcpAgent` logs the
  failure at `warn` and resolves. Rejecting inside those callers' `finally`
  would discard a capability probe or a generated title that had already
  succeeded.

**`Session.terminate` is coalesced.** Concurrent calls share one termination,
so `terminated` is emitted once. It now carries the agent's exit code instead of
the last `exec` command's. A session whose trees survived ends in `failed`, not
`terminated`.

**Groups outlive their leader in the container.** The no-limit container tracks
a group until the group is empty, even after its leader exits. It probes a
lingering group every five seconds and forgets it once empty. The kernel does
not reuse a group id while any member lives, so after the group empties the
reuse window is at most one probe interval.

An alternative was to kill a group's remaining members as soon as its leader
exits. It was rejected because ACP terminal commands can legitimately leave
background jobs running until the Session ends.

**Sandbox processes lead their own group on Linux too.** Before, cgroup
sandboxes started children in the daemon's group and killed only the root per
process. Children are now `detached` there as well, so killing one terminal
command reaches its subtree without `cgroup.kill` ending the whole Session.

**Windows is bounded but not complete.**
- `taskkill /T` runs under a ten-second deadline, and its exit status is checked:
  128 means "gone", other non-zero values are failures.
- If a graceful `taskkill` is refused, as happens for console processes that can
  only be killed forcefully, termination goes straight to `/F` instead of waiting
  out the grace period.
- Descendants whose parent already exited are unreachable from the root. Only a
  Job Object could contain them, and that is left to a separate change.

**Listeners attach in the spawn's synchronous step.** Tests showed that a
`taskkill` finishing before its `close` listener was attached made termination
wait for its whole deadline. Spawn now wires `exit`, `error` and `spawn` events,
and the caller's `onSpawned` hook, before any fiber can yield.

**Deviation from the plan: no daemon runtime yet.** The proposal put a daemon
`ManagedRuntime` in PR1. No resource in this PR has daemon lifetime: every
process belongs to a Session or a single call. Facades therefore provide the
Layers per call, and the daemon runtime arrives with L4, whose session pool is
its first daemon-scoped owner. Rewiring the turn fiber onto a daemon scope now
would touch L5 before the layers beneath it are finished.

## Follow-up: every CLI process caller ([#1069](https://github.com/LodyAI/Lody/pull/1069))

The next stacked PR moves every remaining process caller in `apps/cli/src` onto the
layer:
- git and gh invocations;
- daemon, worker and MCP host children;
- tunnels;
- setup scripts;
- memory probes;
- the upgrade installer;
- PTY termination.

That leaves one implementation. `pnpm check:cli-process-boundary` now fails when
CLI source imports `child_process` or `cross-spawn`, references `node-pty`, or
calls `process.kill` anywhere but `platform/process/node-process.ts`. Its
allowlist holds only two kinds of entry:
- the source text of standalone scripts that run in their own process;
- the node-pty loader.

`apps/cli/AGENTS.md` points new code at the layer.

New capabilities:
- **`runCommand` / `runCommandOk`:** collect output with a per-stream ceiling.
- **`runCommandSync`:** for callers that are synchronous by contract; it
  requires a timeout.
- **`isPidAlive`.**
- **`ManagedProcess.closed`:** exit plus drained stdio.
- **`SpawnSpec.windowsDetached`:** for the daemon runner, which must outlive the
  terminal that started it.
- **Promise facades:** `runCommandText`, `runCommandTextSync`, `startProcess`,
  `isPidAliveSync`, and the PTY's `terminatePtyProcessGroup`.

Decisions, each covered by a test:

- **A finished command keeps what it deliberately started.**
  - `runCommand` ends the command's tree only when the caller stops waiting:
    timeout, interruption, or output over the ceiling.
  - Reaping the group after every successful command was rejected. It would
    kill helpers that git or gh leave running on purpose, which `execFile`
    never did.
  - Output over the ceiling fails at once and ends the tree, as `execFile` did.
- **Setup scripts are ended as a tree only on failure.** A successful script's
  background services survive. A failed or timed-out one no longer leaks
  descendants such as a half-finished `pnpm install`.
- **The PTY is hung up first.** An interactive shell puts each job in its own
  process group, so ending only the shell's group would miss them. The PTY
  therefore sends SIGHUP first, then ends the shell's group with a bounded
  escalation.
- **The `lody` subcommand run by the stdio MCP server stays in the agent's
  process group**, so a session teardown still reaches it.
- **Windows opens URLs via `rundll32 url.dll,FileProtocolHandler`**, so a URL
  never passes through cmd's metacharacter parsing.
- **Timeouts where there were none.** Synchronous callers (`diff-line-counts`,
  `git-identity`) now have timeouts. Worktree git output has a 64 MiB per-stream
  ceiling; it previously had none.

Trade-offs of giving commands their own process group:
- Because `detached` starts a new session on POSIX, commands lose the
  controlling terminal. A foreground CLI's Ctrl-C no longer reaches them, and a
  prompt that opens `/dev/tty` (an ssh passphrase) fails instead of prompting.
- The daemon has no terminal, so this matters only for foreground CLI runs.
- Waits after SIGKILL are now bounded everywhere, so, for example,
  `cloudflared stop()` can reject instead of hanging.

## Follow-up: one layer for the whole repository

A further stacked PR moves the layer into `packages/shared/src/node/process.ts`
(`@lody/shared/node/process`), with its facades and the fake process table
(`process-testing.ts`). Electron main, the CLI supervisor and the shared Node
helpers now use it too. The CLI keeps only its session containers and a thin
facade that adds its logger.

The boundary guard now covers:
- `apps/cli/src`;
- `apps/electron/src/main`;
- `packages/cli-supervisor/src`;
- `packages/shared/src/node`, including `.cjs` files.

It also flags `<child>.kill(` calls, so every termination path is the layer's.
The rules moved with the code to `packages/shared/src/node/AGENTS.md`.

Decisions:
- **One module, no relative imports.** Electron runs its tests with plain
  `node --test --experimental-strip-types`, which cannot resolve extensionless
  relative imports. `process.ts` is therefore one module, and
  `process-testing.ts` avoids TypeScript parameter properties.
- **The three `.cjs` twins were deleted.** The hand-maintained CommonJS copies of
  `cli-detection`, `local-project` and `file-lock` duplicated their process
  logic. A repository search found only their own parity tests loading them.
  Unique cases from those tests were moved onto the TypeScript modules.
- **Lock liveness is three-state.** `file-lock` asks `probePid`, which returns
  `ours`, `foreign` or `missing`. A lock is valid only while its pid is still a
  process of ours: EPERM means the pid now belongs to another user, so the
  owner is gone. The earlier `kill(pid, 0)` code had the same outcome. The first
  migration briefly treated EPERM as alive, which a test now rules out.
- **`signalChildTreeNow` runs synchronously.** Exit handlers cannot await, so
  it signals without waiting for the tree to disappear. A forked fiber would
  send nothing before the process exits; on Windows the `taskkill` starts
  inside the synchronous step.
- **The supervisor ends the tree its launcher describes.** `LaunchHandle` states
  whether its child leads a process group; neither the CLI nor Electron
  launches the supervised CLI detached. If there is no shutdown channel, or it
  fails, the supervisor sends SIGTERM through the tree and cuts the grace period
  short when that SIGTERM cannot be delivered. A child whose tree survives
  SIGKILL makes the supervisor fatal.
- **Electron quit uses bounded tree termination.** It keeps quit-time ownership:
  a survivor still fails quit. On Windows it now ends the whole tree instead of
  only the root.

## Follow-up: correctness review

A review of the stacked PRs against the code they replaced found regressions,
all fixed on the top PR with a failing-first test each unless noted:

- **A failed spawn never reaches the caller's own group.** Until Node reports
  a failed spawn, `child.kill()` signals pid 0: the daemon's (or Electron
  main's) whole process group. `childTree` treats a child without a pid as
  gone. The test runs the race in a real, isolated process group.
- **Abandoned commands get a SIGTERM grace.** A timed-out command was
  SIGKILLed at once, so git left `index.lock` behind and blocked every later
  index write. `ABANDONED_COMMAND_POLICY` now gives 2 s of SIGTERM first.
- **Waits inside finalizers are bounded by the clock, not by interruption.**
  The abandoned-command termination runs in a scope finalizer, where nothing
  is interruptible, so a `timeoutTo` there waited forever for a tree that
  survived SIGKILL (a zombie under a PID-1 daemon, a D-state process).
  `waitUntilGone` polls against a clock deadline, and the `taskkill` deadline
  completes the awaited Deferred from a separate interruptible timer fiber.
- **EPERM from a group signal waits instead of failing.** On macOS a group
  whose only member is an exited, not yet reaped leader answers EPERM; the
  layer now lets the bounded wait decide. A group that truly belongs to
  another user still ends in `TerminationFailed` after the wait.
- **Windows commands never resolve from the working directory.** `cross-spawn`
  searched cwd first with every PATHEXT extension, so a repository's
  `git.cmd` would run during an automatic git refresh. `nodeProcessLive`
  resolves bare names through absolute PATH entries only. When nothing
  matches, Node's own spawn reports ENOENT. Before, cross-spawn wrapped the
  missing command in cmd.exe, which lost `git_executable_not_found` and made
  a missing launcher `.exe` look launched. Unit tested only: no Windows run.
- **`Session.terminate` escalates and does not wait on terminals when forced.**
  A forced call joining a graceful one now SIGKILLs at once and ends the
  graceful waits (terminals, `session/close`). A forced teardown no longer
  waits for terminal commands' graceful stop, since the sandbox kills them.
  A finished termination is reused only while no process was started since.
- **Archive releases a Session even when a tree survives.** The failure is
  logged at warn; the archive, its idle status and local-project removal
  continue.
- **Smaller fixes.** The PTY hangup is the polite signal: a 2 s wait, then
  SIGKILL. SIGTERM right after SIGHUP made fish skip forwarding the hangup to
  its jobs; this one has no test because the race is timing-dependent. Other
  fixes:
  - the shell-env probe allows 15 s and does not cache a failure;
  - `rundll32` gets a visible show state;
  - the cgroup container refuses spawns after cleanup and treats a populated
    nested cgroup as alive;
  - the supervisor no longer retains every run through a shared
    never-settling promise;
  - process-layer warnings reach the daemon's root logger (or the console)
    when a caller passes no logger.

## Follow-up: the last process callers

A repository-wide audit after the review found three processes still outside
the layer, all moved in the same PR:

- **The CLI's login-shell probe used the `shell-env` library.** It spawned the
  shell through execa, so the 3 s timeout could stop waiting but not end the
  shell: a hung rc file kept it alive until the daemon exited. The desktop ran
  a second, different probe. Both now call one probe,
  `@lody/shared/node/login-shell-env`, which runs through `runCommandText`,
  bounded at 15 s. It keeps `shell-env`'s delimiters, its oh-my-zsh and tmux
  guards and its zsh/bash fallback for non-POSIX shells. It also keeps the
  desktop's `env -0` and `~/.bashrc` sourcing, falling back to plain `env`
  where `-0` is missing (BusyBox). The CLI still lets ACP spawns go ahead after
  3 s and replaces the cached value when the probe finishes. The dependency is
  removed.
- **`@lody/code-review-helper` ran git with `execFile`** for `lody review`,
  with no timeout. It now uses `runCommandText` with a 60 s bound, which also
  applies the Windows rule that commands never resolve from the repository.
- **The guard missed several shapes:** optional-chained and parenthesized
  `.kill(` calls, dynamic and `createRequire` imports of `child_process`,
  re-exports, and process libraries other than cross-spawn. It now matches
  module specifiers in any import position, a list of process libraries, and
  any `.kill(` receiver. It also scans `packages/code-review-helper/src`. A
  probe file with each shape confirmed every one is reported, and that type
  imports, `np.kill` and non-import strings are not.

A second review of that work found, and the same PR fixed:
- **Probe output was lost.** macOS `/bin/sh` prints `echo -n` literally, which
  broke the first variable after the delimiter, so the delimiters go through
  `printf`. The probe's own oh-my-zsh and tmux guards no longer leak into the
  returned environment.
- **A failed desktop probe is cached again.** 15 s already covers a slow cold
  login, and retrying stalled every CLI launch.
- **Preparation cleanup no longer rejects** when a tree survives, so the cold
  fallback still runs. This one has no test: the real preparation runtime has
  no test harness.
- **A finished `Session.terminate` is never reused**, so what a later agent
  leaves in the sandbox is ended and a failed attempt is retried.
- **`windowsTree.signal` does nothing for an exited root.** Its pid may already
  belong to another process.
- **Read-only probes** (memory pressure, process table, login shell) pass
  `READ_ONLY_ABANDON_POLICY`: SIGKILL at the deadline, with no SIGTERM grace
  stretching their tight budgets. Commands that may hold locks keep the
  default grace. The trade-off is deliberate: a caller learns of a timeout
  only after the tree is proven gone, so an immediate retry cannot race a
  dying git.
- **Duplication removed.** ACP and supervisor force kills use
  `terminateChildTree`; the CLI facade gained `logPrefix` so the ACP label
  survives. The session sandbox reuses `unwrapSpawnFailure`, and the unused
  shared `withSpawn` is gone.

Left out on purpose:
- scripts generated for their own processes (already allowlisted);
- node-pty, the only PTY spawner, whose groups end through the layer;
- build scripts and ACP extension submodules;
- Electron `shell.openExternal`/`openPath`;
- worker threads.

## Verification

- `@effect/vitest` 0.26 was added. The new tests (now `packages/shared/tests/process.test.ts`)
  drive time with `TestClock` over an in-memory process table,
  `packages/shared/src/node/process-testing.ts`, that models groups, ignored signals and
  `taskkill`. They cover:
  - a descendant that outlives its leader;
  - escalation exactly at the end of the grace period;
  - failure when SIGKILL is ignored;
  - forced termination;
  - already-empty trees;
  - a forced termination that arrives during a graceful one and escalates at
    once instead of waiting out the grace period;
  - scope release;
  - a refused graceful `taskkill`;
  - a hung `taskkill`;
  - a lingering group being tracked and then forgotten;
  - one real POSIX process tree.
- Sandbox and `shutdownLocalAcpAgent` tests assert on the fake process table
  instead of counting `kill` mock calls. `Session` tests cover coalesced
  termination, the agent exit code in `terminated`, and rejection when a tree
  survives.
- Ablation: disabling each new mechanism fails at least one test. The
  mechanisms were whole-tree liveness, lingering-group tracking, coalescing,
  rejection, and the exit-code source. An earlier per-process lock that
  serialized terminations was caught by no test. Its only effect was to make a
  forced termination wait behind a graceful one, so it was removed. A test now
  pins the escalate-at-once behaviour, and re-adding the lock fails it.
- CLI typecheck passes. The full CLI suite passes: 3199 tests, 4 skipped.
- Not verified:
  - Windows behaviour on a real host;
  - cgroup behaviour on a real delegated hierarchy (the tests use a fake
    filesystem);
  - the effect on ACP `terminal/kill` latency. A command that ignores SIGTERM
    now keeps the kill request open for up to five seconds before SIGKILL,
    whereas it previously never died.
