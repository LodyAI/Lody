# Encrypted machine sharing

Status: draft
Translation: current

[中文](machine-sharing.zh.md)

## Problem and goal

In an encrypted workspace a member can, by default, run agents only on their own
machines. A machine's owner may share that machine with the team, one project at a
time. Sharing must be the owner's own decision: the server cannot grant it.

## Who can grant access

- Only the machine's owner can share it. The owner signs a complete policy (the
  full list of what is shared) on one of their currently active personal devices,
  such as their desktop. A machine, recovery device or revoked device cannot sign.
- The server, a workspace Owner or Admin, and other members cannot grant or change
  sharing on someone else's machine. Other members see the policy read-only.
- Sharing is not written into the membership ledger (the signed record of members
  and devices). Turning a project on or off is not a membership change.

## Defaults and switches

- Every machine is private by default.
- The owner has one switch per machine and one per project on that machine.
  Turning a project on also turns its machine on.
- Turning the machine off keeps the project choices, so turning it on again
  restores them.
- Sharing with the team includes members who join later. Guests and recovery
  devices never run work on a shared machine.

## Checks at execution time

The receiving machine decides. Before it starts a task, and before each later
action of that task, it checks that the requester is a current member and that
the owner's current policy shares the machine and **every** local project the
task can reach. Anything not shared is refused with a precise reason, such as
"machine not shared", "project not shared" or "policy unavailable". The owner's
own work needs no policy.

A machine switch alone admits work that touches no registered project (for
example a plain chat). Project switches choose where a member may start work;
they are not a filesystem sandbox.

## Withdrawal

When the owner turns sharing off and the machine learns the new policy:

- new tasks from members are refused;
- running tasks may take no further authorized action;
- the machine drops its cached grant immediately.

A sender that already knows about the withdrawal refuses to send and keeps the
draft.

**Trust boundary.** A machine reuses a verified policy read for under 15 minutes,
so a withdrawal normally takes effect within that window. Signatures detect forged
or rolled-back policies, but cannot prove a policy is the newest one. A server
that keeps withholding the newer policy could therefore delay withdrawal without
limit. On 2026-10-28 the owner accepted this risk: we trust the server not to
withhold newer policies continuously, and the MVP adds no freshness proof.

## Removal and re-joining

- Removing a machine closes its current *generation* (one continuous identity
  of that machine in the ledger). If it is paired again, even with the same name
  and owner, it is a new generation: private, with no old grants. The owner must
  share it again explicitly.
- Atomic key replacement (swapping the machine's key in one step without removal)
  stays in the same generation and keeps its policy.

## Out of scope

- Sharing across workspaces.
- An Owner or Admin sharing a machine on another member's behalf.
- Work that a shared member's turn derives on a *different* machine; see
  [derived work](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.md).
- Filesystem isolation within a machine.

## Open question

The current implementation does not kill an already running command when sharing
is withdrawn; it only blocks new starts and later authorized actions. The owner
should confirm whether "running tasks stop" means this, or requires forced
termination.

## Acceptance

From the E2EE usability scenarios (the plan is not in this repository):

- **⑫ Share and withdraw.** A member can use a shared machine and project and is
  refused on an unshared one; after withdrawal, new tasks are refused.
- **⑬ Re-paired machine.** After removal and re-pairing, the member is refused
  until the owner shares again; atomic key replacement keeps sharing.

## Evidence

Intended behavior is this Spec. Inspected implementation and executed tests are
listed below; no two-member, two-machine product run is claimed here.

- Notes: [machine sharing](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md),
  [ledger binding](../../.agents/notes/proposed/architecture/2026-10-27-e2ee-machine-ledger-binding.md),
  [derived work](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.md),
  [pairing journal](../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md);
  [foundations increment](../e2ee-foundations.md#machine-sharing-policy-pending-approval-increment).
- PRs: [#2014](https://github.com/LodyAI/Lody/pull/2014), [#2018](https://github.com/LodyAI/Lody/pull/2018),
  [#2033](https://github.com/LodyAI/Lody/pull/2033), [#2144](https://github.com/LodyAI/Lody/pull/2144),
  [#2147](https://github.com/LodyAI/Lody/pull/2147), [#2171](https://github.com/LodyAI/Lody/pull/2171),
  [#2175](https://github.com/LodyAI/Lody/pull/2175).
- Tests: [core](../../packages/e2ee-core/test/machine-sharing.test.ts),
  [host](../../packages/e2ee-machine-sharing/test/host.test.ts),
  [member visibility](../../packages/components/tests/encrypted-shared-machines.test.ts),
  [CLI execution](../../apps/cli/tests/session-execution-service.test.ts).
