# Session initialization deadline

Status: draft
Translation: current

[中文](session-initialization-deadline.zh.md)

A Session turn begins in `initializing` and stays there while Lody does the work
that must happen before the agent can be prompted: resolving the requester's
identity, verifying machine access, preparing a worktree, downloading a managed
runtime, and starting or resuming the ACP agent. Only once that work completes
does the turn become `running`.

Every one of those steps depends on something Lody does not control — a cloud
query, a remote repository, a download, a child process. Lody therefore
guarantees that **initialization always reaches a terminal state**. A turn whose
initialization stops making progress is failed with a visible error; it never
waits indefinitely.

## What counts as progress

The deadline measures silence, not duration. It runs from the last time the
session's published status changed, so a step that reports progress keeps
resetting it. A managed-runtime download that publishes a rising percentage may
legitimately take as long as the transfer needs; the same download stuck at one
percentage is a stall.

Steps that publish no intermediate progress — preparing a clone, spawning the
agent process — are measured from when they began, because for those the absence
of any published change is the only signal available.

Each initialization step carries its own budget, because their honest worst
cases differ by orders of magnitude. Pre-agent bookkeeping is the tightest: its
only intentionally slow dependency, the requester profile query, already carries
its own 60-second deadline, so anything meaningfully longer is a wedge rather
than a slow answer. Cloning a repository is the most generous, because its input
size and the user's link speed are both unbounded and neither is Lody's to
assume.

## What the user sees

A stalled turn fails the way any other known pre-prompt failure does: the chat
records `session_init_failed` with a message naming the step that went silent
and how long it was given, and the session returns to `idle`. It is not silently
returned to `idle` with no explanation, and it is not reported as cancelled — the
user did not cancel it. Retrying is sending the message again.

Failing the turn also releases what initialization was holding: the session's
active presence, its turn registration, and the pending agent process. Until it
is released, active presence keeps the session counted as busy, which both
suppresses idle collection and makes the machine publish a Session that looks
like it is working when nothing is.

The deadline is a backstop for a dependency that never answers. It is not a
performance budget, and a step that trips it is a defect somewhere else.

## Evidence

The watchdog and its per-stage budgets live in
`apps/cli/src/lib/loro/session-active-presence.ts`; the turn-side enforcement is
`awaitInitializationStall` in `apps/cli/src/session/session-execution-service.ts`.
The requester-profile deadline it is calibrated against is
`USER_PROFILE_TIMEOUT_MS` in `apps/cli/src/session/session-user-resolver.ts`.

This draft records the requested guarantee. The budgets are calibrated from one
machine's daemon logs (923 initializations over one week) and from the single
production stall that motivated it; they have not been validated against a
managed-runtime download or a large clone on a slow link. Covering tests are in
`apps/cli/tests/session-execution-service.test.ts`.
