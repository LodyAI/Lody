# Encrypted machine sharing

Status: draft
Translation: current

[中文](machine-sharing.zh.md)

## Goal

In an encrypted workspace, members can run agents only on their own machines by
default. A machine's owner may share it with the team, project by project.

## Who can grant access

- Only the machine's owner, by signing the complete sharing policy on one of
  their active personal devices.
- The server, workspace Owners/Admins and other members cannot share someone
  else's machine; they see the policy read-only.
- Sharing is not recorded in the membership ledger.

## Defaults and switches

- Machines are private by default.
- The owner has a switch per machine and per project. Turning a project on also
  turns its machine on; turning the machine off keeps the project choices.
- Team sharing includes members who join later. Guests and recovery devices never
  run work on a shared machine.

## Execution

The receiving machine runs a member's task only if the current policy shares the
machine and every project the task uses. Otherwise it refuses with a specific
reason, such as "machine not shared" or "project not shared". The owner's own
work needs no policy.

## Withdrawal

After withdrawal, no new task can start and no further authorized action can run;
commands already running are not forcibly terminated.

A machine may reuse a verified policy for under 15 minutes, so withdrawal normally
applies within that window. There is no strict upper bound: a server that keeps
withholding the newer policy could delay it. The owner accepted this risk on
2026-10-28; we trust the server not to do so.

## Removal and re-pairing

- A removed and re-paired machine is a new *generation* (a fresh identity in the
  ledger). It starts private with no old grants; the owner must share it again.
- Atomic key replacement (swapping the machine's key without removal) keeps the
  same generation and its policy.

## Out of scope

Sharing across workspaces; an Owner/Admin sharing on another member's behalf.

## Acceptance

From the E2EE usability scenarios (not in this repository):

- **⑫ Share and withdraw:** shared machine/project works, unshared is refused;
  after withdrawal, new tasks are refused.
- **⑬ Re-paired machine:** refused until the owner shares again; atomic key
  replacement keeps sharing.

## Evidence

No two-member, two-machine product run is claimed.

- Notes: [machine sharing](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md)
  (details, limits and threat model), [ledger binding](../../.agents/notes/proposed/architecture/2026-10-27-e2ee-machine-ledger-binding.md),
  [derived work](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.md).
- PRs: [#2014](https://github.com/LodyAI/Lody/pull/2014), [#2018](https://github.com/LodyAI/Lody/pull/2018),
  [#2033](https://github.com/LodyAI/Lody/pull/2033), [#2144](https://github.com/LodyAI/Lody/pull/2144),
  [#2147](https://github.com/LodyAI/Lody/pull/2147), [#2171](https://github.com/LodyAI/Lody/pull/2171),
  [#2175](https://github.com/LodyAI/Lody/pull/2175).
- Tests: [core](../../packages/e2ee-core/test/machine-sharing.test.ts),
  [host](../../packages/e2ee-machine-sharing/test/host.test.ts),
  [visibility](../../packages/components/tests/encrypted-shared-machines.test.ts),
  [CLI execution](../../apps/cli/tests/session-execution-service.test.ts).
