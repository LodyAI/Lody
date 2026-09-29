# Agent Roles reach any machine the executing machine's owner may use

Status: implemented
Translation: current

[中文](2026-09-28-mcp-cross-machine-agent-role.zh.md)

## Abstract

An Agent asked to work with a Role bound to another machine was refused with
`AGENT_ROLE_MACHINE_MISMATCH`, then started a Role-less Agent on that machine,
silently dropping the Role's prompt and run config. Three layers enforced a
stale single-machine rule: MCP creation, MCP discovery and the composer's Role
mentions pinned plain chats or Local Projects to their own machine, and the
delegated access check only admitted machines the executing machine's owner
owned. Roles are now dispatchable from every context to any machine that owner
may use: machines they own, or shared machines, and a shared machine's local
project only when it is shared too. The person driving the Turn must also be
able to use the target, so delegation never widens either one's reach; a new
hosted query checks both users.

## Discovery

`resolveMcpSessionCreate` in `apps/cli/src/mcp/lody-mcp-server.ts` rejected a
Role on another machine unless the requester was in a GitHub project, a rule from
the Role V1 design (#135). The [mention Spec](../../../../specs/agent-role-mentions.md)
and [mention availability note](../feature/2026-09-09-agent-role-mention-availability.md)
later widened plain chat to all authorized machines (#548), but the MCP check and
discovery's `roleMachineScope` (`outside_work_context`) were not updated. The
error was non-retryable, so the calling Agent fell back to a manual
`machineId + agentConfigId` create, which carries no Role.

MCP runs as a delegated requester: the daemon's CLI token belongs to the
executing machine's owner, and the driving human comes from the Turn. The
delegated path called the hosted `canUseMachineFromCliToken`, which exists for a
serving daemon to vet a requester on its own machine and so requires the target
to be owned by the token user. A teammate's shared machine was therefore
unreachable even for its intended users.

## Decision

- **Reach.** `readDelegatedMachineAccess` (`apps/cli/src/commands/session.ts`)
  calls the hosted `canDelegateMachineUseFromCliToken`, declared in
  `packages/cloud-api`. The server authenticates the token user and runs the
  same machine rule (owned, or shared plus shared project, plus workspace
  membership) for that user and for the driving human, without the
  serving-owner condition; both must pass. Every delegated surface uses this
  function: create validation, `lody_session_create_options` machines and
  local projects, and resource discovery.
- **Rollout.** Against a backend without the query (Convex reports a missing
  public function), the CLI keeps the conservative two-step fallback:
  `canRequestMachineFromCliToken` as the token user, then, for a different
  human, `canUseMachineFromCliToken`. That fallback cannot check the human on a
  machine the owner does not own, so it denies that case until the backend
  ships.
- **Target machine.** The executing daemon still verifies the Turn's human with
  its own `verifyMachineAccess`; this change does not relax it.
- **Role placement.** The MCP machine check and discovery's work-context scope
  are removed. A child Session must share its parent's machine, so a Local
  Project requester defaults to a child only for a same-machine Role; a Role
  elsewhere starts independently on its machine, in the local project passed as
  `workContext` or as a plain chat. An explicit child request for a remote Role
  still fails with the existing parent-machine error.
- **Composer mentions.** Every composer uses the authorized-machines scope; the
  `outside_work_context` reason and the pinning helpers are deleted.

Rejected alternatives: keeping the Local Project restriction (the owner asked
for Roles to be callable everywhere, and an independent Session is the valid
shape there); checking only the driving human (a daemon could name any
teammate, so the executing owner's access must bound delegation); and deciding
the third-party case in the CLI from `MachineMeta.ownerUserId`, which comes from
an unauthenticated synced document.

## Limits

Until the hosted query is deployed, a teammate driving someone else's shared
machine cannot reach a third person's shared machine through an Agent. The
`Could not find (public )?function` match that selects the fallback follows
Convex's documented server error and has not been observed against a real
older deploy.

## Verification

- The private backend's `machines.test.ts` covers the hosted query: owned,
  shared, unshared and shared-project targets, a teammate reaching a third
  person's shared machine, neither user borrowing the other's private reach,
  and a non-member requester. Dropping either user's check fails a test.
- `apps/cli/src/commands/session.test.ts` runs the same cases against the
  hosted path and the fallback; ignoring the hosted verdict fails the
  third-party teammate case.
- `apps/cli/src/mcp/lody-mcp-server.test.ts` covers a chat requester resolving a
  remote Role to its own machine and a Local Project requester defaulting to a
  child only for a same-machine Role; reverting the fix fails both.
- CLI typecheck and scoped lint pass.
