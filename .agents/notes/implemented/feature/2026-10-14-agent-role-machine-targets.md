# One Agent Role across several machines

Status: implemented
Translation: current

[中文](2026-10-14-agent-role-machine-targets.zh.md)

## Abstract

Users with several machines kept one Role per machine because a Role bound exactly
one machine and Agent Config and names had to be unique, so every edit was repeated
by hand. A Role now keeps its shared fields (name, prompt, description, emoji,
visibility) once and carries one target per machine with its own agent, run config,
memory and optional alias. The editor shows machine tabs, the Settings list names
each Role's machines, and `@` offers one row per target. Single-target Roles stay
in the v1 row shape; only multi-target Roles use a v2 row that older clients skip.
The [draft Spec](../../../../specs/agent-role-machine-targets.md) awaits review.

## Problem and evidence

`isAgentRole` accepted only `v === 1`, and `normalizeAgentRole` rebuilt the row
from known fields, so an older client editing a row with extra fields wrote it back
without them. Adding targets as an extra field on a v1 row would therefore let any
older client silently delete the other machines. `validateAgentRoleForm` rejected a
name whose mention token was already used, which forced per-machine copies. Memory
associations are stored per machine
([memory Spec](../../../../specs/agent-role-memory.md)).

## Design

- **In-memory shape.** `AgentRole` keeps its inline `machineId`, `agentConfigId`
  and `runConfig` as the first target and adds `additionalTargets`.
  `bindAgentRoleTarget(role, machineId)` returns the Role with that machine's
  target inline, so every execution path — composer, session hook, schedules, MCP
  create, reconciliation — keeps reading the inline fields and only has to bind
  first. A Role already inline is returned unchanged to keep memoized identity.
- **Storage.** `serializeAgentRoleRow` writes v1 for one target and
  `{ v: 2, targets }` for several; both the UI catalog writer and the shared Flock
  writer go through it. Reconciliation edits one target of the stored row and
  re-serializes, so a single-target Role never leaves v1.
- **Mentions.** The range value is the Role id, plus `@machineId` for a
  multi-target Role (`formatAgentRoleMentionValue`). A bare id of a multi-target
  Role resolves to nothing, so old drafts stay plain text instead of guessing.
- **Agents and CLI.** MCP create tools take `agentRoleMachineId`; the CLI uses
  `--machine` or a target alias. A multi-target Role without a machine fails with
  the list of its machines. Discovery lists one row per target.
- **Editor.** The machine selector became tabs; the Memory tab moved into each
  machine tab. "Add to this machine" suggests the same agent type (same name
  first) and copies the run config; unsupported values surface as the existing
  compatibility issues. Explicit-save option cleanup applies only to the tab being
  edited, because only that agent's capabilities are loaded.
- **List.** Settings is one list instead of machine groups. Every row is the same
  two lines (a fixed-height title line absorbs badges); machines sit in a trailing
  column with state dots, folding past two into "+N" or reading "All N machines".
  Problems and pending checks mark the machine and explain on hover. An earlier
  version stacked machines and reasons as extra lines; rows then varied in height
  and crowded the left edge, which the owner rejected.

## Alternatives

- **Duplicate Role action.** Small (the editor already opens in create mode with a
  prefilled value), but it multiplies the copies the user must keep in sync.
- **Targets as separate Flock rows next to the v1 row.** Older clients would keep a
  working first target, but it adds a row family with orphan cleanup and delete
  ordering. The owner required only that new clients read old data.
- **A target list as the only in-memory shape.** Cleaner types, but every consumer
  and fixture would change; binding a Role to a machine keeps the change local to
  the places that choose a machine.
- **Two-step mention (pick Role, then machine).** Replaced by one row per target,
  ordered by the composer's machine, with an optional alias for the label.

## Verification and limits

Behavior tests cover row shapes and old-row reads, binding, mention resolution,
form save/validation/suggestion, list rows, composer binding, schedule proposals,
reconciliation of one target in a v2 row, catalog writes through the real writer,
CLI/MCP target selection and discovery. Storybook states were rendered and checked
for the list rows and editor. Not covered: an end-to-end desktop walk, and older
clients were not run against a v2 row — only their `v === 1` gate was relied on.
Creating a memory identity while adding a machine is left open in the Spec.
