# Remove draft session preparation

Status: implemented
Translation: current

[中文](2026-10-16-remove-draft-session-preparation.zh.md)

## Abstract

While a user typed a first message, the desktop asked the target machine to
start the agent process and create the worktree, so the first turn could adopt
them. On one machine over three days, the daemon prepared 64 drafts and adopted none. In 27
cases the turn arrived, found the preparation incompatible, deleted it, and
rebuilt everything from scratch. That rebuild was slower than an ordinary cold
start and sometimes failed the turn. Preparation is removed. A Session now
starts its agent and worktree only when its first turn is dispatched. Daemons
still answer the old request so older desktops keep working, and worktrees that
older daemons prepared are either claimed safely by their Session or removed.

## Problem

A user reported that a message sent to a remote machine sat at "Starting…" long
after its read receipt appeared. The read receipt is written as soon as the
daemon sees the pending user turn, so that wait is entirely the daemon's
pre-prompt work.

The daemon log for one such turn (2026-10-16) showed the cost. The preparation
had finished 80 seconds before the send. At dispatch, the claim missed: the
daemon killed the prepared agent, removed the prepared worktree and its branch
(about 8 s), then ran the cold path: `git fetch`, worktree creation, Git
identity, agent spawn and `newSession` (about 16 s). Waiting for the Session
took 26.4 s of the 33 s between dispatch and the first prompt.

Across three days of that machine's daemon logs, 64 drafts were prepared and
54 new Sessions were created. No preparation was adopted. The 27 discarded
preparations had a median wait of 11.4 s for the Session, against 6.6 s for the
cold starts that had nothing prepared. Preparation therefore made the first
turn slower whenever it existed at all.

Why the claims missed is not established. Adoption required the requester, the
project, the launch configuration and the run selection (model, memory, MCP
servers, option values) to match exactly. That daemon predated the claim-miss
reason logging added in
[preparation cleanup diagnostics](../bug-fix/2026-10-16-preparation-cleanup-diagnostics.md),
so the log never recorded which field differed. One cause is visible in code for
local worktree projects: a preparation recorded the project's branch selector
(`main`), while the durable create compares the resolved ref (`refs/heads/main`),
so those claims could never match.

The cost was not only latency. Preparation owned a separate lifecycle: a TTL
control, a retirement barrier that a cold start had to wait on, a credential
lease that transferred on adoption, speculative worktree markers, and a claim
gate inside `AgentClient` startup. Several recent fixes existed only to keep
that lifecycle safe:
[retirement barrier](../../archived/bug-fix/2026-10-09-session-preparation-retirement.md),
[retryable unreleased resources](../bug-fix/2026-10-15-unreleased-session-resources-retry.md)
and the cleanup diagnostics above. One of them recorded a turn that failed
after 75 s because releasing a missed preparation timed out.

## Decision

- The desktop no longer sends `session/prepare` or `session/prepare-cancel`.
- The daemon creates the agent process, sandbox, credentials and worktree only
  through the ordinary Session creation path at dispatch. The preparation
  service, its TTL control, adoption, the claim gate in `AgentClient` startup
  and the speculative worktree materialize/claim/complete steps are deleted.
- The two RPC methods and their schemas stay. Older desktops still send them,
  and the daemon answers both at once without an access check or any work.
  Prepare reports an accepted `duplicate`, so an older desktop holds that one
  lease until the draft idles or is sent. A rejection would make it send a new
  prepare and a cancel after every pause in typing. Cancel reports `not-found`.
- `legacy-speculative-worktrees.ts` handles the markers older daemons left.
  Session creation claims the Session's marker before it probes the directory
  and reruns setup on the worktree, because a preparation never completed it;
  the marker is dropped only after setup succeeds. A worktree no Session ever
  adopted is rebuilt when it targets another repository or base branch. A
  worktree a Session adopted (`durable-pending-setup`, or a create that records
  a branch to restore) is never destroyed over a target mismatch, and claiming
  promotes an unadopted marker before creation records the branch. Removal also
  deletes the branch, and resume restores the branch by name. A drifted
  spelling such as `main` versus `refs/heads/main` would otherwise leave the
  Session permanently unresumable, which a test reproduced. On startup and
  metadata recovery, a sweep removes orphans: markers, and the worktrees they
  created, whose Session is neither durable nor being created. Worktree GC
  cannot, because it never acts on a Session it does not know. New daemons write
  no markers, so the sweep needs no staleness window. It shares the per-session
  marker lock with the claim and re-checks liveness under it, so it never
  removes a worktree a starting Session has just adopted.
- `isSensitiveAcpConfigOptionId` moves to its own shared module. Roles,
  schedules and the retained request schema still use it.

## Alternatives

- **Find and fix the claim mismatch.** Possible, and the new miss logging would
  have named the field. It would keep every lifecycle cost above, and a correct
  claim still only helps when the user waits on the composer long enough for
  preparation to finish. A discard rebuilt the worktree from scratch, so any
  remaining mismatch would keep the "slower than cold" failure mode.
- **Keep the worktree on a miss and only replace the agent.** This removes the
  worst case, but keeps the preparation lifecycle, the credential transfer and
  the retirement barrier for a benefit that was never measured.

## Trade-offs and limits

- The first turn of a new Session now always pays a cold start. On this machine
  that start has a median of 6.6 s. Most of it is `git fetch` and its GitHub
  token requests, which is separate follow-up work.
- Delete `legacy-speculative-worktrees.ts`, and the decline handlers and request
  schemas, once no supported daemon or desktop can still produce them.

## Verification

- Typecheck: CLI sources, `@lody/shared`, `@lody/loro-streams-rpc` and
  `@lody/components` pass. Type-aware lint on the changed files reports no errors.
- Tests that passed: the legacy marker suite (orphan removed at any age,
  adopted directory kept, durable, active and foreign markers left, a Session
  that starts during the sweep's durability check keeps its worktree, failed
  removal retried, mismatched target rebuilt, matching target pending setup
  until completion); the whole session-manager suite, including real-Git cases
  where a legacy worktree is reused with setup rerun on resume, an adopted
  worktree with a drifted base-branch spelling resumes on its own branch, and an
  unadopted mismatched one is rebuilt. With the old rule (any mismatch destroys),
  those adoption cases fail with `Session restore branch not found`; the credential-broker worktree suite; AgentClient
  session startup; dispatch watcher; credential runtime ownership; shared
  schema/sensitivity tests; the Loro Streams RPC suites; and the chat-landing,
  Machine RPC facade and runtime tests.
- The real-Git suites ran with a clean process environment. In this agent's
  sandbox the inherited environment makes `git commit` hang.
- Latency after removal was not measured on a remote machine.
