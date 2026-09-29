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

## Verification

- `@effect/vitest` 0.26 was added. The new tests in `tests/platform-process.test.ts`
  drive time with `TestClock` over an in-memory process table,
  `tests/fake-process-table.ts`, that models groups, ignored signals and
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
